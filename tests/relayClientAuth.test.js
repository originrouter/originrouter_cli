// Stage 9.3 — RelayClient authToken seam tests.
//
// Verifies the additive `authToken` parameter on
// `src/relay/relayClient.js` (the worker daemon's hot path).
//
// Cases:
//   1. Default constructor (no authToken) -> postJson sends no Authorization header
//   2. Constructor with authToken -> postJson carries Authorization: Bearer <token>
//   3. setAuthToken(newToken) updates the bearer on subsequent calls
//   4. authToken: null after setAuthToken() clears the header
//   5. SSE connectEvents also carries Authorization when authToken is set

import http from "node:http";
import assert from "node:assert/strict";
import { RelayClient } from "../src/relay/relayClient.js";

const PORT = 19100 + Math.floor(Math.random() * 1000);

function makeCapture() {
  const captured = { requests: [] };
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
      if (req.url.startsWith("/device/events")) {
        // SSE — return a single event then close.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
        return; // keep open until client closes
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => resolve({ server, captured }));
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
    server.close();
    console.log("[1] default constructor -> no Authorization ok");
  }

  // 2. Constructor with authToken: Authorization: Bearer <token>
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "rt_alpha",
    });
    await c.send("test", { foo: "bar" });
    assert.equal(captured.requests[0].headers.authorization, "Bearer rt_alpha");
    server.close();
    console.log("[2] authToken -> Authorization: Bearer rt_alpha ok");
  }

  // 3. setAuthToken updates the bearer
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "rt_old",
    });
    await c.send("first", {});
    c.setAuthToken("rt_new");
    await c.send("second", {});
    assert.equal(captured.requests[0].headers.authorization, "Bearer rt_old");
    assert.equal(captured.requests[1].headers.authorization, "Bearer rt_new");
    server.close();
    console.log("[3] setAuthToken -> new token in next call ok");
  }

  // 4. setAuthToken(null) clears the header
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "rt_x",
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

  // 5. SSE connectEvents carries Authorization
  {
    const { server, captured } = await makeCapture();
    const c = new RelayClient({
      relayUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d1",
      authToken: "rt_sse",
    });
    // connectEvents blocks; we only need to capture the request, then
    // the test ends. The reader promise never resolves here, so we
    // race it against a timeout.
    const connPromise = c.connectEvents(() => {});
    await delay(150);
    const sseReq = captured.requests.find((r) => r.url.startsWith("/device/events"));
    assert.ok(sseReq, "expected an SSE request to be captured");
    assert.equal(sseReq.headers.authorization, "Bearer rt_sse");
    server.close();
    connPromise.catch(() => {});
  }
  console.log("[5] connectEvents -> Authorization: Bearer rt_sse ok");

  console.log("relay client auth ok");
} catch (err) {
  console.error("relay client auth FAILED:", err.message);
  process.exitCode = 1;
}
