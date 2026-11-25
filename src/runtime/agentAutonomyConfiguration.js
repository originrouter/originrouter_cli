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

export function permissionStateForResume(catalog, conversationId) {
  const snapshot = catalog?.getConversationPermissionState(conversationId);
  if (snapshot) return snapshot;
  const profile = catalog?.getConversation(conversationId)?.permission_profile;
  if (["manual", "guarded", "unrestricted"].includes(profile)) return { profile };
  if (profile === "custom" || profile === "ai_review") {
    throw Object.assign(new Error("This older session has no saved permission configuration. Select a policy explicitly before resuming."),
      { code: "RESUME_PERMISSION_STATE_UNAVAILABLE" });
  }
  return null;
}

// A local resume (`--resume <id>` / `--conversation <id>`) does not travel
// through the supervisor, so ORIGINROUTER_PERMISSION_CONVERSATION_ID is never
// set for it. The conversation the id names is the same one the App resumes —
// the catalog can find it by its provider id and hand the run the permission
// configuration the conversation was left with. Without this the resumed run
// starts on the `manual` default and its startup capture overwrites the saved
// state, which is why a CLI resume used to downgrade every later resume too.
export function resumedPermissionConfiguration(agent, nativeSessionId, { stateDir } = {}) {
  const catalog = new AgentCatalog({ stateDir });
  let saved;
  try {
    const conversationId = catalog.conversationIdForNativeSession(agent, nativeSessionId);
    saved = conversationId ? permissionStateForResume(catalog, conversationId) : null;
  } finally { catalog.close(); }
  return saved ? resolvePersistedPermissionConfiguration(saved) : null;
}

// Resume uses the installed session snapshot, including immutable policy
// contents. Template edits after the session stopped do not change its policy.
export function inheritedPermissionConfiguration(env = process.env, { stateDir } = {}) {
  const conversationId = env.ORIGINROUTER_PERMISSION_CONVERSATION_ID;
  if (!conversationId) return null;
  const catalog = new AgentCatalog({ stateDir });
  let saved;
  try { saved = permissionStateForResume(catalog, conversationId); }
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
