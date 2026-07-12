// Remote-coding relay transport audit for the unified /relay/v1/* contract.
//
// The relay must receive request headers/body to forward the model call, so
// this test does not claim the relay payload is secret-free. It verifies the
// caller-side client no longer uses legacy public paths and that canary
// request secrets are not copied into URLs or normalized error text.

import assert from "node:assert/strict";

import { RemoteCodingRelayClient } from "../src/relay/remoteCodingRelayClient.js";

const PROMPT_CANARY = `the-secret-prompt-content-${Math.random().toString(36).slice(2, 10)}`;
const KEY_CANARY = `sk-probe-leak-canary-${Math.random().toString(36).slice(2, 10)}`;

let captured = null;
const client = new RemoteCodingRelayClient({
  relayUrl: "https://app.easytransnote.com",
  deviceId: "caller-leak",
  authToken: "relay-access-token",
  fetchFn: async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: { accepted: false, reason: "target_offline" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});

const result = await client.publishRequest({
  type: "remote.coding.request",
  requestId: `req-leak-${Date.now()}`,
  sourceDeviceId: "caller-leak",
  targetDeviceId: "worker-leak",
  runtime: "claude",
  method: "POST",
  path: "/v1/messages",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${KEY_CANARY}`,
    "x-api-key": KEY_CANARY,
    "anthropic-version": "2023-06-01",
  },
  body: Buffer.from(JSON.stringify({
    messages: [{ role: "user", content: PROMPT_CANARY }],
  })).toString("base64"),
});

assert.equal(captured.url, "https://app.easytransnote.com/relay/v1/messages");
assert.ok(!captured.url.includes(`/device/${"events"}`));
assert.ok(!captured.url.includes(`/device/${"message"}`));
assert.equal(captured.options.headers.Authorization, "Bearer relay-access-token");

const normalizedResult = JSON.stringify(result);
assert.ok(!normalizedResult.includes(PROMPT_CANARY), "prompt leaked into normalized relay result");
assert.ok(!normalizedResult.includes(KEY_CANARY), "API key leaked into normalized relay result");
assert.equal(result.body.accepted, false);
assert.equal(result.body.reason, "target_offline");

console.log("remote coding secret-leak audit ok");
