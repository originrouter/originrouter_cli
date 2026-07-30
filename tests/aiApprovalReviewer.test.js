import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import { AiApprovalReviewer } from "../src/runtime/aiApprovalReviewer.js";

function credential() {
  const expiresAt = Date.now() + 10 * 60_000;
  const token = (name) => ({ token: `or_at_${name}`, expiresAt, scopes: ["approval.review"] });
  return {
    kind: "oauth",
    clientId: "originrouter_cli",
    source: "originrouter_cli",
    deviceId: "device-reviewer",
    sessionId: "or_ses_reviewer",
    refreshToken: "or_rt_reviewer",
    refreshExpiresAt: Date.now() + 24 * 60 * 60_000,
    tokenEndpoint: "https://surety.example/oauth/token",
    revocationEndpoint: "https://surety.example/oauth/revoke",
    accessTokens: {
      control: token("control"),
      ai: token("ai"),
      coding: token("coding"),
      relay: token("relay"),
    },
  };
}

function reviewRequest(overrides = {}) {
  return {
    request: {
      interactionId: "approval-123",
      kind: "permission",
      title: "Run tests",
      prompt: "Allow this command?",
      containsSecret: false,
      payload: { command: "npm test", cwd: "/tmp/project" },
      ...overrides,
    },
    classification: { scope: "workspace_commands", reason: "routine_workspace_command" },
    runtime: "codex-app-server",
    workspaceRoot: "/tmp/project",
  };
}

const policySnapshot = {
  protocol_version: "1",
  template_id: "ait_daily_tests",
  version: 2,
  name: "Daily tests",
  instructions: "Allow test commands.",
  allowed_scopes: ["workspace_commands"],
  applicability: {},
  content_hash: "a".repeat(64),
};

test("AI approval review uses the AI token and redacts secret-like payload fields", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-ai-reviewer-"));
  writeCodingAuth(stateDir, credential());
  let captured;
  const reviewer = new AiApprovalReviewer({
    stateDir,
    endpoint: "https://chat.example/ai-review",
    fetchFn: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        async json() {
          return { data: { review: { decision: "allow", risk: "low", confidence: 0.99 } } };
        },
      };
    },
  });

  const result = await reviewer.review({
    ...reviewRequest({
      payload: {
        command: "npm test",
        cwd: "/tmp/project",
        api_key: "must-not-leave-device",
        nested: { authorization: "Bearer secret" },
      },
    }),
    aiReviewPolicy: policySnapshot,
  });

  assert.equal(result.decision, "allow");
  assert.equal(captured.url, "https://chat.example/ai-review");
  assert.equal(captured.options.headers.Authorization, "Bearer or_at_ai");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.interaction.payload.api_key, "[redacted]");
  assert.equal(body.interaction.payload.nested.authorization, "[redacted]");
  assert.deepEqual(body.ai_review_policy, policySnapshot);
  assert.doesNotMatch(captured.options.body, /must-not-leave-device|Bearer secret/);
});

test("secret interactions escalate locally without calling the reviewer", async () => {
  let fetchCalls = 0;
  const reviewer = new AiApprovalReviewer({
    stateDir: mkdtempSync(join(tmpdir(), "originrouter-ai-reviewer-secret-")),
    fetchFn: async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
  });
  const result = await reviewer.review(reviewRequest({ containsSecret: true }));
  assert.deepEqual(result, {
    decision: "escalate",
    reason: "secret_input",
    risk: "high",
    confidence: 1,
  });
  assert.equal(fetchCalls, 0);
});

test("reviewer HTTP and protocol failures expose stable errors", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-ai-reviewer-errors-"));
  writeCodingAuth(stateDir, credential());
  const httpFailure = new AiApprovalReviewer({
    stateDir,
    fetchFn: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(
    () => httpFailure.review(reviewRequest()),
    (error) => error.code === "AI_APPROVAL_REVIEW_FAILED",
  );

  const invalidResponse = new AiApprovalReviewer({
    stateDir,
    fetchFn: async () => ({ ok: true, json: async () => ({ data: { review: { decision: "maybe" } } }) }),
  });
  await assert.rejects(
    () => invalidResponse.review(reviewRequest()),
    (error) => error.code === "AI_APPROVAL_INVALID_RESPONSE",
  );
});
