import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseResumeArgv,
  resolveHandoverTarget,
  rewriteResumeArgv,
} from "../src/local/sessionHandover.js";
import { parseElapsedSeconds } from "../src/local/processLiveness.js";
import {
  acquireThreadLock,
  releaseThreadLock,
} from "../src/local/threadLock.js";
import {
  conversationAlreadyOpenMessage,
  conversationSwitchBlockedMessage,
} from "../src/local/agentConflictMessages.js";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";

// --- the conversation the reader asked for -------------------------------

assert.equal(parseResumeArgv(["--resume", "abc-123"]), "abc-123");
assert.equal(parseResumeArgv(["--resume=abc-123"]), "abc-123");
assert.equal(parseResumeArgv(["--resume"]), null, "a bare --resume opens the picker");
assert.equal(parseResumeArgv(["--resume", "--verbose"]), null);
assert.equal(parseResumeArgv(["--verbose"]), null);

// --- the command line for the replacement wrapper ------------------------

assert.deepEqual(
  rewriteResumeArgv(["claude", "--resume", "old-id"], "new-id"),
  ["claude", "--resume", "new-id"],
  "the old resume is replaced, not added to",
);
assert.deepEqual(
  rewriteResumeArgv(["claude", "--resume=old-id", "--verbose"], "new-id"),
  ["claude", "--resume", "new-id", "--verbose"],
);
assert.deepEqual(
  rewriteResumeArgv(["claude", "--verbose"], "new-id"),
  ["claude", "--resume", "new-id", "--verbose"],
  "a switch into a conversation the reader did not name still has to resume it",
);
assert.deepEqual(
  rewriteResumeArgv(["claude", "--resume", "old-id"], null),
  ["claude"],
  "a conversation with no transcript of its own cannot be resumed",
);

// --- where the handover lands --------------------------------------------

const emptyTranscript = (path) => 0;
const sizedTranscript = (size) => () => size;

assert.deepEqual(
  resolveHandoverTarget({
    fromNativeSessionId: "from-id",
    toNativeSessionId: "to-id",
    transcriptPathFor: () => "/tmp/to-id.jsonl",
    transcriptSize: sizedTranscript(4096),
  }),
  {
    mode: "resume",
    resumeNativeSessionId: "to-id",
    transcriptPath: "/tmp/to-id.jsonl",
    reason: "switch",
    holder: null,
  },
);

assert.deepEqual(
  resolveHandoverTarget({
    fromNativeSessionId: "from-id",
    toNativeSessionId: "to-id",
    transcriptPathFor: () => "/tmp/to-id.jsonl",
    transcriptSize: emptyTranscript,
  }),
  {
    mode: "fresh",
    resumeNativeSessionId: null,
    transcriptPath: "/tmp/to-id.jsonl",
    reason: "switch",
    holder: null,
  },
  "an empty conversation has no transcript to resume, so it is opened fresh",
);

assert.deepEqual(
  resolveHandoverTarget({
    fromNativeSessionId: "from-id",
    toNativeSessionId: "to-id",
    transcriptPathFor: (id) => `/tmp/${id}.jsonl`,
    transcriptSize: sizedTranscript(4096),
    holder: { pid: 4242 },
  }),
  {
    mode: "resume",
    resumeNativeSessionId: "from-id",
    transcriptPath: "/tmp/from-id.jsonl",
    reason: "target-open",
    holder: { pid: 4242 },
  },
  "a conversation that is open elsewhere sends the reader back where they were",
);

// --- elapsed time, the one portable reading of a process's start ----------

assert.equal(parseElapsedSeconds("01:05:43"), 3943);
assert.equal(parseElapsedSeconds("03-23:25:52"), 3 * 86400 + 23 * 3600 + 25 * 60 + 52);
assert.equal(parseElapsedSeconds(""), null);
assert.equal(parseElapsedSeconds("nonsense"), null);

// --- one writer per conversation -----------------------------------------

