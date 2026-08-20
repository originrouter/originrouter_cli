import { cwd, stdin as defaultInput, stdout as defaultOutput } from "node:process";
import {
  clearScreenDown,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";

import { handleCollaborationCommand } from "./collaboration.js";
import {
  WORKSPACE_MODES,
  nextWorkspaceMode,
  normalizeCoordinator,
  normalizeWorkspaceMode,
  workspaceModeDefinition,
  workspaceModeSummary,
  workspaceRequiresPlanReview,
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

export function buildWorkspaceAppScreen({
  coordinator = "codex",
  mode = "auto",
  columns = 80,
  rows = 24,
  panel = null,
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

  const screenRows = [
    titleLine("OriginRouter", frameWidth),
    appLine("", contentWidth),
    ...detailRows,
    bottomLine(frameWidth),
  ];
  const separator = border("─".repeat(terminalColumns));
  const blankRows = Math.max(1, terminalRows - screenRows.length - 3);
  return `${screenRows.join("\n")}\n${"\n".repeat(blankRows)}${separator}\n`;
}

function redrawWorkspaceApp(output, { coordinator, mode, panel = null }) {
  output.write("\x1b[2J\x1b[H");
  output.write(buildWorkspaceAppScreen({
    coordinator,
    mode,
    panel,
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
  return muted(`  ${workspaceModeDefinition(mode).label} · Guarded · ${workspaceDirectoryName()}`);
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
  const promptLine = strong(promptVisible);
  const promptWidth = promptDisplayWidth(promptVisible);
  const promptColumn = promptWidth % columns;
  const prompt = `${promptLine}${" ".repeat(Math.max(0, columns - promptWidth))}`;
  output.write(`${styled(prompt, ANSI.bgSoft)}\n${footer}`);
  moveCursor(output, 0, -1);
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
  const explicitlyReviewed = forwarded.includes("--review");
  const explicitlyConfirmed = forwarded.includes("--yes");
  if (!explicitlyReviewed && !explicitlyConfirmed && !workspaceRequiresPlanReview(objective, mode)) {
    args.push("--yes");
  }
  return args;
}

function isInterrupted(error) {
  return error?.code === "ORIGINROUTER_INTERRUPTED"
    || error?.name === "AbortError"
    || error?.cause?.code === "ORIGINROUTER_INTERRUPTED";
}

export async function handleAgentWorkspaceCommand(argv = [], {
  input = defaultInput,
  output = defaultOutput,
  collaborationRunner = handleCollaborationCommand,
  cancelCollaborationRun = async (runId) => handleCollaborationCommand(["cancel", runId]),
} = {}) {
  const parsed = parseAgentWorkspaceArgs(argv);
  if (parsed.objective) {
    await collaborationRunner(collaborationArgs(parsed));
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Agent Workspace requires an interactive terminal when no objective is provided.");
  }
  let coordinator = parsed.coordinator;
  let mode = parsed.mode;
  let panel = null;
  const exitApp = enterWorkspaceApp(output);
  try {
    redrawWorkspaceApp(output, { coordinator, mode, panel });
    while (true) {
      const line = await readWorkspaceLine({
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
      const controller = new AbortController();
      let activeRunId = "";
      let interruptRequested = false;
      let cancelPromise = Promise.resolve();
      const onActiveInterrupt = () => {
        if (interruptRequested) {
          output.write("\nInterrupt already requested. Waiting for the current run to stop.\n");
          return;
        }
        interruptRequested = true;
        controller.abort();
        if (activeRunId) {
          output.write(`\nInterrupt requested. Cancelling ${activeRunId}…\n`);
          cancelPromise = Promise.resolve()
            .then(() => cancelCollaborationRun(activeRunId))
            .catch((error) => {
              output.write(`Cancel failed: ${error.message}\n`);
            });
        } else {
          output.write("\nInterrupt requested. Stopping before a collaboration run is created.\n");
        }
      };
      process.on("SIGINT", onActiveInterrupt);
      try {
        await collaborationRunner(collaborationArgs({
          objective: line,
          coordinator,
          mode,
          forwarded: parsed.forwarded,
        }), {
          signal: controller.signal,
          onRunId: (runId) => {
            activeRunId = runId || activeRunId;
          },
        });
      } catch (error) {
        if (!isInterrupted(error)) throw error;
        output.write(activeRunId
          ? `\nStopped following ${activeRunId}. Resume with: originrouter collaboration attach ${activeRunId}\n`
          : "\nCurrent objective was interrupted before a run was created.\n");
      } finally {
        process.removeListener("SIGINT", onActiveInterrupt);
        await cancelPromise;
      }
      output.write("\nReady for another objective.\n");
    }
  } finally {
    exitApp();
  }
}
