import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../../persistence/state.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function generateClaudeHookSettings({ port, registerPermissionRequest = true }) {
  const path = join(getStateDir(), "tmp", "claude-hooks", `session-hook-${process.pid}.json`);
  mkdirSync(dirname(path), { recursive: true });

  const forwarder = join(packageRoot, "scripts", "claude-session-hook-forwarder.cjs");
  const command = `${process.execPath} ${JSON.stringify(forwarder)} ${port}`;

  const hooks = {
    SessionStart: [
      {
        matcher: "*",
        hooks: [{ type: "command", command }],
      },
    ],
  };

  // PermissionRequest only fires in Claude Code's interactive mode. Under
  // `claude -p` (non-interactive) the hook is registered but Claude Code
  // doesn't suspend on its decision, so registering it adds no value. Skip
  // it explicitly to keep the config honest about what is actually wired.
  if (registerPermissionRequest) {
    hooks.PermissionRequest = [
      {
        matcher: "*",
        hooks: [{ type: "command", command }],
      },
    ];
  }

  writeFileSync(path, JSON.stringify({ hooks }, null, 2));
  return path;
}

export function cleanupClaudeHookSettings(path) {
  if (path && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
