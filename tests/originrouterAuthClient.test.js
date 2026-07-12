// Stage 9.1A: tests for src/auth/originrouterAuthClient.js.
//
// Mocks the global `fetch` and asserts URL / method / header
// shape for each helper. Also asserts that AuthClientError on
// non-2xx does NOT leak the raw Authorization header.

import assert from "node:assert/strict";

import {
  AuthClientError,
  exchangeLoginCode,
  listDevices,
  requestBrowserLoginCodeForTesting,
  revokeDeviceGrant,
  rotateCodingKey,
} from "../src/auth/originrouterAuthClient.js";

const captured = [];
function installFetchMock(impl) {
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return impl(url, init);
  };
}
function okJson(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  };
}
function errJson(status, body) {
  return {
    ok: false,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
  };
}
function errText(status, text) {
  return {
    ok: false,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => text,
    json: async () => { throw new Error("not json"); },
  };
}

const cases = [];

cases.push({
  name: "exchangeLoginCode POSTs /device/exchange with no Authorization",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => okJson({ device_id: "d1" }));
    await exchangeLoginCode({
      apiBaseUrl: "https://server.example.com",
      code: "ABC123",
      deviceId: "device-1",
      deviceName: "Test",
      source: "originrouter_cli",
    });
    const c = captured[0];
    assert.equal(c.init.method, "POST");
    assert.ok(c.url.endsWith("/auth/v1/device/exchange"));
    const headers = c.init.headers || {};
    assert.equal(headers.Authorization, undefined, "no Authorization on exchange");
    const body = JSON.parse(c.init.body);
    assert.equal(body.code, "ABC123");
    assert.equal(body.client, "originrouter_cli");
    assert.equal(body.device_id, "device-1");
  },
});

cases.push({
  name: "rotateCodingKey sends Bearer device grant",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => okJson({ managed_coding_key_id: "k2" }));
    await rotateCodingKey({
      apiBaseUrl: "https://server.example.com",
      deviceGrant: "raw-grant-token-xyz",
    });
    const c = captured[0];
    assert.equal(c.init.method, "POST");
    assert.ok(c.url.endsWith("/auth/v1/device/rotate-coding-key"));
    assert.equal(c.init.headers.Authorization, "Bearer raw-grant-token-xyz");
  },
});

cases.push({
  name: "revokeDeviceGrant sends Bearer device grant",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => okJson({ ok: true, revoked_at: 1 }));
    await revokeDeviceGrant({
      apiBaseUrl: "https://server.example.com",
      deviceGrant: "raw-grant-abc",
    });
    const c = captured[0];
    assert.equal(c.init.method, "POST");
    assert.ok(c.url.endsWith("/auth/v1/device/revoke"));
    assert.equal(c.init.headers.Authorization, "Bearer raw-grant-abc");
  },
});

cases.push({
  name: "revokeDeviceGrant prefers relay access token with device id header",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => okJson({ ok: true, revoked_at: 1 }));
    await revokeDeviceGrant({
      apiBaseUrl: "https://server.example.com",
      deviceGrant: "raw-grant-abc",
      accessToken: "rt-access-token",
      deviceId: "device-1",
    });
    const c = captured[0];
    assert.equal(c.init.method, "POST");
    assert.ok(c.url.endsWith("/auth/v1/device/revoke"));
    assert.equal(c.init.headers.Authorization, "Bearer rt-access-token");
    assert.equal(c.init.headers["X-OriginRouter-Device-Id"], "device-1");
  },
});

cases.push({
  name: "listDevices sends GET with Bearer device grant",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => okJson({ scope: "current_device_only", devices: [] }));
    await listDevices({
      apiBaseUrl: "https://server.example.com",
      deviceGrant: "raw-grant-q",
    });
    const c = captured[0];
    assert.equal(c.init.method, "GET");
    assert.ok(c.url.endsWith("/auth/v1/devices"));
    assert.equal(c.init.headers.Authorization, "Bearer raw-grant-q");
  },
});

cases.push({
  name: "listDevices prefers relay access token with device id header",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => okJson({ scope: "current_device_only", devices: [] }));
    await listDevices({
      apiBaseUrl: "https://server.example.com",
      deviceGrant: "raw-grant-q",
      accessToken: "rt-access-token",
      deviceId: "device-1",
    });
    const c = captured[0];
    assert.equal(c.init.method, "GET");
    assert.ok(c.url.endsWith("/auth/v1/devices"));
    assert.equal(c.init.headers.Authorization, "Bearer rt-access-token");
    assert.equal(c.init.headers["X-OriginRouter-Device-Id"], "device-1");
  },
});

cases.push({
  name: "requestBrowserLoginCodeForTesting sends Bearer uuid",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => okJson({ code: "X" }));
    await requestBrowserLoginCodeForTesting({
      apiBaseUrl: "https://server.example.com",
      browserUuid: "test-uuid-abc",
    });
    const c = captured[0];
    assert.equal(c.init.method, "POST");
    assert.ok(c.url.endsWith("/auth/v1/login-code"));
    assert.equal(c.init.headers.Authorization, "Bearer uuid:test-uuid-abc");
  },
});

