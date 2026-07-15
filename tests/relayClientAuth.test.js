// RelayClient access-token transport tests.
//
// Cases:
//   1. Default constructor (no authToken) -> postJson sends no Authorization header
//   2. Constructor with authToken -> postJson carries Authorization: Bearer <token>
//   3. setAuthToken(newToken) updates the bearer on subsequent calls
//   4. authToken: null after setAuthToken() clears the header
//   5. WebSocket connectEvents also carries Authorization when authToken is set

import http from "node:http";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { RelayClient } from "../src/relay/relayClient.js";

const PORT = 19100 + Math.floor(Math.random() * 1000);

function makeCapture() {
  const captured = { requests: [] };
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "ping" }));
    ws.close();
  });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.on("upgrade", (req, socket, head) => {
    captured.requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: "",
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => resolve({ server, wss, captured }));
  });
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  // 1. Default constructor: no Authorization
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({ relayUrl: `http://127.0.0.1:${PORT}`, deviceId: "d1" });
    await c.send("test", { foo: "bar" });
    assert.equal(captured.requests[0].headers.authorization, undefined);
    assert.equal(captured.requests[0].url, "/relay/v1/messages");
    server.close();
    console.log("[1] default constructor -> no Authorization ok");
  }

  // 2. Constructor with authToken: Authorization: Bearer <token>
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "or_at_alpha",
    });
    await c.send("test", { foo: "bar" });
    assert.equal(captured.requests[0].headers.authorization, "Bearer or_at_alpha");
    server.close();
    console.log("[2] authToken -> Authorization bearer ok");
  }

  // 3. setAuthToken updates the bearer
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "or_at_old",
    });
    await c.send("first", {});
    c.setAuthToken("or_at_new");
    await c.send("second", {});
    assert.equal(captured.requests[0].headers.authorization, "Bearer or_at_old");
    assert.equal(captured.requests[1].headers.authorization, "Bearer or_at_new");
    server.close();
    console.log("[3] setAuthToken -> new token in next call ok");
  }

  // 4. setAuthToken(null) clears the header
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "or_at_x",
    });
    c.setAuthToken(null);
    // Retry once if the previous server's close hasn't fully released
    // the port (common in test suites on macOS).
    try {
      await c.send("third", {});
    } catch (err) {
      await delay(100);
      await c.send("third-retry", {});
    }
    const reqs = captured.requests;
    assert.equal(reqs[reqs.length - 1].headers.authorization, undefined);
    server.close();
    console.log("[4] setAuthToken(null) -> no Authorization ok");
  }

  // 5. WebSocket connectEvents carries Authorization
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "or_at_ws",
    });
    const connPromise = c.connectEvents(() => {});
    await delay(150);
    const wsReq = captured.requests.find((r) => r.url.startsWith("/relay/v1/devices/d1/ws"));
    assert.ok(wsReq, "expected a WebSocket request to be captured");
    assert.equal(wsReq.headers.authorization, "Bearer or_at_ws");
    await connPromise;
    server.close();
  }
  console.log("[5] connectEvents -> Authorization bearer ok");

  console.log("relay client auth ok");
} catch (err) {
  console.error("relay client auth FAILED:", err.message);
  process.exitCode = 1;
}
