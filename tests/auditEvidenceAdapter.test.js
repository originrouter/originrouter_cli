import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAuditEvidenceBundle } from "../src/inquiry/auditEvidenceAdapter.js";
import { LocalAuditStore } from "../src/persistence/localAuditStore.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-inquiry-"));
let clock = Date.parse("2026-07-22T08:00:00Z");
const store = new LocalAuditStore({ stateDir, now: () => clock++ });
const session = { sessionId: "inquiry-session-1", cwd: "/workspace/app" };

store.appendEvent(session, {
  type: "agent.interaction.requested",
  interactionId: "approval-db-1",
  kind: "permission",
  title: "Approve production migration",
  prompt: "Review the requested database migration.",
  payload: { tool: "Bash", command: "mysql -e 'ALTER TABLE users ADD flag INT'" },
});
store.appendEvent(session, {
  type: "agent.interaction.result",
  interactionId: "approval-db-1",
  status: "applied",
  decisionSource: "app_remote",
});
store.appendEvent(session, {
  type: "agent.tool_call.start",
  callId: "db-change-1",
  tool: "Bash",
  input: {
    command: "mysql -e 'UPDATE users SET active=1' --password=topsecret",
    cwd: "/workspace/app",
  },
});
store.appendEvent(session, {
  type: "agent.tool_call.end",
  callId: "db-change-1",
  isError: false,
});

const approval = buildAuditEvidenceBundle({
  auditStore: store,
  sessionId: session.sessionId,
  request: {
    protocol_version: "1",
    query_id: "inq_approval0001",
    domain: "approval",
    query: "谁批准了数据库迁移？",
  },
  now: () => new Date("2026-07-22T09:00:00Z"),
});
assert.equal(approval.domain, "approval");
assert.equal(approval.evidence.length, 1);
assert.equal(approval.evidence[0].source_type, "approval_decision");
assert.equal(approval.evidence[0].locator.session_id, session.sessionId);
assert.equal(approval.evidence[0].metadata.decision_source, "app_remote");
assert.deepEqual(approval.policy, {
  citation_required: true,
  treat_as_untrusted_data: true,
  allow_actions: false,
  allow_cross_domain: false,
});

const change = buildAuditEvidenceBundle({
  auditStore: store,
  sessionId: session.sessionId,
  request: {
    protocol_version: "1",
    query_id: "inq_change000001",
    domain: "change",
    query: "数据库执行了哪些修改？",
    scope: { risks: ["high"], tools: ["bash"] },
    top_k: 5,
    token_budget: 1200,
  },
  now: () => new Date("2026-07-22T09:00:00Z"),
});
assert.equal(change.evidence.length, 1);
assert.equal(change.evidence[0].source_type, "database_change");
assert.ok(change.evidence[0].retrieval_signals.keyword > 0);
assert.ok(!JSON.stringify(change).includes("topsecret"));
assert.ok(change.evidence[0].evidence_id.startsWith("ev_"));
assert.ok(change.bundle_id.startsWith("evb_"));

const repeated = buildAuditEvidenceBundle({
  auditStore: store,
  sessionId: session.sessionId,
  request: {
    query_id: "inq_change000001",
    domain: "change",
    query: "数据库执行了哪些修改？",
  },
  now: () => new Date("2026-07-22T09:00:00Z"),
});
assert.equal(repeated.evidence[0].evidence_id, change.evidence[0].evidence_id);
assert.equal(repeated.evidence[0].content_hash, change.evidence[0].content_hash);

assert.throws(
  () => buildAuditEvidenceBundle({
    auditStore: store,
    sessionId: session.sessionId,
    request: {
      query_id: "inq_invaliddomain1",
      domain: "memory",
      query: "anything",
    },
  }),
  /invalid_inquiry_domain/,
);

console.log("audit evidence adapter tests passed");
