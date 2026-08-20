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
  handleCollaborationCommand,
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

function runtimePhase(runtime) {
  const snapshot = runtime.snapshot;
  const state = snapshot?.run?.state;
  const phase = snapshot?.run?.phase || runtime.phase;
  if (runtime.phase === "needs_setup") {
    return runtime.setup?.workspaces?.length ? "Choose a workspace" : "Workspace authorization required";
  }
  if (runtime.phase === "configuring") return "Choosing the Agent team";
  if (runtime.phase === "awaiting_configuration") return "Review the proposed team";
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

  const configured = runtime.configuration;
  if (configured) {
    const resolved = configured.resolved_workspace_mode
      || configured.auto_configuration?.resolved_workspace_mode
      || configured.workspace_mode;
    const deviceCount = new Set((configured.participants || []).map((item) => item.device_id)).size;
    push(`${workspaceModeDefinition(resolved || "auto").label} · ${(configured.participants || []).length} Agent${configured.participants?.length === 1 ? "" : "s"} · ${deviceCount} device${deviceCount === 1 ? "" : "s"}`, muted);
    if (configured.planning_source === "cloud_advice") push("Auto decision: advisory model", muted);
    if (configured.planning_source === "local_fallback") push("Auto decision: local fallback", muted);
  }
  if (runtime.runId) push(`Run ${runtime.runId}`, muted);
  if (runtime.connectionAttempts > 0) {
    push(`Connection interrupted · retry ${runtime.connectionAttempts}/30`, strong);
  }

  if (runtime.phase === "needs_setup" && runtime.setup) {
    const workspaces = runtime.setup.workspaces || [];
    const deviceName = runtime.setup.device_name || runtime.setup.deviceName || "Remote device";
    push("");
    if (workspaces.length && runtime.setupMode !== "path") {
      push(`${deviceName} has multiple authorized workspaces.`, strong);
      push("Choose the folder this collaboration should use.", muted);
      push("");
      const maxVisible = 6;
      const customIndex = workspaces.length;
      const selectedIndex = Math.max(0, Math.min(customIndex, Number(runtime.setupSelection) || 0));
      const start = Math.max(0, Math.min(
        Math.max(0, workspaces.length - maxVisible),
        selectedIndex - Math.floor(maxVisible / 2),
      ));
      const visible = workspaces.slice(start, start + maxVisible);
      if (start > 0) push("  ↑ more workspaces", muted);
      for (const [offset, workspace] of visible.entries()) {
        const index = start + offset;
        const marker = index === selectedIndex ? "›" : " ";
        const displayName = workspace.display_name || workspace.canonical_path || `Workspace ${index + 1}`;
        const path = workspace.canonical_path || workspace.workspace_id || "path unavailable";
        push(`${marker} ${index + 1}. ${displayName}  ${path}`);
      }
      if (start + visible.length < workspaces.length) push("  ↓ more workspaces", muted);
      push(`${selectedIndex === customIndex ? "›" : " "} P. Enter another folder path`);
    } else {
      push(runtime.setupMode === "path"
        ? `${deviceName} folder path`
        : `${deviceName} is online and trusted, but no workspace is authorized.`, strong);
      push(runtime.setup.remote
        ? "Authorize a folder before a remote Agent can inspect this device."
        : "Authorize a folder before an Agent can work in this workspace.", muted);
      if (runtime.setupMode === "path") {
        push(runtime.setupPath
          ? "The folder path is being edited below."
          : `Type the folder path below. Example: ${runtime.setup.default_path || "/path/to/workspace"}`, muted);
        if (runtime.setupBrowseLoading) push("Searching folders…", muted);
        const suggestions = runtime.setupSuggestions || [];
        if (suggestions.length) {
          push("");
          push("Matching folders", strong);
          for (const [index, suggestion] of suggestions.slice(0, 6).entries()) {
            const marker = index === runtime.setupSuggestionSelection ? "›" : " ";
            push(`${marker} ${suggestion.path || suggestion.name}`);
          }
          push("Tab completes the selected folder.", muted);
        } else if (runtime.setupBrowseError) {
          push(`Folder suggestions unavailable: ${runtime.setupBrowseError}`, muted);
        }
      }
    }
  } else if (runtime.phase === "awaiting_configuration" && configured) {
    push("");
    push("Proposed collaboration team", strong);
    const advice = configured.auto_configuration?.advice;
    if (advice?.reason) push(advice.reason, muted);
    push(`Risk ${configured.risk_tier || "green"} · ${configured.planning_source === "cloud_advice" ? "advisory model" : "local policy"}`, muted);
    for (const participant of configured.participants || []) {
      const runtimeName = participant.runtime === "claude" ? "Claude Code" : "Codex";
      push(`${participant.planner ? "●" : "○"} ${participant.display_name || participant.participant_id} · ${runtimeName}`, strong);
      push(`  ${participant.device_id} · ${participant.workspace_id || "workspace pending"} · ${participant.permission_profile || "manual"}`, muted);
      if (participant.role_hint) push(`  ${participant.role_hint}`, muted);
    }
  } else if (runtime.interactionKind === "attention" && runtime.attention) {
    push("");
    push(runtime.attention.title || "Agent needs your input", strong);
    if (runtime.attention.summary) push(runtime.attention.summary, muted);
    if (runtime.attention.risk) push(`Risk: ${runtime.attention.risk}`, muted);
    push("");
    for (const [index, action] of (runtime.attention.actions || []).entries()) {
      push(`${index === runtime.attentionSelection ? "›" : " "} ${index + 1}. ${action}`);
    }
  } else if (runtime.interactionKind === "paused") {
    push("");
    push("This collaboration is paused.", strong);
    push(runtime.snapshot?.run?.pause_reason || "The OriginRouter service is preserving the Run state.", muted);
    if (runtime.snapshot?.run?.account_budget_blocked) {
      push("The account or device budget must be changed before this Run can resume.", muted);
    }
  } else if (runtime.error) {
    push("");
    push(String(runtime.error.message || runtime.error).split("\n")[0], strong);
  }

  const plan = runtime.snapshot?.plan;
  if (runtime.snapshot?.run?.state === "awaiting_confirmation" && plan) {
    push("");
    push(plan.title || "Proposed plan", strong);
    if (plan.summary) push(plan.summary, muted);
    for (const [index, task] of (plan.tasks || []).entries()) {
      const dependencies = task.depends_on?.length ? ` · after ${task.depends_on.join(", ")}` : "";
      push(`${index + 1}. ${task.title || task.id} · ${task.participant_id || "unassigned"}${dependencies}`);
      if (task.deliverable) push(`   ${task.deliverable}`, muted);
    }
  }

  const tasks = (runtime.snapshot?.tasks || []).filter((task) => task.task_key !== "__planner__");
  if (tasks.length) {
    push("");
    for (const task of tasks.slice(0, 6)) {
      const taskState = String(task.state || "queued").replaceAll("_", " ");
      push(`${taskMarker(task.state)} ${task.title || task.task_key}  ${muted(`${taskState} · ${task.participant_id || "unassigned"}`)}`);
    }
  }

  const report = runtime.snapshot?.final_report;
  if (report?.summary) {
    push("");
    push(report.summary, runtime.snapshot?.run?.state === "completed" ? strong : null);
    for (const task of (report.completed_tasks || []).slice(0, 3)) {
      if (task.result) push(`  ${task.result}`, muted);
    }
  } else {
    const events = (runtime.events || []).filter((event) => event.visibility !== "diagnostic").slice(-4);
    if (events.length) {
      push("");
      for (const event of events) {
        const summary = event.summary || String(event.type || "activity").replaceAll(".", " ");
        push(`  ${summary}`, muted);
        const detail = String(event.detail || "").trim();
        if (detail && detail !== summary) push(`    ${detail}`, muted);
      }
    }
  }
  runtime.contentLineCount = lines.length;
  const visibleRows = Math.max(0, maxRows);
  const maxStart = Math.max(0, lines.length - visibleRows);
  const start = Math.max(0, Math.min(maxStart, Number(runtime.scrollOffset) || 0));
  return lines.slice(start, start + visibleRows);
}

