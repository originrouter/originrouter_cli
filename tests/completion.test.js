import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completionActivationCommand,
  completionScript,
  formatCompletionOutput,
  getCompletionCandidates,
  installCompletion,
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

console.log("completion tests ok");
