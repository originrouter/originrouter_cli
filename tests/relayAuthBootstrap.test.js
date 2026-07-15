import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelayClientOptions,
  RelayAuthBootstrapError,
} from "../src/relay/relayAuthBootstrap.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

test("relay auth off does not require a login", async () => {
  const result = await buildRelayClientOptions({
    relayUrl: "https://relay.example.test",
    fallbackDeviceId: "fallback-device",
    forceAuth: false,
  });
  assert.deepEqual(result, {
    relayUrl: "https://relay.example.test",
    deviceId: "fallback-device",
    authToken: null,
    authState: "off",
  });
});

test("relay auth selects the relay audience token", async () => {
  let requestedResource = null;
  const credential = makeOAuthCredential({ deviceId: "device-relay" });
  const result = await buildRelayClientOptions({
    stateDir: "/tmp/relay-oauth-test",
    relayUrl: "https://relay.example.test",
    fallbackDeviceId: "fallback-device",
    forceAuth: true,
    ensureFreshAccessTokenFn: async ({ resource }) => {
      requestedResource = resource;
      return credential;
    },
  });
  assert.equal(requestedResource, "originrouter.relay");
  assert.equal(result.deviceId, "device-relay");
  assert.equal(result.authToken, "or_at_relay_test");
  assert.equal(result.authState, "on");
});

test("relay auth requires an OAuth login", async () => {
  await assert.rejects(
    () => buildRelayClientOptions({
      forceAuth: true,
      ensureFreshAccessTokenFn: async () => null,
    }),
    (error) => error instanceof RelayAuthBootstrapError &&
      error.code === "login_required" && error.message === error.code,
  );
});

test("relay refresh errors expose only the stable error code", async () => {
  const secret = "or_rt_must_not_leak";
  await assert.rejects(
    () => buildRelayClientOptions({
      forceAuth: true,
      ensureFreshAccessTokenFn: async () => {
        const error = new Error(secret);
        error.code = "invalid_grant";
        throw error;
      },
    }),
    (error) => error.code === "invalid_grant" &&
      error.message === "invalid_grant" && !error.message.includes(secret),
  );
});
