import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../../persistence/state.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const CLAUDE_INTERACTIVE_HOOK_TIMEOUT_SECONDS = 360;

const DISPLAY_HOOK_EVENTS = [
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Notification",
  "PostToolUse",
  "PostToolUseFailure",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "PermissionDenied",
  "Setup",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "ElicitationResult",
];

export function generateClaudeHookSettings({
  port,
  registerPermissionRequest = true,
  registerElicitation = true,
}) {
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

  // Current Claude Code also invokes PermissionRequest while running in
  // `--print`/headless mode. Keep this opt-out only for tests or an explicitly
  // unsupported runtime; the production adapter registers it for every mode
  // so a headless permission prompt cannot bypass the App relay.
  if (registerPermissionRequest) {
    hooks.PermissionRequest = [
      {
        matcher: "*",
        hooks: [{
          type: "command",
          command,
          timeout: CLAUDE_INTERACTIVE_HOOK_TIMEOUT_SECONDS,
        }],
      },
    ];
  }

  if (registerElicitation) {
    hooks.Elicitation = [
      {
        matcher: "*",
        hooks: [{
          type: "command",
          command,
          timeout: CLAUDE_INTERACTIVE_HOOK_TIMEOUT_SECONDS,
        }],
      },
    ];
  }

  for (const eventName of DISPLAY_HOOK_EVENTS) {
    hooks[eventName] = [
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
