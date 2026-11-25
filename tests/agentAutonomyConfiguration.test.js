import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveAgentAutonomyConfiguration, resumedPermissionConfiguration } from "../src/runtime/agentAutonomyConfiguration.js";
import { protectedApprovalPolicy } from "../src/runtime/approvalPolicy.js";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";

function aiSnapshot() {
  const template = { allowed_scopes: ["read_tools"], applicability: {}, instructions: "Allow reads.",
    name: "Audit", protocol_version: "1", template_id: "ait_audit_template" };
  return { ...template, version: 1, content_hash: createHash("sha256").update(JSON.stringify(template)).digest("hex") };
}
test("every mode replaces, rather than merges, the previous permission configuration", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-mode-test-"));
  const policy = { ...protectedApprovalPolicy(), id: "audit-policy" };
  const custom = resolveAgentAutonomyConfiguration({ profile: "custom", policyBundle: { content: policy } }, { stateDir });
  assert.equal(custom.approvalPolicy.policy.id, "audit-policy");
  const ai = resolveAgentAutonomyConfiguration({ profile: "ai_review", aiReviewPolicy: aiSnapshot() }, { stateDir, currentPolicy: custom.approvalPolicy });
  assert.equal(ai.approvalPolicy, null);
  assert.equal(ai.aiReviewPolicy.version, 1);
  const legacyCustom = resolveAgentAutonomyConfiguration({ profile: "custom", allowedScopes: ["read_tools"] }, { stateDir, currentPolicy: custom.approvalPolicy });
  assert.equal(legacyCustom.approvalPolicy, null);
  assert.deepEqual(legacyCustom.allowedScopes, ["read_tools"]);
  for (const profile of ["manual", "guarded", "unrestricted"]) {
    const next = resolveAgentAutonomyConfiguration({ profile }, { stateDir, currentPolicy: custom.approvalPolicy });
    assert.equal(next.approvalPolicy, null);
    assert.equal(next.aiReviewPolicy, null);
    assert.deepEqual(next.allowedScopes, []);
  }
});
test("invalid, missing and corrupted mode settings fail closed without a partial configuration", () => {
  for (const payload of [
    { profile: "not-a-mode" }, { profile: "ai_review" },
    { profile: "custom", allowedScopes: "read_tools" },
    { profile: "custom", allowedScopes: ["unknown-scope"] },
    { profile: "ai_review", aiReviewPolicy: { ...aiSnapshot(), version: true } },
    { profile: "ai_review", aiReviewPolicy: { ...aiSnapshot(), instructions: "tampered" } },
    { profile: "custom", policyId: "selected-policy", policyBundle: { content: { ...protectedApprovalPolicy(), id: "different-policy" } } },
  ]) assert.throws(() => resolveAgentAutonomyConfiguration(payload), { name: "Error" });
});
test("a named resume adopts the permission state its conversation was left with", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-resume-permission-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({
      sessionId: "agy-old", conversationId: "agy-old", agent: "agy", title: "agy session",
      nativeSessionId: "native-1", status: "completed", startedAt: "2026-01-01T00:00:00.000Z",
    });
    catalog.saveConversationPermissionState("agy-old", {
      profile: "unrestricted", allowedScopes: [], revision: 100, sessionId: "agy-old",
    });
    assert.equal(resumedPermissionConfiguration("agy", "native-1", { stateDir }).profile, "unrestricted");
    // A conversation the catalog does not know has no state to adopt.
    assert.equal(resumedPermissionConfiguration("agy", "native-missing", { stateDir }), null);
    // Stop before startup capture can overwrite a damaged saved policy.
    catalog.db.prepare("UPDATE agent_conversations SET permission_state_json = ? WHERE conversation_id = ?")
      .run(JSON.stringify({ profile: "not-a-mode", revision: 200, sessionId: "agy-old" }), "agy-old");
    assert.throws(() => resumedPermissionConfiguration("agy", "native-1", { stateDir }), { code: "RESUME_PERMISSION_STATE_INVALID" });
  } finally { catalog.close(); }
});

test('legacy resume restores self-contained profiles and refuses incomplete policy snapshots', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'originrouter-legacy-resume-'));
  const catalog = new AgentCatalog({ stateDir });
  try {
    for (const profile of ['manual', 'guarded', 'unrestricted', 'custom', 'ai_review']) {
      catalog.upsertSession({ agent: 'agy', sessionId: profile, nativeSessionId: profile, permissionProfile: profile });
      if (['custom', 'ai_review'].includes(profile)) {
        assert.throws(() => resumedPermissionConfiguration('agy', profile, { stateDir }), { code: 'RESUME_PERMISSION_STATE_UNAVAILABLE' });
      } else {
        assert.equal(resumedPermissionConfiguration('agy', profile, { stateDir }).profile, profile);
      }
    }
  } finally { catalog.close(); }
});