function runtimeControls(runtime, columns) {
  const mode = workspaceModeDefinition(runtime.mode || "auto").label;
  let text = runtime.notice || "Enter queues next objective · ctrl+c interrupts · ctrl+t freezes · PgUp/PgDn reviews";
  if (runtime.screenPaused) text = "screen frozen for copying · ctrl+t resumes updates";
  if (runtime.queuedObjective) text = "next objective queued · ctrl+c interrupts · ← agents";
  if (runtime.phase === "needs_setup") text = runtime.setup?.workspaces?.length && runtime.setupMode !== "path"
    ? "↑/↓ selects · Enter confirms · type a path · esc cancels"
    : runtime.setup?.workspaces?.length
      ? "Tab completes · Enter authorizes · Ctrl+U clears · Esc back"
      : "Tab completes · Enter authorizes · Ctrl+U clears · Esc cancels";
  if (runtime.phase === "awaiting_configuration") text = "Enter uses this team · PgUp/PgDn reviews · Esc returns to the objective";
  if (runtime.phase === "reconnecting") text = "connection interrupted · retrying automatically · ctrl+c cancels";
  if (runtime.snapshot?.run?.state === "awaiting_confirmation") text = "Enter starts · E requests changes · PgUp/PgDn reviews · Esc leaves pending";
  if (["attention", "attention_reply"].includes(runtime.interactionKind)) text = "Agent is waiting for your response";
  if (["completed", "failed", "cancelled", "error"].includes(runtime.snapshot?.run?.state || runtime.phase)) {
    text = "returning to the objective prompt";
  }
  return padDisplayRight(muted(`  ${mode} · ${text}`), columns);
}

