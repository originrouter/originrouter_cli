import { cwd, stdin as defaultInput, stdout as defaultOutput } from "node:process";
import {
  clearScreenDown,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";

import {
  browseCollaborationWorkspaces,
  controlCollaborationRun,
  followExistingAgentWorkspaceCollaboration,
  handleCollaborationCommand,
  MAX_COLLABORATION_RECONNECT_ATTEMPTS,
  retryAgentWorkspaceCollaboration,
  runAgentWorkspaceCollaboration,
  trustCollaborationWorkspace,
} from "./collaboration.js";
import {
  WORKSPACE_MODES,
  nextWorkspaceMode,
  normalizeCoordinator,
  normalizeWorkspaceMode,
  workspaceModeDefinition,
  workspaceModeSummary,
} from "../collaboration/workspaceModes.js";
import { projectCollaborationActivity } from "../collaboration/activityPresentation.js";

const FORWARDED_FLAGS = new Set([
  "--detach",
  "--json",
  "--no-wait",
  "--plain",
  "--raw",
  "--review",
  "--verbose",
  "--yes",
  "--cloud-advice",
]);

function optionValue(argv, index, option) {
  const item = String(argv[index]);
  if (item.startsWith(`${option}=`)) return { value: item.slice(option.length + 1), consumed: 1 };
  if (index + 1 >= argv.length) throw new Error(`${option} requires a value.`);
  return { value: String(argv[index + 1]), consumed: 2 };
}

export function parseAgentWorkspaceArgs(argv = []) {
  const objective = [];
  const forwarded = [];
  let coordinator = "codex";
  let mode = "auto";
  for (let index = 0; index < argv.length;) {
    const item = String(argv[index]);
    if (item === "-c" || item === "--coordinator" || item.startsWith("--coordinator=")) {
      const parsed = item === "-c"
        ? optionValue(argv, index, "-c")
        : optionValue(argv, index, "--coordinator");
      coordinator = normalizeCoordinator(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (item === "-m" || item === "--mode" || item === "--team" || item.startsWith("--mode=") || item.startsWith("--team=")) {
      const option = item === "-m" ? "-m" : item.startsWith("--team") ? "--team" : "--mode";
      const parsed = optionValue(argv, index, option);
      mode = normalizeWorkspaceMode(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (item === "--timeout" || item.startsWith("--timeout=")) {
      const parsed = optionValue(argv, index, "--timeout");
      forwarded.push("--timeout", parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (FORWARDED_FLAGS.has(item)) {
      forwarded.push(item);
      index += 1;
      continue;
    }
    if (item.startsWith("-")) throw new Error(`Unknown Agent Workspace option '${item}'.`);
    objective.push(item);
    index += 1;
  }
  return {
    coordinator,
    mode,
    objective: objective.join(" ").trim(),
    forwarded,
  };
}

function workspaceDirectoryName() {
  return cwd().split(/[\\/]/).filter(Boolean).at(-1) || cwd();
}

function coordinatorLabel(coordinator) {
  return coordinator === "codex" ? "Codex" : "Claude Code";
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  gray: "\x1b[38;5;245m",
  softGray: "\x1b[38;5;250m",
  bgSoft: "\x1b[48;5;255m",
};

const workspaceScreenCache = new WeakMap();
const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const PASTE_TOKEN_CODE_POINT_START = 0xF0000;
const TERMINAL_WORKSPACE_RUN_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

// Coalesce background state changes into one terminal frame. Input-driven
// changes can still request an immediate frame when the cursor must feel
// synchronous, while event streams and timers share this short frame window.
export function createWorkspaceFrameScheduler({
  render,
  schedule = setTimeout,
  cancel = clearTimeout,
  frameDelayMs = 16,
} = {}) {
  if (typeof render !== "function") throw new TypeError("workspace frame renderer requires render");
  let pending = null;
  let disposed = false;
  const request = (force = false) => {
    if (disposed) return;
    if (force) {
      if (pending !== null) {
        cancel(pending);
        pending = null;
      }
      render(true);
      return;
    }
    if (pending !== null) return;
    pending = schedule(() => {
      pending = null;
      if (!disposed) render(false);
    }, Math.max(0, frameDelayMs));
  };
  return {
    request,
    flush() {
      request(true);
    },
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}

function colorEnabled() {
  return process.env.ORIGINROUTER_NO_COLOR == null && process.env.TERM !== "dumb";
}

function styled(value, ...codes) {
  if (!colorEnabled() || codes.length === 0) return value;
  return `${codes.join("")}${value}${ANSI.reset}`;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function border(value) {
  return styled(value, ANSI.gray);
}

function muted(value) {
  return styled(value, ANSI.softGray);
}

function strong(value) {
  return styled(value, ANSI.bold);
}

function accent(value) {
  return styled(value, ANSI.cyan);
}

function defaultWorkspacePanel() {
  return {
    title: "Ready for an objective",
    lines: [
      "Describe the outcome you want.",
      "Chooses the Agent team.",
      "Shift+Tab changes mode.",
      "/help shows commands.",
    ],
  };
}

function helpWorkspacePanel() {
  return {
    title: "Commands",
    lines: [
      "/mode [name] changes mode",
      "/coordinator codex|claude",
      "/team shows current team",
      "/exit leaves OriginRouter",
      "Shift+Tab cycles modes",
    ],
  };
}

function modesWorkspacePanel() {
  return {
    title: "Collaboration Modes",
    lines: WORKSPACE_MODES.map((mode) => `${mode.label} - ${mode.description}`),
  };
}

function teamWorkspacePanel({ coordinator, mode }) {
  return {
    title: "Current Team",
    lines: [
      workspaceModeSummary(mode),
      `Coordinator: ${coordinatorLabel(coordinator)}`,
      "Access: Guarded",
    ],
  };
}

function fitDisplayText(value, width) {
  const text = stripAnsi(value ?? "");
  if (width <= 0) return "";
  if (promptDisplayWidth(text) <= width) return text;
  if (width === 1) return "…";
  let out = "";
  for (const char of text) {
    if (promptDisplayWidth(`${out}${char}…`) > width) break;
    out += char;
  }
  return `${out}…`;
}

function padDisplayRight(value, width) {
  const raw = String(value ?? "");
  const visibleWidth = promptDisplayWidth(raw);
  if (visibleWidth > width) {
    const text = fitDisplayText(raw, width);
    return `${text}${" ".repeat(Math.max(0, width - promptDisplayWidth(text)))}`;
  }
  return `${raw}${" ".repeat(Math.max(0, width - visibleWidth))}`;
}

function centerDisplayText(value, width) {
  const text = fitDisplayText(value, width);
  const padding = Math.max(0, width - promptDisplayWidth(text));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
}

function appLine(value, contentWidth) {
  return `${border("│")} ${padDisplayRight(value, contentWidth)} ${border("│")}`;
}

function titleLine(title, frameWidth) {
  const visibleTitle = ` ${title} `;
  const remaining = Math.max(1, frameWidth - promptDisplayWidth(visibleTitle) - 2);
  return `${border("╭─")}${strong(visibleTitle)}${border("─".repeat(remaining))}${border("╮")}`;
}

function bottomLine(frameWidth) {
  return `${border("╰")}${border("─".repeat(frameWidth - 2))}${border("╯")}`;
}

function metricRow(label, value, width) {
  const labelWidth = 9;
  const visible = `${padDisplayRight(label, labelWidth)} ${value}`;
  return padDisplayRight(visible, width);
}

function panelRow(value, width, { heading = false } = {}) {
  const text = padDisplayRight(value, width);
  if (heading) return strong(text);
  if (String(value).startsWith("/")) return accent(text);
  return muted(text);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function wrapDisplayText(value, width) {
  const limit = Math.max(1, width);
  const lines = [];
  let line = "";
  for (const char of stripAnsi(String(value ?? ""))) {
    if (char === "\n") {
      lines.push(line);
      line = "";
      continue;
    }
    if (promptDisplayWidth(`${line}${char}`) > limit) {
      lines.push(line);
      line = char;
    } else {
      line += char;
    }
  }
  lines.push(line);
  return lines;
}

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
  if (/^\x1b\[<64;\d+;\d+[mM]$/.test(sequence)) return -1;
  if (/^\x1b\[<65;\d+;\d+[mM]$/.test(sequence)) return 1;
  return 0;
}

export function scrollRuntimeContent(runtime, direction, pageSize = 6) {
  if (!direction) return false;
  const maxOffset = Math.max(
    0,
    Number(runtime.contentLineCount || 0) - Number(runtime.contentVisibleRows || 0),
  );
  const current = runtime.autoFollow === false
    ? Number(runtime.scrollOffset || 0)
    : maxOffset;
  const nextOffset = Math.max(0, Math.min(
    maxOffset,
    current + direction * pageSize,
  ));
  if (nextOffset === current && runtime.autoFollow === (nextOffset >= maxOffset)) return false;
  runtime.scrollOffset = nextOffset;
  runtime.autoFollow = nextOffset >= maxOffset;
  if (runtime.autoFollow) runtime.unseenActivityCount = 0;
  return true;
}

function workspaceEditorDevice(configuration, participant) {
  return configuration?._workspace_editor?.devices?.find(
    (device) => device.device_id === participant?.device_id,
  ) || null;
}

function workspaceRuntimeOptions(configuration, participant) {
  return (workspaceEditorDevice(configuration, participant)?.runtimes || [])
    .map((runtime) => runtime.id)
    .filter((runtime) => ["codex", "claude"].includes(runtime));
}

function workspaceRouteOptions(configuration, participant, selectedRuntime = participant?.runtime) {
  const device = workspaceEditorDevice(configuration, participant);
  if (!device) return [{ provider: null, model: null, label: "Use device default route" }];
  const configured = device.resolved_routes?.[selectedRuntime] || null;
  const options = [{
    provider: null,
    model: null,
    label: configured
      ? `Device default · ${configured.provider}/${configured.model}`
      : "Device native/default configuration",
  }];
  for (const provider of device.providers || []) {
    for (const model of provider.models || []) {
      if (!provider.name || !model.id) continue;
      options.push({
        provider: provider.name,
        model: model.id,
        label: `${provider.name}/${model.id}`,
      });
    }
  }
  return options;
}

function workspacePermissionOptions(configuration, participant) {
  const supported = new Set(["manual", "guarded", "ai_review", "unrestricted", "custom"]);
  const current = String(participant?.permission_profile || "guarded");
  supported.add(current);
  const profiles = workspaceEditorDevice(configuration, participant)?.permission_profiles || [];
  const options = profiles.filter((profile) => supported.has(profile.id)).map((profile) => (
    profile.id === "custom"
      ? { ...profile, label: "Rules", description: "Use the built-in protected rule policy.", policyId: "protected" }
      : profile
  ));
  if (options.length) return options;
  return [
    { id: "manual", label: "Manual", description: "Ask before every blocking action." },
    { id: "guarded", label: "Guarded", description: "Allow routine work; ask for elevated or uncertain actions." },
    { id: "unrestricted", label: "Full", description: "Allow permission prompts for this managed Agent." },
    { id: "ai_review", label: "AI Review", description: "Use an independent reviewer; uncertain or high-risk actions still ask." },
    { id: "custom", label: "Rules", description: "Use the built-in protected rule policy.", policyId: "protected" },
  ];
}

function sessionPermissionOptions() {
  return [
    { id: "manual", label: "Manual", description: "Ask before every child Agent permission." },
    { id: "guarded", label: "Guarded", description: "Approve routine work and ask for elevated or uncertain actions." },
    { id: "ai_review", label: "AI Review", description: "Use an independent reviewer and escalate high-risk or uncertain actions." },
    { id: "custom", label: "Rules", description: "Use the built-in protected rule policy.", policyId: "protected" },
    { id: "unrestricted", label: "Full", description: "Add no restriction beyond each Agent's own access limit." },
  ];
}

function permissionLabel(value) {
  return sessionPermissionOptions().find((option) => option.id === value)?.label || "Guarded";
}

function participantRouteLabel(configuration, participant) {
  if (participant?.provider && participant?.model) return `${participant.provider}/${participant.model}`;
  return workspaceRouteOptions(configuration, participant, participant?.runtime)[0]?.label || "Device default route";
}

function runtimeDisplayName(runtime) {
  return runtime === "claude" ? "Claude Code" : "Codex";
}

function attentionActionLabel(action) {
  return {
    allow: "Allow once",
    deny: "Deny",
    submit: "Reply",
    cancel: "Cancel",
    rebuild: "Rebuild this Agent",
  }[action] || String(action || "").replaceAll("_", " ");
}

function runtimePhase(runtime) {
  const snapshot = runtime.snapshot;
  const state = snapshot?.run?.state;
  const phase = snapshot?.run?.phase || runtime.phase;
  if (runtime.phase === "needs_setup") {
    return runtime.setup?.workspaces?.length ? "Choose a workspace" : "Workspace authorization required";
  }
  if (runtime.phase === "needs_device") return "Choose remote devices";
  if (runtime.phase === "connection_paused") return "Connection paused";
  if (runtime.phase === "configuring") return "Choosing the Agent team";
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

function buildRuntimeRows(runtime, columns, maxRows) {
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
  push("");
  for (const [index, line] of wrapDisplayText(runtime.objective || "", width - 2).entries()) {
    push(`${index === 0 ? "› " : "  "}${line}`, index === 0 ? strong : null);
  }
  push("");
  const terminal = ["completed", "failed", "cancelled", "expired"].includes(runtime.snapshot?.run?.state);
  const waitingForUser = runtime.interaction === true;
  const spinner = waitingForUser
    ? "●"
    : terminal || ["needs_setup", "error"].includes(runtime.phase)
    ? (runtime.snapshot?.run?.state === "completed" ? "✓" : "!")
    : SPINNER_FRAMES[Number(runtime.animationFrame || 0) % SPINNER_FRAMES.length];
  push(`${spinner} ${runtimePhase(runtime)}${runtime.startedAt && !waitingForUser ? ` (${elapsedText(runtime.startedAt)})` : ""}`, strong);

  const configured = runtime.configuration;
  if (configured) {
    const resolved = configured.resolved_workspace_mode
      || configured.auto_configuration?.resolved_workspace_mode
      || configured.workspace_mode;
    const deviceCount = new Set((configured.participants || []).map((item) => item.device_id)).size;
    pushIndented(`${workspaceModeDefinition(resolved || "auto").label} · ${(configured.participants || []).length} Agent${configured.participants?.length === 1 ? "" : "s"} · ${deviceCount} device${deviceCount === 1 ? "" : "s"}`, 2, muted);
    if (configured.planning_source === "cloud_advice") pushIndented("Auto decision: advisory model", 2, muted);
    if (configured.planning_source === "local_fallback") pushIndented("Auto decision: local fallback", 2, muted);
  }
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
      pushIndented(`${status} · ${(device.runtimes || []).map(runtimeDisplayName).join(" + ") || "no Agent Runtime"} · ${device.workspace_count || 0} authorized workspace${device.workspace_count === 1 ? "" : "s"}`, 6, muted);
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
      push(`${deviceName} has multiple authorized workspaces.`, strong);
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
        : `${deviceName} is online and trusted, but no workspace is authorized.`, strong);
      pushIndented(runtime.setup.remote
        ? "Authorize a folder before a remote Agent can inspect this device."
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
      pushIndented(`S. Session approval · ${permissionLabel(configured.supervisor_permission_profile || "guarded")}`, 2, strong);
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
      const options = sessionPermissionOptions();
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
      pushIndented(`Risk ${configured.risk_tier || "green"} · ${configured.planning_source === "cloud_advice" ? "advisory model" : "local policy"} · Session approval ${permissionLabel(configured.supervisor_permission_profile || "guarded")}`, 2, muted);
      for (const participant of participants) {
        const device = workspaceEditorDevice(configured, participant);
        pushIndented(`${participant.planner ? "●" : "○"} ${participant.display_name || participant.participant_id} · ${runtimeDisplayName(participant.runtime)}`, 2, strong);
        pushIndented(`${device?.device_name || participant.device_id} · ${participant.workspace_id || "workspace pending"} · Agent limit: ${permissionLabel(participant.permission_profile || "manual")}`, 4, muted);
        pushIndented(`Model: ${participantRouteLabel(configured, participant)}`, 4, muted);
        if (participant.role_hint) pushIndented(participant.role_hint, 4, muted);
      }
    }
  } else if (runtime.interactionKind === "attention" && runtime.attention) {
    push("");
    push(runtime.attention.title || "Agent needs your input", strong);
    if (runtime.attention.summary) pushIndented(runtime.attention.summary, 2, muted);
    if (runtime.attention.risk) pushIndented(`Risk: ${runtime.attention.risk}`, 2, muted);
    push("");
    for (const [index, action] of (runtime.attention.actions || []).entries()) {
      pushIndented(`${index === runtime.attentionSelection ? "›" : " "} ${index + 1}. ${attentionActionLabel(action)}`, 2);
    }
  } else if (runtime.interactionKind === "paused") {
    push("");
    push("This collaboration is paused.", strong);
    pushIndented(runtime.snapshot?.run?.pause_reason || "The OriginRouter service is preserving the Run state.", 2, muted);
    if (runtime.snapshot?.run?.account_budget_blocked) {
      pushIndented("The account or device budget must be changed before this Run can resume.", 2, muted);
    }
  } else if (runtime.interactionKind === "reconnect") {
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
  if (runtime.snapshot?.run?.state === "awaiting_confirmation" && plan) {
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
  if (tasks.length) {
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
  const activityGroups = projectCollaborationActivity(runtime.events, {
    expanded: runtime.detailsExpanded === true,
    participantLabels,
    maxGroups: runtime.detailsExpanded ? 8 : 4,
  });
  if (activityGroups.length) {
    push("");
    push(runtime.detailsExpanded ? "Detailed transcript" : "Activity", strong);
    for (const group of activityGroups) {
      const marker = group.marker === "active" ? "●"
        : group.marker === "error" ? "×"
        : group.marker === "warning" ? "!" : "•";
      pushIndented(`${marker} ${group.title}`, 2, group.marker === "active" ? strong : null);
      if (group.summary) pushIndented(group.summary, 4, muted);
      for (const detail of group.details || []) pushIndented(`└ ${detail}`, 4, muted);
    }
    if (!runtime.detailsExpanded) pushIndented("Ctrl+O shows the detailed transcript.", 2, muted);
  }

  const report = runtime.snapshot?.final_report;
  if (report?.summary) {
    push("");
    pushIndented(report.summary, 2, runtime.snapshot?.run?.state === "completed" ? strong : null);
    for (const task of (report.completed_tasks || []).slice(0, 3)) {
      if (task.result) pushIndented(task.result, 4, muted);
    }
  }
  runtime.contentLineCount = lines.length;
  const visibleRows = Math.max(0, maxRows);
  runtime.contentVisibleRows = visibleRows;
  const maxStart = Math.max(0, lines.length - visibleRows);
  const start = runtime.autoFollow === false
    ? Math.max(0, Math.min(maxStart, Number(runtime.scrollOffset) || 0))
    : maxStart;
  runtime.scrollOffset = start;
  return lines.slice(start, start + visibleRows);
}

function runtimeControls(runtime, columns) {
  const mode = workspaceModeDefinition(runtime.mode || "auto").label;
  let text = runtime.notice || "Enter queues next objective · ctrl+c interrupts · ctrl+t freezes · PgUp/PgDn reviews";
  if (runtime.screenPaused) text = "screen frozen for copying · ctrl+t resumes updates";
  if (runtime.detailsExpanded) text = "verbose transcript · ctrl+o collapses · PgUp/PgDn scroll · Ctrl+End latest";
  if (runtime.autoFollow === false) {
    const unseen = Number(runtime.unseenActivityCount || 0);
    text = `${unseen ? `${unseen} new event${unseen === 1 ? "" : "s"} · ` : ""}PgDn/Ctrl+End returns to latest · ctrl+o details`;
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
      text = "↑/↓ reviews · Enter uses this team · E edits team · Esc returns";
    }
  }
  if (runtime.phase === "reconnecting") text = "connection interrupted · retrying automatically · ctrl+c cancels";
  if (runtime.phase === "connection_paused") text = "Enter reconnects · D detaches · ctrl+c interrupts Run";
  if (runtime.snapshot?.run?.state === "awaiting_confirmation") text = "↑/↓ reviews · Enter starts · E requests changes · Esc leaves pending";
  if (["attention", "attention_reply"].includes(runtime.interactionKind)) text = "Agent is waiting for your response";
  if (runtime.snapshot?.run?.state === "completed") {
    text = "Enter continues with this team · /new starts fresh · /exit exits";
  } else if (["failed", "cancelled", "error"].includes(runtime.snapshot?.run?.state || runtime.phase)) {
    text = "reviewing the result";
  }
  if (runtime.notice) text = runtime.notice;
  return padDisplayRight(muted(`  ${mode} · ${text}`), columns);
}

function composerStatus(columns, runtime = null) {
  const profile = runtime?.snapshot?.run?.supervisor_permission_profile
    || runtime?.configuration?.supervisor_permission_profile
    || "guarded";
  const status = `● ${permissionLabel(profile).toLowerCase()} · session approval`;
  return `${" ".repeat(Math.max(0, columns - promptDisplayWidth(status) - 2))}${accent(status)}  `;
}

function runtimeComposer(runtime, columns) {
  return composerLine(
    runtime.composerBuffer || "",
    runtime.composerCursor,
    columns,
    runtime.composerPastes,
  );
}

function composerLine(value, cursor, columns, pendingPastes = []) {
  const chars = [...String(value || "")];
  const boundedCursor = Math.max(0, Math.min(
    Number.isInteger(cursor) ? cursor : chars.length,
    chars.length,
  ));
  const pasteLabels = new Map(
    (pendingPastes || []).map((paste) => [paste.token, paste.label]),
  );
  const displayChars = chars.map((char) => pasteLabels.get(char) || (char === "\t" ? "  " : char));
  const tokens = [
    ...displayChars.slice(0, boundedCursor),
    "▌",
    ...displayChars.slice(boundedCursor),
  ].flatMap((token) => [...token]);
  const lineWidth = Math.max(3, columns - 1);
  const prefix = "› ";
  const continuationPrefix = "  ";
  const lines = [];
  let line = prefix;
  let width = promptDisplayWidth(prefix);

  for (const token of tokens) {
    if (token === "\n") {
      lines.push(line);
      line = continuationPrefix;
      width = promptDisplayWidth(continuationPrefix);
      continue;
    }
    const tokenWidth = promptDisplayWidth(token);
    if (width > promptDisplayWidth(prefix) && width + tokenWidth > lineWidth) {
      lines.push(line);
      line = continuationPrefix;
      width = promptDisplayWidth(continuationPrefix);
    }
    line += token;
    width += tokenWidth;
  }
  lines.push(line);

  return lines
    .map((item) => padDisplayRight(strong(item), columns))
    .join("\n");
}

function runtimePathComposer(runtime, columns) {
  let value = runtime.composerBuffer || "";
  if (runtime.phase === "needs_setup") {
    const selected = runtime.setupMode === "path"
      ? null
      : runtime.setup?.workspaces?.[runtime.setupSelection || 0];
    value = selected?.canonical_path || runtime.setupPath || runtime.setup?.default_path || "";
  }
  const prompt = `› ${value}`;
  return padDisplayRight(strong(fitDisplayText(prompt, Math.max(1, columns - 1))), columns);
}

function interactionComposer(runtime, columns) {
  const kind = runtime.interactionKind;
  let lines;
  if (kind === "device") {
    lines = [
      "? Which remote devices should participate?",
      "↑/↓ move · Space toggle · Enter confirm · A select all",
      "Esc cancel",
    ];
  } else if (kind === "workspace") {
    lines = [
      "? Choose an authorized workspace",
      "↑/↓ select · Enter confirm · P or typing enters a folder not listed",
      "Esc cancel",
    ];
  } else if (kind === "setup") {
    const path = String(runtime.setupPath || "");
    const pathChars = [...path];
    const pathCursor = Math.max(0, Math.min(
      Number.isInteger(runtime.setupCursor) ? runtime.setupCursor : pathChars.length,
      pathChars.length,
    ));
    const pathWithCursor = path
      ? `${pathChars.slice(0, pathCursor).join("")}▌${pathChars.slice(pathCursor).join("")}`
      : "▌";
    lines = [
      "? Enter a folder path to authorize",
      path
        ? `› ${pathWithCursor}`
        : `› ${pathWithCursor}  ${muted(`example: ${runtime.setup?.default_path || "/path/to/workspace"}`)}`,
      runtime.setup?.workspaces?.length
        ? "Tab completes · ↑/↓ suggestions · Enter authorize · Esc back"
        : "Tab completes · ↑/↓ suggestions · Enter authorize · Esc cancels",
    ];
  } else if (kind === "configuration") {
    lines = [
      "? Use this collaboration team?",
      "↑/↓ review · Enter confirm · E edit team · Esc return to objective",
    ];
  } else if (kind === "team_edit") {
    lines = [
      "? Edit an Agent, or finish editing",
      "↑/↓ select · Enter Runtime/model · P Agent limit · S Session approval · D done",
    ];
  } else if (kind === "team_runtime") {
    lines = [
      "? Choose the Agent Runtime",
      "↑/↓ select · Enter continue to model route · Esc back",
    ];
  } else if (kind === "team_route") {
    lines = [
      "? Choose the model route",
      "↑/↓ select · Enter save Agent · Esc back to Runtime",
    ];
  } else if (kind === "team_permission") {
    lines = [
      "? Choose this Agent's access policy",
      "↑/↓ select · Enter save access · Esc back",
    ];
  } else if (kind === "team_session_permission") {
    lines = [
      "? Choose the Session approval policy",
      "↑/↓ select · Enter save Session approval · Esc back",
    ];
  } else if (kind === "plan") {
    lines = [
      "? Start this plan?",
      "↑/↓ or PgUp/PgDn review · Enter start · E request changes · Esc leave pending",
    ];
  } else if (kind === "plan_revision") {
    const feedback = String(runtime.decisionBuffer || "");
    const feedbackChars = [...feedback];
    const feedbackCursor = Math.max(0, Math.min(runtime.decisionCursor || 0, feedbackChars.length));
    lines = [
      "? What should the Planner change?",
      composerLine(feedback, feedbackCursor, columns),
      "Enter submit changes · Ctrl+U clears · Esc back to plan",
    ];
  } else if (kind === "completion") {
    const canRetry = ["failed", "cancelled", "expired"].includes(runtime.snapshot?.run?.state);
    lines = [
      `? ${runtime.snapshot?.run?.state === "completed" ? "Collaboration complete" : "Collaboration stopped"}`,
      canRetry
        ? "R retry · ↑/↓ review · Enter return to objective prompt"
        : "↑/↓ or PgUp/PgDn review · Enter return to objective prompt",
    ];
  } else if (kind === "attention") {
    lines = [
      "? Agent needs your decision",
      "↑/↓ select · Enter confirms · D detaches · Esc stays with Run",
    ];
  } else if (kind === "attention_reply") {
    lines = [
      "? Reply to the Agent",
      composerLine(runtime.decisionBuffer || "", runtime.decisionCursor || 0, columns),
      "Enter sends reply · Ctrl+U clears · Esc back to actions",
    ];
  } else if (kind === "paused") {
    lines = [
      "? Resume this collaboration?",
      "Enter resume · Esc leave it paused",
    ];
  } else if (kind === "reconnect") {
    lines = [
      "? Reconnect to this Run?",
      "Enter reconnect · D detach · Ctrl+C interrupt Run",
    ];
  } else {
    lines = ["? OriginRouter needs your input", "Enter confirm · Esc cancel"];
  }
  const width = Math.max(1, columns - 1);
  return lines.map((line) => padDisplayRight(strong(fitDisplayText(line, width)), columns)).join("\n");
}

function interactionStatus(runtime, columns) {
  const labels = {
    device: "selecting remote devices",
    workspace: "selecting workspace",
    setup: "choosing folder",
    configuration: "reviewing team",
    team_edit: "editing team",
    team_runtime: "choosing Agent Runtime",
    team_route: "choosing model route",
    team_permission: "choosing Agent access limit",
    team_session_permission: "choosing Session approval",
    plan: "reviewing plan",
    plan_revision: "requesting plan changes",
    completion: "reviewing result",
    attention: "Agent needs input",
    attention_reply: "replying to Agent",
    paused: "collaboration paused",
    reconnect: "connection paused · Run preserved",
  };
  return padDisplayRight(muted(`  ${labels[runtime.interactionKind] || "waiting for input"}`), columns);
}

function runtimeHeaderPanel(runtime) {
  const configured = runtime.configuration;
  const resolved = configured?.resolved_workspace_mode
    || configured?.auto_configuration?.resolved_workspace_mode;
  return {
    title: runtimePhase(runtime),
    lines: [
      runtime.runId ? `Run ${runtime.runId}` : "Preparing a collaboration Run",
      resolved ? `${workspaceModeDefinition(resolved).label} · ${(configured.participants || []).length} Agents` : "Resolving mode and participants",
      runtime.startedAt ? `Elapsed ${elapsedText(runtime.startedAt)}` : "",
      runtime.phase === "needs_setup"
        ? "Workspace authorization required"
        : runtime.runId ? "OriginRouter service owns the task" : "No Run has been created yet",
    ].filter(Boolean),
  };
}

export function buildWorkspaceAppScreen({
  coordinator = "codex",
  mode = "auto",
  columns = 80,
  rows = 24,
  panel = null,
  runtime = null,
  composerBuffer = null,
  composerCursor = 0,
  composerPastes = [],
  composerNotice = "",
} = {}) {
  const terminalColumns = Math.max(20, Number(columns) || 80);
  const terminalRows = Math.max(8, Number(rows) || 24);
  const frameWidth = Math.max(18, Math.min(terminalColumns - 2, 94));
  const contentWidth = frameWidth - 4;
  const modeLabel = workspaceModeDefinition(mode).label;
  const lead = coordinatorLabel(coordinator);
  const workspace = workspaceDirectoryName();
  const viewPanel = panel || defaultWorkspacePanel();
  const leftWidth = Math.floor((contentWidth - 3) * 0.43);
  const rightWidth = contentWidth - leftWidth - 3;
  const divider = "│";
  const pair = (left, right, index) => appLine(
    `${left} ${border(divider)} ${panelRow(right, rightWidth, { heading: index === 0 })}`,
    contentWidth,
  );
  const leftRows = [
    strong(padDisplayRight("Agent Workspace", leftWidth)),
    metricRow("Workspace", workspace, leftWidth),
    metricRow("Team", modeLabel, leftWidth),
    metricRow("Lead", lead, leftWidth),
    metricRow("Access", "Guarded", leftWidth),
  ];
  const rightRows = [
    viewPanel.title,
    ...viewPanel.lines,
  ];
  const detailRows = Array.from(
    { length: Math.max(leftRows.length, rightRows.length) },
    (_, index) => pair(leftRows[index] || padDisplayRight("", leftWidth), rightRows[index] || "", index),
  );

  const compactHeader = runtime || terminalRows < 14 || terminalColumns < 56;
  const headerRows = compactHeader
    ? [
        titleLine("OriginRouter", frameWidth),
        appLine(
          runtime
            ? `${workspace} · ${modeLabel} · ${runtimePhase(runtime)}${runtime.runId ? ` · ${runtime.runId}` : ""}`
            : `${workspace} · ${modeLabel} · Ready for an objective`,
          contentWidth,
        ),
        bottomLine(frameWidth),
      ]
    : [
        titleLine("OriginRouter", frameWidth),
        appLine("", contentWidth),
        ...detailRows,
        bottomLine(frameWidth),
      ];
  const normalComposerBlock = !runtime && composerBuffer !== null
    ? composerLine(composerBuffer, composerCursor, terminalColumns, composerPastes)
    : "";
  const runtimeComposerBlock = runtime
    ? runtime.interaction
      ? interactionComposer(runtime, terminalColumns)
      : runtimeComposer(runtime, terminalColumns)
    : "";
  const reservedRows = runtime
    ? 4 + runtimeComposerBlock.split("\n").length
    : normalComposerBlock
      ? 4 + normalComposerBlock.split("\n").length
      : 5;
  const activityRows = runtime
    ? buildRuntimeRows(runtime, terminalColumns, Math.max(0, terminalRows - headerRows.length - reservedRows))
    : [];
  const screenRows = [...headerRows, ...activityRows];
  const separator = border("─".repeat(terminalColumns));
  const blankRows = Math.max(0, terminalRows - screenRows.length - reservedRows);
  const body = `${screenRows.join("\n")}\n${"\n".repeat(blankRows)}`;
  if (!runtime && composerBuffer === null) return `${body}${composerStatus(terminalColumns)}\n${separator}\n`;
  if (!runtime) {
    return [
      `${body}${muted(`  ${composerNotice || `${modeLabel} · shift+tab to cycle · /help for commands`}`)}`,
      separator,
      normalComposerBlock,
      separator,
      muted("  Enter submits · Ctrl+C clears · Ctrl+D exits · /help for commands"),
    ].join("\n");
  }
  const composer = runtimeComposerBlock;
  const status = runtime.interaction
    ? interactionStatus(runtime, terminalColumns)
    : composerStatus(terminalColumns, runtime);
  return [
    `${body}${status}`,
    separator,
    composer,
    separator,
    runtimeControls(runtime, terminalColumns),
  ].join("\n");
}

function redrawWorkspaceApp(output, {
  coordinator,
  mode,
  panel = null,
  runtime = null,
  composerBuffer = null,
  composerCursor = 0,
  composerPastes = [],
  composerNotice = "",
  force = false,
} = {}) {
  const screen = buildWorkspaceAppScreen({
    coordinator,
    mode,
    panel,
    runtime,
    composerBuffer,
    composerCursor,
    composerPastes,
    composerNotice,
    columns: output.columns,
    rows: output.rows,
  });
  const nextLines = screen.replace(/\n$/, "").split("\n");
  const previous = workspaceScreenCache.get(output);
  const writeFrame = (writer) => {
    // DEC 2026 is supported by modern terminals and makes a frame appear
    // atomically. Terminals that do not implement it safely ignore the mode.
    output.write("\x1b[?2026h");
    try {
      writer();
    } finally {
      output.write("\x1b[?2026l");
    }
  };
  if (force || !previous || previous.columns !== output.columns || previous.rows !== output.rows) {
    writeFrame(() => {
      output.write("\x1b[2J\x1b[H");
      output.write(screen);
    });
  } else {
    writeFrame(() => {
      const maxRows = Math.max(previous.lines.length, nextLines.length);
      for (let index = 0; index < maxRows; index += 1) {
        const next = nextLines[index] || "";
        const old = previous.lines[index] || "";
        if (next === old) continue;
        output.write(`\x1b[${index + 1};1H\x1b[2K${next}`);
      }
      output.write(`\x1b[${Math.max(1, nextLines.length)};1H`);
    });
  }
  workspaceScreenCache.set(output, {
    columns: output.columns,
    rows: output.rows,
    lines: nextLines,
  });
}

function supportsAppScreen(output) {
  return Boolean(output?.isTTY) && process.env.TERM !== "dumb";
}

function enterWorkspaceApp(output) {
  if (!supportsAppScreen(output)) return () => {};
  output.write("\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[H\x1b[2J");
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    workspaceScreenCache.delete(output);
    output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
  };
  process.once("exit", exit);
  const onSigterm = () => {
    exit();
    process.exit(143);
  };
  process.once("SIGTERM", onSigterm);
  return () => {
    process.off("exit", exit);
    process.off("SIGTERM", onSigterm);
    exit();
  };
}

export function normalizeWorkspacePathInput(value) {
  let path = String(value ?? "").replace(/[\r\n]+/g, "").trim();
  if (path.length >= 2) {
    const first = path[0];
    const last = path.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      path = path.slice(1, -1).trim();
    }
  }
  return path;
}

function cleanInsertedText(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f\r\n]/g, "");
}

function normalizePastedText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function nextPasteLabel(pendingPastes, charCount) {
  const base = `[Pasted Content ${charCount} chars]`;
  const labels = new Set((pendingPastes || []).map((paste) => paste.label));
  if (!labels.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} #${suffix}`;
    if (!labels.has(candidate)) return candidate;
  }
}

function insertComposerPaste({ buffer, cursor, pendingPastes, nextPasteId, pasted }) {
  const text = normalizePastedText(pasted);
  if (!text) return { buffer, cursor, pendingPastes, nextPasteId };
  const chars = [...buffer];
  const charCount = [...text].length;
  if (charCount <= LARGE_PASTE_CHAR_THRESHOLD) {
    const inserted = [...text];
    chars.splice(cursor, 0, ...inserted);
    return {
      buffer: chars.join(""),
      cursor: cursor + inserted.length,
      pendingPastes,
      nextPasteId,
    };
  }

  let id = nextPasteId;
  let token;
  do {
    token = String.fromCodePoint(PASTE_TOKEN_CODE_POINT_START + id);
    id += 1;
  } while (chars.includes(token) || pendingPastes.some((paste) => paste.token === token));
  const paste = {
    token,
    label: nextPasteLabel(pendingPastes, charCount),
    text,
  };
  chars.splice(cursor, 0, token);
  return {
    buffer: chars.join(""),
    cursor: cursor + 1,
    pendingPastes: [...pendingPastes, paste],
    nextPasteId: id,
  };
}

function pruneComposerPastes(buffer, pendingPastes) {
  const tokens = new Set([...String(buffer || "")]);
  return (pendingPastes || []).filter((paste) => tokens.has(paste.token));
}

function expandComposerPastes(buffer, pendingPastes) {
  const pastes = new Map((pendingPastes || []).map((paste) => [paste.token, paste.text]));
  return [...String(buffer || "")].map((char) => pastes.get(char) || char).join("");
}

function pastedKeyText(text, key = {}) {
  if (typeof text === "string") return text;
  if (key.name === "enter" || key.name === "return") return "\n";
  if (key.name === "tab") return "\t";
  return "";
}

function isFunctionKey(key = {}) {
  return /^f\d+$/i.test(String(key.name || ""));
}

function promptText(buffer) {
  return `› ${buffer}`;
}

function promptFooter(mode, notice = "") {
  if (notice) return accent(`  ${notice}`);
  return muted(`  ${workspaceModeDefinition(mode).label} · shift+tab to cycle · /help for commands`);
}

function isWideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function promptDisplayWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    if (
      (codePoint >= 0x300 && codePoint <= 0x36f)
      || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
      || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
      || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
      || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    ) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function promptRows(output, buffer, mode) {
  const columns = Number.isFinite(output.columns) && output.columns > 0 ? output.columns : 80;
  return Math.max(1, Math.ceil(promptDisplayWidth(promptText(buffer)) / columns));
}

export function redrawPrompt(output, buffer, mode, previousRows = 0, { notice = "" } = {}) {
  const footer = promptFooter(mode, notice);
  const renderedRows = promptRows(output, buffer, mode);
  if (previousRows > 1) {
    moveCursor(output, 0, -(previousRows - 1));
  }
  cursorTo(output, 0);
  clearScreenDown(output);
  const columns = Number.isFinite(output.columns) && output.columns > 0 ? output.columns : 80;
  const promptVisible = promptText(buffer);
  const promptWidth = promptDisplayWidth(promptVisible);
  const promptColumn = promptWidth % columns;
  const separator = border("─".repeat(columns));
  output.write(`${strong(promptVisible)}\n${separator}\n${footer}`);
  moveCursor(output, 0, -2);
  cursorTo(output, promptColumn);
  return renderedRows;
}

async function readWorkspaceLine({ input, output, mode, coordinator, panel, onModeChange, initialBuffer = "" }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive Agent Workspace requires a terminal. Pass an objective, for example: originrouter \"fix the failing test\"");
  }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let buffer = String(initialBuffer || "");
  let cursor = [...buffer].length;
  let pendingPastes = [];
  let nextPasteId = 0;
  let pasteBuffer = null;
  let notice = "";
  let exitArmed = false;
  let noticeTimer = null;
  const renderInput = (force = false) => redrawWorkspaceApp(output, {
    coordinator,
    mode,
    panel,
    composerBuffer: buffer,
    composerCursor: cursor,
    composerPastes: pendingPastes,
    composerNotice: notice,
    force,
  });
  renderInput(true);
  const inputFrameScheduler = createWorkspaceFrameScheduler({ render: renderInput });
  return new Promise((resolve, reject) => {
    const clearNoticeTimer = () => {
      if (!noticeTimer) return;
      clearTimeout(noticeTimer);
      noticeTimer = null;
    };
    const clearNoticeLater = (ms) => {
      clearNoticeTimer();
      noticeTimer = setTimeout(() => {
        notice = "";
        exitArmed = false;
        renderInput(true);
      }, ms);
      noticeTimer.unref?.();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.off("error", onError);
      output.off?.("resize", onResize);
      clearNoticeTimer();
      inputFrameScheduler.dispose();
      input.setRawMode(false);
      input.pause();
    };
    const onResize = () => {
      inputFrameScheduler.request();
    };
    const onKeypress = (text, key = {}) => {
      if (key.name === "paste-start") {
        pasteBuffer = "";
        return;
      }
      if (pasteBuffer !== null) {
        if (key.name === "paste-end") {
          const inserted = insertComposerPaste({
            buffer,
            cursor,
            pendingPastes,
            nextPasteId,
            pasted: pasteBuffer,
          });
          buffer = inserted.buffer;
          cursor = inserted.cursor;
          pendingPastes = inserted.pendingPastes;
          nextPasteId = inserted.nextPasteId;
          pasteBuffer = null;
          clearNoticeTimer();
          notice = "";
          exitArmed = false;
          renderInput(true);
          return;
        }
        pasteBuffer += pastedKeyText(text, key);
        return;
      }
      if (key.ctrl && key.name === "c") {
        if (buffer) {
          buffer = "";
          cursor = 0;
          pendingPastes = [];
          exitArmed = false;
          notice = "Input cleared";
          renderInput(true);
          clearNoticeLater(800);
          return;
        }
        if (exitArmed) {
          cleanup();
          resolve("/exit");
          return;
        }
        exitArmed = true;
        notice = "Press Ctrl+C again to exit";
        renderInput(true);
        clearNoticeLater(500);
        return;
      }
      if (key.ctrl && key.name === "d" && !buffer) {
        cleanup();
        resolve("/exit");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(expandComposerPastes(buffer, pendingPastes).trim());
        return;
      }
      if ((key.shift && key.name === "tab") || key.sequence === "\x1b[Z") {
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        mode = onModeChange().id;
        renderInput(true);
        return;
      }
      if (key.name === "backspace") {
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        const chars = [...buffer];
        if (cursor > 0) {
          chars.splice(cursor - 1, 1);
          cursor -= 1;
          buffer = chars.join("");
          pendingPastes = pruneComposerPastes(buffer, pendingPastes);
        }
        renderInput();
        return;
      }
      if (key.name === "delete") {
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        const chars = [...buffer];
        if (cursor < chars.length) {
          chars.splice(cursor, 1);
          buffer = chars.join("");
          pendingPastes = pruneComposerPastes(buffer, pendingPastes);
        }
        renderInput();
        return;
      }
      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        renderInput();
        return;
      }
      if (key.name === "right") {
        cursor = Math.min([...buffer].length, cursor + 1);
        renderInput();
        return;
      }
      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
        renderInput();
        return;
      }
      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = [...buffer].length;
        renderInput();
        return;
      }
      if (key.ctrl && key.name === "u") {
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        buffer = "";
        cursor = 0;
        pendingPastes = [];
        renderInput();
        return;
      }
      if (key.name === "escape" || key.ctrl || key.meta) return;
      if (text && !isFunctionKey(key)) {
        text = cleanInsertedText(text);
        if (!text) return;
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        const chars = [...buffer];
        chars.splice(cursor, 0, ...text);
        buffer = chars.join("");
        cursor += [...text].length;
        renderInput();
      }
    };
    input.on("keypress", onKeypress);
    input.once("error", onError);
    output.on?.("resize", onResize);
  });
}

function collaborationArgs({ objective, coordinator, mode, forwarded }) {
  const args = [
    "create",
    objective,
    "--workspace-mode", mode,
    "--coordinator", coordinator,
    ...forwarded,
  ];
  // Auto mode delegates task interpretation to the advisory model. Local
  // rules remain a conservative fallback when the advisory service is down.
  if (mode === "auto" && !forwarded.includes("--cloud-advice")) {
    args.push("--cloud-advice");
  }
  return args;
}

function isInterrupted(error) {
  return error?.code === "ORIGINROUTER_INTERRUPTED"
    || error?.name === "AbortError"
    || error?.cause?.code === "ORIGINROUTER_INTERRUPTED";
}

async function readRuntimeDecision({ input, runtime, render, kind, browseWorkspaceFn = null }) {
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  runtime.interaction = true;
  runtime.interactionKind = kind;
  runtime.scrollOffset = 0;
  let buffer = kind === "setup" ? String(runtime.setupPath || "") : "";
  let cursor = [...buffer].length;
  runtime.setupPath = buffer;
  runtime.setupCursor = cursor;
  runtime.setupSuggestions = [];
  runtime.setupSuggestionSelection = 0;
  runtime.setupBrowseLoading = false;
  runtime.setupBrowseError = "";
  runtime.decisionBuffer = ["plan_revision", "attention_reply"].includes(kind)
    ? String(runtime.decisionBuffer || "")
    : "";
  runtime.decisionCursor = [...runtime.decisionBuffer].length;
  let browseTimer = null;
  let browseGeneration = 0;
  const scheduleBrowse = () => {
    if (kind !== "setup" || typeof browseWorkspaceFn !== "function") return;
    if (browseTimer) clearTimeout(browseTimer);
    const generation = ++browseGeneration;
    runtime.setupBrowseLoading = Boolean(buffer);
    runtime.setupBrowseError = "";
    runtime.setupSuggestions = [];
    runtime.setupSuggestionSelection = 0;
    if (!buffer) {
      runtime.setupBrowseLoading = false;
      render(true);
      return;
    }
    browseTimer = setTimeout(() => {
      browseTimer = null;
      Promise.resolve(browseWorkspaceFn(runtime.setup?.device_id, buffer))
        .then((page) => {
          if (generation !== browseGeneration || kind !== "setup" || !runtime.interaction) return;
          runtime.setupBrowseLoading = false;
          runtime.setupSuggestions = (page?.entries || [])
            .filter((entry) => entry?.path)
            .slice(0, 6);
          runtime.setupSuggestionSelection = 0;
          render(true);
        })
        .catch((error) => {
          if (generation !== browseGeneration || kind !== "setup" || !runtime.interaction) return;
          runtime.setupBrowseLoading = false;
          runtime.setupSuggestions = [];
          runtime.setupBrowseError = String(error?.message || error).split("\n")[0];
          render(true);
        });
    }, 180);
    browseTimer.unref?.();
  };
  render(true);
  if (kind === "setup" && buffer) scheduleBrowse();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (browseTimer) clearTimeout(browseTimer);
      browseGeneration += 1;
      input.off("keypress", onKeypress);
      input.off("error", onError);
      runtime.interaction = false;
      runtime.interactionKind = "";
    };
    const finish = (value) => {
      cleanup();
      resolve(value);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === "o") {
        runtime.detailsExpanded = !runtime.detailsExpanded;
        runtime.notice = runtime.detailsExpanded ? "Detailed transcript shown" : "Execution details collapsed";
        render(true);
        return;
      }
      if (key.ctrl && key.name === "end" && !["setup", "plan_revision", "attention_reply"].includes(kind)) {
        runtime.autoFollow = true;
        runtime.unseenActivityCount = 0;
        render(true);
        return;
      }
      const scrollDirection = reviewScrollDirection(text, key, {
        arrows: ["configuration", "plan", "completion", "paused", "reconnect"].includes(kind),
      });
      if (scrollDirection) {
        scrollRuntimeContent(runtime, scrollDirection);
        render(true);
        return;
      }
      if (kind === "reconnect" && key.ctrl && key.name === "c") {
        finish("interrupt");
        return;
      }
      if (kind === "reconnect" && key.name === "escape") {
        runtime.notice = "Run preserved · press Enter to reconnect, D to detach, or Ctrl+C to interrupt";
        render(true);
        return;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        if (kind === "attention" && key.name === "escape") {
          runtime.notice = "This Run is still waiting for a decision · press D to detach explicitly";
          render(true);
          return;
        }
        if (kind === "team_edit") {
          kind = "configuration";
          runtime.interactionKind = "configuration";
          runtime.teamEditDraft = null;
          runtime.notice = "Review the updated team, then press Enter to continue";
          render(true);
          return;
        }
        if (kind === "team_runtime") {
          kind = "team_edit";
          runtime.interactionKind = "team_edit";
          runtime.teamEditDraft = null;
          runtime.notice = "";
          render(true);
          return;
        }
        if (kind === "team_route") {
          kind = "team_runtime";
          runtime.interactionKind = "team_runtime";
          runtime.notice = "";
          render(true);
          return;
        }
        if (kind === "team_permission") {
          kind = "team_edit";
          runtime.interactionKind = "team_edit";
          runtime.notice = "";
          render(true);
          return;
        }
        if (kind === "team_session_permission") {
          kind = "team_edit";
          runtime.interactionKind = "team_edit";
          runtime.notice = "";
          render(true);
          return;
        }
        if (kind === "plan_revision") {
          kind = "plan";
          runtime.interactionKind = "plan";
          runtime.decisionBuffer = "";
          runtime.decisionCursor = 0;
          render(true);
          return;
        }
        if (kind === "attention_reply") {
          kind = "attention";
          runtime.interactionKind = "attention";
          runtime.decisionBuffer = "";
          runtime.decisionCursor = 0;
          render(true);
          return;
        }
        if (kind === "setup" && runtime.setup?.workspaces?.length) {
          runtime.interactionKind = "workspace";
          runtime.setupMode = "workspace";
          runtime.setupSelection = 0;
          runtime.setupPath = "";
          runtime.setupCursor = 0;
          runtime.setupSuggestions = [];
          runtime.setupBrowseLoading = false;
          kind = "workspace";
          buffer = "";
          cursor = 0;
          render(true);
          return;
        }
        finish(["device", "setup", "workspace"].includes(kind) ? null : "leave");
        return;
      }
      if (kind === "attention" && !key.ctrl && !key.meta && /^[dD]$/.test(text || "")) {
        finish("leave");
        return;
      }
      if (kind === "reconnect" && !key.ctrl && !key.meta && /^[dD]$/.test(text || "")) {
        finish("leave");
        return;
      }
      if (kind === "team_edit" && !key.ctrl && !key.meta && /^[dD]$/.test(text || "")) {
        kind = "configuration";
        runtime.interactionKind = "configuration";
        runtime.teamEditDraft = null;
        runtime.notice = "Review the updated team, then press Enter to continue";
        render(true);
        return;
      }
      if (kind === "team_edit" && !key.ctrl && !key.meta && /^[pP]$/.test(text || "")) {
        const participant = runtime.configuration?.participants?.[runtime.teamEditSelection || 0];
        if (!participant) return;
        const options = workspacePermissionOptions(runtime.configuration, participant);
        runtime.teamPermissionSelection = Math.max(
          0,
          options.findIndex((option) => option.id === participant.permission_profile),
        );
        kind = "team_permission";
        runtime.interactionKind = "team_permission";
        runtime.notice = "";
        render(true);
        return;
      }
      if (kind === "team_edit" && !key.ctrl && !key.meta && /^[sS]$/.test(text || "")) {
        const options = sessionPermissionOptions();
        runtime.teamSessionPermissionSelection = Math.max(
          0,
          options.findIndex((option) => option.id === (runtime.configuration?.supervisor_permission_profile || "guarded")),
        );
        kind = "team_session_permission";
        runtime.interactionKind = "team_session_permission";
        runtime.notice = "";
        render(true);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (kind === "device") {
          const selectedIds = new Set(runtime.deviceSelections || []);
          if (!selectedIds.size) {
            runtime.notice = "Select at least one remote device with Space";
            render(true);
            return;
          }
          finish((runtime.setup?.devices || [])
            .filter((device) => selectedIds.has(device.device_id))
            .map((device) => device.device_id));
        } else if (kind === "workspace") {
          const workspaces = runtime.setup?.workspaces || [];
          finish(runtime.setupSelection >= workspaces.length
            ? "__custom_workspace_path__"
            : workspaces[runtime.setupSelection || 0] || null);
        } else if (kind === "team_edit") {
          const participant = runtime.configuration?.participants?.[runtime.teamEditSelection || 0];
          const options = workspaceRuntimeOptions(runtime.configuration, participant);
          if (!participant || !options.length) {
            runtime.notice = "This device has no editable Codex or Claude Code Runtime";
            render(true);
            return;
          }
          runtime.teamEditDraft = {
            participantIndex: runtime.teamEditSelection || 0,
            runtime: participant.runtime,
          };
          runtime.teamRuntimeSelection = Math.max(0, options.indexOf(participant.runtime));
          kind = "team_runtime";
          runtime.interactionKind = "team_runtime";
          runtime.notice = "";
          render(true);
        } else if (kind === "team_runtime") {
          const participant = runtime.configuration?.participants?.[runtime.teamEditSelection || 0];
          const options = workspaceRuntimeOptions(runtime.configuration, participant);
          const selectedRuntime = options[runtime.teamRuntimeSelection || 0];
          if (!participant || !selectedRuntime) return;
          runtime.teamEditDraft = {
            participantIndex: runtime.teamEditSelection || 0,
            runtime: selectedRuntime,
          };
          const routes = workspaceRouteOptions(runtime.configuration, participant, selectedRuntime);
          const currentRoute = participant.runtime === selectedRuntime && participant.provider && participant.model
            ? routes.findIndex((route) => route.provider === participant.provider && route.model === participant.model)
            : 0;
          runtime.teamRouteSelection = Math.max(0, currentRoute);
          kind = "team_route";
          runtime.interactionKind = "team_route";
          runtime.notice = "";
          render(true);
        } else if (kind === "team_route") {
          const participant = runtime.configuration?.participants?.[runtime.teamEditSelection || 0];
          const selectedRuntime = runtime.teamEditDraft?.runtime || participant?.runtime;
          const routes = workspaceRouteOptions(runtime.configuration, participant, selectedRuntime);
          const route = routes[runtime.teamRouteSelection || 0];
          if (!participant || !selectedRuntime || !route) return;
          participant.runtime = selectedRuntime;
          if (route.provider && route.model) {
            participant.provider = route.provider;
            participant.model = route.model;
          } else {
            delete participant.provider;
            delete participant.model;
          }
          if (participant.planner) {
            runtime.configuration.coordinator_runtime = selectedRuntime;
            runtime.configuration.auto_configuration = {
              ...(runtime.configuration.auto_configuration || {}),
              coordinator: selectedRuntime,
            };
          }
          runtime.configuration.auto_configuration = {
            ...(runtime.configuration.auto_configuration || {}),
            runtimes: [...new Set((runtime.configuration.participants || []).map((item) => item.runtime))],
          };
          runtime.teamEditDraft = null;
          runtime.notice = `${participant.display_name || participant.participant_id} updated`;
          kind = "team_edit";
          runtime.interactionKind = "team_edit";
          render(true);
        } else if (kind === "team_permission") {
          const participant = runtime.configuration?.participants?.[runtime.teamEditSelection || 0];
          const options = workspacePermissionOptions(runtime.configuration, participant);
          const profile = options[runtime.teamPermissionSelection || 0];
          if (!participant || !profile) return;
          participant.permission_profile = profile.id;
          if (profile.id === "custom") participant.approval_policy_id = profile.policyId || "protected";
          else delete participant.approval_policy_id;
          runtime.notice = `${participant.display_name || participant.participant_id} access set to ${profile.label}`;
          kind = "team_edit";
          runtime.interactionKind = "team_edit";
          render(true);
        } else if (kind === "team_session_permission") {
          const options = sessionPermissionOptions();
          const profile = options[runtime.teamSessionPermissionSelection || 0];
          if (!profile) return;
          runtime.configuration.supervisor_permission_profile = profile.id;
          if (profile.id === "custom") runtime.configuration.supervisor_policy_id = profile.policyId || "protected";
          else delete runtime.configuration.supervisor_policy_id;
          runtime.notice = `Session approval set to ${profile.label}`;
          kind = "team_edit";
          runtime.interactionKind = "team_edit";
          render(true);
        } else {
          if (kind === "setup") {
            const path = normalizeWorkspacePathInput(buffer);
            if (!path) {
              runtime.notice = "Enter a folder path before authorizing";
              render(true);
              return;
            }
            runtime.notice = "";
            finish(path);
          } else if (kind === "plan_revision") {
            const feedback = String(runtime.decisionBuffer || "").trim();
            if (!feedback) {
              runtime.notice = "Describe the required plan change before submitting";
              render(true);
              return;
            }
            finish({ action: "revise", feedback });
          } else if (kind === "attention") {
            const action = runtime.attention?.actions?.[runtime.attentionSelection || 0];
            if (!action) return;
            if (runtime.attention?.kind === "input" && action === "submit") {
              kind = "attention_reply";
              runtime.interactionKind = "attention_reply";
              runtime.decisionBuffer = "";
              runtime.decisionCursor = 0;
              render(true);
              return;
            }
            finish({ action, response: {} });
          } else if (kind === "attention_reply") {
            const reply = String(runtime.decisionBuffer || "").trim();
            if (!reply) {
              runtime.notice = "Enter a reply before submitting";
              render(true);
              return;
            }
            finish({ action: "submit", response: { text: reply } });
          } else if (kind === "completion") {
            finish("continue");
          } else if (kind === "paused") {
            finish("resume");
          } else if (kind === "reconnect") {
            finish("reconnect");
          } else {
            finish("confirm");
          }
        }
        return;
      }
      if (kind === "configuration" && !key.ctrl && !key.meta && /^[eE]$/.test(text || "")) {
        const participants = runtime.configuration?.participants || [];
        const editable = participants.some(
          (participant) => workspaceRuntimeOptions(runtime.configuration, participant).length > 0,
        );
        if (!editable) {
          runtime.notice = "Team editing is unavailable because device capabilities are missing";
          render(true);
          return;
        }
        kind = "team_edit";
        runtime.interactionKind = "team_edit";
        runtime.teamEditSelection = Math.max(0, Math.min(
          participants.length - 1,
          Number(runtime.teamEditSelection) || 0,
        ));
        runtime.teamEditDraft = null;
        runtime.notice = "";
        render(true);
        return;
      }
      if (kind === "plan" && !key.ctrl && !key.meta && /^[eE]$/.test(text || "")) {
        kind = "plan_revision";
        runtime.interactionKind = "plan_revision";
        runtime.decisionBuffer = "";
        runtime.decisionCursor = 0;
        runtime.notice = "";
        render(true);
        return;
      }
      if (kind === "completion" && !key.ctrl && !key.meta && /^[rR]$/.test(text || "")) {
        if (["failed", "cancelled", "expired"].includes(runtime.snapshot?.run?.state)) {
          finish("retry");
        }
        return;
      }
      if (["team_edit", "team_runtime", "team_route", "team_permission", "team_session_permission"].includes(kind)) {
        let optionCount = 0;
        if (kind === "team_edit") {
          optionCount = runtime.configuration?.participants?.length || 0;
        } else {
          const participant = runtime.configuration?.participants?.[runtime.teamEditSelection || 0];
          optionCount = kind === "team_runtime"
            ? workspaceRuntimeOptions(runtime.configuration, participant).length
            : kind === "team_route"
              ? workspaceRouteOptions(
                  runtime.configuration,
                  participant,
                  runtime.teamEditDraft?.runtime || participant?.runtime,
                ).length
              : kind === "team_permission"
                ? workspacePermissionOptions(runtime.configuration, participant).length
                : sessionPermissionOptions().length;
        }
        if (!optionCount) return;
        const selectionKey = kind === "team_edit"
          ? "teamEditSelection"
          : kind === "team_runtime"
            ? "teamRuntimeSelection"
            : kind === "team_route"
              ? "teamRouteSelection"
              : kind === "team_permission" ? "teamPermissionSelection" : "teamSessionPermissionSelection";
        if (key.name === "up") {
          runtime[selectionKey] = (runtime[selectionKey] - 1 + optionCount) % optionCount;
        } else if (key.name === "down" || key.name === "tab") {
          runtime[selectionKey] = (runtime[selectionKey] + 1) % optionCount;
        } else if (/^[1-9]$/.test(text || "") && Number(text) <= optionCount) {
          runtime[selectionKey] = Number(text) - 1;
        } else {
          return;
        }
        runtime.notice = "";
        render(true);
        return;
      }
      if (kind === "device") {
        const devices = runtime.setup?.devices || [];
        if (!devices.length) return;
        if (key.name === "up") {
          runtime.deviceSelection = (runtime.deviceSelection - 1 + devices.length) % devices.length;
        } else if (key.name === "down" || key.name === "tab") {
          runtime.deviceSelection = (runtime.deviceSelection + 1) % devices.length;
        } else if (key.name === "space" || text === " ") {
          const deviceId = devices[runtime.deviceSelection || 0]?.device_id;
          const selected = new Set(runtime.deviceSelections || []);
          if (selected.has(deviceId)) selected.delete(deviceId);
          else selected.add(deviceId);
          runtime.deviceSelections = [...selected];
        } else if (!key.ctrl && !key.meta && /^[aA]$/.test(text || "")) {
          runtime.deviceSelections = runtime.deviceSelections?.length === devices.length
            ? []
            : devices.map((device) => device.device_id);
        } else if (/^[1-9]$/.test(text || "") && Number(text) <= devices.length) {
          runtime.deviceSelection = Number(text) - 1;
        } else {
          return;
        }
        runtime.notice = "";
        render(true);
        return;
      }
      if (kind === "attention") {
        const actions = runtime.attention?.actions || [];
        if (!actions.length) return;
        if (key.name === "up") {
          runtime.attentionSelection = (runtime.attentionSelection - 1 + actions.length) % actions.length;
        } else if (key.name === "down" || key.name === "tab") {
          runtime.attentionSelection = (runtime.attentionSelection + 1) % actions.length;
        } else if (/^[1-9]$/.test(text || "") && Number(text) <= actions.length) {
          runtime.attentionSelection = Number(text) - 1;
        } else {
          return;
        }
        render(true);
        return;
      }
      if (kind === "workspace") {
        const workspaces = runtime.setup?.workspaces || [];
        if (!workspaces.length) return;
        if (!key.ctrl && !key.meta && /^[pP]$/.test(text || "")) {
          kind = "setup";
          runtime.interactionKind = "setup";
          runtime.setupMode = "path";
          buffer = "";
          cursor = 0;
          runtime.setupPath = "";
          runtime.setupCursor = 0;
          runtime.notice = "";
          render(true);
          return;
        }
        if (!key.ctrl && !key.meta && text && !isFunctionKey(key)) {
          kind = "setup";
          runtime.interactionKind = "setup";
          runtime.setupMode = "path";
          // Typing directly from the list opens the path editor. The first
          // character is the complete beginning of the new path; the
          // device default remains an example, never hidden input content.
          buffer = cleanInsertedText(text);
          if (!buffer) return;
          cursor = [...buffer].length;
          runtime.setupPath = buffer;
          runtime.setupCursor = cursor;
          runtime.notice = "";
          render(true);
          scheduleBrowse();
          return;
        }
        if (key.name === "up") {
          runtime.setupSelection = (runtime.setupSelection - 1 + workspaces.length + 1) % (workspaces.length + 1);
        } else if (key.name === "down" || key.name === "tab") {
          runtime.setupSelection = (runtime.setupSelection + 1) % (workspaces.length + 1);
        } else if (/^[1-9]$/.test(text || "") && Number(text) <= workspaces.length + 1) {
          runtime.setupSelection = Number(text) - 1;
        } else {
          return;
        }
        if (runtime.setupSelection === workspaces.length) {
          runtime.setupMode = "path-choice";
        } else {
          runtime.setupMode = "workspace";
        }
        render(true);
        return;
      }
      if (["plan_revision", "attention_reply"].includes(kind)) {
        const chars = [...runtime.decisionBuffer];
        let decisionCursor = runtime.decisionCursor;
        if (key.name === "backspace") {
          if (decisionCursor > 0) {
            chars.splice(decisionCursor - 1, 1);
            decisionCursor -= 1;
          }
        } else if (key.name === "delete") {
          chars.splice(decisionCursor, 1);
        } else if (key.name === "left") {
          decisionCursor = Math.max(0, decisionCursor - 1);
        } else if (key.name === "right") {
          decisionCursor = Math.min(chars.length, decisionCursor + 1);
        } else if (key.name === "home" || (key.ctrl && key.name === "a")) {
          decisionCursor = 0;
        } else if (key.name === "end" || (key.ctrl && key.name === "e")) {
          decisionCursor = chars.length;
        } else if (key.ctrl && key.name === "u") {
          chars.splice(0, chars.length);
          decisionCursor = 0;
        } else if (!key.ctrl && !key.meta && text && !isFunctionKey(key)) {
          text = cleanInsertedText(text);
          if (!text) return;
          chars.splice(decisionCursor, 0, ...text);
          decisionCursor += [...text].length;
        } else {
          return;
        }
        runtime.decisionBuffer = chars.join("");
        runtime.decisionCursor = decisionCursor;
        runtime.notice = "";
        render(true);
        return;
      }
      if (kind !== "setup") return;
      const suggestions = runtime.setupSuggestions || [];
      if (key.name === "tab" && suggestions.length) {
        const selected = suggestions[runtime.setupSuggestionSelection || 0] || suggestions[0];
        buffer = String(selected.path || "");
        cursor = [...buffer].length;
        runtime.setupPath = buffer;
        runtime.setupCursor = cursor;
        runtime.setupSuggestions = [];
        runtime.setupSuggestionSelection = 0;
        runtime.notice = "Folder completed; press Enter to authorize";
        render(true);
        scheduleBrowse();
        return;
      }
      if (["up", "down"].includes(key.name) && suggestions.length) {
        const direction = key.name === "up" ? -1 : 1;
        runtime.setupSuggestionSelection = (
          runtime.setupSuggestionSelection + direction + suggestions.length
        ) % suggestions.length;
        render(true);
        return;
      }
      const chars = [...buffer];
      if (key.name === "backspace") {
        if (cursor > 0) {
          chars.splice(cursor - 1, 1);
          cursor -= 1;
        }
        buffer = chars.join("");
      } else if (key.name === "delete") {
        chars.splice(cursor, 1);
        buffer = chars.join("");
      } else if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
      } else if (key.name === "right") {
        cursor = Math.min(chars.length, cursor + 1);
      } else if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
      } else if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = chars.length;
      } else if (key.ctrl && key.name === "u") {
        buffer = "";
        cursor = 0;
      } else if (!key.ctrl && !key.meta && text && !isFunctionKey(key)) {
        text = cleanInsertedText(text);
        if (!text) return;
        chars.splice(cursor, 0, ...text);
        cursor += [...text].length;
        buffer = chars.join("");
      } else {
        return;
      }
      runtime.setupPath = buffer;
      runtime.setupCursor = cursor;
      runtime.notice = "";
      render(true);
      scheduleBrowse();
    };
    input.on("keypress", onKeypress);
    input.once("error", onError);
  });
}

