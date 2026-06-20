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
    assert.ok(c.url.endsWith("/originrouter/auth/device/exchange"));
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
    assert.ok(c.url.endsWith("/originrouter/auth/device/rotate-coding-key"));
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
    assert.ok(c.url.endsWith("/originrouter/auth/device/revoke"));
    assert.equal(c.init.headers.Authorization, "Bearer raw-grant-abc");
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
    assert.ok(c.url.endsWith("/originrouter/auth/devices"));
    assert.equal(c.init.headers.Authorization, "Bearer raw-grant-q");
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
    assert.ok(c.url.endsWith("/originrouter/auth/login-code"));
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