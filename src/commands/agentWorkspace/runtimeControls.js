import { workspaceModeDefinition } from "../../collaboration/workspaceModes.js";
import { fitDisplayText, padDisplayRight, promptDisplayWidth } from "./terminalText.js";
import { muted } from "./panels.js";
import { permissionLabel } from "./attentionHelpers.js";
import { runtimePhase } from "./runtimeRows.js";

function runtimeControls(runtime, columns) {
  // Keep the footer as an action legend only. Mode, Run state, and approval
  // live together in composerStatus(), so they are not repeated at both ends
  // of the composer dock.
  let text = runtime.notice || "↑/↓ history · Enter queues next objective";
  const selectedActivityId = runtime.activityParticipantIds?.[runtime.activitySelection || 0];
  const selectedActivityExpanded = selectedActivityId
    && (runtime.expandedActivityParticipants || []).includes(selectedActivityId);
  if (selectedActivityId && !runtime.interaction) {
    text = `↑/↓ history · Ctrl+O ${selectedActivityExpanded ? "collapses" : "expands"} Agent`;
  }
  if (runtime.autoFollow === false) {
    const unseen = Number(runtime.unseenActivityCount || 0);
    text = `${unseen ? `${unseen} new event${unseen === 1 ? "" : "s"} · ` : ""}↑/↓ history · PgDn latest · Ctrl+O details`;
  }
  if (runtime.queuedObjective) text = "next objective queued · ctrl+c interrupts · ← agents";
  if (runtime.phase === "needs_setup") text = runtime.setup?.workspaces?.length && runtime.setupMode !== "path"
    ? "↑/↓ selects · Enter confirms · P or typing enters another path · esc cancels"
    : runtime.setup?.workspaces?.length
      ? "Tab completes · Enter authorizes · Ctrl+U clears · Esc back"
      : "Tab completes · Enter authorizes · Ctrl+U clears · Esc cancels";
  if (runtime.phase === "needs_device") text = "↑/↓ moves · Space toggles · Enter confirms · A selects all · Esc cancels";
  if (runtime.phase === "awaiting_configuration") {
    if (runtime.interactionKind === "team_edit") {
      text = "Enter edits Runtime/model · P Agent limit · S Session approval · D reviews team";
    } else if (["team_runtime", "team_route", "team_permission", "team_session_permission"].includes(runtime.interactionKind)) {
      text = "↑/↓ selects · Enter continues · Esc goes back";
    } else {
      text = "↑/↓ selects an Agent · E edits selection · Enter uses this team · PgUp/PgDn reviews";
    }
  }
  if (runtime.phase === "reconnecting") text = "connection interrupted · retrying automatically · ctrl+c cancels";
  if (runtime.phase === "connection_paused") text = "Enter reconnects · D detaches · ctrl+c interrupts Run";
  if (runtime.snapshot?.run?.state === "awaiting_confirmation") text = "↑/↓ reviews · Enter starts · E requests changes · Esc leaves pending";
  if (["attention", "attention_reply"].includes(runtime.interactionKind)) {
    text = runtime.interactionKind === "attention_reply"
      ? "Enter submits · Ctrl+U clears · Esc returns to actions · Shift+Tab approval"
      : "↑/↓ selects · Enter confirms · Esc stays with Run · D detaches";
  }
  if (runtime.interactionKind === "paused") text = "Enter resumes · Esc leaves this Run paused";
  if (runtime.interactionKind === "reconnect") text = "Enter reconnect · D detach · Ctrl+C interrupt Run";
  if (runtime.snapshot?.run?.state === "completed") {
    text = "↑/↓ history · Enter continues with this team · /new starts fresh · /exit exits";
  } else if (["failed", "cancelled", "error"].includes(runtime.snapshot?.run?.state || runtime.phase)) {
    text = "reviewing the result";
  }
  if (runtime.interactionKind === "live_workspace_mode") {
    text = runtime.runId
      ? "↑/↓ selects · Enter saves for /new · Esc keeps current mode"
      : "↑/↓ selects · Enter applies · Esc keeps current mode";
  }
  if (runtime.interactionKind === "live_session_permission") {
    text = "↑/↓ selects · Enter applies · Esc keeps current approval";
  }
  if (runtime.interactionKind === "session_resume") {
    text = "↑/↓ selects · Enter restores · Esc returns to the Workspace prompt";
  }
  // Detached history browsing always gets the scroll affordances, including
  // after a Run has completed. Keep this contextual hint from being replaced
  // by the terminal-result copy above.
  if (runtime.autoFollow === false) {
    const unseen = Number(runtime.unseenActivityCount || 0);
    text = `${unseen ? `${unseen} new event${unseen === 1 ? "" : "s"} · ` : ""}↑/↓ history · PgDn latest · Ctrl+O details`;
  }
  if (runtime.notice) text = runtime.notice;
  return padDisplayRight(muted(`  ${text}`), columns);
}

