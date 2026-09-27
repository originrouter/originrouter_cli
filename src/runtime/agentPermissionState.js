// The durable configuration belongs to the conversation. Runtime/session ids
// identify executions; old executions must not overwrite a newer revision.
export function permissionConfiguration({ profile, allowedScopes = [], approvalPolicy = null, aiReviewPolicy = null }) {
  return {
    profile,
    allowedScopes: profile === "custom" && !approvalPolicy ? [...allowedScopes] : [],
    policyBundle: profile === "custom" && approvalPolicy ? {
      id: approvalPolicy.policy.id,
      revision: approvalPolicy.revision,
      content: approvalPolicy.policy,
    } : null,
    aiReviewPolicy: profile === "ai_review" ? aiReviewPolicy : null,
  };
}

export function publicPermissionState(state) {
  if (!state || !state.profile) return null;
  return {
    profile: state.profile,
    revision: Number(state.revision) || 0,
    allowed_scopes: state.allowedScopes || [],
    policy_id: state.policyBundle?.id || null,
    policy_revision: state.policyBundle?.revision || null,
    ai_review_template_id: state.aiReviewPolicy?.template_id || null,
    ai_review_content_hash: state.aiReviewPolicy?.content_hash || null,
  };
}

// Full rules and AI review instructions stay on the device. The Server only
// persists this bounded display projection, which is also sent over E2EE.
export function publicAutonomyStatus(event) {
  if (event?.type !== "agent.autonomy.status") return null;
  return Object.fromEntries([
    "autonomyProfile", "autonomyRevision", "autonomyControl",
    "availableAutonomyProfiles", "allowedAutonomyScopes", "availableAutonomyScopes",
    "approvalPolicy", "approvalPolicyCapabilities", "aiReviewPolicy",
  ].filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]]));
}
