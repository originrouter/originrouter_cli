import { MAX_COLLABORATION_RECONNECT_ATTEMPTS } from "../collaboration.js";
import { WORKSPACE_MODES, workspaceModeDefinition } from "../../collaboration/workspaceModes.js";
import { projectCollaborationActivity } from "../../collaboration/activityPresentation.js";
import { compactRunState, runLabel } from "./runSummary.js";
import { wrapDisplayText } from "./terminalText.js";
import {
  attentionActionLabel,
  attentionRequestContext,
  attentionRequestKind,
  participantRouteLabel,
  permissionLabel,
  runtimeDisplayName,
  sessionPermissionOptions,
  workspaceEditorDevice,
  workspacePermissionOptions,
  workspaceRouteOptions,
  workspaceRuntimeOptions,
} from "./attentionHelpers.js";
import { ANSI, accent, muted, strong, styled } from "./panels.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function elapsedText(startedAt = Date.now()) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(startedAt || Date.now())) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function reviewScrollDirection(text, key = {}, { arrows = false } = {}) {
  const sequence = String(key.sequence || text || "");
  if (key.name === "pageup" || sequence === "\x1b[5~" || (key.ctrl && key.name === "b")) return -1;
  if (key.name === "pagedown" || sequence === "\x1b[6~" || (key.ctrl && key.name === "f")) return 1;
  if (arrows && key.name === "up") return -1;
  if (arrows && key.name === "down") return 1;
  return 0;
}

function toggleSelectedActivity(runtime) {
  const participants = runtime.activityParticipantIds || [];
  const participantId = participants[Math.max(0, Math.min(
    participants.length - 1,
    Number(runtime.activitySelection) || 0,
  ))];
  if (!participantId) return false;
  const expanded = new Set(runtime.expandedActivityParticipants || []);
  if (expanded.has(participantId)) expanded.delete(participantId);
  else expanded.add(participantId);
  runtime.expandedActivityParticipants = [...expanded];
  runtime.notice = expanded.has(participantId)
    ? `${runtime.activityParticipantLabels?.[participantId] || participantId} details expanded`
    : `${runtime.activityParticipantLabels?.[participantId] || participantId} details collapsed`;
  return true;
}

function runtimePhase(runtime) {
  const snapshot = runtime.snapshot;
  const state = snapshot?.run?.state;
  const phase = snapshot?.run?.phase || runtime.phase;
  if (runtime.interactionKind === "live_session_permission") return "Choose Session approval";
  if (runtime.interactionKind === "live_workspace_mode") return "Choose collaboration mode";
  if (runtime.interactionKind === "session_resume") return "Choose a Workspace Session";
  if (runtime.phase === "needs_setup") {
    return runtime.setup?.workspaces?.length ? "Choose a workspace" : "Workspace authorization required";
  }
  if (runtime.phase === "needs_device") return "Choose remote devices";
  if (runtime.phase === "connection_paused") return "Connection paused";
  if (runtime.phase === "configuring") return "Choosing the Agent team";
  if (runtime.phase === "awaiting_configuration_input") return "Planner needs more context";
  if (runtime.phase === "awaiting_configuration") {
    if (runtime.interactionKind === "team_edit") return "Edit the collaboration team";
    if (runtime.interactionKind === "team_runtime") return "Choose an Agent Runtime";
    if (runtime.interactionKind === "team_route") return "Choose a model route";
    if (runtime.interactionKind === "team_permission") return "Choose an Agent access limit";
    if (runtime.interactionKind === "team_session_permission") return "Choose Session approval";
    return "Review the proposed team";
  }
  if (state === "awaiting_confirmation") return "Plan ready for review";
  if (state === "completed") return "Completed";
  if (state === "failed") return "Failed";
  if (state === "cancelled") return "Cancelled";
  if (state === "paused") return "Paused";
  if (state === "blocked") return "Needs attention";
  if (runtime.phase === "reconnecting") return "Reconnecting to the collaboration";
  if (["planning", "created", "designing", "researching", "decomposing"].includes(state) || runtime.phase === "planning") return "Planner is preparing the work";
  if (["running", "queued"].includes(state) || runtime.phase === "executing") {
    if (phase === "verification") return "Verifying the result";
    if (phase === "implementation") return "Agents are implementing";
    return "Agents are working";
  }
  if (runtime.phase === "interrupted") return "Interrupting the collaboration";
  if (runtime.phase === "error") return "Could not start the collaboration";
  return "Working";
}

