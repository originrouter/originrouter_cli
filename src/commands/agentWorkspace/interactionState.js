import { workspaceModeDefinition } from "../../collaboration/workspaceModes.js";
import {
  attentionActionLabel,
  attentionRequestContext,
  permissionLabel,
} from "./attentionHelpers.js";
import { wrapDisplayText } from "./terminalText.js";

export function interactionResultSummary(runtime, kind, value) {
  if (value == null || value === "leave") return "";
  if (kind === "device" && Array.isArray(value)) {
    const selected = (runtime.setup?.devices || [])
      .filter((device) => value.includes(device.device_id))
      .map((device) => device.device_name || device.device_id);
    return selected.length
      ? `Remote device${selected.length === 1 ? "" : "s"} selected · ${selected.join(", ")}`
      : "Remote devices selected";
  }
  if (kind === "workspace") {
    if (value === "__custom_workspace_path__") return "";
    return `Workspace selected · ${value?.display_name || value?.canonical_path || "ready workspace"}`;
  }
  if (kind === "setup" && typeof value === "string") return `Folder selected · ${value}`;
  if (kind === "configuration" && value === "confirm") {
    const configuration = runtime.configuration || {};
    const resolved = configuration.resolved_workspace_mode
      || configuration.auto_configuration?.resolved_workspace_mode
      || configuration.workspace_mode
      || "auto";
    const participants = configuration.participants || [];
    return `Team confirmed · ${workspaceModeDefinition(resolved).label} · ${participants.length} Agent${participants.length === 1 ? "" : "s"}`;
  }
  if (kind === "plan" && value === "confirm") {
    const tasks = runtime.snapshot?.plan?.tasks || [];
    return `Plan approved${tasks.length ? ` · ${tasks.length} step${tasks.length === 1 ? "" : "s"}` : ""}`;
  }
  if (kind === "plan_revision" && value?.action === "revise") return "Plan changes requested";
  if (kind === "attention" && value?.action) {
    return `Agent request answered · ${attentionActionLabel(value.action, runtime.attention)}`;
  }
  if (kind === "attention_reply" && value?.response) return "Agent response submitted";
  if (kind === "paused" && value === "resume") return "Collaboration resumed";
  if (kind === "reconnect" && value === "reconnect") return "Live connection resumed";
  if (kind === "live_session_permission" && value?.profile) {
    return `Session approval changed · ${permissionLabel(value.profile, value.policyId)}`;
  }
  if (kind === "live_workspace_mode" && typeof value === "string") {
    return `Next collaboration mode · ${workspaceModeDefinition(value).label}`;
  }
  return "";
}

export function recordInteractionResult(runtime, kind, value) {
  const summary = interactionResultSummary(runtime, kind, value);
  if (!summary) return;
  runtime.interactionHistory = [
    ...(runtime.interactionHistory || []),
    { kind, summary, at: Date.now() },
  ].slice(-12);
}

// A Workspace interaction owns exactly one visual surface.  Keeping this
// classification separate from rendering and key handling prevents a new
// dialog from accidentally drawing its controls in the composer while its
// arrows still operate the document (or the reverse).
export const INTERACTION_SURFACES = Object.freeze({
  NORMAL: "normal",
  INLINE: "inline",
  FOCUSED: "focused",
});

const FOCUSED_INTERACTION_KINDS = new Set([
  "device",
  "workspace",
  "setup",
  "configuration",
  "configuration_question",
  "team_edit",
  "team_runtime",
  "team_route",
  "team_permission",
  "team_session_permission",
  "session_resume",
  "plan",
  "plan_revision",
  "completion",
]);

const INLINE_INTERACTION_KINDS = new Set([
  // These are short decisions. They preserve the conversation viewport and
  // replace only the composer dock, just like a permission prompt in Codex.
  "live_session_permission",
  "live_workspace_mode",
  "paused",
  "reconnect",
]);

export function workspaceInteractionSurface(runtime, columns = 80, rows = 24) {
  if (!runtime?.interaction) return INTERACTION_SURFACES.NORMAL;
  // An interaction must not jump between the composer dock and a focus page
  // merely because a resize changes its wrapping estimate.  The decision loop
  // locks this value until it resolves, then restores the saved document
  // viewport as one atomic transition.
  if (Object.values(INTERACTION_SURFACES).includes(runtime.interactionSurface)) {
    return runtime.interactionSurface;
  }
  if (FOCUSED_INTERACTION_KINDS.has(runtime.interactionKind)) {
    return INTERACTION_SURFACES.FOCUSED;
  }
  if (INLINE_INTERACTION_KINDS.has(runtime.interactionKind)) {
    return INTERACTION_SURFACES.INLINE;
  }
  if (!runtime.attention || !["attention", "attention_reply"].includes(runtime.interactionKind)) {
    return INTERACTION_SURFACES.INLINE;
  }
  const width = Math.max(20, Number(columns) - 8);
  const contextRows = attentionRequestContext(runtime.attention, runtime).reduce(
    (total, item) => total + Math.max(1, wrapDisplayText(`${item.label}: ${item.value}`, width).length),
    0,
  );
  const promptRows = contextRows + (runtime.attention.actions || []).length + 4;
  const request = runtime.attention.payload?.request || {};
  const hasLargeArtifact = String(request.file_changes_preview || "").length > 240
    || String(request.tool_input_preview || "").length > 320
    || String(request.command || "").length > Math.max(180, width * 2);
  return hasLargeArtifact || promptRows > Math.max(10, Math.floor(Number(rows || 24) * 0.45))
    ? INTERACTION_SURFACES.FOCUSED
    : INTERACTION_SURFACES.INLINE;
}
