import assert from "node:assert/strict";
import test from "node:test";

import {
  CollaborationCliError,
  collaborationErrorDetails,
} from "../src/commands/collaborationErrors.js";

test("collaboration CLI errors retain diagnostic context", () => {
  const error = new CollaborationCliError("failed", { diagnosticCode: "TEST" });
  assert.match(error.message, /Impact:/);
  assert.match(error.message, /Diagnostic code: TEST/);
  assert.equal(error.diagnosticCode, "TEST");
});

test("collaboration error details map stable classes to exit codes", () => {
  assert.equal(collaborationErrorDetails(401, "auth_failed").exitCode, 4);
  assert.equal(collaborationErrorDetails(503, "offline").exitCode, 10);
  assert.equal(collaborationErrorDetails(400, "unknown").exitCode, 1);
});
