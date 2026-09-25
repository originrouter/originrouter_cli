// Shared by runtime registration and durable history. Keep this module free
// of persistence dependencies so both boundaries use the same classification.
export function isCollaborationSessionPayload(payload = {}) {
  const sessionId = String(payload.sessionId || payload.session_id || "");
  const runId = String(payload.runId || payload.run_id || "");
  const startedBy = String(payload.startedBy || payload.started_by || "");
  return (payload.sessionKind || payload.session_kind) === "collaboration"
    || runId.startsWith("acr_")
    || sessionId.startsWith("collab-")
    || startedBy === "collaboration-runtime"
    || startedBy === "collaboration-remote";
}
