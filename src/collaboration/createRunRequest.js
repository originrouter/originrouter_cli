import {
  classifyWorkspaceRisk,
  normalizeCoordinator,
  normalizeWorkspaceMode,
  workspaceModeDefinition,
} from "./workspaceModes.js";

// Both the loopback API and encrypted device-control entry points must apply
// exactly the same target-CLI policy before a Run exists.  Keeping this here
// prevents a remote coordinator from accepting an Auto request that a local
// coordinator would reject or classify differently.
export function normalizeCollaborationCreateRequest(input = {}, {
  coordinatorDeviceId = "local",
} = {}) {
  const requestedMode = normalizeWorkspaceMode(input.workspace_mode || "auto");
  const suppliedResolvedMode = normalizeWorkspaceMode(
    input.resolved_workspace_mode || "auto",
  );
  const resolvedMode = requestedMode === "auto" ? suppliedResolvedMode : requestedMode;
  const planner = Array.isArray(input.participants)
    ? input.participants.find((participant) => participant?.planner === true)
      || input.participants[0]
    : null;
  const coordinatorRuntime = normalizeCoordinator(
    input.coordinator_runtime || planner?.runtime || "codex",
  );
  const riskTier = classifyWorkspaceRisk(input.objective, resolvedMode);
  if (resolvedMode === "remote_ops" && !input.participants?.some(
    (participant) => String(participant?.device_id || participant?.deviceId || "")
      !== String(coordinatorDeviceId),
  )) {
    const error = new Error(
      "Remote Ops requires a participant on a different trusted device.",
    );
    error.code = "COLLABORATION_REMOTE_PARTICIPANT_REQUIRED";
    throw error;
  }
  return {
    ...input,
    workspace_mode: requestedMode,
    resolved_workspace_mode: resolvedMode,
    coordinator_runtime: coordinatorRuntime,
    planning_source: String(input.planning_source || "").trim() || "manual",
    risk_tier: riskTier,
    workflow_template_id:
      input.workflow_template_id || workspaceModeDefinition(resolvedMode).templateId,
    coordinator_device_id: coordinatorDeviceId,
  };
}
