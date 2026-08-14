import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthClientError,
  pollDeviceToken,
  refreshOAuthToken,
  requestDeviceCode,
  revokeOAuthToken,
} from "../src/auth/originrouterAuthClient.js";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("requestDeviceCode sends RFC 8628 form data and all resources", async () => {
  let call;
  await requestDeviceCode({
    suretyBaseUrl: "https://surety.example.test/",
    deviceId: "device-1",
    deviceName: "Work Mac",
    fetchFn: async (url, init) => {
      call = { url, init };
      return response(200, { device_code: "or_dc_test", user_code: "ABCD" });
    },
  });
  const body = new URLSearchParams(call.init.body);
  assert.equal(call.url, "https://surety.example.test/api/oauth/device/code");
  assert.equal(call.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(body.get("client_id"), "originrouter_cli");
  assert.equal(body.get("device_id"), "device-1");
  assert.deepEqual(body.getAll("resource"), [
    "originrouter.control",
    "originrouter.ai",
    "originrouter.coding",
    "originrouter.relay",
    "originrouter.memory",
  ]);
});

test("device poll and refresh send the requested audience", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body) });
    return response(200, { access_token: "or_at_test", refresh_token: "or_rt_test" });
  };
  await pollDeviceToken({
    suretyBaseUrl: "https://surety.example.test",
    deviceCode: "or_dc_test",
    resource: "originrouter.control",
    fetchFn,
  });
  await refreshOAuthToken({
    tokenEndpoint: "https://surety.example.test/api/oauth/token",
    refreshToken: "or_rt_old",
    resource: "originrouter.coding",
    fetchFn,
  });
  assert.equal(calls[0].body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(calls[0].body.get("resource"), "originrouter.control");
  assert.equal(calls[1].body.get("grant_type"), "refresh_token");
  assert.equal(calls[1].body.get("refresh_token"), "or_rt_old");
  assert.equal(calls[1].body.get("resource"), "originrouter.coding");
});

test("revoke sends the refresh token without a service credential", async () => {
  let body;
  await revokeOAuthToken({
    revocationEndpoint: "https://surety.example.test/api/oauth/revoke",
    token: "or_rt_secret",
    fetchFn: async (_url, init) => {
      body = new URLSearchParams(init.body);
      return response(200, {});
    },
  });
  assert.equal(body.get("client_id"), "originrouter_cli");
  assert.equal(body.get("token"), "or_rt_secret");
});

test("OAuth errors expose a stable code without echoing submitted secrets", async () => {
  const secret = "or_rt_secret_must_not_leak";
  await assert.rejects(
    () => refreshOAuthToken({
      tokenEndpoint: "https://surety.example.test/api/oauth/token",
      refreshToken: secret,
      resource: "originrouter.ai",
      fetchFn: async () => response(401, { error: "invalid_grant", detail: secret }),
    }),
    (error) => error instanceof AuthClientError &&
      error.code === "invalid_grant" &&
      error.message === "invalid_grant" &&
      !JSON.stringify(error).includes(secret),
  );
});