cases.push({
  name: "non-2xx JSON throws AuthClientError with status and body",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => errJson(400, { code: "invalid_code", message: "bad" }));
    try {
      await exchangeLoginCode({
        apiBaseUrl: "https://server.example.com", code: "x",
        deviceId: "d", deviceName: "n", source: "originrouter_cli",
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AuthClientError);
      assert.equal(e.status, 400);
      assert.deepEqual(e.body, { code: "invalid_code", message: "bad" });
      assert.equal(e.message, "bad");
    }
  },
});

cases.push({
  name: "non-2xx HTML exposes raw text in body",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => errText(502, "Bad Gateway"));
    try {
      await rotateCodingKey({ apiBaseUrl: "https://server.example.com", deviceGrant: "x" });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AuthClientError);
      assert.equal(e.status, 502);
      assert.equal(e.body, "Bad Gateway");
    }
  },
});

cases.push({
  name: "AuthClientError does NOT include Authorization header",
  run: async () => {
    captured.length = 0;
    installFetchMock(() => errJson(401, { code: "unauthenticated", message: "no" }));
    try {
      await rotateCodingKey({
        apiBaseUrl: "https://server.example.com",
        deviceGrant: "raw-sensitive-grant-DO-NOT-LEAK",
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof AuthClientError);
      const text = JSON.stringify({
        name: e.name, status: e.status, body: e.body, message: e.message,
        stack: e.stack,
      });
      assert.ok(!text.includes("raw-sensitive-grant-DO-NOT-LEAK"),
        "AuthClientError MUST NOT contain the raw device grant");
    }
  },
});

// Stage 9.6: exchangeResponseToManagedKeyShape tests
import { exchangeResponseToManagedKeyShape } from "../src/auth/originrouterAuthClient.js";

cases.push({
  name: "exchangeResponseToManagedKeyShape: happy path converts seconds to ms and passes isManagedKeyShape",
  run: async () => {
    const { isManagedKeyShape } = await import("../src/runtime/authContract.js");
    const out = exchangeResponseToManagedKeyShape({
      device_id: "smoke-9.6",
      device_grant: "grant-raw-secret",
      device_grant_id: "og_x",
      managed_coding_key: "sk-or-raw-secret",
      managed_coding_key_id: "ok_x",
      managed_coding_key_expires_at: 1700000000,
      device_grant_idle_expires_at: 1702592000,
      device_grant_absolute_expires_at: 1731456000,
      scopes: ["coding"],
      source: "originrouter_cli",
    });
    assert.ok(isManagedKeyShape(out), "shape must satisfy isManagedKeyShape");
    assert.equal(out.kind, "managed");
    assert.equal(out.source, "originrouter_cli");
    assert.equal(out.keyId, "ok_x");
    assert.equal(out.deviceGrantId, "og_x");
    assert.equal(out.expiresAt, 1700000000 * 1000);
    assert.equal(out.deviceGrantIdleExpiresAt, 1702592000 * 1000);
    assert.equal(out.deviceGrantAbsoluteExpiresAt, 1731456000 * 1000);
    assert.deepEqual(out.scopes, ["coding"]);
  },
});

cases.push({
  name: "exchangeResponseToManagedKeyShape: missing required field throws AuthClientError WITHOUT raw response in body or message",
  run: async () => {
    let thrown = null;
    try {
      exchangeResponseToManagedKeyShape({
        // managed_coding_key missing
        device_id: "smoke-9.6",
        device_grant: "grant-raw-DO-NOT-LEAK",
        device_grant_id: "og_x",
        managed_coding_key_id: "ok_x",
        managed_coding_key_expires_at: 1700000000,
        source: "originrouter_cli",
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown, "must throw");
    assert.equal(thrown.name, "AuthClientError");
    // The error MUST NOT include the raw grant/key in body or message.
    assert.equal(thrown.body, null, "body must be null (no raw response)");
    assert.ok(!thrown.message.includes("grant-raw-DO-NOT-LEAK"),
      "message must not contain raw grant");
    assert.ok(!thrown.message.includes("sk-or-"),
      "message must not contain a raw key prefix");
    assert.match(thrown.message, /managed_coding_key/);
  },
});

cases.push({
  name: "exchangeResponseToManagedKeyShape: missing scopes defaults to ['coding']",
  run: async () => {
    const out = exchangeResponseToManagedKeyShape({
      device_id: "smoke-9.6",
      device_grant: "g",
      device_grant_id: "og_x",
      managed_coding_key: "sk-or-x",
      managed_coding_key_id: "ok_x",
      managed_coding_key_expires_at: 1700000000,
      source: "originrouter_cli",
      // scopes intentionally omitted
    });
    assert.deepEqual(out.scopes, ["coding"]);
  },
});

// Stage 9.7: devMintLoginCode test was removed along with the
// devMintLoginCode helper (the backend's /login-code/dev-mint
// route was retired — see `README.md` Stage 9.7 migration notes).

let failures = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`  ok: ${c.name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL: ${c.name}`);
    console.log(`    ${e.message}`);
    if (e.stack) console.log(`    ${e.stack.split("\n").slice(1, 4).join("\n")}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log("originrouter auth client tests ok");
