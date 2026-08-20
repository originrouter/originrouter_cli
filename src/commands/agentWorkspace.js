import { cwd, stdin as defaultInput, stdout as defaultOutput } from "node:process";
import {
  clearScreenDown,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";

import {
  controlCollaborationRun,
  handleCollaborationCommand,
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
  if (runtime.phase === "needs_setup") return "Setup required";
  if (runtime.phase === "configuring") return "Choosing the Agent team";
  if (runtime.phase === "awaiting_configuration") return "Review the proposed team";
  if (state === "awaiting_confirmation") return "Plan ready for review";
  if (state === "completed") return "Completed";
  if (state === "failed") return "Failed";
  if (state === "cancelled") return "Cancelled";
  if (state === "paused") return "Paused";
  if (state === "blocked") return "Needs attention";
  if (["planning", "created"].includes(state) || runtime.phase === "planning") return "Planner is preparing the work";
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
      lines.push(`  ${style ? style(row) : row}`);
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
    : SPINNER_FRAMES[Math.floor(Date.now() / 100) % SPINNER_FRAMES.length];
  push(`${spinner} ${runtimePhase(runtime)}${runtime.startedAt ? ` (${elapsedText(runtime.startedAt)})` : ""}`, strong);

  const configured = runtime.configuration;
  if (configured) {
    const resolved = configured.resolved_workspace_mode
      || configured.auto_configuration?.resolved_workspace_mode
      || configured.workspace_mode;
    const deviceCount = new Set((configured.participants || []).map((item) => item.device_id)).size;
    push(`${workspaceModeDefinition(resolved || "auto").label} · ${(configured.participants || []).length} Agent${configured.participants?.length === 1 ? "" : "s"} · ${deviceCount} device${deviceCount === 1 ? "" : "s"}`, muted);
  }
  if (runtime.runId) push(`Run ${runtime.runId}`, muted);

  if (runtime.phase === "needs_setup" && runtime.setup) {
    push("");
    push(`${runtime.setup.device_name} is online and trusted, but no workspace is authorized.`, strong);
    push(runtime.setup.remote
      ? "Authorize a folder before a remote Agent can inspect this device."
      : "Authorize a folder before an Agent can work in this workspace.", muted);
    push("");
    push(`Folder  ${runtime.setupPath || runtime.setup.default_path || "Enter a path"}▌`);
  } else if (runtime.error) {
    push("");
    push(String(runtime.error.message || runtime.error).split("\n")[0], strong);
  }

  const plan = runtime.snapshot?.plan;
  if (runtime.snapshot?.run?.state === "awaiting_confirmation" && plan) {
    push("");
    push(plan.title || "Proposed plan", strong);
    if (plan.summary) push(plan.summary, muted);
  }

  const tasks = (runtime.snapshot?.tasks || []).filter((task) => task.task_key !== "__planner__");
  if (tasks.length) {
    push("");
    for (const task of tasks.slice(0, 6)) {
      push(`${taskMarker(task.state)} ${task.title || task.task_key}  ${muted(task.participant_id || "unassigned")}`);
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
      for (const event of events) push(`  ${event.summary || String(event.type || "activity").replaceAll(".", " ")}`, muted);
    }
  }
  return lines.slice(0, Math.max(0, maxRows));
}

function runtimeControls(runtime, columns) {
  const mode = workspaceModeDefinition(runtime.mode || "auto").label;
  let text = runtime.notice || "Enter queues next objective · ctrl+c interrupts · ← agents";
  if (runtime.queuedObjective) text = "next objective queued · ctrl+c interrupts · ← agents";
  if (runtime.phase === "needs_setup") text = "Enter authorizes this folder · esc cancels";
  if (runtime.phase === "awaiting_configuration") text = "Enter uses this team · esc cancels before creating a Run";
  if (runtime.snapshot?.run?.state === "awaiting_confirmation") text = "Enter starts the plan · esc leaves it pending";
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
  let value = runtime.composerBuffer || "";
  if (runtime.phase === "needs_setup") value = runtime.setupPath || runtime.setup?.default_path || "";
  const prompt = `› ${value}`;
  return padDisplayRight(strong(fitDisplayText(prompt, Math.max(1, columns - 1))), columns);
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
} = {}) {
  const terminalColumns = Math.max(40, Number(columns) || 80);
  const terminalRows = Math.max(14, Number(rows) || 24);
  const frameWidth = Math.max(56, Math.min(terminalColumns, 96) - 2);
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

  const headerRows = [
    titleLine("OriginRouter", frameWidth),
    appLine("", contentWidth),
    ...detailRows,
    bottomLine(frameWidth),
  ];
  const reservedRows = 5;
  const activityRows = runtime
    ? buildRuntimeRows(runtime, terminalColumns, Math.max(3, terminalRows - headerRows.length - reservedRows))
    : [];
  const screenRows = [...headerRows, ...activityRows];
  const separator = border("─".repeat(terminalColumns));
  const blankRows = Math.max(0, terminalRows - screenRows.length - reservedRows);
  const body = `${screenRows.join("\n")}\n${"\n".repeat(blankRows)}`;
  if (!runtime) return `${body}${composerStatus(terminalColumns)}\n${separator}\n`;
  return [
    `${body}${composerStatus(terminalColumns)}`,
    separator,
    runtimeComposer(runtime, terminalColumns),
    separator,
    runtimeControls(runtime, terminalColumns),
  ].join("\n");
}

