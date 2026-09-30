import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completionActivationCommand,
  completionScript,
  formatCompletionOutput,
  getCompletionCandidates,
  installCompletion,
  refreshCompletion,
  uninstallCompletion,
} from "../src/commands/completion.js";

assert(getCompletionCandidates([""]).includes("provider"));
assert.deepEqual(getCompletionCandidates(["pro"]), ["provider", "proxy"]);
assert(getCompletionCandidates(["serv"]).includes("services"));
assert(getCompletionCandidates(["services", "r"]).includes("restart"));
assert(getCompletionCandidates(["route", ""]).includes("set"));
assert(getCompletionCandidates(["route", "cloud", ""]).includes("models"));
assert.deepEqual(getCompletionCandidates(["claude", "--originrouter-autonomy", "g"]), ["guarded"]);
assert.deepEqual(getCompletionCandidates(["claude", "--originrouter-autonomy", "guard"]), ["guarded"]);
assert(getCompletionCandidates(["history", "--a"]).includes("--agent"));
assert(getCompletionCandidates(["completion", "p"]).includes("powershell"));
assert.deepEqual(getCompletionCandidates(["completion", "install", "--shell", "f"]), ["fish"]);
assert(getCompletionCandidates(["-"]).includes("--mode"));
assert.deepEqual(getCompletionCandidates(["--coordinator", "c"]), ["claude", "codex"]);
assert(getCompletionCandidates(["--mode", "p"]).includes("plan-build-verify"));
assert(getCompletionCandidates(["remote", "workspace", "r"]).includes("request"));

// Commands that exist in the dispatch table must be offered at the top level.
for (const command of [
  "token", "daemon", "daemon-port", "claude-terminal", "codex-terminal",
  "claude-sdk", "codex-app-server", "claude-config", "remote",
]) {
  assert(getCompletionCandidates([""]).includes(command), `${command} missing from top level`);
}

// `remote` used to be declared as a nested key, which the lookup never read,
// so its subcommands were unreachable.
assert.deepEqual(getCompletionCandidates(["remote", ""]), ["setup", "share", "status", "workspace"]);
assert.deepEqual(getCompletionCandidates(["remote", "share", ""]), ["restart", "start", "status", "stop"]);
assert.deepEqual(getCompletionCandidates(["remote", "workspace", ""]), ["authorize", "list", "request"]);

// Deeper nesting resolves rather than falling back to flags.
assert.deepEqual(getCompletionCandidates(["agent", "budget", ""]), ["clear", "set", "show"]);
assert.deepEqual(getCompletionCandidates(["local", "api", ""]), ["connect", "pair", "set-host", "set-port", "status"]);
assert.deepEqual(getCompletionCandidates(["token", ""]), ["rotate", "show"]);

// A flag that consumed a value must not swallow the command path.
assert(getCompletionCandidates(["remote", "--port", "8080", ""]).includes("setup"));

// Positional value sets declared on the node.
assert.deepEqual(getCompletionCandidates(["route", "set", ""]), ["claude.main", "claude.small", "codex.main"]);
assert.deepEqual(getCompletionCandidates(["agent", "detail", "s"]), ["set"]);

// Cobra wire format: 'value<TAB>description' with a trailing ':4' directive.
const wire = formatCompletionOutput(["remote", ""]);
const wireLines = wire.split("\n");
assert.equal(wireLines.at(-1), ":4");
assert(wireLines[0].startsWith("setup\t"), `expected a tab-separated description, got ${wireLines[0]}`);
assert(wireLines.some((line) => line.startsWith("workspace\t")));
assert(formatCompletionOutput(["provider", "use", "--provider", ""]).split("\n").at(-1) === ":4");

assert.equal(completionActivationCommand("bash", "/root/.bashrc"), "source '/root/.bashrc'");
assert.equal(completionActivationCommand("zsh", "/Users/test user/.zshrc"), "source '/Users/test user/.zshrc'");
assert.equal(completionActivationCommand("powershell", "C:\\Users\\Test\\profile.ps1"), ". 'C:\\Users\\Test\\profile.ps1'");

// The generated scripts each had a bug that only manual shell testing caught,
// so pin the specific constructs that matter.
const bashScript = completionScript("bash");
const zshScript = completionScript("zsh");
const fishScript = completionScript("fish");
const powershellScript = completionScript("powershell");

