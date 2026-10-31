import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultConversationTitle,
  looksLikePlaceholderTitle,
  parseClaudeTitleRecords,
  readAgentSessionTitle,
  readClaudeTranscriptTitle,
  readCodexThreadTitle,
  resolveConversationTitle,
  safeTitleText,
} from "../src/agent/agentTitleSource.js";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";

// The placeholder is ours, not the conversation's. "Claude Code" is the
// agent's own name in the title slot, and it used to be treated as a title
// somebody had chosen — which is how a conversation could never show
// anything else again.
assert.equal(defaultConversationTitle("claude"), "claude session");
assert.equal(defaultConversationTitle("codex"), "codex session");
assert.equal(defaultConversationTitle(""), "agent session");

// The set is relative to the agent: "Claude Code" is a placeholder for a
// Claude conversation, and nothing else.
for (const [placeholder, agentType] of [
  ["", "claude"],
  ["agent session", "claude"],
  ["Agent Session", "claude"],
  ["claude session", "claude"],
  ["Claude session", "claude"],
  ["claude code", "claude"],
  ["Claude Code", "claude"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["Codex", "codex"],
  ["codex session", "codex"],
  ["Codex session", "codex"],
]) {
  assert.equal(
    looksLikePlaceholderTitle(placeholder, agentType),
    true,
    `"${placeholder}" is a placeholder for ${agentType}`,
  );
}
assert.equal(looksLikePlaceholderTitle("Claude Code", "codex"), false);
assert.equal(looksLikePlaceholderTitle("Fix the checkout", "claude"), false);

assert.equal(safeTitleText("  hello  "), "hello");
assert.equal(safeTitleText(null), "");
assert.equal(safeTitleText("x".repeat(400)).length, 191);

// A title is the newest one Claude Code wrote. Both record shapes have been
// seen on disk, and the SDK reads the same field.
assert.equal(
  parseClaudeTitleRecords([
    JSON.stringify({ type: "ai-title", aiTitle: "first" }),
    JSON.stringify({ type: "ai-title", aiTitle: "second" }),
  ].join("\n")),
  "second",
);
assert.equal(
  parseClaudeTitleRecords(JSON.stringify({ type: "ai-title", title: "from title field" })),
  "from title field",
);
assert.equal(parseClaudeTitleRecords("not json\n{\"aiTitle\":\"kept\"}"), "kept");
assert.equal(parseClaudeTitleRecords(""), "");

const workDir = mkdtempSync(join(tmpdir(), "originrouter-title-source-"));
try {
  const transcriptPath = join(workDir, "session.jsonl");
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "检查结算流程" }),
      "",
    ].join("\n"),
  );
  assert.equal(readClaudeTranscriptTitle(transcriptPath), "检查结算流程");
  assert.equal(readClaudeTranscriptTitle(join(workDir, "missing.jsonl")), "");
  assert.equal(readClaudeTranscriptTitle(""), "");

  // A title written after the file grew past the tail window still counts:
  // the newest one is near the end.
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: "ai-title", aiTitle: "old" })}\n${"x".repeat(200 * 1024)}\n${JSON.stringify({ type: "ai-title", aiTitle: "new" })}\n`,
  );
  assert.equal(readClaudeTranscriptTitle(transcriptPath), "new");

  // Codex keeps one line per update; the last line for a thread wins.
  const codexHome = join(workDir, "codex");
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({ id: "thread-1", thread_name: "first name" }),
      JSON.stringify({ id: "thread-2", thread_name: "other thread" }),
      JSON.stringify({ id: "thread-1", thread_name: "final name" }),
    ].join("\n"),
  );
  assert.equal(readCodexThreadTitle("thread-1", { codexHome }), "final name");
  assert.equal(readCodexThreadTitle("thread-2", { codexHome }), "other thread");
  assert.equal(readCodexThreadTitle("thread-3", { codexHome }), "");
  assert.equal(readCodexThreadTitle("", { codexHome }), "");

  assert.equal(
    readAgentSessionTitle({ agentType: "codex", nativeSessionId: "thread-1", codexHome }),
    "final name",
  );
  assert.equal(
    readAgentSessionTitle({ agentType: "claude", transcriptPath }),
    "new",
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// The one rule: a title somebody chose beats a title the agent produced,
// which beats a placeholder.
assert.deepEqual(
  resolveConversationTitle({
    existing: "My name",
    existingIsCustom: true,
    agentTitle: "The agent's name",
    agentType: "claude",
  }),
  { title: "My name", isCustom: true },
);
assert.deepEqual(
  resolveConversationTitle({
    existing: "claude session",
    existingIsCustom: false,
    agentTitle: "The agent's name",
    agentType: "claude",
  }),
  { title: "The agent's name", isCustom: false },
);
assert.deepEqual(
  resolveConversationTitle({
    existing: "claude session",
    existingIsCustom: false,
    agentTitle: "",
    agentType: "claude",
    requested: "Claude Code",
  }),
  { title: "claude session", isCustom: false },
);
assert.deepEqual(
  resolveConversationTitle({
    existing: "",
    existingIsCustom: false,
    agentTitle: "",
    agentType: "claude",
    requested: "A name from the launcher",
  }),
  { title: "A name from the launcher", isCustom: false },
);

// The catalog is where the rule is enforced for real: a placeholder written
// at launch gives way to the title the agent produced, and a rename is never
// clobbered.
const stateDir = mkdtempSync(join(tmpdir(), "originrouter-title-catalog-"));
try {
  let clock = Date.parse("2026-10-29T00:00:00Z");
  const catalog = new AgentCatalog({ stateDir, now: () => new Date(clock++) });

  catalog.upsertSession({
    sessionId: "session-app",
    conversationId: "conversation-app",
    runId: "run-app",
    agent: "claude",
    title: "Claude Code",
    deviceId: "device-1",
    cwd: stateDir,
    runtime: "claude-sdk",
    status: "running",
  });
  assert.equal(
    catalog.getConversation("conversation-app").title,
    "Claude Code",
    "the placeholder is what the launcher asked for",
  );
  assert.equal(
    catalog.getConversation("conversation-app").title_is_custom,
    false,
    "a placeholder must never latch as a title somebody chose",
  );

  catalog.updateSession("session-app", {
    title: "Fix the checkout idempotency",
    titleIsCustom: false,
  });
  assert.equal(
    catalog.getConversation("conversation-app").title,
    "Fix the checkout idempotency",
    "the agent's title replaces the placeholder",
  );

  // A rename sticks: a later automatic title must not undo it.
  catalog.renameConversation("conversation-app", "The name I chose");
  catalog.updateSession("session-app", {
    title: "A different automatic title",
  });
  assert.equal(
    catalog.getConversation("conversation-app").title,
    "The name I chose",
    "a rename is never overwritten by an automatic title",
  );
  const registry = new ExternalAgentRegistry({ catalog });
  registry.register({ sessionId: "session-app", conversationId: "conversation-app",
    runId: "run-app", agent: "claude", title: "Old automatic title" });
  registry.update("session-app", { title: "New automatic title" });
  registry.register({ sessionId: "session-app", conversationId: "conversation-app",
    runId: "run-app", agent: "claude", title: "Stale launch title", titleIsCustom: true });
  assert.equal(catalog.getConversation("conversation-app").title, "The name I chose",
    "legacy registration and title updates cannot undo a rename");

  // A conversation with no title of its own keeps the placeholder.
  catalog.upsertSession({
    sessionId: "session-plain",
    conversationId: "conversation-plain",
    runId: "run-plain",
    agent: "codex",
    deviceId: "device-1",
    cwd: stateDir,
    runtime: "codex-app-server",
    status: "running",
  });
  assert.equal(catalog.getConversation("conversation-plain").title, "codex session");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("agent title source tests ok");
