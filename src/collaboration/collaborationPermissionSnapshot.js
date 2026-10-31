import { createHash } from "node:crypto";

import { compileApprovalPolicy } from "../runtime/approvalPolicy.js";
import { normalizeAiReviewPolicySnapshot } from "../runtime/aiReviewPolicy.js";

function invalid(message) {
  return Object.assign(new Error(message), { code: "COLLABORATION_PERMISSION_SNAPSHOT_INVALID" });
}

// Never install the document in the device-wide policy library: a Run must
// keep the exact policy selected when it was created, even if a template is
// later edited. This object belongs in account-scoped local storage only.
export function normalizeCollaborationPermissionSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("A Session permission snapshot is required.");
  const profile = String(input.profile || "").trim();
  if (profile === "custom") {
    const bundle = input.policyBundle;
    if (!bundle || typeof bundle !== "object" || !bundle.content) throw invalid("A custom Session approval policy is required.");
    const compiled = compileApprovalPolicy(bundle.content);
    const claimedId = String(bundle.id || "").trim();
    const claimedRevision = String(bundle.revision || "").trim().replace(/^sha256:/, "");
    if (!claimedId || claimedId !== compiled.policy.id || !claimedRevision || claimedRevision !== compiled.revision) {
      throw invalid("The Session approval policy identity or revision does not match its contents.");
    }
    return { profile, policyBundle: { id: compiled.policy.id, revision: compiled.revision, content: compiled.policy }, aiReviewPolicy: null };
  }
  if (profile === "ai_review") {
    return { profile, policyBundle: null, aiReviewPolicy: normalizeAiReviewPolicySnapshot(input.aiReviewPolicy, { required: true }) };
  }
  throw invalid("This Session permission profile does not use a policy snapshot.");
}

export function collaborationPermissionSnapshotDigest(input) {
  return createHash("sha256").update(JSON.stringify(normalizeCollaborationPermissionSnapshot(input))).digest("hex");
}

export function resolveCollaborationPermissionSnapshot(input) {
  const snapshot = normalizeCollaborationPermissionSnapshot(input);
  return {
    profile: snapshot.profile,
    approvalPolicy: snapshot.policyBundle ? compileApprovalPolicy(snapshot.policyBundle.content) : null,
    aiReviewPolicy: snapshot.aiReviewPolicy,
  };
}