// bash: a global `local IFS=$'\n'` also applies to the command substitution
// and collapses the multi-line reply down to its last line (":4").
assert(!bashScript.includes("local IFS=$'\\n'"), "bash script must not override IFS globally");
assert(bashScript.includes("COMP_WORDS[0]"), "bash script must call the invoked binary, not a literal name");
assert(bashScript.includes("__complete"), "bash script must delegate to __complete");

// zsh: '\${words[2,-1]}' would join the words into one, so '(@)' is required.
assert(zshScript.includes("${(@)words[2,-1]}"), "zsh script must expand words as a separate-element array");
assert(zshScript.includes("compdef"), "zsh script must register a compdef");

// fish: '${args[1]}' is not fish syntax.
assert(!fishScript.includes("${args[1]}"), "fish script must not use ${...} expansion");
assert(fishScript.includes("$args[1]"), "fish script must call the invoked binary");

// powershell: a literal backslash-t is not a tab; the backtick escape is.
assert(powershellScript.includes('`t'), "powershell script must split on an actual tab");
assert(powershellScript.includes("Register-ArgumentCompleter"), "powershell script must register the completer");

// PowerShell 5.1 drops a trailing empty argument when invoking a native
// command (verified on Windows: '', an empty variable, [string]::Empty and a
// splat all arrive as nothing, while ' ' survives). Without the sentinel the
// word being completed never reaches the CLI, so `provider <TAB>` echoed
// `provider` back instead of offering its subcommands.
assert(
  powershellScript.includes("__OR_EMPTY__"),
  "powershell script must send the empty-word sentinel, not a bare ''",
);

// The sentinel must resolve to exactly what an empty word would produce, so
// the PowerShell path and the bash/zsh/fish path agree. This asserts on
// formatCompletionOutput because that is the entry point the shells invoke,
// and where the sentinel is translated.
assert.deepEqual(
  formatCompletionOutput(["provider", "__OR_EMPTY__"]),
  formatCompletionOutput(["provider", ""]),
  "the sentinel must be equivalent to an empty trailing word",
);
assert(
  formatCompletionOutput(["provider", "__OR_EMPTY__"]).split("\n").includes("add\tAdd a Provider"),
  "the sentinel must restore the subcommand the dropped empty word used to lose",
);

// Only the last word is translated. Earlier the sentinel is ordinary typed
// input, and must stay literal so it can never fabricate an empty argument.
assert.equal(
  formatCompletionOutput(["__OR_EMPTY__", "ad"]),
  formatCompletionOutput(["zzzz", "ad"]),
  "a non-trailing sentinel must be treated as a literal word",
);

const home = mkdtempSync(join(tmpdir(), "originrouter-completion-"));
try {
  const env = { HOME: home, SHELL: "/bin/zsh" };
  const first = installCompletion("zsh", { env, platformName: "darwin" });
  assert.equal(first.changed, true);
  const second = installCompletion("zsh", { env, platformName: "darwin" });
  assert.equal(second.reason, "already-installed");

  const profile = join(home, ".zshrc");
  writeFileSync(profile, "export TEST=1\n# >>> originrouter completion >>>\nbroken\n");
  const repaired = installCompletion("zsh", { env, platformName: "darwin" });
  assert.equal(repaired.repaired, true);
  const content = readFileSync(profile, "utf8");
  assert.match(content, /export TEST=1/);
  assert.equal(content.split("# >>> originrouter completion >>>").length - 1, 1);
  assert.equal(content.split("# <<< originrouter completion <<<").length - 1, 1);

  const removed = uninstallCompletion("zsh", { env, platformName: "darwin" });
  assert.equal(removed.changed, true);
  assert.doesNotMatch(readFileSync(profile, "utf8"), /originrouter completion/);
} finally {
  rmSync(home, { recursive: true, force: true });
}

