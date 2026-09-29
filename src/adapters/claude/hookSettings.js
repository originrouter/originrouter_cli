import { chmodSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../../persistence/state.js";
import { restrictDirectoryToCurrentUser } from "../../utils/windowsAcl.js";

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

// Claude Code hook "exec form": `command` is the executable and `args` its
// arguments, spawned directly with no shell. Added in Claude Code 2.1.139.
//
// This replaced a shell-form string, `${process.execPath} "<forwarder>"
// <port>`, which was broken on Windows in two ways at once. Shell form there
// runs under PowerShell (not cmd.exe) unless Git Bash is present, and
// PowerShell treats a leading quoted string as a string expression rather
// than a command, so quoting the default `C:\Program Files\nodejs\node.exe`
// makes the hook print its own path instead of running; leaving it unquoted
// splits the path at the space. Exec form removes the shell entirely, so
// neither the interpreter nor the quoting rules matter.
function buildForwarderHook(port, extra = {}) {
  const forwarder = join(packageRoot, "scripts", "claude-session-hook-forwarder.cjs");
  return {
    type: "command",
    command: process.execPath,
    args: [forwarder, String(port)],
    ...extra,
  };
}

export function generateClaudeHookSettings({
  port,
  registerPermissionRequest = true,
  registerElicitation = true,
  // Transport override from buildClaudeSettingsOverride(). Written into the
  // same file because `--settings` is Claude Code's flagSettings layer, which
  // outranks every filesystem settings layer. Omitted under --native-config.
  settingsOverride = null,
}) {
  const directory = join(getStateDir(), "tmp", "claude-hooks");
  const path = join(directory, `session-hook-${process.pid}.json`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const hooks = {
    SessionStart: [
      {
        matcher: "*",
        hooks: [buildForwarderHook(port)],
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
        hooks: [buildForwarderHook(port, {
          timeout: CLAUDE_INTERACTIVE_HOOK_TIMEOUT_SECONDS,
        })],
      },
    ];
  }

  if (registerElicitation) {
    hooks.Elicitation = [
      {
        matcher: "*",
        hooks: [buildForwarderHook(port, {
          timeout: CLAUDE_INTERACTIVE_HOOK_TIMEOUT_SECONDS,
        })],
      },
    ];
  }

  for (const eventName of DISPLAY_HOOK_EVENTS) {
    hooks[eventName] = [
      {
        matcher: "*",
        hooks: [buildForwarderHook(port)],
      },
    ];
  }

  // Spread first so `hooks` cannot be displaced by an override key.
  const payload = { ...(settingsOverride || {}), hooks };

  // The file now carries ANTHROPIC_AUTH_TOKEN, so it is written 0600 like
  // every other credential-bearing file here. fs mode bits are close to a
  // no-op on Windows (a 0600 file reports mode 666 there), so the directory
  // is hardened through its ACL instead — new files inherit the restriction.
  // Best-effort by design: a directory that refuses ACL edits must stay
  // usable, matching ensureStateDir().
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
  if (platform() === "win32") restrictDirectoryToCurrentUser(directory);
  return path;
}

export function cleanupClaudeHookSettings(path) {
  if (path && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {}
  }
}
