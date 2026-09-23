import assert from "node:assert/strict";
import test from "node:test";

import {
  fitDisplayText,
  padDisplayRight,
  promptDisplayWidth,
  stripAnsi,
  wrapDisplayText,
} from "../src/commands/agentWorkspace/terminalText.js";

test("terminal text helpers measure ANSI, wide, and combining characters", () => {
  assert.equal(stripAnsi("\x1b[1mAgent\x1b[0m"), "Agent");
  assert.equal(promptDisplayWidth("A中"), 3);
  assert.equal(promptDisplayWidth("e\u0301"), 1);
});

test("terminal text helpers preserve layout semantics", () => {
  assert.equal(fitDisplayText("abcdef", 4), "abc…");
  assert.equal(padDisplayRight("A", 3), "A  ");
  assert.deepEqual(wrapDisplayText("abcd", 2), ["ab", "cd"]);
});