function completionPanel(runtime) {
  const snapshot = runtime.snapshot;
  const state = snapshot?.run?.state || runtime.phase;
  const report = snapshot?.final_report;
  if (runtime.detachRequested && runtime.runId && !TERMINAL_WORKSPACE_RUN_STATES.has(state)) {
    return {
      title: "Collaboration continues in the service",
      lines: [
        `Run ${runtime.runId}`,
        "This terminal detached explicitly; the task was not stopped.",
        `Use originrouter collaboration attach ${runtime.runId} to follow it again.`,
      ],
    };
  }
  if (state === "completed") {
    return {
      title: "Last collaboration completed",
      lines: [
        report?.summary || "The collaboration completed.",
        runtime.runId ? `Run ${runtime.runId}` : "",
        "Enter another objective below.",
      ].filter(Boolean),
    };
  }
  if (state === "awaiting_confirmation") {
    return {
      title: "Plan left pending",
      lines: [
        runtime.runId ? `Run ${runtime.runId}` : "",
        "The service still owns this Run.",
        "Use collaboration attach to review it later.",
      ].filter(Boolean),
    };
  }
  if (state === "configuration_pending") {
    return {
      title: "Configuration not started",
      lines: [
        "No collaboration Run was created.",
        "Change mode or enter a clearer objective.",
        "Enter another objective below.",
      ],
    };
  }
  return {
    title: state === "cancelled" || runtime.phase === "interrupted" ? "Collaboration stopped" : "Collaboration needs attention",
    lines: [
      runtime.error ? String(runtime.error.message || runtime.error).split("\n")[0] : report?.summary || runtimePhase(runtime),
      runtime.runId ? `Run ${runtime.runId}` : "No Run was created.",
      runtime.runId ? `Use originrouter collaboration retry ${runtime.runId} to continue it later.` : "Enter another objective below.",
    ],
  };
}