function taskMarker(state) {
  if (state === "completed") return styled("✓", ANSI.cyan);
  if (["running", "active"].includes(state)) return accent("●");
  if (["failed", "cancelled", "blocked"].includes(state)) return "×";
  return muted("○");
}

function buildRuntimeRows(runtime, columns, maxRows, {
  focusedInteraction = false,
  prefixRows = [],
} = {}) {
  const width = Math.max(20, columns - 4);
  const lines = [];
  const push = (value = "", style = null) => {
    for (const row of wrapDisplayText(value, width)) {
      lines.push(style ? style(row) : row);
    }
  };
  const pushIndented = (value = "", indent = 2, style = null) => {
    const prefix = " ".repeat(indent);
    for (const row of wrapDisplayText(value, Math.max(1, width - indent))) {
      const indented = `${prefix}${row}`;
      lines.push(style ? style(indented) : indented);
    }
  };
  const configured = runtime.configuration;
  if (focusedInteraction) {
    push("");
    push(`● ${runtimePhase(runtime)}`, strong);
    push("");
  } else {
    push("");
    for (const [index, line] of wrapDisplayText(runtime.objective || "", width - 2).entries()) {
      push(`${index === 0 ? "› " : "  "}${line}`, index === 0 ? strong : null);
    }
    push("");
    const terminal = ["completed", "failed", "cancelled", "expired"].includes(runtime.snapshot?.run?.state);
    const spinner = terminal || ["needs_setup", "error"].includes(runtime.phase)
      ? (runtime.snapshot?.run?.state === "completed" ? "✓" : "!")
      : SPINNER_FRAMES[Number(runtime.animationFrame || 0) % SPINNER_FRAMES.length];
    push(`${spinner} ${runtimePhase(runtime)}${runtime.startedAt ? ` (${elapsedText(runtime.startedAt)})` : ""}`, strong);
    if (configured) {
      const resolved = configured.resolved_workspace_mode
        || configured.auto_configuration?.resolved_workspace_mode
        || configured.workspace_mode;
      const deviceCount = new Set((configured.participants || []).map((item) => item.device_id)).size;
      pushIndented(`${workspaceModeDefinition(resolved || "auto").label} · ${(configured.participants || []).length} Agent${configured.participants?.length === 1 ? "" : "s"} · ${deviceCount} device${deviceCount === 1 ? "" : "s"}`, 2, muted);
      if (["model", "server_model"].includes(configured.planning_source)) {
        pushIndented("Auto decision: OriginRouter planner", 2, muted);
      }
    }
    const workspaceSessionId = runtime.snapshot?.run?.workspace_session_id;
    if (workspaceSessionId) pushIndented(`Session ${workspaceSessionId}`, 2, muted);
    if (runtime.runId) pushIndented(`Run ${runtime.runId}`, 2, muted);
    if (runtime.sessionHistory?.length) {
      const previous = runtime.sessionHistory.at(-1);
      pushIndented(
        `Continued session · previous Run ${previous.runId || "completed"}: ${previous.summary || previous.objective}`,
        2,
        muted,
      );
      if (runtime.detailsExpanded && runtime.sessionHistory.length > 1) {
        for (const item of runtime.sessionHistory.slice(-5, -1)) {
          pushIndented(`Earlier · ${item.runId || "Run"} · ${item.summary || item.objective}`, 4, muted);
        }
      }
    }
    if (runtime.connectionAttempts > 0) {
      pushIndented(`Connection interrupted · retry ${runtime.connectionAttempts}/${MAX_COLLABORATION_RECONNECT_ATTEMPTS}`, 2, strong);
    }
    for (const result of (runtime.interactionHistory || []).slice(-4)) {
      pushIndented(`✓ ${result.summary}`, 2, muted);
    }
  }

  if (runtime.phase === "needs_device" && runtime.setup) {
    const devices = runtime.setup.devices || [];
    const selectedIds = new Set(runtime.deviceSelections || []);
    const selectedIndex = Math.max(0, Math.min(devices.length - 1, Number(runtime.deviceSelection) || 0));
    push("");
    push("Choose remote devices", strong);
    pushIndented("Select every computer this collaboration should inspect.", 2, muted);
    push("");
    const maxVisible = 7;
    const start = Math.max(0, Math.min(
      Math.max(0, devices.length - maxVisible),
      selectedIndex - Math.floor(maxVisible / 2),
    ));
    for (const [offset, device] of devices.slice(start, start + maxVisible).entries()) {
      const index = start + offset;
      const focused = index === selectedIndex ? "›" : " ";
      const checked = selectedIds.has(device.device_id) ? "[✓]" : "[ ]";
      const status = device.online ? "online" : "offline · cached capabilities";
      pushIndented(`${focused} ${checked} ${device.device_name || device.device_id}`, 2, strong);
      const readyCount = Number(device.ready_workspace_count ?? device.workspace_count) || 0;
      const registeredCount = Number(device.registered_workspace_count ?? readyCount) || 0;
      const actionRequiredCount = Number(device.workspace_action_required_count) || 0;
      const workspaceStatus = [
        `${readyCount} ready workspace${readyCount === 1 ? "" : "s"}`,
        registeredCount !== readyCount ? `${registeredCount} registered` : "",
        actionRequiredCount ? `${actionRequiredCount} need target authorization` : "",
      ].filter(Boolean).join(" · ");
      pushIndented(`${status} · ${(device.runtimes || []).map(runtimeDisplayName).join(" + ") || "no Agent Runtime"} · ${workspaceStatus}`, 6, muted);
    }
    if (start > 0 || start + maxVisible < devices.length) {
      pushIndented(`${selectedIndex + 1} of ${devices.length}`, 2, muted);
    }
    push("");
    pushIndented(`${selectedIds.size} selected`, 2, selectedIds.size ? strong : muted);
  } else if (runtime.phase === "needs_setup" && runtime.setup) {
    const workspaces = runtime.setup.workspaces || [];
    const deviceName = runtime.setup.device_name || runtime.setup.deviceName || "Remote device";
    push("");
    if (workspaces.length && runtime.setupMode !== "path") {
      push(`${deviceName} has multiple ready workspaces.`, strong);
      pushIndented("Choose a listed folder, or enter another folder path.", 2, muted);
      push("");
      const maxVisible = 6;
      const customIndex = workspaces.length;
      const selectedIndex = Math.max(0, Math.min(customIndex, Number(runtime.setupSelection) || 0));
      const start = Math.max(0, Math.min(
        Math.max(0, workspaces.length - maxVisible),
        selectedIndex - Math.floor(maxVisible / 2),
      ));
      const visible = workspaces.slice(start, start + maxVisible);
      if (start > 0) pushIndented("↑ more workspaces", 2, muted);
      for (const [offset, workspace] of visible.entries()) {
        const index = start + offset;
        const marker = index === selectedIndex ? "›" : " ";
        const displayName = workspace.display_name || workspace.canonical_path || `Workspace ${index + 1}`;
        const path = workspace.canonical_path || workspace.workspace_id || "path unavailable";
        pushIndented(`${marker} ${index + 1}. ${displayName}  ${path}`, 2);
      }
      if (start + visible.length < workspaces.length) pushIndented("↓ more workspaces", 2, muted);
      pushIndented(`${selectedIndex === customIndex ? "›" : " "} P. Other folder · enter a path not listed above`, 2);
    } else {
      push(runtime.setupMode === "path"
        ? `${deviceName} folder path`
        : `${deviceName} is online and trusted, but no workspace is ready for unattended use.`, strong);
      pushIndented(runtime.setup.remote
        ? "Request a normal folder here, or authorize a protected folder from the target device's management context."
        : "Authorize a folder before an Agent can work in this workspace.", 2, muted);
      if (runtime.setupMode === "path") {
        pushIndented(runtime.setupPath
          ? "The folder path is being edited below."
          : `Type the folder path below. Example: ${runtime.setup.default_path || "/path/to/workspace"}`, 2, muted);
        if (runtime.setupBrowseLoading) pushIndented("Searching folders…", 2, muted);
        const suggestions = runtime.setupSuggestions || [];
        if (suggestions.length) {
          push("");
          push("Matching folders", strong);
          for (const [index, suggestion] of suggestions.slice(0, 6).entries()) {
            const marker = index === runtime.setupSuggestionSelection ? "›" : " ";
            pushIndented(`${marker} ${suggestion.path || suggestion.name}`, 2);
          }
          pushIndented("Tab completes the selected folder.", 2, muted);
        } else if (runtime.setupBrowseError) {
          pushIndented(`Folder suggestions unavailable: ${runtime.setupBrowseError}`, 2, muted);
        }
      }
    }
  } else if (runtime.phase === "awaiting_configuration" && configured) {
    push("");
    const participants = configured.participants || [];
    if (runtime.interactionKind === "team_edit") {
      push("Edit collaboration team", strong);
      pushIndented("Choose an Agent to change its Runtime, model route, or access limit.", 2, muted);
      pushIndented("Session approval can only make an Agent's access limit stricter.", 2, muted);
      push("");
      const selected = Math.max(0, Math.min(participants.length - 1, Number(runtime.teamEditSelection) || 0));
      const start = Math.max(0, Math.min(Math.max(0, participants.length - 6), selected - 2));
      for (const [offset, participant] of participants.slice(start, start + 6).entries()) {
        const index = start + offset;
        const device = workspaceEditorDevice(configured, participant);
        pushIndented(`${index === selected ? "›" : " "} ${participant.display_name || participant.participant_id} · ${runtimeDisplayName(participant.runtime)}`, 2, strong);
        pushIndented(`${device?.device_name || participant.device_id} · ${participantRouteLabel(configured, participant)} · Agent limit: ${permissionLabel(participant.permission_profile || "manual")}`, 6, muted);
      }
      push("");
      pushIndented(`S. Session approval · ${permissionLabel(configured.supervisor_permission_profile || "guarded", configured.supervisor_policy_id)}`, 2, strong);
      pushIndented("P. Change access for the selected Agent", 2, strong);
      pushIndented("D. Done editing · return to team review", 2, strong);
    } else if (runtime.interactionKind === "team_runtime") {
      const participant = participants[runtime.teamEditSelection || 0];
      const options = workspaceRuntimeOptions(configured, participant);
      push(`${participant?.display_name || "Agent"} Runtime`, strong);
      pushIndented(`${workspaceEditorDevice(configured, participant)?.device_name || participant?.device_id || "Device"}`, 2, muted);
      push("");
      for (const [index, option] of options.entries()) {
        pushIndented(`${index === runtime.teamRuntimeSelection ? "›" : " "} ${runtimeDisplayName(option)}`, 2);
      }
    } else if (runtime.interactionKind === "team_route") {
      const participant = participants[runtime.teamEditSelection || 0];
      const draftRuntime = runtime.teamEditDraft?.runtime || participant?.runtime;
      const options = workspaceRouteOptions(configured, participant, draftRuntime);
      const selected = Math.max(0, Math.min(options.length - 1, Number(runtime.teamRouteSelection) || 0));
      const start = Math.max(0, Math.min(Math.max(0, options.length - 6), selected - 2));
      push(`${participant?.display_name || "Agent"} model route`, strong);
      pushIndented(`${runtimeDisplayName(draftRuntime)} · ${workspaceEditorDevice(configured, participant)?.device_name || participant?.device_id || "Device"}`, 2, muted);
      push("");
      for (const [offset, option] of options.slice(start, start + 6).entries()) {
        const index = start + offset;
        pushIndented(`${index === selected ? "›" : " "} ${option.label}`, 2);
      }
      if (start > 0 || start + 6 < options.length) pushIndented(`${selected + 1} of ${options.length}`, 2, muted);
    } else if (runtime.interactionKind === "team_permission") {
      const participant = participants[runtime.teamEditSelection || 0];
      const options = workspacePermissionOptions(configured, participant);
      push(`${participant?.display_name || "Agent"} access`, strong);
      pushIndented(`${workspaceEditorDevice(configured, participant)?.device_name || participant?.device_id || "Device"}`, 2, muted);
      push("");
      for (const [index, option] of options.entries()) {
        pushIndented(`${index === runtime.teamPermissionSelection ? "›" : " "} ${option.label}`, 2);
        if (index === runtime.teamPermissionSelection && option.description) {
          pushIndented(option.description, 6, muted);
        }
      }
    } else if (runtime.interactionKind === "team_session_permission") {
      const options = sessionPermissionOptions({ includePolicies: true });
      push("Session approval", strong);
      pushIndented("Applied after each Agent's own access limit.", 2, muted);
      push("");
      for (const [index, option] of options.entries()) {
        pushIndented(`${index === runtime.teamSessionPermissionSelection ? "›" : " "} ${option.label}`, 2);
        if (index === runtime.teamSessionPermissionSelection) pushIndented(option.description, 6, muted);
      }
    } else {
      push("Proposed collaboration team", strong);
      const advice = configured.auto_configuration?.advice;
      if (advice?.reason) pushIndented(advice.reason, 2, muted);
      const planningLabel = ["model", "server_model"].includes(configured.planning_source)
        ? "OriginRouter planner"
        : "manual configuration";
      pushIndented(`Risk ${configured.risk_tier || "green"} · ${planningLabel} · Session approval ${permissionLabel(configured.supervisor_permission_profile || "guarded", configured.supervisor_policy_id)}`, 2, muted);
      const selected = Math.max(0, Math.min(
        Math.max(0, participants.length - 1),
        Number(runtime.teamEditSelection) || 0,
      ));
      for (const [index, participant] of participants.entries()) {
        const device = workspaceEditorDevice(configured, participant);
        pushIndented(`${index === selected ? "›" : " "} ${participant.planner ? "●" : "○"} ${participant.display_name || participant.participant_id} · ${runtimeDisplayName(participant.runtime)}`, 2, index === selected ? strong : null);
        pushIndented(`${device?.device_name || participant.device_id} · ${participant.workspace_id || "workspace pending"} · Agent limit: ${permissionLabel(participant.permission_profile || "manual")}`, 4, muted);
        pushIndented(`Model: ${participantRouteLabel(configured, participant)}`, 4, muted);
        if (participant.role_hint) pushIndented(participant.role_hint, 4, muted);
      }
    }
  } else if (focusedInteraction && runtime.interactionKind === "live_workspace_mode") {
    const selected = Math.max(0, Math.min(
      WORKSPACE_MODES.length - 1,
      Number(runtime.workspaceModeSelection) || 0,
    ));
    push("");
    push("Collaboration mode", strong);
    pushIndented(runtime.runId
      ? "The active Run keeps its current team. The selected mode applies after /new."
      : "Choose how OriginRouter should form the Agent team for the next objective.", 2, muted);
    push("");
    for (const [index, option] of WORKSPACE_MODES.entries()) {
      pushIndented(`${index === selected ? "›" : " "} ${option.label}`, 2, index === selected ? strong : null);
      if (index === selected) pushIndented(option.description, 6, muted);
    }
  } else if (focusedInteraction && runtime.interactionKind === "live_session_permission") {
    const options = runtime.sessionPermissionOptions || sessionPermissionOptions({ includePolicies: true });
    push("");
    push("Session approval", strong);
    pushIndented("Applies immediately to permission requests from every Agent in this Workspace Session.", 2, muted);
    push("");
    for (const [index, option] of options.entries()) {
      pushIndented(`${index === runtime.teamSessionPermissionSelection ? "›" : " "} ${option.label}`, 2);
      if (index === runtime.teamSessionPermissionSelection) pushIndented(option.description, 6, muted);
    }
    push("");
    pushIndented("Rules templates are loaded from the OriginRouter approval policy library.", 2, muted);
  } else if (runtime.interactionKind === "session_resume") {
    const sessions = runtime.sessionResumeChoices || [];
    const selected = Math.max(0, Math.min(sessions.length - 1, Number(runtime.sessionResumeSelection) || 0));
    push("");
    push("Resume a Workspace Session", strong);
    pushIndented("Choose a recent session. Its latest Run and Team will be restored.", 2, muted);
    push("");
    if (!sessions.length) {
      pushIndented("No saved Workspace Sessions are available yet.", 2, muted);
    } else {
      const start = Math.max(0, Math.min(Math.max(0, sessions.length - 6), selected - 2));
      for (const [offset, choice] of sessions.slice(start, start + 6).entries()) {
        const index = start + offset;
        const run = choice.run || {};
        pushIndented(`${index === selected ? "›" : " "} ${runLabel(run)}`, 2, index === selected ? strong : null);
        pushIndented(`${choice.sessionId} · ${compactRunState(run)}`, 6, muted);
      }
      if (start > 0 || start + 6 < sessions.length) pushIndented(`${selected + 1} of ${sessions.length}`, 2, muted);
    }
  } else if (runtime.interactionKind === "paused" && focusedInteraction) {
    push("");
    push("This collaboration is paused.", strong);
    pushIndented(runtime.snapshot?.run?.pause_reason || "The OriginRouter service is preserving the Run state.", 2, muted);
    if (runtime.snapshot?.run?.account_budget_blocked) {
      pushIndented("The account or device budget must be changed before this Run can resume.", 2, muted);
    }
  } else if (runtime.interactionKind === "reconnect" && focusedInteraction) {
    push("");
    push("The live connection is paused.", strong);
    pushIndented("OriginRouter service still owns this Run; its task state and history are preserved.", 2, muted);
    if (runtime.runId) pushIndented(`Reconnects will continue following Run ${runtime.runId}.`, 2, muted);
    pushIndented("No new Run will be created.", 2, muted);
  } else if (runtime.error) {
    push("");
    pushIndented(String(runtime.error.message || runtime.error).split("\n")[0], 2, strong);
  }

  const plan = runtime.snapshot?.plan;
  if (runtime.snapshot?.run?.state === "awaiting_confirmation" && plan
    && (!focusedInteraction || ["plan", "plan_revision"].includes(runtime.interactionKind))) {
    push("");
    push(plan.title || "Proposed plan", strong);
    if (plan.summary) pushIndented(plan.summary, 2, muted);
    for (const [index, task] of (plan.tasks || []).entries()) {
      const dependencies = task.depends_on?.length ? ` · after ${task.depends_on.join(", ")}` : "";
      pushIndented(`${index + 1}. ${task.title || task.id} · ${task.participant_id || "unassigned"}${dependencies}`, 2);
      if (task.deliverable) pushIndented(task.deliverable, 4, muted);
    }
  }

  const tasks = (runtime.snapshot?.tasks || []).filter((task) => task.task_key !== "__planner__");
  if (!focusedInteraction && tasks.length) {
    push("");
    for (const task of tasks.slice(0, 6)) {
      const taskState = String(task.state || "queued").replaceAll("_", " ");
      pushIndented(`${taskMarker(task.state)} ${task.title || task.task_key}  ${muted(`${taskState} · ${task.participant_id || "unassigned"}`)}`, 2);
    }
  }

  const participantLabels = Object.fromEntries([
    ...(runtime.configuration?.participants || []),
    ...(runtime.snapshot?.participants || []),
  ].map((participant) => [
    participant.participant_id,
    participant.display_name || participant.participant_id,
  ]));
  const activityGroups = focusedInteraction ? [] : projectCollaborationActivity(runtime.events, {
    expanded: runtime.detailsExpanded === true,
    expandedParticipantIds: runtime.expandedActivityParticipants || [],
    participantLabels,
    maxGroups: runtime.detailsExpanded ? 8 : 4,
  });
  const activityParticipants = activityGroups
    .filter((group) => group.participantId)
    .map((group) => group.participantId);
  runtime.activityParticipantIds = activityParticipants;
  runtime.activityParticipantLabels = participantLabels;
  runtime.activitySelection = Math.max(0, Math.min(
    Math.max(0, activityParticipants.length - 1),
    Number(runtime.activitySelection) || 0,
  ));
  const selectedActivityParticipant = activityParticipants[runtime.activitySelection] || "";
  if (activityGroups.length) {
    push("");
    push("Activity", strong);
    for (const group of activityGroups) {
      const marker = group.marker === "active" ? "●"
        : group.marker === "error" ? "×"
        : group.marker === "warning" ? "!" : "•";
      const selected = group.participantId && group.participantId === selectedActivityParticipant;
      pushIndented(`${selected ? "›" : " "} ${marker} ${group.title}`, 2, selected || group.marker === "active" ? strong : null);
      if (group.summary) pushIndented(group.summary, 4, muted);
      for (const task of tasks.filter((item) => item.participant_id === group.participantId).slice(0, 3)) {
        const taskState = String(task.state || "queued").replaceAll("_", " ");
        pushIndented(`Task · ${task.title || task.task_key} · ${taskState}`, 4, task.state === "active" ? strong : muted);
      }
      for (const [index, detail] of (group.details || []).entries()) {
        const branch = index === group.details.length - 1 ? "└" : "├";
        pushIndented(`${branch} ${detail}`, 4, muted);
      }
    }
    if (activityParticipants.length) {
      const selectedGroup = activityGroups.find(
        (group) => group.participantId === selectedActivityParticipant,
      );
      const action = selectedGroup?.expanded ? "collapses" : "expands";
      pushIndented(`Ctrl+O ${action} ${selectedGroup?.title?.replace(/ (?:is working|worked)$/, "") || "Agent"}.`, 2, muted);
    }
  }

  if (focusedInteraction && ["attention", "attention_reply"].includes(runtime.interactionKind) && runtime.attention) {
    push("");
    const requestKind = attentionRequestKind(runtime.attention);
    const permission = runtime.attention.kind === "approval";
    const heading = requestKind === "confirm" ? "Continue execution"
      : requestKind === "questions" ? "Agent questions"
        : requestKind === "form" ? "Agent form"
          : requestKind === "url" ? "External authorization"
            : permission ? "Permission decision" : "Agent question";
    push(heading, strong);
    pushIndented(runtime.attention.title || (permission ? "Agent permission required" : "Agent needs your input"), 2, strong);
    for (const item of attentionRequestContext(runtime.attention, runtime)) {
      pushIndented(`${item.label}: ${item.value}`, 2, item.code ? strong : muted);
    }
    if (runtime.attention.risk) pushIndented(`Risk: ${runtime.attention.risk}`, 2, muted);
    push("");
    for (const [index, action] of (runtime.attention.actions || []).entries()) {
      pushIndented(`${index === runtime.attentionSelection ? "›" : " "} ${index + 1}. ${attentionActionLabel(action, runtime.attention)}`, 2, index === runtime.attentionSelection ? strong : null);
    }
  }

  const report = runtime.snapshot?.final_report;
  if (report?.summary && (!focusedInteraction || runtime.interactionKind === "completion")) {
    push("");
    const completedTasks = (report.completed_tasks || []).filter((task) => task.result);
    const completed = runtime.snapshot?.run?.state === "completed";
    // The count is transport metadata; the Agent's delivered result is the
    // user's primary outcome.  Keeping that outcome in the normal top-level
    // hierarchy prevents it from looking like an activity log footnote.
    if (completedTasks.length) {
      push("Final result", strong);
      for (const task of completedTasks.slice(0, 3)) {
        if (completedTasks.length > 1 && task.title) pushIndented(`✓ ${task.title}`, 2, strong);
        for (const row of wrapDisplayText(task.result, Math.max(1, width - 2))) {
          pushIndented(row, 2, null);
        }
      }
      pushIndented(report.summary, 2, muted);
    } else {
      push("Final result", strong);
      pushIndented(report.summary, 2, completed ? strong : null);
      const failureDetails = (report.failed_or_skipped_tasks || [])
        .map((task) => String(task.result || "").trim())
        .filter(Boolean);
      for (const detail of [...new Set(failureDetails)].slice(0, 2)) {
        for (const row of wrapDisplayText(detail, Math.max(1, width - 2))) {
          pushIndented(row, 2, strong);
        }
      }
    }
  }
  // The title card belongs to the document, rather than to the permanent
  // chrome. This lets a new Run open at its natural first screen, while the
  // composer and its status remain anchored at the bottom of the terminal.
  // A phase update can arrive from both the planner snapshot and the event
  // stream. Collapse adjacent identical presentation rows so one transition
  // cannot occupy two lines or push the composer/footer out of the viewport.
  const documentRows = [];
  for (const row of [...prefixRows, ...lines]) {
    if (documentRows.at(-1) === row) continue;
    documentRows.push(row);
  }
  runtime.contentLineCount = documentRows.length;
  const visibleRows = Math.max(0, maxRows);
  runtime.contentVisibleRows = visibleRows;
  const maxStart = Math.max(0, documentRows.length - visibleRows);
  const start = runtime.autoFollow === false
    ? Math.max(0, Math.min(maxStart, Number(runtime.scrollOffset) || 0))
    : maxStart;
  runtime.scrollOffset = start;
  return documentRows.slice(start, start + visibleRows);
}

export {
  buildRuntimeRows,
  elapsedText,
  reviewScrollDirection,
  runtimePhase,
  toggleSelectedActivity,
};
