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
  INDIRECT_DISPATCH,
  SUBSYSTEM_MODULE,
  allCommandPaths,
  findCommand,
  topLevelCommands,
} from "../src/commands/commandCatalog.js";
import { getCompletionCandidates } from "../src/commands/completion.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(join(root, "src/index.js"), "utf8");
const helpSource = readFileSync(join(root, "src/commands/help.js"), "utf8");

// Refuse to import a path that was not declared above, so a typo in the table
// fails loudly here rather than silently reading nothing and passing.
const moduleCache = new Map();
function readModule(relativePath) {
  assert(
    relativePath.startsWith("src/") && relativePath.endsWith(".js"),
    `SUBSYSTEM_MODULE must name a source file, got '${relativePath}'`,
  );
  if (!moduleCache.has(relativePath)) {
    moduleCache.set(relativePath, readFileSync(join(root, relativePath), "utf8"));
  }
  return moduleCache.get(relativePath);
}

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

// 8. Nested subcommands are dispatchable, not merely declared.
//
//    Checks 1 and 5 stop at the top level and at completion reachability, so a
//    leaf could be declared, offered by TAB, and still be rejected by the CLI.
//    That is exactly how `auth logout` shipped: declared in the catalog, but
//    `handleAuthCommand` accepts only `status` and `verify`.
//
//    Dispatch is written several ways across the codebase, so collect every
//    literal a module matches on and require the name to appear in one of them.
//    Matching is by literal presence, not by parsing the condition: a
//    subcommand may be compared with ===, listed in an array passed to
//    .includes(), or held in a Set.
function dispatchedLiterals(source) {
  const literals = new Set();
  // `x === "name"`, `x !== "name"`, `["a", "b"].includes(x)`,
  // `new Set([...]).has(x)`, and object keys such as `{ "name": fn }`.
  for (const match of source.matchAll(/"([a-z][a-z0-9-]*)"/g)) literals.add(match[1]);
  return literals;
}

const unreachable = [];
for (const path of allCommandPaths()) {
  if (path.length < 2) continue; // top level is covered by check 1
  const [top, ...rest] = path;
  const fullPath = path.join(" ");
  // An indirect entry is exempt only for its own prefix, and the reason is
  // recorded next to the exemption.
  const indirect = INDIRECT_DISPATCH[fullPath]
    || (path.length > 2 && INDIRECT_DISPATCH[path.slice(0, 2).join(" ")] ? "covered by its parent's delegation" : null);
  if (indirect) continue;

  const modulePath = SUBSYSTEM_MODULE[top];
  if (!modulePath) {
    unreachable.push(`${fullPath} (no SUBSYSTEM_MODULE entry for '${top}')`);
    continue;
  }
  // A three-part path is matched by its own name once its parent delegation is
  // established, so check the leaf against the delegate that owns it.
  const leafName = rest.at(-1);
  const owner = path.length > 2 ? (SUBSYSTEM_MODULE[top] && modulePath) : modulePath;
  if (!dispatchedLiterals(readModule(owner)).has(leafName)) {
    unreachable.push(`${fullPath} ('${leafName}' absent from ${owner})`);
  }
}
assert.deepEqual(
  unreachable,
  [],
  `catalog declares subcommands the CLI cannot dispatch:\n  ${unreachable.join("\n  ")}`,
);

// 9. Subcommands must be listed where help documents their command, not just
//    the command itself. Check 7 passes as long as the top-level name appears
//    anywhere in the prose — `local` satisfied it while the entire `local api`
//    family (including `local api pair`) went undocumented.
//
//    Help writes subcommands either one per line (`originrouter local api
//    status`) or as an alternation (`originrouter update [status|check|
//    install]`), so accept either form for the immediate child.
const helpMentionsSubcommand = (top, sub) => {
  if (new RegExp(`originrouter\\s+${top}\\s+${sub}\\b`).test(helpSource)) return true;
  // Alternation on the same line as the parent, e.g. `update [status|check|install]`.
  const line = new RegExp(`originrouter\\s+${top}\\b[^\\n]*`).exec(helpSource);
  if (line && new RegExp(`\\b${sub}\\b`).test(line[0])) return true;
  return false;
};
const undocumentedSubs = [];
for (const entry of topLevelCommands({ includeHidden: false })) {
  for (const child of entry.children || []) {
    if (!helpMentionsSubcommand(entry.name, child.name)) {
      undocumentedSubs.push(`${entry.name} ${child.name}`);
    }
  }
}
assert.deepEqual(
  undocumentedSubs,
  [],
  `subcommands absent from the help text: ${undocumentedSubs.join(", ")}`,
);

// 10. `hidden` means "absent from completion", and that is the whole contract:
//     a hidden command is internal, so help does not document it either. Assert
//     the completion half, so a command that should be hidden and is not (or a
//     hidden one leaking into TAB) fails here.
for (const entry of COMMAND_CATALOG) {
  if (!entry.hidden) continue;
  const offered = getCompletionCandidates([""]);
  assert(
    !offered.includes(entry.name),
    `'${entry.name}' is hidden but still offered by completion`,
  );
}

console.log("command catalog tests ok");
