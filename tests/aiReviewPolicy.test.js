import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  aiReviewPolicyFromEnvironment,
  encodeAiReviewPolicyEnvironment,
  normalizeAiReviewPolicySnapshot,
} from "../src/runtime/aiReviewPolicy.js";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function snapshot(overrides = {}) {
  const template = {
    protocol_version: "1",
    template_id: "ait_daily_tests",
    name: "Daily tests",
    instructions: "Allow tests and workspace checks. Ask before deployment.",
    allowed_scopes: ["read_tools", "workspace_commands"],
    applicability: {},
    ...overrides,
  };
  return {
    ...template,
    version: 4,
    content_hash: createHash("sha256")
      .update(JSON.stringify(canonical(template)))
      .digest("hex"),
  };
}

test("AI review policy validates its immutable content hash", () => {
  const value = snapshot();
  const normalized = normalizeAiReviewPolicySnapshot(value, { required: true });
  assert.equal(normalized.template_id, "ait_daily_tests");
  assert.equal(normalized.version, 4);
  assert.throws(
    () => normalizeAiReviewPolicySnapshot({ ...value, instructions: "changed" }),
    (error) => error.code === "AI_REVIEW_POLICY_INVALID",
  );
});

test("AI review policy survives the managed child environment envelope", () => {
  const value = snapshot();
  const encoded = encodeAiReviewPolicyEnvironment(value);
  const decoded = aiReviewPolicyFromEnvironment({
    ORIGINROUTER_AI_REVIEW_POLICY_B64: encoded,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), value);
});
