import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalAuditStore } from "../src/persistence/localAuditStore.js";
import { AiOperationReviewer } from "../src/runtime/aiOperationReviewer.js";
import { writeCodingAuth } from "../src/persistence/codingAuth.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const session = { sessionId: "ai-operation", cwd: "/workspace/app", agent: "claude" };

{
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-ai-audit-job-"));
  const expiresAt = Date.now() + 600_000;
  const token = (name) => ({ token: `or_at_${name}`, expiresAt, scopes: ["ai.invoke"] });
  writeCodingAuth(stateDir, {
    kind: "oauth", clientId: "originrouter_cli", source: "originrouter_cli",
    deviceId: "device-audit", sessionId: "or_ses_audit", refreshToken: "or_rt_audit",
    refreshExpiresAt: Date.now() + 86400000,
    tokenEndpoint: "https://surety.example/token", revocationEndpoint: "https://surety.example/revoke",
    accessTokens: { control: token("control"), ai: token("ai"), coding: token("coding"), relay: token("relay") },
  });
  let polls = 0;
  const reviewer = new AiOperationReviewer({
    stateDir,
    fetchFn: async (url) => {
      if (String(url).endsWith("/reviews")) return { ok: true, status: 202, json: async () => ({ data: { job_id: "aaj_1" } }) };
      polls += 1;
      return { ok: true, status: 200, json: async () => ({ data: polls === 1 ? { state: "processing" } : { state: "completed", review: { record: true, risk: "high" } } }) };
    },
  });
  const review = await reviewer.review({ session, event: { callId: "job-test" }, analysis: { risk: "elevated" } });
  assert.equal(review.record, true);
  assert.equal(polls, 2);
}

{
  const store = new LocalAuditStore({
    stateDir: mkdtempSync(join(tmpdir(), "originrouter-ai-audit-ignore-")),
    operationReviewer: { review: async () => ({ record: false, risk: "normal", confidence: 0.95 }) },
  });
  store.appendEvent(session, {
    type: "agent.tool_call.start", callId: "outside-read", tool: "Read",
    input: { file_path: "/Users/alice/Documents/public.txt" },
  });
  await flush();
  store.appendEvent(session, { type: "agent.tool_call.end", callId: "outside-read", isError: false });
  assert.equal(store.list(session.sessionId, { category: "change" }).records.length, 0);
}

{
  const store = new LocalAuditStore({
    stateDir: mkdtempSync(join(tmpdir(), "originrouter-ai-audit-record-")),
    operationReviewer: { review: async () => ({
      record: true, risk: "high", confidence: 0.9, action_kind: "sensitive_read",
      title: "Private document access", reason: "The path contains private user data", signals: ["private_data"],
    }) },
  });
  store.appendEvent(session, {
    type: "agent.tool_call.start", callId: "private-read", tool: "Read",
    input: { file_path: "/Users/alice/Documents/private.txt" },
  });
  await flush();
  store.appendEvent(session, { type: "agent.tool_call.end", callId: "private-read", isError: false });
  const records = store.list(session.sessionId, { category: "change" }).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "succeeded");
  assert.equal(records[0].decisionSource, "ai_audit_reviewer");
}

console.log("AI operation audit tests passed");