function continuedTeamConfiguration(runtime) {
  if (!runtime.configuration) return null;
  const configuration = structuredClone(runtime.configuration);
  const bindings = new Map((runtime.snapshot?.participants || []).map((participant) => (
    [participant.participant_id, participant]
  )));
  configuration.participants = (configuration.participants || []).map((participant) => {
    const binding = bindings.get(participant.participant_id);
    if (!binding) return participant;
    return {
      ...participant,
      ...(binding.native_session_id ? { native_session_id: binding.native_session_id } : {}),
      ...(binding.conversation_id ? { conversation_id: binding.conversation_id } : {}),
    };
  });
  return configuration;
}

async function runWorkspaceObjective({
  objective,
  continuedConfiguration = null,
  continuedFromRunId = "",
  sessionHistory = [],
  coordinator,
  mode,
  forwarded,
  input,
  output,
  collaborationRunner,
  workspaceRunner = runAgentWorkspaceCollaboration,
  followRunner = followExistingAgentWorkspaceCollaboration,
  retryRunner = retryAgentWorkspaceCollaboration,
  cancelCollaborationRun,
  trustWorkspaceFn = trustCollaborationWorkspace,
  browseWorkspaceFn = browseCollaborationWorkspaces,
}) {
  const runtime = {
    phase: "configuring",
    objective,
    coordinator,
    mode,
    startedAt: Date.now(),
    events: [],
    sessionHistory,
    runId: "",
    snapshot: null,
    configuration: continuedConfiguration,
    setup: null,
    setupPath: "",
    setupCursor: 0,
    setupSelection: 0,
    setupSuggestions: [],
    setupSuggestionSelection: 0,
    setupBrowseLoading: false,
    setupBrowseError: "",
    deviceSelection: 0,
    deviceSelections: [],
    composerBuffer: "",
    composerCursor: 0,
    composerPastes: [],
    composerNextPasteId: 0,
    composerPasteBuffer: null,
    queuedObjective: "",
    exitRequested: false,
    returnToHome: false,
    notice: "",
    interaction: false,
    interactionKind: "",
    error: null,
    connectionAttempts: 0,
    detailsExpanded: false,
    autoFollow: true,
    unseenActivityCount: 0,
    animationFrame: 0,
    scrollOffset: 0,
    contentLineCount: 0,
    decisionBuffer: "",
    decisionCursor: 0,
    draftObjective: "",
    screenPaused: false,
    attention: null,
    attentionSelection: 0,
    detachRequested: false,
    teamEditSelection: 0,
    teamRuntimeSelection: 0,
    teamRouteSelection: 0,
    teamPermissionSelection: 0,
    teamSessionPermissionSelection: 0,
    teamEditDraft: null,
  };
  const render = (force = false) => redrawWorkspaceApp(output, {
    coordinator,
    mode,
    panel: runtimeHeaderPanel(runtime),
    runtime,
    force,
  });
  const frameScheduler = createWorkspaceFrameScheduler({ render });
  const scheduleRender = () => {
    if (!runtime.screenPaused) frameScheduler.request(false);
  };
  const onResize = () => scheduleRender();
  const timer = setInterval(() => {
    // Do not invalidate native terminal text selection while a setup/composer
    // interaction is active. State is redrawn on keypress and resize.
    const terminal = ["completed", "failed", "cancelled", "expired", "error"].includes(
      runtime.snapshot?.run?.state || runtime.phase,
    );
    if (!runtime.interaction && !runtime.screenPaused && !terminal && runtime.phase !== "needs_setup") {
      runtime.animationFrame = (runtime.animationFrame + 1) % SPINNER_FRAMES.length;
      scheduleRender();
    }
  }, 100);
  timer.unref?.();
  output.on?.("resize", onResize);
  // Entering the runtime changes the bottom-pane layout. Start it with a
  // complete frame so no composer rows from the objective prompt can survive
  // the transition, even if the terminal wrapped a wide character differently.
  render(true);

  const controller = new AbortController();
  const workspaceSelections = {};
  let interruptRequested = false;
  let cancelPromise = Promise.resolve();
  let completedInputResolve = null;
  const onActiveInterrupt = () => {
    if (interruptRequested) return;
    interruptRequested = true;
    runtime.phase = "interrupted";
    controller.abort();
    if (runtime.runId) {
      cancelPromise = Promise.resolve(cancelCollaborationRun(runtime.runId)).catch((error) => {
        runtime.error = error;
      });
    }
    render(true);
  };
  process.on("SIGINT", onActiveInterrupt);
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let noticeTimer = null;
  const showNotice = (notice, duration = 1600) => {
    runtime.notice = notice;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      runtime.notice = "";
      render(true);
    }, duration);
    noticeTimer.unref?.();
    render();
  };
  const onActiveKeypress = (text, key = {}) => {
    if (runtime.interaction) return;
    if (key.ctrl && key.name === "o") {
      runtime.detailsExpanded = !runtime.detailsExpanded;
      runtime.notice = runtime.detailsExpanded ? "Detailed transcript shown" : "Execution details collapsed";
      render(true);
      return;
    }
    if (key.ctrl && key.name === "end") {
      runtime.autoFollow = true;
      runtime.unseenActivityCount = 0;
      render(true);
      return;
    }
    if (key.name === "paste-start") {
      runtime.composerPasteBuffer = "";
      return;
    }
    if (runtime.composerPasteBuffer !== null) {
      if (key.name === "paste-end") {
        const inserted = insertComposerPaste({
          buffer: runtime.composerBuffer,
          cursor: runtime.composerCursor,
          pendingPastes: runtime.composerPastes,
          nextPasteId: runtime.composerNextPasteId,
          pasted: runtime.composerPasteBuffer,
        });
        runtime.composerBuffer = inserted.buffer;
        runtime.composerCursor = inserted.cursor;
        runtime.composerPastes = inserted.pendingPastes;
        runtime.composerNextPasteId = inserted.nextPasteId;
        runtime.composerPasteBuffer = null;
        render(true);
        return;
      }
      runtime.composerPasteBuffer += pastedKeyText(text, key);
      return;
    }
    if (key.ctrl && key.name === "t") {
      runtime.screenPaused = !runtime.screenPaused;
      runtime.notice = runtime.screenPaused ? "Screen frozen for copying" : "Screen updates resumed";
      render(true);
      return;
    }
    const scrollDirection = reviewScrollDirection(text, key);
    if (scrollDirection) {
      scrollRuntimeContent(runtime, scrollDirection);
      render(true);
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (runtime.composerBuffer) {
        runtime.composerBuffer = "";
        runtime.composerCursor = 0;
        runtime.composerPastes = [];
        showNotice("Input cleared");
        return;
      }
      if (runtime.snapshot?.run?.state === "completed") {
        showNotice("Result preserved · type a follow-up, /new, or /exit");
        return;
      }
      onActiveInterrupt();
      return;
    }
    if (key.ctrl && key.name === "d" && runtime.snapshot?.run?.state === "completed") {
      runtime.exitRequested = true;
      completedInputResolve?.("exit");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const objectiveText = expandComposerPastes(
        runtime.composerBuffer,
        runtime.composerPastes,
      ).trim();
      if (!objectiveText) {
        if (runtime.snapshot?.run?.state === "completed") {
          showNotice("Type a follow-up to continue with this team · /new starts fresh");
        }
        return;
      }
      if (runtime.snapshot?.run?.state === "completed" && ["/exit", "/quit"].includes(objectiveText.toLowerCase())) {
        runtime.exitRequested = true;
        runtime.composerBuffer = "";
        runtime.composerCursor = 0;
        runtime.composerPastes = [];
        completedInputResolve?.("exit");
        return;
      }
      if (runtime.snapshot?.run?.state === "completed" && objectiveText.toLowerCase() === "/new") {
        runtime.returnToHome = true;
        runtime.composerBuffer = "";
        runtime.composerCursor = 0;
        runtime.composerPastes = [];
        completedInputResolve?.("new");
        return;
      }
      runtime.queuedObjective = objectiveText;
      runtime.composerBuffer = "";
      runtime.composerCursor = 0;
      runtime.composerPastes = [];
      if (runtime.snapshot?.run?.state === "completed") {
        runtime.notice = "Follow-up accepted · continuing with the same team";
        render(true);
        completedInputResolve?.("follow_up");
      } else {
        showNotice("Next objective queued");
      }
      return;
    }
    const chars = [...runtime.composerBuffer];
    if (key.name === "backspace") {
      if (runtime.composerCursor > 0) {
        chars.splice(runtime.composerCursor - 1, 1);
        runtime.composerCursor -= 1;
        runtime.composerBuffer = chars.join("");
        runtime.composerPastes = pruneComposerPastes(runtime.composerBuffer, runtime.composerPastes);
      }
      render();
      return;
    }
    if (key.name === "delete") {
      if (runtime.composerCursor < chars.length) {
        chars.splice(runtime.composerCursor, 1);
        runtime.composerBuffer = chars.join("");
        runtime.composerPastes = pruneComposerPastes(runtime.composerBuffer, runtime.composerPastes);
      }
      render();
      return;
    }
    if (key.name === "left") {
      runtime.composerCursor = Math.max(0, runtime.composerCursor - 1);
      render();
      return;
    }
    if (key.name === "right") {
      runtime.composerCursor = Math.min(chars.length, runtime.composerCursor + 1);
      render();
      return;
    }
    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      runtime.composerCursor = 0;
      render();
      return;
    }
    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      runtime.composerCursor = chars.length;
      render();
      return;
    }
    if (key.ctrl && key.name === "u") {
      runtime.composerBuffer = "";
      runtime.composerCursor = 0;
      runtime.composerPastes = [];
      render();
      return;
    }
    if ((key.shift && key.name === "tab") || key.sequence === "\x1b[Z") {
      showNotice("Team mode is fixed for the current Run");
      return;
    }
    if (key.name === "escape" || key.ctrl || key.meta) return;
    if (text && !isFunctionKey(key)) {
      text = cleanInsertedText(text);
      if (!text) return;
      chars.splice(runtime.composerCursor, 0, ...text);
      runtime.composerBuffer = chars.join("");
      runtime.composerCursor += [...text].length;
      render();
    }
  };
  input.on("keypress", onActiveKeypress);
  const applyRuntimeUpdate = (update) => {
    if (update.phase) runtime.phase = update.phase;
    if (Number.isFinite(update.connectionAttempts)) runtime.connectionAttempts = update.connectionAttempts;
    if (typeof update.message === "string") runtime.notice = update.message;
    if (update.payload) runtime.configuration = update.payload;
    if (update.snapshot) {
      runtime.snapshot = update.snapshot;
      if (runtime.phase === "reconnecting" && runtime.connectionAttempts === 0) {
        const state = update.snapshot.run?.state;
        runtime.phase = ["planning", "created", "designing", "researching", "decomposing"].includes(state)
          ? "planning"
          : ["running", "queued"].includes(state) ? "executing" : state || "working";
      }
    }
    if (update.events?.length) {
      const eventKey = (event, index) => event.sequence ?? event.event_id
        ?? `${event.type || "event"}:${event.created_at || ""}:${event.summary || ""}:${index}`;
      const merged = new Map(runtime.events.map((event, index) => [eventKey(event, index), event]));
      for (const [index, event] of update.events.entries()) merged.set(eventKey(event, index), event);
      runtime.events = [...merged.values()].sort(
        (a, b) => Number(a.sequence || 0) - Number(b.sequence || 0),
      ).slice(-200);
      if (runtime.autoFollow === false) runtime.unseenActivityCount += update.events.length;
    }
    scheduleRender();
  };
  const reviewPlan = async (snapshotForReview) => {
    runtime.snapshot = snapshotForReview;
    runtime.phase = "awaiting_confirmation";
    runtime.composerBuffer = "";
    runtime.composerPastes = [];
    const decision = await readRuntimeDecision({ input, runtime, render, kind: "plan" });
    if (decision === "leave") runtime.detachRequested = true;
    return decision;
  };
  const reviewAttention = async (attention, snapshotForReview) => {
    runtime.snapshot = snapshotForReview;
    runtime.attention = attention;
    runtime.attentionSelection = 0;
    runtime.phase = "blocked";
    runtime.composerBuffer = "";
    runtime.composerPastes = [];
    const decision = await readRuntimeDecision({ input, runtime, render, kind: "attention" });
    runtime.attention = null;
    if (decision === "leave") runtime.detachRequested = true;
    return decision;
  };
  const reviewPause = async (snapshotForReview) => {
    runtime.snapshot = snapshotForReview;
    runtime.phase = "paused";
    runtime.composerBuffer = "";
    runtime.composerPastes = [];
    const decision = await readRuntimeDecision({ input, runtime, render, kind: "paused" });
    if (decision === "leave") runtime.detachRequested = true;
    return decision;
  };
  let followExistingRun = false;
  try {
    while (true) {
      try {
        if (collaborationRunner !== handleCollaborationCommand) {
          await collaborationRunner(collaborationArgs({ objective, coordinator, mode, forwarded }), {
            signal: controller.signal,
            onRunId: (runId) => {
              runtime.runId = runId || runtime.runId;
            },
          });
          runtime.phase = "completed";
          runtime.snapshot = { run: { state: "completed" }, tasks: [], final_report: null };
          return runtime;
        }
        const confirmation = forwarded.includes("--yes")
          ? "always"
          : forwarded.includes("--review") ? "never" : "safe";
        const followerOptions = {
          signal: controller.signal,
          onUpdate: applyRuntimeUpdate,
          onPlanConfirmation: reviewPlan,
          onAttention: reviewAttention,
          onPaused: reviewPause,
        };
        let snapshot;
        if (followExistingRun) {
          followExistingRun = false;
          snapshot = await followRunner(runtime.runId, followerOptions);
        } else {
          snapshot = await workspaceRunner({
            objective,
            workspaceMode: mode,
            coordinator,
            cloudAdvice: mode === "auto" || forwarded.includes("--cloud-advice"),
            presetConfiguration: continuedConfiguration,
            continuedFromRunId,
            workspaceSelections,
            deviceSelections: runtime.deviceSelections,
            confirmation,
            signal: controller.signal,
            onRunId: (runId) => {
              runtime.runId = runId || runtime.runId;
              render(true);
            },
            onUpdate: applyRuntimeUpdate,
            onConfigurationConfirmation: async (configuration) => {
              runtime.configuration = configuration;
              runtime.phase = "awaiting_configuration";
              runtime.composerBuffer = "";
              runtime.composerPastes = [];
              const decision = await readRuntimeDecision({ input, runtime, render, kind: "configuration" });
              if (decision !== "confirm") runtime.draftObjective = objective;
              return decision;
            },
            onPlanConfirmation: reviewPlan,
            onAttention: reviewAttention,
            onPaused: reviewPause,
          });
        }
        let currentSnapshot = snapshot;
        let unexpectedFollowReturns = 0;
        while (
          runtime.runId
          && currentSnapshot?.run
          && !TERMINAL_WORKSPACE_RUN_STATES.has(currentSnapshot.run.state)
          && !runtime.detachRequested
        ) {
          unexpectedFollowReturns += 1;
          if (unexpectedFollowReturns > 3) {
            throw new Error(`The collaboration follow stream ended repeatedly while Run ${runtime.runId} was still active.`);
          }
          runtime.snapshot = currentSnapshot;
          runtime.phase = currentSnapshot.run.state || "executing";
          runtime.notice = "Run is still active · restoring the live connection";
          render(true);
          currentSnapshot = await followRunner(runtime.runId, followerOptions);
        }
        runtime.snapshot = currentSnapshot;
        runtime.phase = currentSnapshot?.run?.state || "completed";
        if (runtime.phase === "completed" && !runtime.queuedObjective) {
          runtime.interaction = false;
          runtime.interactionKind = "";
          runtime.notice = "Result preserved · Enter continues with this team · /new starts fresh · /exit exits";
          render(true);
          await new Promise((resolve) => {
            completedInputResolve = resolve;
          });
          completedInputResolve = null;
          return runtime;
        }
        while (["completed", "failed", "cancelled", "expired"].includes(runtime.phase) && !runtime.queuedObjective) {
          const decision = await readRuntimeDecision({ input, runtime, render, kind: "completion" });
          if (decision !== "retry" || !runtime.runId) break;
          runtime.phase = "planning";
          runtime.error = null;
          runtime.events = [];
          currentSnapshot = await retryRunner(runtime.runId, {
            signal: controller.signal,
            onUpdate: applyRuntimeUpdate,
            onPlanConfirmation: reviewPlan,
            onAttention: reviewAttention,
            onPaused: reviewPause,
          });
          runtime.snapshot = currentSnapshot;
          runtime.phase = currentSnapshot?.run?.state || "failed";
        }
        return runtime;
      } catch (error) {
        if (isInterrupted(error)) {
          runtime.phase = "interrupted";
          runtime.snapshot = runtime.snapshot || { run: { state: "cancelled" }, tasks: [] };
          return runtime;
        }
        if (
          runtime.runId
          && (error?.code === "COLLABORATION_FOLLOW_RECONNECT_EXHAUSTED"
            || error?.diagnosticCode === "COLLABORATION_FOLLOW_RECONNECT_EXHAUSTED")
        ) {
          runtime.phase = "connection_paused";
          runtime.connectionAttempts = MAX_COLLABORATION_RECONNECT_ATTEMPTS;
          runtime.error = error;
          runtime.notice = "";
          const decision = await readRuntimeDecision({ input, runtime, render, kind: "reconnect" });
          if (decision === "reconnect") {
            runtime.phase = "reconnecting";
            runtime.connectionAttempts = 0;
            runtime.error = null;
            runtime.notice = "Reconnecting to the same Run";
            followExistingRun = true;
            render(true);
            continue;
          }
          if (decision === "interrupt") {
            runtime.error = null;
            onActiveInterrupt();
            return runtime;
          }
          runtime.detachRequested = true;
          runtime.error = null;
          return runtime;
        }
        if (error?.code === "AUTO_CONFIG_REMOTE_DEVICE_SELECTION_REQUIRED" && error.setup) {
          runtime.phase = "needs_device";
          runtime.setup = error.setup;
          runtime.deviceSelection = 0;
          runtime.deviceSelections = runtime.deviceSelections.filter((deviceId) => (
            error.setup.devices.some((device) => device.device_id === deviceId)
          ));
          runtime.error = null;
          runtime.notice = "";
          const selected = await readRuntimeDecision({
            input,
            runtime,
            render,
            kind: "device",
          });
          if (!selected) {
            runtime.phase = "cancelled";
            runtime.draftObjective = objective;
            return runtime;
          }
          runtime.deviceSelections = selected;
          runtime.phase = "configuring";
          runtime.setup = null;
          continue;
        }
        if (["AUTO_CONFIG_WORKSPACE_REQUIRED", "AUTO_CONFIG_REMOTE_WORKSPACE_REQUIRED"].includes(error?.code) && error.setup) {
          runtime.phase = "needs_setup";
          runtime.setup = error.setup;
          // The device default is a hint, not prefilled user input. Keeping
          // it out of the editable buffer prevents accidental insertion at a
          // surprising cursor position when the user starts typing a path.
          runtime.setupPath = "";
          runtime.setupCursor = 0;
          runtime.setupSelection = 0;
          runtime.error = null;
          const workspaces = error.setup.workspaces || [];
          runtime.setupMode = workspaces.length ? "workspace" : "path";
          let selected = await readRuntimeDecision({
            input,
            runtime,
            render,
            kind: workspaces.length ? "workspace" : "setup",
            browseWorkspaceFn,
          });
          while (true) {
            if (!selected) {
              runtime.phase = "cancelled";
              runtime.draftObjective = objective;
              return runtime;
            }
            if (selected === "__custom_workspace_path__") {
              runtime.setupMode = "path";
              runtime.setupPath = "";
              runtime.setupCursor = 0;
              selected = await readRuntimeDecision({
                input,
                runtime,
                render,
                kind: "setup",
                browseWorkspaceFn,
              });
              continue;
            }
            if (typeof selected === "object") {
              workspaceSelections[error.setup.device_id] = selected.workspace_id || selected.canonical_path;
              break;
            }
            try {
              runtime.phase = "configuring";
              render(true);
              const workspace = await trustWorkspaceFn(
                error.setup.device_id,
                selected,
                { signal: controller.signal },
              );
              workspaceSelections[error.setup.device_id] = workspace.workspace_id
                || workspace.canonical_path
                || selected;
              break;
            } catch (authorizationError) {
              if (isInterrupted(authorizationError)) throw authorizationError;
              runtime.phase = "needs_setup";
              runtime.setupMode = "path";
              runtime.setupPath = String(selected);
              runtime.setupCursor = [...runtime.setupPath].length;
              runtime.notice = `Could not authorize folder: ${String(authorizationError.message || authorizationError).split("\n")[0]}`;
              selected = await readRuntimeDecision({
                input,
                runtime,
                render,
                kind: "setup",
                browseWorkspaceFn,
              });
            }
          }
          runtime.phase = "configuring";
          runtime.setup = null;
          runtime.setupPath = "";
          runtime.notice = "";
          continue;
        }
        runtime.phase = "error";
        runtime.error = error;
        if (!runtime.runId) runtime.draftObjective = objective;
        return runtime;
      }
    }
  } finally {
    process.removeListener("SIGINT", onActiveInterrupt);
    input.off("keypress", onActiveKeypress);
    if (noticeTimer) clearTimeout(noticeTimer);
    input.setRawMode(false);
    input.pause();
    output.off?.("resize", onResize);
    clearInterval(timer);
    frameScheduler.dispose();
    await cancelPromise;
    render(true);
  }
}

