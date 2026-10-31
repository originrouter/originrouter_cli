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

// Claude Code's "auto mode" is a *second*, server-side permission classifier
// that runs in front of our PermissionRequest hook. When it is on, a call can
// be approved (or denied) by Anthropic's classifier before the hook is ever
// consulted, so a request the user should have seen never reaches the App. It
// also shows an unavoidable billing notice on the gateway path: the notice's
// eligibility test resolves the *request host* (`127.0.0.1:<port>` here) and
// treats anything that is not `*.anthropic.com` as an incompatible gateway, so
// on our relay it is never eligible and re-arms every 24 hours.
//
// Both halves are structural rather than configurable, so the only lever is to
// take auto out of the session entirely:
//   - `disableAutoMode: "disable"` is Claude Code's documented kill switch. It
//     removes "auto" from the Shift+Tab cycle, refuses to adopt it at startup,
//     and suppresses the classifier path (and therefore its notice).
//   - `permissions.defaultMode: "default"` pins the session's starting mode to
//     "default", which is the real "ask every time" mode. "dontAsk" is not a
//     lower level — it denies without asking, which starves the relay.
// An explicit `--permission-mode` on the command line still outranks settings,
// so a user who deliberately passes one keeps it.
const CLAUDE_PERMISSION_SAFETY_SETTINGS = Object.freeze({
  disableAutoMode: "disable",
  permissions: Object.freeze({ defaultMode: "default" }),
});

/**
 * Merge the safety keys into a settings object, forcing them last so neither a
 * caller's override nor a stray settings fragment can weaken them. `permissions`
 * is merged rather than replaced: an override may legitimately carry `allow` /
 * `deny` / `ask` rules we must not drop.
 */
export function withClaudePermissionSafety(settings) {
  const base = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : {};
  const basePermissions = base.permissions && typeof base.permissions === "object"
    && !Array.isArray(base.permissions)
    ? base.permissions
    : {};
  return {
    ...base,
    disableAutoMode: CLAUDE_PERMISSION_SAFETY_SETTINGS.disableAutoMode,
    permissions: {
      ...basePermissions,
      defaultMode: CLAUDE_PERMISSION_SAFETY_SETTINGS.permissions.defaultMode,
    },
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

  // Spread first so `hooks` cannot be displaced by an override key; the safety
  // keys are applied last, after the spread, so an override cannot re-enable
  // auto mode either. (`--settings` is the flagSettings layer, which outranks
  // user/project/local files, so this is the one place a session-wide pin
  // actually holds.)
  const payload = withClaudePermissionSafety({ ...(settingsOverride || {}), hooks });

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
