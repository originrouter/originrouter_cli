function stripAnsi(value) {
  return String(value ?? "").replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    "",
  );
}

function visibleWidth(value) {
  return [...stripAnsi(value)].length;
}

function fitText(value, width) {
  const text = String(value ?? "");
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "…";
  let out = "";
  let used = 0;
  for (const char of text) {
    const next = used + 1;
    if (next >= width) break;
    out += char;
    used = next;
  }
  return `${out}…`;
}

function padRight(value, width) {
  const text = fitText(value, width);
  const padding = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(padding)}`;
}

function centerText(value, width) {
  const text = fitText(value, width);
  const padding = Math.max(0, width - visibleWidth(text));
  const left = Math.floor(padding / 2);
  const right = padding - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function colorize(enabled, code, text) {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function agentLabel(agent) {
  return agent === "codex" ? "OpenAI Codex" : "Claude Code";
}

function agentAccent(agent) {
  return agent === "codex" ? 36 : 35;
}

export function buildAgentLaunchScreen({
  agent,
  workspaceName,
  cwd,
  detailLabel,
  controlLabel,
  sessionLabel,
  columns = 80,
}) {
  const useColor = process.stdout?.isTTY === true && !process.env.NO_COLOR;
  const frameWidth = Math.max(56, Math.min(Number(columns) || 80, 88) - 2);
  const contentWidth = frameWidth - 4;
  const labelWidth = 11;
  const valueWidth = contentWidth - labelWidth - 3;
  const title = colorize(useColor, agentAccent(agent), "OriginRouter");
  const heading = centerText(title, contentWidth);
  const rows = [
    heading,
    "",
    `${padRight("Workspace", labelWidth)} : ${padRight(workspaceName, valueWidth)}`,
    `${padRight("Directory", labelWidth)} : ${padRight(cwd, valueWidth)}`,
    `${padRight("Runtime", labelWidth)} : ${padRight(agentLabel(agent), valueWidth)}`,
    `${padRight("Session", labelWidth)} : ${padRight(sessionLabel, valueWidth)}`,
    `${padRight("Control", labelWidth)} : ${padRight(controlLabel, valueWidth)}`,
    `${padRight("Detail", labelWidth)} : ${padRight(detailLabel, valueWidth)}`,
    "",
    centerText("Starting session", contentWidth),
    centerText("Ctrl+C exits", contentWidth),
  ];
  const top = `╭${"─".repeat(frameWidth - 2)}╮`;
  const bottom = `╰${"─".repeat(frameWidth - 2)}╯`;
  const body = rows.map((row) => `│ ${padRight(row, contentWidth)} │`);
  return [top, ...body, bottom].join("\n");
}

export async function showAgentLaunchScreen({
  input,
  output,
  agent,
  workspaceName,
  cwd,
  detailLabel,
  controlLabel,
  sessionLabel,
  timeoutMs = 650,
} = {}) {
  if (!input?.isTTY || !output?.isTTY) {
    return true;
  }
  const screen = buildAgentLaunchScreen({
    agent,
    workspaceName,
    cwd,
    detailLabel,
    controlLabel,
    sessionLabel,
    columns: output.columns,
  });
  output.write("\u001b[?25l\u001b[2J\u001b[H");
  output.write(`${screen}\n`);

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  output.write("\u001b[?25h\u001b[2J\u001b[H");
  return true;
}
