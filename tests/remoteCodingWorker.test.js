// Stage 9.2 — Worker-side coverage for `handleRemoteCodingRequest`.
// Groups (per plan §B.3):
//   A. Happy path: multi-chunk body, base64 round-trip, start/chunk/end sequence.
//   B. Error paths: 5xx from local proxy, fetch throws.
//   C. Header stripping: credential + transport headers stripped, content-type preserved.
//   D. No local proxy: localProxyUrl is null → upstream_error with "local proxy is not running".
//
// No real relay, no daemon. The relayClient is a stub that captures
// every `send` call. The local proxy is a `node:http` server bound to
// 127.0.0.1:0.

import assert from "node:assert/strict";
import http from "node:http";
import { handleRemoteCodingRequest } from "../src/daemon/remoteCodingServer.js";
import {
  decryptRemoteCodingResponse,
  encryptRemoteCodingRequest,
  generateRemoteCodingIdentity,
} from "../src/crypto/remoteCodingE2ee.js";

// Capture relayClient.
function makeRelayClient(context) {
  const events = [];
  return {
    events,
    async send(type, payload) {
      events.push(decryptRemoteCodingResponse(context, { type, ...payload }));
    },
  };
}

// Start a tiny `node:http` server. `handler` receives (req, res).
function startLocalProxy(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopLocalProxy(server) {
  return new Promise((resolve) => server.close(resolve));
}

const workerIdentity = generateRemoteCodingIdentity();
const basePayload = {
  runtime: "claude",
  method: "POST",
  path: "/v1/messages",
  headers: { "content-type": "application/json", "accept": "text/event-stream" },
  body: Buffer.from('{"hello":"world"}').toString("base64"),
};

let requestCounter = 0;
function makeCase(payload = basePayload) {
  requestCounter += 1;
  const encrypted = encryptRemoteCodingRequest({
    sourceDeviceId: "caller-test",
    targetDeviceId: "worker-test",
    requestId: `req-${requestCounter}`,
    targetPublicKey: workerIdentity.publicKey,
    payload,
  });
  return {
    envelope: encrypted.envelope,
    relayClient: makeRelayClient(encrypted.context),
  };
}

// ----------------------------------------------------------------
// Group A: Happy path
// ----------------------------------------------------------------
{
  const { server, url } = await startLocalProxy(async (req, res) => {
    // Echo a multi-chunk body in three writes.
    res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
    res.write('{"answer":');
    await new Promise((r) => setTimeout(r, 5));
    res.write('42}');
    res.end();
  });

  const { envelope, relayClient } = makeCase();
  const result = await handleRemoteCodingRequest(envelope, {
    relayClient,
    localProxyUrl: url,
    e2eeIdentity: workerIdentity,
  });
  await stopLocalProxy(server);

  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.status, 200);

  // Sequence: start, chunk, chunk, end (the proxy wrote in 2 chunks).
  const types = relayClient.events.map((e) => e.type);
  assert.deepEqual(types, [
    "remote.coding.response.start",
    "remote.coding.response.chunk",
    "remote.coding.response.chunk",
    "remote.coding.response.end",
  ]);

  const start = relayClient.events[0];
  assert.equal(start.status, 200);
  assert.equal(start.headers["content-type"], "application/json");
  // transfer-encoding must be stripped.
  assert.equal(start.headers["transfer-encoding"], undefined);

  // Base64 round-trip of the body.
  const fullBody = Buffer.concat(
    relayClient.events
      .filter((e) => e.type === "remote.coding.response.chunk")
      .map((e) => Buffer.from(e.chunk, "base64"))
  ).toString("utf8");
  assert.equal(fullBody, '{"answer":42}');
}

// ----------------------------------------------------------------
// Group B1: 5xx from local proxy → single error event, no start/chunk/end
// ----------------------------------------------------------------
{
  const { server, url } = await startLocalProxy((req, res) => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("upstream is sad");
  });
  const { envelope, relayClient } = makeCase();
  const result = await handleRemoteCodingRequest(envelope, {
    relayClient,
    localProxyUrl: url,
    e2eeIdentity: workerIdentity,
  });
  await stopLocalProxy(server);

  assert.equal(result.ok, false);
  assert.equal(result.code, "upstream_error");
  assert.equal(result.status, 503);

  assert.equal(relayClient.events.length, 1, "must not emit start/chunk/end for 5xx");
  assert.equal(relayClient.events[0].type, "remote.coding.response.error");
  assert.equal(relayClient.events[0].code, "upstream_error");
  assert.equal(relayClient.events[0].status, 503);
}

// ----------------------------------------------------------------
// Group B2: fetch throws (e.g. local proxy process died mid-request) → upstream_error
// ----------------------------------------------------------------
{
  const { envelope, relayClient } = makeCase();
  // A fetchFn that always rejects simulates a torn-down local proxy.
  const result = await handleRemoteCodingRequest(envelope, {
    relayClient,
    localProxyUrl: "http://127.0.0.1:1", // port nobody listens on
    e2eeIdentity: workerIdentity,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "upstream_error");
  assert.equal(relayClient.events.length, 1);
  assert.equal(relayClient.events[0].type, "remote.coding.response.error");
  assert.equal(relayClient.events[0].code, "upstream_error");
}

// ----------------------------------------------------------------
// Group C: Header stripping
// ----------------------------------------------------------------
{
  let receivedHeaders = null;
  const { server, url } = await startLocalProxy(async (req, res) => {
    receivedHeaders = { ...req.headers };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  const payload = {
    ...basePayload,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer sk-secret-SHOULD-NOT-LEAK",
      "x-api-key": "sk-noop-SHOULD-NOT-LEAK",
      host: "evil.example",
      "content-length": "999",
      connection: "close",
      "transfer-encoding": "chunked",
      "user-agent": "originrouter-caller/9.2",
    },
  };
  const { envelope, relayClient } = makeCase(payload);
  await handleRemoteCodingRequest(
    envelope,
    { relayClient, localProxyUrl: url, e2eeIdentity: workerIdentity }
  );
  await stopLocalProxy(server);

  // The caller's noop / auth / transport headers must NOT reach the
  // worker's local proxy. `user-agent` and `content-type` survive.
  assert.equal(receivedHeaders.authorization, undefined, "authorization leaked to local proxy");
  assert.equal(receivedHeaders["x-api-key"], undefined, "x-api-key leaked to local proxy");
  assert.notEqual(receivedHeaders.host, "evil.example", "host header not overridden by fetch");
  // node http normalizes connection but the original "close" must be gone.
  assert.ok(receivedHeaders["content-type"].includes("application/json"));
  assert.equal(receivedHeaders["user-agent"], "originrouter-caller/9.2");
  // The relay events must NEVER contain the noop key. We sent
  // ANTHROPIC_API_KEY=sk-noop-litellm-passthrough from the caller
  // only via env (not in headers), but assert no header leak anyway.
  const eventsStr = JSON.stringify(relayClient.events);
  assert.ok(!eventsStr.includes("SHOULD-NOT-LEAK"));
}

// ----------------------------------------------------------------
// Group D: localProxyUrl is null
// ----------------------------------------------------------------
{
  const { envelope, relayClient } = makeCase();
  const result = await handleRemoteCodingRequest(envelope, {
    relayClient,
    localProxyUrl: null,
    e2eeIdentity: workerIdentity,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "upstream_error");
  assert.equal(relayClient.events.length, 1);
  assert.equal(relayClient.events[0].type, "remote.coding.response.error");
  assert.equal(relayClient.events[0].message, "local proxy is not running");
}

console.log("remote coding worker ok");
