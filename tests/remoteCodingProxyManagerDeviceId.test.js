// Stage 9.5 — RemoteCodingProxyManager uses coding-key.json.deviceId in auth-on.
//
// When ORIGINROUTER_RELAY_AUTH=on, the manager must construct the inner
// RemoteCodingRelayProxy with the deviceId from coding-key.json, not the
// deviceId passed to the constructor. The inner proxy's
// RemoteCodingRelayClient uses that deviceId in the WebSocket URL:
//   WS <relayUrl>/relay/v1/devices/<deviceId>/ws
//
// We assert the WebSocket URL by capturing the fake relay upgrade request.
//
// We do NOT assert .status().deviceId because RemoteCodingProxyManager
// does not expose deviceId in its status object.

import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import { RemoteCodingProxyManager } from "../src/proxy/remoteCodingProxyManager.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const tmpStateDir = mkdtempSync(join(tmpdir(), "rcpm-devid-"));
try {
  writeFileSync(join(tmpStateDir, "coding-key.json"), JSON.stringify(
    makeOAuthCredential({ deviceId: "prod-X-from-coding-key" }),
    null,
    2,
  ));

  const captured = [];
  const relay = await new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      captured.push(String(req.url || ""));
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: "device.connected" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, wss, port: server.address().port });
    });
  });
  const fetchFn = globalThis.fetch;

  const prevAuth = process.env.ORIGINROUTER_RELAY_AUTH;
  process.env.ORIGINROUTER_RELAY_AUTH = "on";
  try {
    const mgr = new RemoteCodingProxyManager({
      stateDir: tmpStateDir,
      relayUrl: `http://127.0.0.1:${relay.port}`,
      deviceId: "WRONG-CONSTRUCTOR-DEVICE-ID", // intentionally wrong
      fetchFn,
    });
    const r = await mgr.start();
    assert.equal(r.ok, true, `start failed: ${JSON.stringify(r)}`);
    await new Promise((resolve) => setTimeout(resolve, 80));

    // The WebSocket URL the inner client connected to must use the coding-key
    // deviceId, not the constructor's WRONG-... value.
    const wsCall = captured.find((u) => u.includes("/relay/v1/devices/"));
    assert.ok(wsCall, `no WebSocket call captured; got: ${JSON.stringify(captured)}`);
    assert.ok(
      wsCall.includes("/relay/v1/devices/prod-X-from-coding-key/ws"),
      `WebSocket URL did not use coding-key deviceId: ${wsCall}`,
    );
    assert.ok(
      !wsCall.includes("WRONG-CONSTRUCTOR-DEVICE-ID"),
      `WebSocket URL still uses constructor deviceId: ${wsCall}`,
    );

    await mgr.stop();
  } finally {
    if (prevAuth === undefined) delete process.env.ORIGINROUTER_RELAY_AUTH;
    else process.env.ORIGINROUTER_RELAY_AUTH = prevAuth;
    relay.wss.close();
    relay.server.close();
  }
} finally {
  rmSync(tmpStateDir, { recursive: true, force: true });
}

console.log("remoteCodingProxyManager deviceId override ok");
