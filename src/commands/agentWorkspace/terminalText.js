/**
 * Terminal text measurement and layout primitives for Agent Workspace.
 *
 * The functions are pure and intentionally know nothing about streams or
 * application state. They are shared by panels, the prompt composer, and the
 * mouse-selection renderer.
 */

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

export function isWideCodePoint(codePoint) {
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

export function promptDisplayWidth(text) {
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

export function fitDisplayText(value, width) {
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

export function padDisplayRight(value, width) {
  const raw = String(value ?? "");
  const visibleWidth = promptDisplayWidth(raw);
  if (visibleWidth > width) {
    const text = fitDisplayText(raw, width);
    return `${text}${" ".repeat(Math.max(0, width - promptDisplayWidth(text)))}`;
  }
  return `${raw}${" ".repeat(Math.max(0, width - visibleWidth))}`;
}

export function centerDisplayText(value, width) {
  const text = fitDisplayText(value, width);
  const padding = Math.max(0, width - promptDisplayWidth(text));
  const left = Math.floor(padding / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
}

export function wrapDisplayText(value, width) {
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

export function compareWorkspacePoints(left, right) {
  if (left.y !== right.y) return left.y - right.y;
  return left.x - right.x;
}

export function displaySlice(value, startColumn, endColumn) {
  const start = Math.max(1, Number(startColumn) || 1);
  const end = Math.max(start, Number(endColumn) || start);
  let column = 1;
  let text = "";
  for (const char of stripAnsi(String(value || ""))) {
    const width = Math.max(0, promptDisplayWidth(char));
    const charStart = column;
    const charEnd = width ? column + width - 1 : column;
    if (charEnd >= start && charStart <= end) text += char;
    if (width) column += width;
    if (column > end) break;
  }
  return text;
}

export function displaySelectionSegments(value, startColumn, endColumn) {
  const start = Math.max(1, Number(startColumn) || 1);
  const end = Math.max(start, Number(endColumn) || start);
  const segments = { before: "", selected: "", after: "" };
  let column = 1;
  for (const char of stripAnsi(String(value || ""))) {
    const width = Math.max(0, promptDisplayWidth(char));
    const charStart = column;
    const charEnd = width ? column + width - 1 : column;
    if (charEnd < start) segments.before += char;
    else if (charStart > end) segments.after += char;
    else segments.selected += char;
    if (width) column += width;
  }
  return segments;
}
