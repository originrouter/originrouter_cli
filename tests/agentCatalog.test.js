import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCatalog } from "../src/persistence/agentCatalog.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-agent-catalog-"));
let clock = Date.parse("2026-07-22T00:00:00Z");
const now = () => new Date(clock++);
const catalog = new AgentCatalog({ stateDir, now });

const migration = catalog.migrateLegacySessions([
  {
    sessionId: "legacy-session-1",
    deviceId: "server-1",
    agent: "claude",
    cwd: "/srv/project-a",
    startedAt: "2026-07-20T01:00:00Z",
    exitedAt: "2026-07-20T01:30:00Z",
    status: "exited",
    runtime: "claude-pty",
    startedBy: "local-wrapper",
  },
]);
assert.deepEqual(migration, { migrated: 1, skipped: false });
assert.deepEqual(
  catalog.migrateLegacySessions([]),
  { migrated: 0, skipped: true },
  "legacy migration must be idempotent",
);

catalog.upsertSession({
  sessionId: "origin-session-1",
  conversationId: "conversation-1",
  runId: "run-1",
  agent: "codex",
  title: "Fix checkout idempotency",
  deviceId: "server-2",
  deviceName: "Build Server",
  cwd: stateDir,
  runtime: "codex-app-server",
  provider: "originrouter-cloud",
  model: "gpt-codex",
  permissionProfile: "guarded",
  startedBy: "app-remote",
  pid: 1234,
  startedAt: "2026-07-22T02:00:00Z",
});
catalog.updateSession("origin-session-1", {
  nativeSessionId: "thread-native-1",
  transcriptPath: join(stateDir, "codex-session.jsonl"),
});
catalog.recordEvent("origin-session-1", {
  type: "user.text",
  text: "Inspect the checkout callback and make it idempotent.",
  createdAt: "2026-07-22T02:00:01Z",
});
catalog.recordEvent("origin-session-1", {
  type: "agent.task.complete",
  summary: "Checkout callback fixed and tests passed.",
  createdAt: "2026-07-22T02:10:00Z",
});
catalog.recordEvent("origin-session-1", {
  type: "agent.tool_call.start",
  tool: "edit",
  input: { file_path: "lib/checkout.dart" },
  createdAt: "2026-07-22T02:05:00Z",
});
catalog.finishSession("origin-session-1", {
  status: "completed",
  exitedAt: "2026-07-22T02:11:00Z",
  exitCode: 0,
});

const search = catalog.listConversations({ search: "checkout" });
assert.equal(search.length, 1);
assert.equal(search[0].conversation_id, "conversation-1");
assert.equal(search[0].native_session_id, "thread-native-1");
assert.equal(search[0].runtime, "codex-app-server");
assert.equal(search[0].permission_profile, "guarded");
assert.equal(search[0].status, "completed");
assert.equal(search[0].transcript_available, true);
assert.equal(search[0].artifact_count, 1);

const detail = catalog.getConversation("conversation-1");
assert.equal(detail.runs.length, 1);
assert.equal(detail.artifacts.length, 1);
assert.equal(detail.artifacts[0].display_value, "lib/checkout.dart");
assert.equal(detail.first_prompt_preview, "Inspect the checkout callback and make it idempotent.");
assert.equal(detail.summary, "Checkout callback fixed and tests passed.");

const workspaces = catalog.listWorkspaces({ deviceId: "server-2" });
assert.equal(workspaces.length, 1);
assert.equal(workspaces[0].conversation_count, 1);
assert.equal(catalog.status().conversations, 2);
assert.equal(statSync(catalog.dbPath).mode & 0o777, 0o600);

catalog.upsertSession({
  sessionId: "collaboration-lead-session",
  conversationId: "collaboration-lead-conversation",
  runId: "shared-collaboration-run",
  agent: "codex",
  deviceId: "server-2",
  cwd: stateDir,
  workspaceTrusted: true,
});
catalog.upsertSession({
  sessionId: "collaboration-worker-session",
  conversationId: "collaboration-worker-conversation",
  runId: "shared-collaboration-run",
  agent: "claude",
  deviceId: "server-2",
  cwd: stateDir,
  workspaceTrusted: true,
});
catalog.upsertSession({
  sessionId: "collaboration-worker-session",
  conversationId: "collaboration-worker-conversation",
  runId: "shared-collaboration-run",
  agent: "claude",
  deviceId: "server-2",
  cwd: stateDir,
  workspaceTrusted: true,
  nativeSessionId: "claude-native-session",
});
const leadRun = catalog.getConversation("collaboration-lead-conversation").runs[0];
const workerDetail = catalog.getConversation("collaboration-worker-conversation");
assert.equal(leadRun.run_id, "shared-collaboration-run");
assert.equal(workerDetail.runs.length, 1);
assert.notEqual(workerDetail.runs[0].run_id, leadRun.run_id);
assert.match(workerDetail.runs[0].run_id, /^agent_run_/);
assert.equal(workerDetail.native_session_id, "claude-native-session");
catalog.close();

const reopened = new AgentCatalog({ stateDir, now });
assert.equal(reopened.getConversation("conversation-1").native_session_id, "thread-native-1");
assert.equal(reopened.listConversations({ search: "checkout.dart" }).length, 1);
reopened.close();

console.log("agent catalog tests ok");
