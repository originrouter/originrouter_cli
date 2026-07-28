import assert from "node:assert/strict";
import test from "node:test";

import { classifyError } from "../src/runtime/cliErrors.js";

test("device E2EE quota errors have actionable CLI messages", () => {
  const deviceLimit = new Error("active_device_limit_reached");
  deviceLimit.code = "active_device_limit_reached";
  deviceLimit.status = 409;
  assert.deepEqual(classifyError(deviceLimit), {
    headline: "This account already has 50 active devices.",
    next: "Revoke a device you no longer use in the App, then try again.",
  });

  const rotationLimit = new Error("daily_key_rotation_limit_reached");
  rotationLimit.code = "daily_key_rotation_limit_reached";
  rotationLimit.status = 429;
  assert.deepEqual(classifyError(rotationLimit), {
    headline: "This account has already rotated device keys 10 times today.",
    next: "Try again after the next UTC day begins.",
  });
});
