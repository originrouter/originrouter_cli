import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentRelayPlan,
  normalizeAgentRelayMode,
} from "../src/relay/agentRelayPolicy.js";

test("local Relay mode never requests an OAuth token", async () => {
  let refreshCalls = 0;
  const plan = await buildAgentRelayPlan({
    stateDir: "/tmp/originrouter-relay-policy",
    relayUrl: "https://app.easytransnote.com",
    fallbackDeviceId: "local-device",
    mode: "local",
    ensureFreshAccessTokenFn: async () => {
      refreshCalls += 1;
      return null;
    },
  });
  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, "local_only");
  assert.equal(refreshCalls, 0);
});

test("official Relay uses authenticated cloud when signed in", async () => {
  const plan = await buildAgentRelayPlan({
    stateDir: "/tmp/originrouter-relay-policy",
    relayUrl: "https://app.easytransnote.com",
    fallbackDeviceId: "fallback-device",
    mode: "auto",
    ensureFreshAccessTokenFn: async () => ({
      deviceId: "oauth-device",
      accessTokens: {
        relay: {
          token: "or_at_relay",
          expiresAt: Date.now() + 60_000,
          scopes: ["relay.connect"],
        },
      },
    }),
  });
  assert.equal(plan.enabled, true);
  assert.equal(plan.authState, "on");
  assert.equal(plan.deviceId, "oauth-device");
  assert.equal(plan.authToken, "or_at_relay");
});

test("official Relay degrades to local-only when login is unavailable", async () => {
  const plan = await buildAgentRelayPlan({
    stateDir: "/tmp/originrouter-relay-policy",
    relayUrl: "https://app.easytransnote.com",
    fallbackDeviceId: "local-device",
    mode: "auto",
    ensureFreshAccessTokenFn: async () => null,
  });
  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, "login_required");
  assert.equal(plan.deviceId, "local-device");
});

test("custom Relay keeps explicit unauthenticated LAN compatibility", async () => {
  const previous = process.env.ORIGINROUTER_RELAY_AUTH;
  delete process.env.ORIGINROUTER_RELAY_AUTH;
  try {
    const plan = await buildAgentRelayPlan({
      stateDir: "/tmp/originrouter-relay-policy",
      relayUrl: "http://192.168.1.8:8787",
      fallbackDeviceId: "lan-device",
      mode: "custom",
    });
    assert.equal(plan.enabled, true);
    assert.equal(plan.authState, "off");
    assert.equal(plan.authToken, null);
  } finally {
    if (previous === undefined) delete process.env.ORIGINROUTER_RELAY_AUTH;
    else process.env.ORIGINROUTER_RELAY_AUTH = previous;
  }
});

test("off is a local-mode alias", () => {
  assert.equal(normalizeAgentRelayMode("off"), "local");
});