const lockDir = mkdtempSync(join(tmpdir(), "originrouter-thread-lock-"));
try {
  // The liveness check is injected: the pids in this test are not running.
  const alive = (pid) => pid === 111;
  const first = acquireThreadLock("conversation-a", {
    dir: lockDir, pid: 111, startedAt: 1000, isAlive: alive,
  });
  assert.equal(first.ok, true, "the first claim takes the lock");

  const second = acquireThreadLock("conversation-a", {
    dir: lockDir, pid: 222, startedAt: 2000, isAlive: alive,
  });
  assert.equal(second.ok, false, "a live holder keeps the lock");
  assert.equal(second.holder.pid, 111);

  const other = acquireThreadLock("conversation-b", {
    dir: lockDir, pid: 222, startedAt: 2000, isAlive: alive,
  });
  assert.equal(other.ok, true, "a different conversation has its own lock");

  assert.equal(releaseThreadLock(first, { pid: 111 }), true);
  const afterRelease = acquireThreadLock("conversation-a", {
    dir: lockDir, pid: 222, startedAt: 2000, isAlive: alive,
  });
  assert.equal(afterRelease.ok, true, "a released lock can be taken");
} finally {
  rmSync(lockDir, { recursive: true, force: true });
}

const staleDir = mkdtempSync(join(tmpdir(), "originrouter-thread-stale-"));
try {
  // A lock whose owner is gone must not make its conversation unopenable
  // forever. This is the residue a killed run leaves behind.
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "conversation-c.lock"), JSON.stringify({
    pid: 999999,
    startedAt: 1,
    acquiredAt: 1,
  }));
  const reclaimed = acquireThreadLock("conversation-c", { dir: staleDir, pid: 333, startedAt: 3000 });
  assert.equal(reclaimed.ok, true, "a lock left by a dead process is reclaimed");
} finally {
  rmSync(staleDir, { recursive: true, force: true });
}

// --- what we say when a conversation cannot be opened ---------------------

const refusal = conversationAlreadyOpenMessage({ holder: { pid: 1 } });
assert.match(refusal, /already open in another terminal/);
assert.match(refusal, /does not lock it/, "the refusal has to say why");
assert.match(refusal, /Close that session and run this again, or start a new conversation\./);

const rollback = conversationSwitchBlockedMessage({ holder: { pid: 1 } });
assert.match(rollback, /stayed in this one/);
assert.match(rollback, /Close that session and switch again/);

// --- the catalog: one conversation, many runs ----------------------------

const catalogDir = mkdtempSync(join(tmpdir(), "originrouter-catalog-identity-"));
try {
  let clock = Date.parse("2026-11-05T00:00:00Z");
  const catalog = new AgentCatalog({ stateDir: catalogDir, now: () => new Date(clock++) });

  catalog.upsertSession({
    sessionId: "claude-run-1",
    agentType: "claude",
    nativeSessionId: "native-uuid-1",
    title: "Hello",
    deviceId: "device-1",
    cwd: catalogDir,
    status: "running",
  });

  catalog.upsertSession({
    sessionId: "claude-run-2",
    agentType: "claude",
    nativeSessionId: "native-uuid-1",
    title: "Hello",
    deviceId: "device-1",
    cwd: catalogDir,
    status: "running",
  });

  const conversations = catalog.db
    .prepare("SELECT conversation_id, native_session_id FROM agent_conversations")
    .all();
  assert.equal(
    conversations.length,
    1,
    "resuming a conversation is a second run of it, not a second conversation",
  );

  const runs = catalog.db
    .prepare("SELECT run_id, conversation_id FROM agent_runs ORDER BY run_id")
    .all();
  assert.equal(runs.length, 2, "both runs are kept");
  assert.equal(
    runs[0].conversation_id,
    runs[1].conversation_id,
    "both runs belong to the same conversation",
  );
} finally {
  rmSync(catalogDir, { recursive: true, force: true });
}

console.log("conversation handover tests ok");
