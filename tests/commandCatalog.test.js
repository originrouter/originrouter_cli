// Guards the single-source-of-truth contract described in
// src/commands/commandCatalog.js: every command the CLI can dispatch must be
// declared in the catalog, or shell completion and help silently lose it.
//
// This is the test that would have caught `token`, `daemon`, and the other
// commands that were dispatched in src/index.js but absent from the
// hand-written completion tables.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  COMMAND_CATALOG,
  allCommandPaths,
  findCommand,
  topLevelCommands,
} from "../src/commands/commandCatalog.js";
import { getCompletionCandidates } from "../src/commands/completion.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(root, "src/index.js"), "utf8");
const helpSource = readFileSync(join(root, "src/commands/help.js"), "utf8");

// Commands handled outside the `command === "..."` chain: flags parsed before
// dispatch, and the hidden completion endpoint the shell scripts call.
const DISPATCH_EXCEPTIONS = new Set([
  "__complete", "help", "completion",
  "--help", "-h", "--version", "-v",
  "-c", "--coordinator", "-m", "--mode", "--team",
  "--detach", "--json", "--no-wait", "--plain", "--raw", "--review",
  "--verbose", "--yes", "--timeout",
]);

function dispatchedCommands() {
  const found = new Set();
  for (const match of indexSource.matchAll(/command === "([a-z0-9-]+)"/g)) {
    found.add(match[1]);
  }
  return found;
}

const dispatched = dispatchedCommands();
const declared = new Set(topLevelCommands({ includeHidden: true }).map((entry) => entry.name));

// 1. Every catalog entry is actually runnable.
for (const name of declared) {
  assert(
    dispatched.has(name) || DISPATCH_EXCEPTIONS.has(name),
    `catalog declares '${name}' but src/index.js has no dispatch branch for it`,
  );
}

// 2. Every dispatched command is completable. This is the direction that was
//    broken: nine commands existed but never appeared on TAB.
const notInCatalog = [];
for (const name of dispatched) {
  if (DISPATCH_EXCEPTIONS.has(name)) continue;
  if (!declared.has(name)) notInCatalog.push(name);
}
assert.deepEqual(
  notInCatalog,
  [],
  `dispatched but missing from the command catalog (TAB-invisible): ${notInCatalog.join(", ")}`,
);

// 3. Every top-level command is offered by completion on an empty line.
const offered = new Set(getCompletionCandidates([""]));
for (const entry of topLevelCommands()) {
  assert(offered.has(entry.name), `'${entry.name}' is in the catalog but not offered by completion`);
}

// 4. Commands documented in `help all` must resolve in the catalog, so the
//    reference and the completion tree cannot diverge.
const documented = new Set();
for (const match of helpSource.matchAll(/originrouter ([a-z][a-z0-9-]*)/g)) {
  documented.add(match[1]);
}
const undocumented = [];
for (const name of documented) {
  if (name === "or") continue;
  if (!findCommand(name) && !DISPATCH_EXCEPTIONS.has(name)) undocumented.push(name);
}
assert.deepEqual(
  undocumented,
  [],
  `documented in help but absent from the catalog: ${undocumented.join(", ")}`,
);

// 5. Nested children are reachable through completion, not just declared.
//    A fully-specified leaf legitimately offers no candidates (Cobra answers
//    with just the directive), so this checks reachability and that the
//    immediate children are the ones offered.
for (const entry of COMMAND_CATALOG) {
  for (const child of entry.children || []) {
    const candidates = getCompletionCandidates([entry.name, ""]);
    assert(
      candidates.includes(child.name),
      `'${entry.name} ${child.name}' is declared but not offered by completion`,
    );
  }
}

// 6. Every declared subcommand carries a summary, because the shell renders it
//    as the description next to the candidate.
for (const entry of COMMAND_CATALOG) {
  assert(entry.summary, `top-level '${entry.name}' is missing a summary`);
  for (const child of entry.children || []) {
    assert(child.summary, `'${entry.name} ${child.name}' is missing a summary`);
  }
}

// 7. Every runnable, non-hidden command is mentioned somewhere in the help
//    text. This is the "added a command, forgot help" case — the same class of
//    drift the completion checks cover, caught without asserting on prose.
//
//    The help text is deliberately hand-authored rather than generated (see
//    the catalog header), so this checks presence only: it cannot judge
//    whether a description is any good, and does not try.
const helpMentions = (name) => new RegExp(`\\b${name}\\b`).test(helpSource);
const missingFromHelp = [];
for (const entry of topLevelCommands({ includeHidden: false })) {
  // Flag-style and passthrough-only entries are documented by their flags.
  if (entry.hidden) continue;
  if (!helpMentions(entry.name)) missingFromHelp.push(entry.name);
}
assert.deepEqual(
  missingFromHelp,
  [],
  `runnable commands never mentioned in help: ${missingFromHelp.join(", ")}`,
);

console.log("command catalog tests ok");
