import assert from "node:assert/strict";

import { getCompletionCandidates } from "../src/commands/completion.js";

assert(getCompletionCandidates([""]).includes("provider"));
assert.deepEqual(getCompletionCandidates(["pro"]), ["provider", "proxy"]);
assert(getCompletionCandidates(["serv"]).includes("services"));
assert(getCompletionCandidates(["services", "r"]).includes("restart"));
assert(getCompletionCandidates(["route", ""]).includes("set"));
assert(getCompletionCandidates(["route", "cloud", ""]).includes("models"));
assert.deepEqual(getCompletionCandidates(["claude", "--originrouter-autonomy", "g"]), ["guarded"]);
assert(getCompletionCandidates(["history", "--a"]).includes("--agent"));
assert(getCompletionCandidates(["completion", "p"]).includes("powershell"));
assert(getCompletionCandidates(["-"]).includes("--mode"));
assert.deepEqual(getCompletionCandidates(["--coordinator", "c"]), ["claude", "codex"]);
assert(getCompletionCandidates(["--mode", "p"]).includes("plan-build-verify"));

console.log("completion tests ok");
