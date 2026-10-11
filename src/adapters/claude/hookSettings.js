import { chmodSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../../persistence/state.js";
import { restrictDirectoryToCurrentUser } from "../../utils/windowsAcl.js";
import { CLAUDE_PERMISSION_TIMEOUT_MS } from "./hookServer.js";
import {
  AGENT_INTERACTION_GRACE_MS,
  CLAUDE_HOOK_DEADLINE_CEILING_SECONDS,
} from "../../config/agentInteractionTimeout.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The deadline Claude Code enforces on the hook process itself. It is the
// outermost bound on a permission: when it fires, Claude Code stops waiting and
// the request is over. Everything inside it — the hook server's hold, the
// forwarder's socket timeout — must be shorter, or one of them becomes the
// real deadline while the user believes they still have time.
//
// Normally derived from `agent.interactionTimeoutMs` (see
// config/agentInteractionTimeout.js) so raising the window raises this with
// it. This constant is only the fallback for a caller that passes nothing.
export const CLAUDE_INTERACTIVE_HOOK_TIMEOUT_SECONDS = 360;

// Slack between the hook server's hold and Claude Code's own deadline, so the
// hold is what ends a request we are still handling, not the process being
// killed underneath it. Same margin the fixed 315s/360s pair used to have.
const HOOK_DEADLINE_MARGIN_MS = AGENT_INTERACTION_GRACE_MS;

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
// `holdMs` is the hook server's permission hold for this session, in ms, or 0
// for "no deadline". It is appended to argv so the forwarder sizes its own
// socket timeout from the same number that sized the hold — one value, so the
// socket can never become the real deadline by drifting from the server.
function buildForwarderHook(port, holdMs, extra = {}) {
  const forwarder = join(packageRoot, "scripts", "claude-session-hook-forwarder.cjs");
  return {
    type: "command",
    command: process.execPath,
    args: [forwarder, String(port), String(holdMs)],
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
  // How long the hook server may hold a permission open, in ms — the same
  // value the adapter hands startClaudeHookServer. Only used to size Claude
  // Code's own hook deadline above it. `0` (no deadline) falls back to
  // CLAUDE_HOOK_DEADLINE_CEILING_SECONDS, because Claude Code insists on a
  // finite number and refusing to start is not an option.
  permissionTimeoutMs = CLAUDE_PERMISSION_TIMEOUT_MS,
}) {
  const directory = join(getStateDir(), "tmp", "claude-hooks");
  const path = join(directory, `session-hook-${process.pid}.json`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  // Claude Code's deadline must outlast the hook server's hold with room to
  // spare, or it fires first and denies a request the user is still reading.
  // Round up to whole seconds — Claude Code takes an integer, and rounding
  // down here would shave up to a second off the margin.
  const holdMs = Number(permissionTimeoutMs) > 0 ? Number(permissionTimeoutMs) : 0;
  const permissionHookTimeoutSeconds = holdMs > 0
    ? Math.ceil((holdMs + HOOK_DEADLINE_MARGIN_MS) / 1000)
    : CLAUDE_HOOK_DEADLINE_CEILING_SECONDS;

  const hooks = {
    SessionStart: [
      {
        matcher: "*",
        hooks: [buildForwarderHook(port, holdMs)],
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
        hooks: [buildForwarderHook(port, holdMs, {
          timeout: permissionHookTimeoutSeconds,
        })],
      },
    ];
  }

  if (registerElicitation) {
    hooks.Elicitation = [
      {
        matcher: "*",
        hooks: [buildForwarderHook(port, holdMs, {
          timeout: permissionHookTimeoutSeconds,
        })],
      },
    ];
  }

  for (const eventName of DISPLAY_HOOK_EVENTS) {
    hooks[eventName] = [
      {
        matcher: "*",
        hooks: [buildForwarderHook(port, holdMs)],
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