function composerStatus(columns) {
  const status = "● guarded · /access";
  return `${" ".repeat(Math.max(0, columns - promptDisplayWidth(status) - 2))}${accent(status)}  `;
}

function runtimeComposer(runtime, columns) {
  return composerLine(runtime.composerBuffer || "", runtime.composerCursor, columns);
}

function composerLine(value, cursor, columns) {
  const chars = [...String(value || "")];
  const boundedCursor = Math.max(0, Math.min(
    Number.isInteger(cursor) ? cursor : chars.length,
    chars.length,
  ));
  const cursorValue = `${chars.slice(0, boundedCursor).join("")}▌${chars.slice(boundedCursor).join("")}`;
  return padDisplayRight(strong(fitDisplayText(`› ${cursorValue}`, Math.max(1, columns - 1))), columns);
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
  if (kind === "workspace") {
    lines = [
      "? Choose an authorized workspace",
      "↑/↓ select · number selects an item · Enter confirm · P enters a path",
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
      "Enter confirm · PgUp/PgDn review · Esc return to objective",
    ];
  } else if (kind === "plan") {
    lines = [
      "? Start this plan?",
      "Enter start · E request changes · PgUp/PgDn review · Esc leave pending",
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
        ? "R retry this Run · PgUp/PgDn review · Enter return to objective prompt"
        : "PgUp/PgDn review result · Enter return to objective prompt",
    ];
  } else if (kind === "attention") {
    lines = [
      "? Agent needs your decision",
      "↑/↓ select · number selects · Enter confirms · Esc leaves pending",
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
  } else {
    lines = ["? OriginRouter needs your input", "Enter confirm · Esc cancel"];
  }
  const width = Math.max(1, columns - 1);
  return lines.map((line) => padDisplayRight(strong(fitDisplayText(line, width)), columns)).join("\n");
}

function interactionStatus(runtime, columns) {
  const labels = {
    workspace: "selecting workspace",
    setup: "choosing folder",
    configuration: "reviewing team",
    plan: "reviewing plan",
    plan_revision: "requesting plan changes",
    completion: "reviewing result",
    attention: "Agent needs input",
    attention_reply: "replying to Agent",
    paused: "collaboration paused",
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
  const runtimeComposerBlock = runtime
    ? runtime.interaction
      ? interactionComposer(runtime, terminalColumns)
      : runtimeComposer(runtime, terminalColumns)
    : "";
  const reservedRows = runtime
    ? 4 + runtimeComposerBlock.split("\n").length
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
      composerLine(composerBuffer, composerCursor, terminalColumns),
      separator,
      muted("  Enter submits · Ctrl+C clears · Ctrl+D exits · /help for commands"),
    ].join("\n");
  }
  const composer = runtimeComposerBlock;
  const status = runtime.interaction
    ? interactionStatus(runtime, terminalColumns)
    : composerStatus(terminalColumns);
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
  output.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    workspaceScreenCache.delete(output);
    output.write("\x1b[?25h\x1b[?1049l");
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
  let notice = "";
  let exitArmed = false;
  let noticeTimer = null;
  const renderInput = (force = false) => redrawWorkspaceApp(output, {
    coordinator,
    mode,
    panel,
    composerBuffer: buffer,
    composerCursor: cursor,
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
      if (key.ctrl && key.name === "c") {
        if (buffer) {
          buffer = "";
          cursor = 0;
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
        resolve(buffer.trim());
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
        renderInput();
        return;
      }
      if (key.name === "escape" || key.ctrl || key.meta) return;
      if (text && !key.name?.startsWith("f")) {
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
      if (["pageup", "pagedown"].includes(key.name)) {
        const direction = key.name === "pageup" ? -1 : 1;
        const pageSize = 6;
        const maxOffset = Math.max(0, Number(runtime.contentLineCount || 0) - 3);
        runtime.scrollOffset = Math.max(0, Math.min(
          maxOffset,
          Number(runtime.scrollOffset || 0) + direction * pageSize,
        ));
        render(true);
        return;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
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
        finish(["setup", "workspace"].includes(kind) ? null : "leave");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (kind === "workspace") {
          const workspaces = runtime.setup?.workspaces || [];
          finish(runtime.setupSelection >= workspaces.length
            ? "__custom_workspace_path__"
            : workspaces[runtime.setupSelection || 0] || null);
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
          } else {
            finish("confirm");
          }
        }
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
        if (!key.ctrl && !key.meta && text && !key.name?.startsWith("f")) {
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
        } else if (!key.ctrl && !key.meta && text && !key.name?.startsWith("f")) {
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
      } else if (!key.ctrl && !key.meta && text && !key.name?.startsWith("f")) {
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

async function runWorkspaceObjective({
  objective,
  coordinator,
  mode,
  forwarded,
  input,
  output,
  collaborationRunner,
  workspaceRunner = runAgentWorkspaceCollaboration,
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
    runId: "",
    snapshot: null,
    configuration: null,
    setup: null,
    setupPath: "",
    setupCursor: 0,
    setupSelection: 0,
    setupSuggestions: [],
    setupSuggestionSelection: 0,
    setupBrowseLoading: false,
    setupBrowseError: "",
    composerBuffer: "",
    composerCursor: 0,
    queuedObjective: "",
    notice: "",
    interaction: false,
    interactionKind: "",
    error: null,
    connectionAttempts: 0,
    animationFrame: 0,
    scrollOffset: 0,
    contentLineCount: 0,
    decisionBuffer: "",
    decisionCursor: 0,
    draftObjective: "",
    screenPaused: false,
    attention: null,
    attentionSelection: 0,
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
    if (key.ctrl && key.name === "t") {
      runtime.screenPaused = !runtime.screenPaused;
      runtime.notice = runtime.screenPaused ? "Screen frozen for copying" : "Screen updates resumed";
      render(true);
      return;
    }
    if (["pageup", "pagedown"].includes(key.name)) {
      const direction = key.name === "pageup" ? -1 : 1;
      const maxOffset = Math.max(0, Number(runtime.contentLineCount || 0) - 3);
      runtime.scrollOffset = Math.max(0, Math.min(
        maxOffset,
        Number(runtime.scrollOffset || 0) + direction * 6,
      ));
      render(true);
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (runtime.composerBuffer) {
        runtime.composerBuffer = "";
        runtime.composerCursor = 0;
        showNotice("Input cleared");
        return;
      }
      onActiveInterrupt();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const objectiveText = runtime.composerBuffer.trim();
      if (!objectiveText) return;
      runtime.queuedObjective = objectiveText;
      runtime.composerBuffer = "";
      runtime.composerCursor = 0;
      showNotice("Next objective queued");
      return;
    }
    const chars = [...runtime.composerBuffer];
    if (key.name === "backspace") {
      if (runtime.composerCursor > 0) {
        chars.splice(runtime.composerCursor - 1, 1);
        runtime.composerCursor -= 1;
        runtime.composerBuffer = chars.join("");
      }
      render();
      return;
    }
    if (key.name === "delete") {
      if (runtime.composerCursor < chars.length) {
        chars.splice(runtime.composerCursor, 1);
        runtime.composerBuffer = chars.join("");
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
      render();
      return;
    }
    if ((key.shift && key.name === "tab") || key.sequence === "\x1b[Z") {
      showNotice("Team mode is fixed for the current Run");
      return;
    }
    if (key.name === "escape" || key.ctrl || key.meta) return;
    if (text && !key.name?.startsWith("f")) {
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
      ).slice(-20);
    }
    scheduleRender();
  };
  const reviewPlan = async (snapshotForReview) => {
    runtime.snapshot = snapshotForReview;
    runtime.phase = "awaiting_confirmation";
    runtime.composerBuffer = "";
    return readRuntimeDecision({ input, runtime, render, kind: "plan" });
  };
  const reviewAttention = async (attention, snapshotForReview) => {
    runtime.snapshot = snapshotForReview;
    runtime.attention = attention;
    runtime.attentionSelection = 0;
    runtime.phase = "blocked";
    runtime.composerBuffer = "";
    const decision = await readRuntimeDecision({ input, runtime, render, kind: "attention" });
    runtime.attention = null;
    return decision;
  };
  const reviewPause = async (snapshotForReview) => {
    runtime.snapshot = snapshotForReview;
    runtime.phase = "paused";
    runtime.composerBuffer = "";
    return readRuntimeDecision({ input, runtime, render, kind: "paused" });
  };
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
        const snapshot = await workspaceRunner({
          objective,
          workspaceMode: mode,
          coordinator,
          cloudAdvice: mode === "auto" || forwarded.includes("--cloud-advice"),
          workspaceSelections,
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
            const decision = await readRuntimeDecision({ input, runtime, render, kind: "configuration" });
            if (decision !== "confirm") runtime.draftObjective = objective;
            return decision;
          },
          onPlanConfirmation: reviewPlan,
          onAttention: reviewAttention,
          onPaused: reviewPause,
        });
        let currentSnapshot = snapshot;
        runtime.snapshot = currentSnapshot;
        runtime.phase = currentSnapshot?.run?.state || "completed";
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
        coordinator,
        mode,
        forwarded: parsed.forwarded,
        input,
        output,
        collaborationRunner,
        workspaceRunner,
        retryRunner,
        cancelCollaborationRun,
        trustWorkspaceFn,
        browseWorkspaceFn,
      });
      panel = completionPanel(runtime);
      pendingObjective = runtime.queuedObjective || "";
      draftObjective = pendingObjective ? "" : runtime.draftObjective || "";
      redrawWorkspaceApp(output, { coordinator, mode, panel, force: true });
    }
  } finally {
    exitApp();
  }
}
