import { AgentCatalog } from "../persistence/agentCatalog.js";
import { compileApprovalPolicy } from "./approvalPolicy.js";
import { normalizeAutonomyProfile, normalizeAutonomyScopes, invalidAutonomyScopes } from "./agentAutonomyPolicy.js";
import { resolveApprovalPolicySelection } from "./approvalPolicyStore.js";
import { aiReviewPolicyFromPayload } from "./aiReviewPolicy.js";

// Build the next configuration completely before committing any runtime
// field. Direct HTTP, E2EE, Claude PTY/SDK and Codex share this boundary.
export function resolveAgentAutonomyConfiguration(payload, { stateDir, currentPolicy = null } = {}) {
  const profile = normalizeAutonomyProfile(payload?.profile, "");
  if (!profile) throw Object.assign(new Error("Invalid permission handling mode"), { code: "AUTONOMY_PROFILE_INVALID" });
  const rawScopes = payload?.allowedScopes ?? payload?.allowed_scopes ?? [];
  if (!Array.isArray(rawScopes) || invalidAutonomyScopes(rawScopes).length) {
    throw Object.assign(new Error("Invalid permission handling scope"), { code: "AUTONOMY_SCOPE_INVALID" });
  }
  const approvalPolicy = profile === "custom"
    ? resolveApprovalPolicySelection(payload, {
      stateDir,
      current: Object.hasOwn(payload, "allowedScopes") || Object.hasOwn(payload, "allowed_scopes")
        ? null : currentPolicy,
    })
    : null;
  const aiReviewPolicy = profile === "ai_review"
    ? aiReviewPolicyFromPayload(payload, { required: true }) : null;
  return {
    profile, approvalPolicy, aiReviewPolicy,
    allowedScopes: profile === "custom" && !approvalPolicy ? normalizeAutonomyScopes(rawScopes) : [],
  };
}

// Resume uses the installed session snapshot, including immutable policy
// contents. Template edits after the session stopped do not change its policy.
export function inheritedPermissionConfiguration(env = process.env, { stateDir } = {}) {
  const conversationId = env.ORIGINROUTER_PERMISSION_CONVERSATION_ID;
  if (!conversationId) return null;
  const catalog = new AgentCatalog({ stateDir });
  let saved;
  try { saved = catalog.getConversationPermissionState(conversationId); }
  finally { catalog.close(); }
  if (!saved) throw Object.assign(new Error("Saved permission state is unavailable"), { code: "RESUME_PERMISSION_STATE_UNAVAILABLE" });
  return resolvePersistedPermissionConfiguration(saved);
}

export function resolvePersistedPermissionConfiguration(saved) {
  const profile = normalizeAutonomyProfile(saved.profile, "");
  if (!profile) throw Object.assign(new Error("Invalid saved permission state"), { code: "RESUME_PERMISSION_STATE_INVALID" });
  const scopes = saved.allowedScopes ?? [];
  if (!Array.isArray(scopes) || invalidAutonomyScopes(scopes).length) {
    throw Object.assign(new Error("Invalid saved permission scope"), { code: "RESUME_PERMISSION_STATE_INVALID" });
  }
  const compiled = saved.policyBundle ? compileApprovalPolicy(saved.policyBundle.content) : null;
  if (compiled && (compiled.revision !== saved.policyBundle.revision || compiled.policy.id !== saved.policyBundle.id)) {
    throw Object.assign(new Error("Saved permission policy revision mismatch"), { code: "RESUME_PERMISSION_STATE_INVALID" });
  }
  return {
    profile,
    allowedScopes: profile === "custom" && !compiled ? normalizeAutonomyScopes(scopes) : [],
    approvalPolicy: profile === "custom" ? compiled : null,
    aiReviewPolicy: profile === "ai_review"
      ? aiReviewPolicyFromPayload({ aiReviewPolicy: saved.aiReviewPolicy }, { required: true }) : null,
  };
}
