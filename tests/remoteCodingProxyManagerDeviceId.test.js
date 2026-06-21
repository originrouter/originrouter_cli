// Stage 9.5 — RemoteCodingProxyManager uses coding-key.json.deviceId in auth-on.
//
// When ORIGINROUTER_RELAY_AUTH=on, the manager must construct the inner
// RemoteCodingRelayProxy with the deviceId from coding-key.json, not the
// deviceId passed to the constructor. The inner proxy's
// RemoteCodingRelayClient uses that deviceId in the SSE URL:
//   GET <relayUrl>/device/events?deviceId=<deviceId>
//
// We assert the SSE URL by spying on the fetchFn passed to the manager
// (which is forwarded to the inner client). The fake fetchFn captures
// every URL the inner client requests.
//
// We do NOT assert .status().deviceId because RemoteCodingProxyManager
// does not expose deviceId in its status object.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteCodingProxyManager } from "../src/proxy/remoteCodingProxyManager.js";

const tmpStateDir = mkdtempSync(join(tmpdir(), "rcpm-devid-"));
try {
  // The coding-key.json shape must satisfy isManagedKeyShape().
  // deviceGrant and deviceId are what _acquireToken() reads.
  const expiresAtMs = Date.now() + 3600_000;
  writeFileSync(join(tmpStateDir, "coding-key.json"), JSON.stringify({
    kind: "managed",
    source: "originrouter_cli",
    keyId: "ck-test",
    key: "sk-test",
    deviceGrantId: "dgid-test",
    deviceGrant: "dg-test-grant-9.5",
    deviceId: "prod-X-from-coding-key",
    expiresAt: expiresAtMs,
    scopes: ["coding"],
  }, null, 2));

  // Spy fetchFn: capture every URL the inner client requests.
  // For the SSE GET, return a never-ending body so the proxy stays open
  // but we can immediately stop the manager and inspect what was captured.
  const sseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"type\":\"device.connected\",\"deviceId\":\"\"}\n\n"));
    },
    cancel() {},
  });
  const captured = [];
  const fetchFn = async (url, opts = {}) => {
    captured.push(String(url));
    // First call: SSE GET. Return a 200 with a never-ending body.
    // Subsequent calls: token POST. Return a Surety 200/0.
    if (String(url).includes("/api/relay/token")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "success",
        data: { "relay-access-token": "test-token", "expires-at": Math.floor(Date.now()/1000) + 3600, "token-id": "tid", scopes: ["relay.remote_coding"] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const prevAuth = process.env.ORIGINROUTER_RELAY_AUTH;
  const prevSurety = process.env.SURETY_BASE_URL;
  process.env.ORIGINROUTER_RELAY_AUTH = "on";
  process.env.SURETY_BASE_URL = "http://127.0.0.1:9001";
  try {
    const mgr = new RemoteCodingProxyManager({
      stateDir: tmpStateDir,
      relayUrl: "http://127.0.0.1:9999",
      deviceId: "WRONG-CONSTRUCTOR-DEVICE-ID", // intentionally wrong
      fetchFn,
    });
    const r = await mgr.start();
    assert.equal(r.ok, true, `start failed: ${JSON.stringify(r)}`);

    // The SSE URL the inner client connected to must use the coding-key
    // deviceId, not the constructor's WRONG-... value.
    const sseCall = captured.find((u) => u.includes("/device/events"));
    assert.ok(sseCall, `no SSE call captured; got: ${JSON.stringify(captured)}`);
    assert.ok(
      sseCall.includes("deviceId=prod-X-from-coding-key"),
      `SSE URL did not use coding-key deviceId: ${sseCall}`,
    );
    assert.ok(
      !sseCall.includes("WRONG-CONSTRUCTOR-DEVICE-ID"),
      `SSE URL still uses constructor deviceId: ${sseCall}`,
    );

    await mgr.stop();
  } finally {
    if (prevAuth === undefined) delete process.env.ORIGINROUTER_RELAY_AUTH;
    else process.env.ORIGINROUTER_RELAY_AUTH = prevAuth;
    if (prevSurety === undefined) delete process.env.SURETY_BASE_URL;
    else process.env.SURETY_BASE_URL = prevSurety;
  }
} finally {
  rmSync(tmpStateDir, { recursive: true, force: true });
}

console.log("remoteCodingProxyManager deviceId override ok");