function redrawWorkspaceApp(output, { coordinator, mode, panel = null, runtime = null }) {
  output.write("\x1b[2J\x1b[H");
  output.write(buildWorkspaceAppScreen({
    coordinator,
    mode,
    panel,
    runtime,
    columns: output.columns,
    rows: output.rows,
  }));
}

function supportsAppScreen(output) {
  return Boolean(output?.isTTY) && process.env.TERM !== "dumb";
}

function enterWorkspaceApp(output) {
  if (!supportsAppScreen(output)) return () => {};
  output.write("\x1b[?1049h\x1b[H\x1b[2J");
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    output.write("\x1b[?1049l");
  };
  process.once("exit", exit);
  return () => {
    process.off("exit", exit);
    exit();
  };
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

async function readWorkspaceLine({ input, output, mode, coordinator, panel, onModeChange }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive Agent Workspace requires a terminal. Pass an objective, for example: originrouter \"fix the failing test\"");
  }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let buffer = "";
  let notice = "";
  let exitArmed = false;
  let noticeTimer = null;
  let renderedRows = redrawPrompt(output, buffer, mode, 0, { notice });
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
        renderedRows = redrawPrompt(output, buffer, mode, renderedRows, { notice });
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
      input.setRawMode(false);
      input.pause();
    };
    const redrawLine = () => {
      redrawWorkspaceApp(output, { coordinator, mode, panel });
      renderedRows = redrawPrompt(output, buffer, mode, 0, { notice });
    };
    const onResize = () => {
      redrawLine();
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        if (buffer) {
          buffer = "";
          exitArmed = false;
          notice = "Input cleared";
          renderedRows = redrawPrompt(output, buffer, mode, renderedRows, { notice });
          clearNoticeLater(800);
          return;
        }
        if (exitArmed) {
          cleanup();
          output.write("\n");
          resolve("/exit");
          return;
        }
        exitArmed = true;
        notice = "Press Ctrl+C again to exit";
        renderedRows = redrawPrompt(output, buffer, mode, renderedRows, { notice });
        clearNoticeLater(500);
        return;
      }
      if (key.ctrl && key.name === "d" && !buffer) {
        cleanup();
        output.write("\n");
        resolve("/exit");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(buffer.trim());
        return;
      }
      if ((key.shift && key.name === "tab") || key.sequence === "\x1b[Z") {
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        mode = onModeChange().id;
        redrawLine();
        return;
      }
      if (key.name === "backspace") {
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        buffer = [...buffer].slice(0, -1).join("");
        renderedRows = redrawPrompt(output, buffer, mode, renderedRows, { notice });
        return;
      }
      if (key.name === "escape" || key.ctrl || key.meta) return;
      if (text && !key.name?.startsWith("f")) {
        clearNoticeTimer();
        notice = "";
        exitArmed = false;
        buffer += text;
        renderedRows = redrawPrompt(output, buffer, mode, renderedRows, { notice });
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

async function readRuntimeDecision({ input, runtime, render, kind }) {
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  runtime.interaction = true;
  let buffer = kind === "setup" ? String(runtime.setupPath || "") : "";
  runtime.setupPath = buffer;
  render();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.off("error", onError);
      runtime.interaction = false;
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
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(kind === "setup" ? null : "leave");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(kind === "setup" ? buffer.trim() || null : "confirm");
        return;
      }
      if (kind !== "setup") return;
      if (key.name === "backspace") {
        buffer = [...buffer].slice(0, -1).join("");
      } else if (!key.ctrl && !key.meta && text && !key.name?.startsWith("f")) {
        buffer += text;
      } else {
        return;
      }
      runtime.setupPath = buffer;
      render();
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
      runtime.runId ? "Use collaboration retry to continue from this Run." : "Enter another objective below.",
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
  cancelCollaborationRun,
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
    composerBuffer: "",
    queuedObjective: "",
    notice: "",
    interaction: false,
    error: null,
  };
  const render = () => redrawWorkspaceApp(output, {
    coordinator,
    mode,
    panel: runtimeHeaderPanel(runtime),
    runtime,
  });
  const onResize = () => render();
  const timer = setInterval(render, 250);
  timer.unref?.();
  output.on?.("resize", onResize);
  render();

  const controller = new AbortController();
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
    render();
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
      render();
    }, duration);
    noticeTimer.unref?.();
    render();
  };
  const onActiveKeypress = (text, key = {}) => {
    if (runtime.interaction) return;
    if (key.ctrl && key.name === "c") {
      onActiveInterrupt();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const objectiveText = runtime.composerBuffer.trim();
      if (!objectiveText) return;
      runtime.queuedObjective = objectiveText;
      runtime.composerBuffer = "";
      showNotice("Next objective queued");
      return;
    }
    if (key.name === "backspace") {
      runtime.composerBuffer = [...runtime.composerBuffer].slice(0, -1).join("");
      render();
      return;
    }
    if ((key.shift && key.name === "tab") || key.sequence === "\x1b[Z") {
      showNotice("Team mode is fixed for the current Run");
      return;
    }
    if (key.name === "escape" || key.ctrl || key.meta) return;
    if (text && !key.name?.startsWith("f")) {
      runtime.composerBuffer += text;
      render();
    }
  };
  input.on("keypress", onActiveKeypress);
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
        const snapshot = await runAgentWorkspaceCollaboration({
          objective,
          workspaceMode: mode,
          coordinator,
          cloudAdvice: mode === "auto" || forwarded.includes("--cloud-advice"),
          confirmation,
          signal: controller.signal,
          onRunId: (runId) => {
            runtime.runId = runId || runtime.runId;
            render();
          },
          onUpdate: (update) => {
            if (update.phase) runtime.phase = update.phase;
            if (update.payload) runtime.configuration = update.payload;
            if (update.snapshot) runtime.snapshot = update.snapshot;
            if (update.events?.length) {
              const merged = new Map(runtime.events.map((event) => [event.sequence, event]));
              for (const event of update.events) merged.set(event.sequence, event);
              runtime.events = [...merged.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence)).slice(-20);
            }
            render();
          },
          onConfigurationConfirmation: async (configuration) => {
            runtime.configuration = configuration;
            runtime.phase = "awaiting_configuration";
            runtime.composerBuffer = "";
            return readRuntimeDecision({ input, runtime, render, kind: "configuration" });
          },
          onPlanConfirmation: async (snapshotForReview) => {
            runtime.snapshot = snapshotForReview;
            runtime.phase = "awaiting_confirmation";
            runtime.composerBuffer = "";
            return readRuntimeDecision({ input, runtime, render, kind: "plan" });
          },
        });
        runtime.snapshot = snapshot;
        runtime.phase = snapshot?.run?.state || "completed";
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
          runtime.setupPath = error.setup.default_path || "";
          runtime.error = null;
          const path = await readRuntimeDecision({ input, runtime, render, kind: "setup" });
          if (!path) {
            runtime.phase = "cancelled";
            return runtime;
          }
          runtime.phase = "configuring";
          await trustCollaborationWorkspace(error.setup.device_id, path, { signal: controller.signal });
          runtime.setup = null;
          runtime.setupPath = "";
          continue;
        }
        runtime.phase = "error";
        runtime.error = error;
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
    await cancelPromise;
    render();
  }
}

export async function handleAgentWorkspaceCommand(argv = [], {
  input = defaultInput,
  output = defaultOutput,
  collaborationRunner = handleCollaborationCommand,
  cancelCollaborationRun = async (runId) => controlCollaborationRun(runId, "cancel"),
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
          onModeChange: () => {
            const next = nextWorkspaceMode(mode);
            mode = next.id;
            panel = null;
            return next;
          },
        });
      pendingObjective = "";
      if (!line) {
        redrawWorkspaceApp(output, { coordinator, mode, panel });
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
        cancelCollaborationRun,
      });
      panel = completionPanel(runtime);
      pendingObjective = runtime.queuedObjective || "";
      redrawWorkspaceApp(output, { coordinator, mode, panel });
    }
  } finally {
    exitApp();
  }
}
