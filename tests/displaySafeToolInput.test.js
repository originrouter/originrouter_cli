import assert from "node:assert/strict";

import {
  displaySafeToolInput,
  toolInputContainsSecret,
} from "../src/runtime/displaySafeToolInput.js";

const input = {
  command: "deploy",
  headers: { Authorization: "Bearer private" },
  api_key: "sk-private",
  access_token: "private-token",
  total_tokens: 1200,
  token_count: 500,
  nested: [{ password: "hidden", visible: "ok" }],
};

assert.equal(toolInputContainsSecret(input), true);
assert.deepEqual(displaySafeToolInput(input), {
  command: "deploy",
  headers: { Authorization: "[redacted]" },
  api_key: "[redacted]",
  access_token: "[redacted]",
  total_tokens: 1200,
  token_count: 500,
  nested: [{ password: "[redacted]", visible: "ok" }],
});

console.log("display-safe tool input tests ok");
