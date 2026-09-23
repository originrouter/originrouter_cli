import { spawn } from "node:child_process";
import { cursorTo } from "node:readline";

import {
  compareWorkspacePoints,
  displaySelectionSegments,
  displaySlice,
  promptDisplayWidth,
  stripAnsi,
} from "./terminalText.js";

export const workspaceScreenCache = new WeakMap();
export const workspaceSelectionCache = new WeakMap();

export function consumeWorkspaceMouseKeypress(state, text, key = {}) {
  const sequence = String(key.sequence || text || "");
  let buffer = String(state?.mouseSequenceBuffer || "");
  if (!buffer) {
    if (!sequence.startsWith("\x1b[<")) return { handled: false };
    buffer = sequence;
  } else {
    buffer += sequence;
  }
  if (buffer.length > 64) {
    state.mouseSequenceBuffer = "";
    return { handled: true };
  }
  if (!/[mM]$/.test(buffer)) {
    state.mouseSequenceBuffer = buffer;
    return { handled: true };
  }
  state.mouseSequenceBuffer = "";
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(buffer);
  if (!match) return { handled: true };
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (code === 64 || code === 65) {
    return { handled: true, type: "wheel", direction: code === 64 ? -1 : 1, x, y };
  }
  const button = code & 3;
  const motion = (code & 32) !== 0;
  if (match[4] === "m") return { handled: true, type: "release", button, x, y };
  if (motion) return { handled: true, type: "move", button, x, y };
  return { handled: true, type: "press", button, x, y };
}

function workspaceSelection(output) {
  let selection = workspaceSelectionCache.get(output);
  if (!selection) {
    selection = { anchor: null, focus: null, dragging: false };
    workspaceSelectionCache.set(output, selection);
  }
  return selection;
}

export function clearWorkspaceSelection(output) {
  const selection = workspaceSelectionCache.get(output);
  if (!selection) return;
  selection.anchor = null;
  selection.focus = null;
  selection.dragging = false;
}

function clampWorkspacePoint(output, point = {}) {
  return {
    x: Math.max(1, Math.min(Number(output.columns) || 80, Number(point.x) || 1)),
    y: Math.max(1, Math.min(Number(output.rows) || 24, Number(point.y) || 1)),
  };
}

function workspacePointHasText(output, point) {
  const lines = workspaceScreenCache.get(output)?.lines || [];
  const line = stripAnsi(lines[Math.max(0, point.y - 1)] || "");
  if (!line) return false;
  const visibleChars = [...line];
  let column = 1;
  for (const char of visibleChars) {
    const charWidth = Math.max(1, promptDisplayWidth(char));
    if (point.x >= column && point.x < column + charWidth) {
      return !/^\s$/.test(char) && !["─", "│", "╭", "╮", "╰", "╯", "›", "▌"].includes(char);
    }
    column += charWidth;
    if (column > point.x) break;
  }
  return false;
}

export function workspaceSelectionText(lines, selection) {
  if (!selection?.anchor || !selection?.focus) return "";
  let start = selection.anchor;
  let end = selection.focus;
  if (compareWorkspacePoints(start, end) > 0) [start, end] = [end, start];
  const rows = [];
  for (let row = start.y; row <= end.y; row += 1) {
    const line = lines[row - 1] || "";
    const from = row === start.y ? start.x : 1;
    const to = row === end.y ? end.x : Number.MAX_SAFE_INTEGER;
    rows.push(displaySlice(line, from, to).replace(/[ \t]+$/g, ""));
  }
  return rows.join("\n").replace(/[\n\s]+$/g, "");
}

function renderWorkspaceSelection(output, lines) {
  const selection = workspaceSelectionCache.get(output);
  if (!selection?.anchor || !selection?.focus) return;
  let start = selection.anchor;
  let end = selection.focus;
  for (let row = start.y; row <= end.y; row += 1) {
    const from = row === start.y ? start.x : 1;
    const to = row === end.y ? end.x : Number(output.columns) || 80;
    const segments = displaySelectionSegments(lines[row - 1] || "", from, to);
    if (!segments.selected) continue;
    output.write(
      `\x1b[${row};1H\x1b[2K${segments.before}\x1b[7m${segments.selected}\x1b[27m${segments.after}`,
    );
  }
}

export function renderWorkspaceSelectionFrame(output, lines) {
  renderWorkspaceSelection(output, lines);
}

export function positionWorkspaceCursor(output, lines) {
  const row = lines.findIndex((line) => stripAnsi(line).includes("▌"));
  if (row < 0) return;
  const plain = stripAnsi(lines[row]);
  const cursorIndex = plain.indexOf("▌");
  const column = Math.max(0, promptDisplayWidth(plain.slice(0, cursorIndex)));
  cursorTo(output, column, row);
}

function copyWorkspaceSelection(text) {
  if (!text) return;
  if (process.platform === "darwin") {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => {});
    child.stdin.end(text);
  }
}

export function handleWorkspaceMouseKeypress({ output, state, text, key, runtime = null, render }) {
  const mouse = consumeWorkspaceMouseKeypress(state, text, key);
  if (!mouse.handled) return false;
  if (mouse.type === "wheel") {
    clearWorkspaceSelection(output);
    if (runtime && mouse.direction) scrollRuntimeContent(runtime, mouse.direction, 3);
    render?.(true);
    return true;
  }
  if (mouse.button !== 0) return true;
  const selection = workspaceSelection(output);
  const point = clampWorkspacePoint(output, mouse);
  if (mouse.type === "press") {
    if (!workspacePointHasText(output, point)) {
      clearWorkspaceSelection(output);
      render?.(true);
      return true;
    }
    selection.anchor = point;
    selection.focus = point;
    selection.dragging = true;
    render?.(true);
    return true;
  }
  if (mouse.type === "move" && selection.dragging) {
    selection.focus = point;
    render?.(true);
    return true;
  }
  if (mouse.type === "release" && selection.dragging) {
    selection.focus = point;
    selection.dragging = false;
    const copied = workspaceSelectionText(workspaceScreenCache.get(output)?.lines || [], selection);
    copyWorkspaceSelection(copied);
    render?.(true);
  }
  return true;
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
