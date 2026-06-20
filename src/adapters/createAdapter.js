import { TerminalAdapter } from "./terminalAdapter.js";
import { ClaudeAdapter } from "./claudeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";

export function createAdapter({ agent, command, args = [], cwd }) {
  if (agent === "claude" || command === "claude") return new ClaudeAdapter({ args, cwd });
  if (agent === "codex" || command === "codex") return new CodexAdapter({ args });
  return new TerminalAdapter({ command, args });
}
