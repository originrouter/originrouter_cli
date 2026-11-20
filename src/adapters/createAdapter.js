import { TerminalAdapter } from "./terminalAdapter.js";
import { ClaudeAdapter } from "./claudeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";
import { AgyAdapter } from "./agyAdapter.js";
import { AgyAcpAdapter } from "./agyAcpAdapter.js";

export function createAdapter({ agent, command, args = [], cwd, nativeConfig = false, runtime = null }) {
  if (agent === 'agy') return runtime === 'agy-acp' ? new AgyAcpAdapter({ args, cwd }) : new AgyAdapter({ args, cwd });
  if (agent === "claude" || command === "claude") return new ClaudeAdapter({ args, cwd });
  // Managed Codex sessions use runtime/codexAppServerSession.js. This
  // factory is the explicit terminal path and must not start a second,
  // unrelated app-server alongside the TUI.
  if (agent === "codex" || command === "codex") {
    return new CodexAdapter({
      args,
      appServerAvailable: false,
      nativeConfig,
    });
  }
  return new TerminalAdapter({ command, args });
}