export async function handleAgentWorkspaceCommand(argv = [], {
  input = defaultInput,
  output = defaultOutput,
  collaborationRunner = handleCollaborationCommand,
  workspaceRunner = runAgentWorkspaceCollaboration,
  followRunner = followExistingAgentWorkspaceCollaboration,
  retryRunner = retryAgentWorkspaceCollaboration,
  cancelCollaborationRun = async (runId) => controlCollaborationRun(runId, "cancel"),
  trustWorkspaceFn = trustCollaborationWorkspace,
  browseWorkspaceFn = browseCollaborationWorkspaces,
} = {}) {
  const parsed = parseAgentWorkspaceArgs(argv);
  if (parsed.objective && (!input.isTTY || !output.isTTY)) {
    await collaborationRunner(collaborationArgs(parsed));
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Agent Workspace requires an interactive terminal when no objective is provided.");
  }
  let coordinator = parsed.coordinator;
  let mode = parsed.mode;
  let panel = null;
  let pendingObjective = parsed.objective;
  let draftObjective = "";
  let continuedConfiguration = null;
  let continuedFromRunId = "";
  const sessionHistory = [];
  const exitApp = enterWorkspaceApp(output);
  try {
    redrawWorkspaceApp(output, { coordinator, mode, panel });
    while (true) {
      const line = pendingObjective || await readWorkspaceLine({
          input,
          output,
          mode,
          coordinator,
          panel,
          initialBuffer: draftObjective,
          onModeChange: () => {
            const next = nextWorkspaceMode(mode);
            mode = next.id;
            panel = null;
            return next;
          },
        });
      pendingObjective = "";
      draftObjective = "";
      if (!line) {
        redrawWorkspaceApp(output, { coordinator, mode, panel, force: true });
        continue;
      }
      if (["/exit", "/quit", "exit", "quit"].includes(line.toLowerCase())) return;
      if (line === "/help") {
        panel = helpWorkspacePanel();
        redrawWorkspaceApp(output, { coordinator, mode, panel });
        continue;
      }
      if (line === "/mode") {
        panel = modesWorkspacePanel();
        redrawWorkspaceApp(output, { coordinator, mode, panel });
        continue;
      }
      if (line.startsWith("/mode ")) {
        mode = normalizeWorkspaceMode(line.slice(6));
        panel = teamWorkspacePanel({ coordinator, mode });
        redrawWorkspaceApp(output, { coordinator, mode, panel });
        continue;
      }
      if (line === "/team") {
        panel = teamWorkspacePanel({ coordinator, mode });
        redrawWorkspaceApp(output, { coordinator, mode, panel });
        continue;
      }
      if (line.startsWith("/coordinator ")) {
        coordinator = normalizeCoordinator(line.slice(13));
        panel = teamWorkspacePanel({ coordinator, mode });
        redrawWorkspaceApp(output, { coordinator, mode, panel });
        continue;
      }
      panel = null;
      const runtime = await runWorkspaceObjective({
        objective: line,
        continuedConfiguration,
        continuedFromRunId,
        sessionHistory,
        coordinator,
        mode,
        forwarded: parsed.forwarded,
        input,
        output,
        collaborationRunner,
        workspaceRunner,
        followRunner,
        retryRunner,
        cancelCollaborationRun,
        trustWorkspaceFn,
        browseWorkspaceFn,
      });
      if (runtime.exitRequested) return;
      if (runtime.returnToHome) {
        panel = completionPanel(runtime);
        pendingObjective = "";
        draftObjective = "";
        continuedConfiguration = null;
        continuedFromRunId = "";
        sessionHistory.splice(0, sessionHistory.length);
        redrawWorkspaceApp(output, { coordinator, mode, panel, force: true });
        continue;
      }
      panel = completionPanel(runtime);
      if (runtime.snapshot?.run?.state === "completed" && runtime.runId) {
        sessionHistory.push({
          runId: runtime.runId,
          objective: runtime.objective,
          summary: runtime.snapshot?.final_report?.summary || "Collaboration completed.",
        });
        if (sessionHistory.length > 20) sessionHistory.splice(0, sessionHistory.length - 20);
      }
      pendingObjective = runtime.queuedObjective || "";
      draftObjective = pendingObjective ? "" : runtime.draftObjective || "";
      if (pendingObjective && runtime.configuration) {
        continuedConfiguration = continuedTeamConfiguration(runtime);
        continuedFromRunId = runtime.runId;
      } else {
        continuedConfiguration = null;
        continuedFromRunId = "";
      }
      redrawWorkspaceApp(output, { coordinator, mode, panel, force: true });
    }
  } finally {
    exitApp();
  }
}
