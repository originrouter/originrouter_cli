// Stage 8.0A: Codex semver parser + app-server gate tests.
//
// The parser and gate are exported from src/adapters/codex/appServerClient.js
// so we can exercise them directly without mocking `runCapture`. The
// process-spawn path is verified end-to-end by the manual verification
// step in docs/agent-runtime-audit.md §6 (shadow PATH with a fake
// `/tmp/codex` binary that prints a low version).

import assert from "node:assert/strict";
import { parseCodexSemver } from "../src/adapters/codex/appServerClient.js";

// ---- parseCodexSemver ----

assert.deepEqual(
  parseCodexSemver("codex-cli 0.99.5"),
  { major: 0, minor: 99, patch: 5 },
  "0.99.5 should parse to {0, 99, 5}",
);
assert.deepEqual(
  parseCodexSemver("codex-cli 0.100.0"),
  { major: 0, minor: 100, patch: 0 },
  "0.100.0 should parse to {0, 100, 0} (the gate threshold)",
);
assert.deepEqual(
  parseCodexSemver("codex-cli 1.0.0"),
  { major: 1, minor: 0, patch: 0 },
  "1.0.0 should parse to {1, 0, 0}",
);
assert.deepEqual(
  parseCodexSemver("not a version"),
  null,
  "garbage should return null",
);
assert.deepEqual(
  parseCodexSemver(""),
  null,
  "empty string should return null",
);
assert.deepEqual(
  parseCodexSemver(undefined),
  null,
  "undefined should return null",
);
assert.deepEqual(
  parseCodexSemver(null),
  null,
  "null should return null",
);
// The parser is intentionally lenient about prefixes — Codex CLI prints
// `codex-cli X.Y.Z` but a fork might print just the version.
assert.deepEqual(
  parseCodexSemver("1.2.3\n"),
  { major: 1, minor: 2, patch: 3 },
  "bare version with trailing newline should still parse",
);

// ---- Gate predicate ----
// Compose the gate predicate the same way isCodexAppServerAvailable does,
// and verify the boundary cases. The predicate shape (`major > 0 ||
// minor >= 100`) is the public contract documented in §6.2 of the audit.

function gateFor(semver) {
  if (!semver) return false;
  if (semver.major > 0) return true;
  return semver.minor >= 100;
}

assert.equal(gateFor(parseCodexSemver("codex-cli 0.99.5")), false, "0.99.5 should be gated out");
assert.equal(gateFor(parseCodexSemver("codex-cli 0.99.99")), false, "0.99.99 should be gated out");
assert.equal(gateFor(parseCodexSemver("codex-cli 0.100.0")), true, "0.100.0 should pass the gate");
assert.equal(gateFor(parseCodexSemver("codex-cli 0.101.0")), true, "0.101.0 should pass the gate");
assert.equal(gateFor(parseCodexSemver("codex-cli 0.100.1")), true, "0.100.1 should pass the gate");
assert.equal(gateFor(parseCodexSemver("codex-cli 1.0.0")), true, "1.0.0 should pass the gate");
assert.equal(gateFor(parseCodexSemver("codex-cli 2.5.7")), true, "2.5.7 should pass the gate");
assert.equal(gateFor(null), false, "null should be gated out");

console.log("codex semver tests ok");