// Windows runs two PowerShells with different profile paths: 5.1 (plain
// `powershell`) reads Documents\WindowsPowerShell, PowerShell 7+ (pwsh) reads
// Documents\PowerShell. Installing only the 7+ path left 5.1 with completion
// that was "already configured" yet never loaded — which is exactly what
// happened on a Windows box where `powershell` is 5.1. Both must be written.
const winHome = mkdtempSync(join(tmpdir(), "originrouter-completion-win-"));
try {
  const env = { USERPROFILE: winHome };
  const installed = installCompletion("powershell", { env, platformName: "win32" });
  assert.equal(installed.changed, true);
  assert.equal(installed.reason, undefined);
  assert.equal(installed.additionalTargets.length, 1, "Windows must also target the other PowerShell profile");

  const ps7Profile = join(winHome, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  const ps5Profile = join(winHome, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
  for (const file of [ps7Profile, ps5Profile]) {
    const content = readFileSync(file, "utf8");
    assert.match(content, /originrouter completion powershell/, `no completion block in ${file}`);
    assert.equal(content.split("# >>> originrouter completion >>>").length - 1, 1, `block count in ${file}`);
  }

  // Re-installing must be a no-op on both, not a duplicate append.
  const again = installCompletion("powershell", { env, platformName: "win32" });
  assert.equal(again.reason, "already-installed");
  assert.equal(again.additionalTargets[0].reason, "already-installed");
  assert.equal(readFileSync(ps5Profile, "utf8").split("# >>> originrouter completion >>>").length - 1, 1);

  // Uninstall has to clear the 5.1 profile too, or a stale block lingers there.
  const removed = uninstallCompletion("powershell", { env, platformName: "win32" });
  assert.equal(removed.changed, true);
  for (const file of [ps7Profile, ps5Profile]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /originrouter completion/, `stale block left in ${file}`);
  }
} finally {
  rmSync(winHome, { recursive: true, force: true });
}

// `update` refreshes completion after a successful upgrade, because the
// generated script changes between versions and a block that is present is not
// necessarily current. The rule that matters: refresh only what is already
// installed. Updating the CLI is not consent to configure a new shell.
const refreshHome = mkdtempSync(join(tmpdir(), "originrouter-completion-refresh-"));
try {
  const env = { USERPROFILE: refreshHome, HOME: refreshHome };
  const ps7 = join(refreshHome, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  const ps5 = join(refreshHome, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");

  // Nothing installed: refresh must be a no-op, creating no files at all.
  const untouched = refreshCompletion("powershell", { env, platformName: "win32" });
  assert.equal(untouched.installed, false, "refresh must not install where nothing was installed");
  assert.equal(existsSync(ps7), false, "refresh must not create the PowerShell 7 profile");
  assert.equal(existsSync(ps5), false, "refresh must not create the Windows PowerShell profile");

  // A stale block (as left by an older CLI) plus the person's own profile text.
  mkdirSync(join(refreshHome, "Documents", "PowerShell"), { recursive: true });
  writeFileSync(ps7, [
    "# my own profile",
    "export FOO=1",
    "# >>> originrouter completion >>>",
    "OLD STALE CONTENT",
    "# <<< originrouter completion <<<",
    "",
  ].join("\n"));

  const refreshed = refreshCompletion("powershell", { env, platformName: "win32" });
  assert.equal(refreshed.installed, true);
  // Only the profile that already carried a block is refreshed. The other
  // PowerShell's profile is a separate file that this person never configured,
  // and an upgrade is not the moment to start writing to it — `completion
  // install` is what creates both.
  assert.deepEqual(refreshed.refreshed, [ps7], "only the already-configured profile is refreshed");
  assert.equal(existsSync(ps5), false, "refresh must not create a profile that was never configured");

  const ps7Text = readFileSync(ps7, "utf8");
  assert.match(ps7Text, /export FOO=1/, "refresh must preserve the person's own profile content");
  assert.doesNotMatch(ps7Text, /OLD STALE CONTENT/, "refresh must replace the previous block body");
  assert.match(ps7Text, /originrouter completion powershell/, "refresh must write the current block");
  assert.equal(ps7Text.split("# >>> originrouter completion >>>").length - 1, 1, "refresh must not duplicate the block");

  // Idempotent: a second refresh changes nothing, so `update` stays quiet.
  const second = refreshCompletion("powershell", { env, platformName: "win32" });
  assert.deepEqual(second.refreshed, [], "a current block must not be rewritten");
  assert.equal(readFileSync(ps7, "utf8").split("# >>> originrouter completion >>>").length - 1, 1);
} finally {
  rmSync(refreshHome, { recursive: true, force: true });
}

console.log("completion tests ok");
