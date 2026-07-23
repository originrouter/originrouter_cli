import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalAuditStore } from "../src/persistence/localAuditStore.js";
import { LocalAgentBridgeClient } from "../src/local/localAgentBridgeClient.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-audit-"));
let clock = Date.parse("2026-07-20T00:00:00Z");
const store = new LocalAuditStore({ stateDir, now: () => clock++ });
const session = {
  sessionId: "audit-session-1",
  cwd: "/workspace/project",
  agent: "claude",
};

store.appendEvent(session, {
  type: "agent.interaction.requested",
  interactionId: "approval-1",
  kind: "permission",
  title: "Run database migration?",
  prompt: "Review the production schema change.",
  source: "app-server",
  payload: {
    tool: "Bash",
    command: "mysql -e \"ALTER TABLE users ADD COLUMN flag INT\"",
    cwd: "/workspace/project",
  },
});
store.appendEvent(session, {
  type: "agent.interaction.result",
  interactionId: "approval-1",
  status: "applied",
  action: "allow",
  decisionSource: "app_remote",
});

store.appendEvent(session, {
  type: "agent.tool_call.start",
  callId: "normal-edit",
  tool: "Edit",
  input: { file_path: "/workspace/project/lib/app.js" },
});
store.appendEvent(session, {
  type: "agent.tool_call.end",
  callId: "normal-edit",
  isError: false,
});

store.appendEvent(session, {
  type: "agent.tool_call.start",
  callId: "sql-change",
  tool: "Bash",
  input: {
    command: "mysql -e \"UPDATE users SET active=1\" --password=topsecret",
    cwd: "/workspace/project",
  },
});
store.appendEvent(session, {
  type: "agent.tool_call.end",
  callId: "sql-change",
  isError: false,
});

store.appendEvent(session, {
  type: "agent.tool_call.start",
  callId: "migration-script",
  tool: "Bash",
  input: {
    command: "python3 /private/tmp/migrate_accounts.py",
    cwd: "/workspace/project",
  },
});
store.appendEvent(session, {
  type: "agent.tool_call.end",
  callId: "migration-script",
  isError: true,
});

const approvals = store.list(session.sessionId, { category: "approval" });
assert.equal(approvals.records.length, 1);
assert.equal(approvals.records[0].title, "Run database migration?");
assert.equal(approvals.records[0].outcome, "allowed");
assert.equal(approvals.records[0].decisionSource, "app_remote");

store.appendEvent(session, {
  type: "agent.interaction.auto_resolved",
  interactionId: "ai-review-allow",
  kind: "permission",
  decision: "allow",
  decisionSource: "ai_reviewer",
  autonomyScope: "workspace_commands",
  reason: "Routine bounded command",
  aiReview: { confidence: 0.94, risk: "low" },
});
store.appendEvent(session, {
  type: "agent.interaction.auto_resolved",
  interactionId: "ai-review-deny",
  kind: "permission",
  decision: "deny",
  decisionSource: "ai_reviewer",
  autonomyScope: "network_mutations",
  reason: "Unrelated remote mutation",
  aiReview: { confidence: 0.91, risk: "high" },
});
const aiApprovals = store.list(session.sessionId, { category: "approval", limit: 20 }).records;
assert.equal(aiApprovals.find((item) => item.correlationId === "ai-review-allow").outcome, "allowed");
assert.equal(aiApprovals.find((item) => item.correlationId === "ai-review-deny").outcome, "denied");
assert.equal(aiApprovals.find((item) => item.correlationId === "ai-review-deny").decisionSource, "ai_reviewer");
assert.equal(approvals.records[0].risk, "high");

const changes = store.list(session.sessionId, { category: "change" });
assert.equal(changes.records.length, 2, "routine workspace edits must be excluded");
assert.deepEqual(
  new Set(changes.records.map((item) => item.actionKind)),
  new Set(["database_mutation", "potential_script_mutation"]),
);
assert.equal(changes.records.find((item) => item.actionKind === "database_mutation").outcome, "succeeded");
assert.equal(changes.records.find((item) => item.actionKind === "potential_script_mutation").outcome, "failed");
assert.ok(!JSON.stringify(changes.records).includes("topsecret"));

const firstPage = store.list(session.sessionId, { category: "change", limit: 1 });
assert.equal(firstPage.records.length, 1);
assert.equal(firstPage.hasMore, true);
const secondPage = store.list(session.sessionId, {
  category: "change",
  beforeCursor: firstPage.nextCursor,
  limit: 1,
});
assert.equal(secondPage.records.length, 1);
assert.notEqual(firstPage.records[0].correlationId, secondPage.records[0].correlationId);

const auditPath = store.filePath(session.sessionId);
const raw = readFileSync(auditPath, "utf8").trim().split("\n").map(JSON.parse);
assert.ok(raw.length >= 4);
for (let index = 1; index < raw.length; index += 1) {
  assert.equal(raw[index].previousHash, raw[index - 1].hash);
}
assert.equal(statSync(auditPath).mode & 0o777, 0o600);

const previousHome = process.env.ORIGINROUTER_HOME;
process.env.ORIGINROUTER_HOME = stateDir;
const offlineBridge = new LocalAgentBridgeClient({
  stateDir,
  sessionId: "offline-session",
});
assert.equal(
  await offlineBridge.start({
    agent: "codex",
    cwd: "/workspace/project",
  }),
  false,
);
await offlineBridge.sendEvent({
  type: "agent.tool_call.start",
  callId: "offline-migration",
  tool: "exec",
  input: { command: "python3 migrate_production.py" },
});
const offlinePage = new LocalAuditStore({ stateDir }).list("offline-session", {
  category: "change",
});
assert.equal(offlinePage.records.length, 1);
assert.equal(offlinePage.records[0].outcome, "started");
await offlineBridge.close();
if (previousHome == null) delete process.env.ORIGINROUTER_HOME;
else process.env.ORIGINROUTER_HOME = previousHome;

console.log("local audit store tests passed");
