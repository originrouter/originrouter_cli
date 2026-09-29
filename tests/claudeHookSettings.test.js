import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

// getStateDir() reads ORIGINROUTER_HOME, so point it at a scratch directory
// before importing the module under test.
process.env.ORIGINROUTER_HOME = mkdtempSync(join(tmpdir(), "originrouter-hooksettings-test-"));

const { generateClaudeHookSettings, cleanupClaudeHookSettings } =
  await import("../src/adapters/claude/hookSettings.js");

// ---------- exec form ----------

const hooksOnlyPath = generateClaudeHookSettings({ port: 43210 });
const hooksOnly = JSON.parse(readFileSync(hooksOnlyPath, "utf8"));

const sessionStartHook = hooksOnly.hooks.SessionStart[0].hooks[0];
// Exec form: `command` is the executable itself and `args` carries the rest,
// so Claude Code spawns it directly with no shell. The previous shell-form
// string broke on Windows, where hook shell form runs under PowerShell: an
// unquoted `C:\Program Files\nodejs\node.exe` splits at the space, and a
// quoted one is parsed as a string expression rather than a command.
assert.equal(sessionStartHook.type, "command");
assert.equal(sessionStartHook.command, process.execPath);
assert.ok(Array.isArray(sessionStartHook.args));
assert.equal(sessionStartHook.args.length, 2);
assert.match(sessionStartHook.args[0], /claude-session-hook-forwarder\.cjs$/);
// The forwarder reads the port from process.argv[2], as a string.
assert.equal(sessionStartHook.args[1], "43210");
// No shell metacharacter quoting anywhere: nothing is concatenated.
assert.equal(sessionStartHook.command.includes('"'), false);
assert.equal(sessionStartHook.args[0].includes('"'), false);

// Every registered event uses the same exec form, including the interactive
// ones that also carry a timeout.
const permissionHook = hooksOnly.hooks.PermissionRequest[0].hooks[0];
assert.equal(permissionHook.command, process.execPath);
assert.deepEqual(permissionHook.args, sessionStartHook.args);
assert.equal(typeof permissionHook.timeout, "number");

for (const [eventName, entries] of Object.entries(hooksOnly.hooks)) {
  const hook = entries[0].hooks[0];
  assert.equal(hook.command, process.execPath, `${eventName} should use exec form`);
  assert.deepEqual(hook.args, sessionStartHook.args, `${eventName} args`);
}

// Hooks-only file: no env block when there is no override (native config, or
// no OriginRouter route).
assert.equal("env" in hooksOnly, false);
assert.equal("apiKeyHelper" in hooksOnly, false);

// ---------- override rides along ----------

const withOverride = generateClaudeHookSettings({
  port: 43211,
  settingsOverride: {
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:43211/coding",
      ANTHROPIC_AUTH_TOKEN: "or_local_secret",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_USE_BEDROCK: "",
    },
    apiKeyHelper: "",
  },
});
const parsed = JSON.parse(readFileSync(withOverride, "utf8"));
assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43211/coding");
assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, "or_local_secret");
assert.equal(parsed.env.ANTHROPIC_API_KEY, "");
assert.equal(parsed.env.CLAUDE_CODE_USE_BEDROCK, "");
assert.equal(parsed.apiKeyHelper, "");
// Hooks survive alongside the override: one --settings file carries both, so
// the transport override does not depend on the hook server having started.
assert.ok(parsed.hooks.SessionStart);
assert.equal(parsed.hooks.SessionStart[0].hooks[0].args[1], "43211");

// An override cannot displace the hooks block.
const hostile = generateClaudeHookSettings({
  port: 43212,
  settingsOverride: { hooks: { SessionStart: [] }, env: { ANTHROPIC_MODEL: "m" } },
});
const hostileParsed = JSON.parse(readFileSync(hostile, "utf8"));
assert.ok(hostileParsed.hooks.SessionStart.length > 0);
assert.equal(hostileParsed.env.ANTHROPIC_MODEL, "m");

// ---------- permissions ----------

// The file now carries ANTHROPIC_AUTH_TOKEN. fs mode bits are effectively a
// no-op on Windows (a 0600 file reports 666 there), where the directory ACL is
// what protects it instead.
if (platform() !== "win32") {
  assert.equal(statSync(withOverride).mode & 0o777, 0o600);
  assert.equal(statSync(hooksOnlyPath).mode & 0o777, 0o600);
}

cleanupClaudeHookSettings(hooksOnlyPath);
cleanupClaudeHookSettings(withOverride);
cleanupClaudeHookSettings(hostile);
// Idempotent: a second cleanup on a removed path is a no-op, not a throw.
cleanupClaudeHookSettings(withOverride);
cleanupClaudeHookSettings(null);

console.log("claude hook settings tests passed");