function footerLine(columns, left, right = "") {
  const width = Math.max(1, Number(columns) || 1);
  const contentWidth = Math.max(1, width - 2);
  const leftText = String(left || "");
  const rightText = String(right || "");
  const gap = rightText ? 2 : 0;
  const availableRight = Math.max(0, contentWidth - promptDisplayWidth(leftText) - gap);
  const fittedRight = rightText ? fitDisplayText(rightText, availableRight) : "";
  const gapText = fittedRight ? " ".repeat(Math.max(1, contentWidth - promptDisplayWidth(leftText) - promptDisplayWidth(fittedRight))) : "";
  return `${muted(`  ${leftText}${gapText}${fittedRight}`)}`;
}

function idleFooter(columns, mode, sessionApproval, notice = "") {
  const profile = sessionApproval?.profile || "guarded";
  const policyId = sessionApproval?.policyId || "";
  return footerLine(
    columns,
    `${workspaceModeDefinition(mode).label} · ${permissionLabel(profile, policyId)} approval`,
    notice || "/mode · /help",
  );
}

function runtimeFooterLine(runtime, columns) {
  const profile = runtime?.sessionApprovalOverride?.profile
    || runtime?.snapshot?.run?.supervisor_permission_profile
    || runtime?.configuration?.supervisor_permission_profile
    || "guarded";
  const policyId = runtime?.sessionApprovalOverride?.policyId
    || runtime?.snapshot?.run?.supervisor_policy_id
    || runtime?.configuration?.supervisor_policy_id
    || "";
  const left = `${workspaceModeDefinition(runtime?.mode || "auto").label} · ${permissionLabel(profile, policyId)} approval`;
  let notice = runtime?.notice || "";
  if (/^Result preserved\b/i.test(notice)) notice = "Enter continue · /new fresh";
  if (/^Press Ctrl\+C again to exit$/i.test(notice)) notice = "Ctrl+C again to exit";
  if (notice) return footerLine(columns, left, notice);
  return footerLine(
    columns,
    left,
    runtimeControls(runtime, columns).replace(/\x1b\[[0-9;]*m/g, "").trim(),
  );
}

function runtimeStatusVisible(runtime) {
  if (!runtime) return false;
  // Notices are rendered in the Footer's transient right-hand slot. Keeping
  // them out of the status row prevents messages such as the Ctrl+C exit hint
  // from appearing twice.
  if (runtime.queuedObjective) return true;
  const state = String(runtime.snapshot?.run?.state || "").toLowerCase();
  const phase = String(runtime.phase || "").toLowerCase();
  if (["reconnecting", "connection_paused"].includes(phase)) return true;
  if (["running", "in_progress", "executing"].includes(state)
    || ["running", "executing"].includes(phase)) return true;
  // Configuration/planning screens already render their phase (with the
  // elapsed timer) in the document body. Repeating it above the composer
  // creates two identical "Choosing the Agent team" rows.
  if (runtime.interaction) return ["attention", "attention_reply", "paused", "reconnect"].includes(runtime.interactionKind);
  return false;
}

function runtimeControlsVisible(runtime) {
  if (!runtime) return false;
  return Boolean(
    runtime.autoFollow === false
      || runtime.notice
      || runtime.interaction
      || runtime.queuedObjective
      || ["reconnecting", "connection_paused"].includes(runtime.phase)
      || runtime.snapshot?.run?.state === "awaiting_confirmation"
      || ["attention", "attention_reply", "paused", "reconnect"].includes(runtime.interactionKind),
  );
}

export {
  footerLine,
  idleFooter,
  runtimeControls,
  runtimeControlsVisible,
  runtimeFooterLine,
  runtimeStatusVisible,
};
