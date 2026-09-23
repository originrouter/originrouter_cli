import assert from "node:assert/strict";
import test from "node:test";

import {
  hasOption,
  optionValue,
  optionValues,
  parseOptionArgs,
} from "../src/commands/shared/cliArgs.js";

test("shared CLI argument helpers support repeated and equals options", () => {
  const args = ["--role", "planner", "--role=builder", "--json"];
  assert.deepEqual(optionValues(args, "role"), ["planner", "builder"]);
  assert.equal(optionValue(args, "--role"), "builder");
  assert.equal(hasOption(args, "json"), true);
  assert.equal(hasOption(args, "missing"), false);
});

test("shared option parser preserves boolean and value semantics", () => {
  assert.deepEqual(
    parseOptionArgs(["--json", "--limit", "10"], { booleanFlags: ["json"] }),
    { "--json": true, "--limit": "10" },
  );
  assert.throws(
    () => parseOptionArgs(["--limit"], { booleanFlags: ["json"] }),
    /Missing value for --limit/,
  );
});
