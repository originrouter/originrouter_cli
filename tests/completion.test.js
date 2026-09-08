import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCompletionCandidates, installCompletion, uninstallCompletion } from "../src/commands/completion.js";

assert(getCompletionCandidates([""]).includes("provider"));
assert.deepEqual(getCompletionCandidates(["pro"]), ["provider", "proxy"]);
assert(getCompletionCandidates(["serv"]).includes("services"));
assert(getCompletionCandidates(["services", "r"]).includes("restart"));
assert(getCompletionCandidates(["route", ""]).includes("set"));
assert(getCompletionCandidates(["route", "cloud", ""]).includes("models"));
assert.deepEqual(getCompletionCandidates(["claude", "--originrouter-autonomy", "g"]), ["guarded"]);
assert(getCompletionCandidates(["history", "--a"]).includes("--agent"));
assert(getCompletionCandidates(["completion", "p"]).includes("powershell"));
assert.deepEqual(getCompletionCandidates(["completion", "install", "--shell", "f"]), ["fish"]);
assert(getCompletionCandidates(["-"]).includes("--mode"));
assert.deepEqual(getCompletionCandidates(["--coordinator", "c"]), ["claude", "codex"]);
assert(getCompletionCandidates(["--mode", "p"]).includes("plan-build-verify"));
assert(getCompletionCandidates(["remote", "workspace", "r"]).includes("request"));

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
