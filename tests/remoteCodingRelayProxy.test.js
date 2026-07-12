// Stage 9.2 — Caller-side coverage.
//
// Three groups:
//   A. env-builder branch in `buildAgentProviderEnv` for type=remote, target=proxy.
//   B. caller-side HTTP↔SSE bridge end-to-end against a fake relay.
//   C. In-process PoC: fake relay + the real RemoteCodingRelayProxy.

import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { buildAgentProviderEnv, willRouteRemoteCoding } from "../src/config/claudeConfig.js";
import { RemoteCodingRelayProxy } from "../src/runtime/remoteCodingRelayProxy.js";
import { staticProxyStatusFn, NOOP_REMOTE_CODING_SNAPSHOT } from "../src/proxy/snapshot.js";

const RELAY_PORT = 28787 + Math.floor(Math.random() * 1000);

// ---- Group A: env-builder branch ---------------------------------------

{
  const config = {
    providers: {
      remote1: { name: "remote1", type: "remote", deviceId: "worker-x", target: "proxy", model: "claude-sonnet-4-6" },
    },
    routes: { claude: { main: { provider: "remote1", model: "claude-sonnet-4-6" } } },
  };
  const probe = staticProxyStatusFn({
    state: "running", port: 40123, host: "127.0.0.1", pid: 9999, runtime: "remote-coding",
  });
  const r = await buildAgentProviderEnv("claude", config, { remoteCodingStatus: probe });
  assert.equal(r.source, "remote-coding");
  assert.equal(r.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:40123");
  assert.equal(r.env.ANTHROPIC_API_KEY, "sk-noop-litellm-passthrough");
  assert.equal(r.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
}

{
  const config = {
    providers: {
      remote1: { name: "remote1", type: "remote", deviceId: "worker-x", target: "proxy", model: "gpt-5-codex" },
    },
    routes: { codex: { main: { provider: "remote1", model: "gpt-5-codex" } } },
  };
  const probe = staticProxyStatusFn({
    state: "running", port: 40123, host: "127.0.0.1", pid: 9999, runtime: "remote-coding",
  });
  const r = await buildAgentProviderEnv("codex", config, { remoteCodingStatus: probe });
  assert.equal(r.source, "remote-coding");
  assert.equal(r.env.OPENAI_BASE_URL, "http://127.0.0.1:40123/v1");
  assert.equal(r.env.OPENAI_API_KEY, "sk-noop-litellm-passthrough");
  assert.equal(r.env.OPENAI_MODEL, "gpt-5-codex");
}

{
  const config = {
    providers: { remote1: { name: "remote1", type: "remote", deviceId: "worker-x", target: "proxy", model: "m" } },
    routes: { claude: { main: { provider: "remote1", model: "m" } } },
  };
  let threw = null;
  try {
    await buildAgentProviderEnv("claude", config, { remoteCodingStatus: staticProxyStatusFn(NOOP_REMOTE_CODING_SNAPSHOT) });
  } catch (err) { threw = err; }
  assert.ok(threw, "expected throw");
  assert.equal(threw.code, "PROVIDER_UNSUPPORTED");
  assert.match(threw.message, /Remote-coding relay proxy is not running/);
}

{
  const config = {
    providers: { remote1: { name: "remote1", type: "remote", deviceId: "worker-x", target: "agent", model: "m" } },
    routes: { claude: { main: { provider: "remote1", model: "m" } } },
  };
  const probe = staticProxyStatusFn({ state: "running", port: 40123, host: "127.0.0.1", pid: 9999 });
  let threw = null;
  try { await buildAgentProviderEnv("claude", config, { remoteCodingStatus: probe }); } catch (err) { threw = err; }
  assert.ok(threw);
  assert.equal(threw.code, "PROVIDER_UNSUPPORTED");
  assert.match(threw.message, /target=agent is not supported/);
}

{
  const config = {
    providers: {
      remote1: { name: "remote1", type: "remote", deviceId: "w", target: "proxy", model: "m" },
      proxy1:  { name: "proxy1",  type: "proxy",  engine: "litellm", litellmProvider: "openai", model: "m", apiKey: "sk" },
    },
    routes: {
      claude: {
        main:  { provider: "remote1", model: "m" },
        small: { provider: "proxy1",  model: "m" },
      },
    },
  };
  const probe = staticProxyStatusFn({ state: "running", port: 40123, host: "127.0.0.1", pid: 9999 });
  let threw = null;
  try { await buildAgentProviderEnv("claude", config, { remoteCodingStatus: probe }); } catch (err) { threw = err; }
  assert.ok(threw);
  assert.equal(threw.code, "PROVIDER_UNSUPPORTED");
  assert.match(threw.message, /claude\.small.*remote provider/);
}

{
  const config = {
    providers: { remote1: { name: "remote1", type: "remote", target: "proxy", model: "m" } },
    routes: { claude: { main: { provider: "remote1", model: "m" } } },
  };
  const probe = staticProxyStatusFn({ state: "running", port: 40123, host: "127.0.0.1", pid: 9999 });
  let threw = null;
  try { await buildAgentProviderEnv("claude", config, { remoteCodingStatus: probe }); } catch (err) { threw = err; }
  assert.ok(threw);
  assert.match(threw.message, /requires a deviceId/);
}

{
  const base = (type, target) => ({
    providers: { r: { name: "r", type, target, model: "m", deviceId: "w" } },
    routes: { claude: { main: { provider: "r", model: "m" } } },
  });
  assert.equal(willRouteRemoteCoding(base("remote", "proxy"), "claude"), true);
  assert.equal(willRouteRemoteCoding(base("remote", "agent"), "claude"), false);
  assert.equal(willRouteRemoteCoding(base("originrouter", undefined), "claude"), false);
  assert.equal(willRouteRemoteCoding(base("proxy", undefined), "claude"), false);
}

// ---- Group B + C: caller-side HTTP↔WS bridge against a fake relay ----

// One fake relay process for all bridge cases. The relay keeps a
// single "current script" that the next request will execute.
const fakeRelay = await new Promise((resolve) => {
  const callerWsClients = new Set();
  let pendingScript = [];
  const postedEnvelopes = [];   // 9.2.1: every envelope the proxy POSTs is captured here.
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/relay/v1/messages") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const wrapper = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const body = wrapper.payload || wrapper;
        postedEnvelopes.push(body);
        if (body.type === "remote.coding.request") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 0, data: { accepted: true } }));
          for (const evt of pendingScript) {
            for (const c of callerWsClients) c.send(JSON.stringify({ ...evt, requestId: body.requestId }));
          }
          pendingScript = [];
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: { accepted: true } }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/relay/v1/devices/")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const parts = req.url.split("/");
      const deviceId = decodeURIComponent(parts[4] || "");
      ws.send(JSON.stringify({ type: "device.connected", device_id: deviceId }));
      if (deviceId.startsWith("caller-")) callerWsClients.add(ws);
      ws.on("message", (raw) => {
        const body = JSON.parse(String(raw));
        postedEnvelopes.push(body);
        if (body.type === "remote.coding.request") {
          for (const evt of pendingScript) {
            ws.send(JSON.stringify({ ...evt, requestId: body.requestId }));
          }
          pendingScript = [];
        }
      });
      ws.on("close", () => { callerWsClients.delete(ws); });
    });
  });
  server.unref();
  server.listen(RELAY_PORT, "127.0.0.1", () => {
    resolve({
      server,
      wss,
      setNextScript: (events) => { pendingScript = events; },
      getPostedEnvelopes: () => postedEnvelopes.slice(),
    });
  });
});

// Helper: post to the proxy and capture (status, body).
function postToProxy(port, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = http.request(
      {
        host: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-originrouter-target-device": "worker-test",
          "x-originrouter-runtime": "claude",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed = {};
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function makeProxy() {
  const proxy = new RemoteCodingRelayProxy({
    relayUrl: `http://127.0.0.1:${RELAY_PORT}`,
    deviceId: "caller-test",
  });
  await proxy.start();
  // Wait for the SSE handshake to land at the relay.
  await new Promise((r) => setTimeout(r, 80));
  return proxy;
}

const proxies = [];

// Group B1: target_offline → 502
{
  fakeRelay.setNextScript([{ type: "remote.coding.response.error", code: "target_offline", message: "offline" }]);
  const proxy = await makeProxy();
  proxies.push(proxy);
  const r = await postToProxy(proxy.status().port, {});
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "target_offline");
}

// Group B2: upstream_error → 502
{
  fakeRelay.setNextScript([{ type: "remote.coding.response.error", code: "upstream_error", status: 500, message: "boom" }]);
  const proxy = await makeProxy();
  proxies.push(proxy);
  const r = await postToProxy(proxy.status().port, {});
  assert.equal(r.status, 502);
  assert.equal(r.body.code, "upstream_error");
}

// Group B3: timeout → 504
{
  fakeRelay.setNextScript([{ type: "remote.coding.response.error", code: "timeout", message: "timed out" }]);
  const proxy = await makeProxy();
  proxies.push(proxy);
  const r = await postToProxy(proxy.status().port, {});
  assert.equal(r.status, 504);
  assert.equal(r.body.code, "timeout");
}

// Group B4: caller aborts mid-stream → proxy publishes cancel.
{
  // Script: send start + one chunk, then stay silent. The test client
  // will read the first chunk and destroy the request.
  fakeRelay.setNextScript([
    { type: "remote.coding.response.start", status: 200, headers: { "content-type": "application/json" } },
    { type: "remote.coding.response.chunk", chunk: Buffer.from('{"partial":').toString("base64") },
  ]);
  const proxy = await makeProxy();
  proxies.push(proxy);
  fakeRelay.getPostedEnvelopes().length = 0; // reset

  const result = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port: proxy.status().port, path: "/v1/messages", method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-originrouter-target-device": "worker-test",
          "x-originrouter-runtime": "claude",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c.toString("utf8");
          // Abort after first chunk.
          req.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", () => resolve({ status: 0, body }));
      }
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end("{}");
  });

  // Give the proxy a beat to publish the cancel.
  await new Promise((r) => setTimeout(r, 80));
  const envelopes = fakeRelay.getPostedEnvelopes();
  const cancel = envelopes.find((e) => e.type === "remote.coding.request.cancel");
  assert.ok(cancel, `expected cancel; got: ${JSON.stringify(envelopes.map((e) => e.type))}`);
  assert.equal(cancel.deviceId, "caller-test");
  assert.ok(typeof cancel.requestId === "string" && cancel.requestId.length > 0);
}

// Group C: full happy path — multi-chunk response, status 200, body round-trip.
{
  fakeRelay.setNextScript([
    { type: "remote.coding.response.start", status: 200, headers: { "content-type": "application/json" } },
    { type: "remote.coding.response.chunk", chunk: Buffer.from('{"answer":').toString("base64") },
    { type: "remote.coding.response.chunk", chunk: Buffer.from("42}").toString("base64") },
    { type: "remote.coding.response.end" },
  ]);
  const proxy = await makeProxy();
  proxies.push(proxy);
  const r = await postToProxy(proxy.status().port, { hello: "world" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.raw, '{"answer":42}');
}

// Tear down all proxies and the fake relay.
for (const p of proxies) {
  try { await p.stop(); } catch {}
}
fakeRelay.server.close();
fakeRelay.wss.close();
fakeRelay.server.unref();
await new Promise((r) => setTimeout(r, 30));

// ---- Group E: concurrent in-flight -----------------------------------
// Stage 9.2.1: two simultaneous HTTP requests must each get their own
// stream, with no cross-talk. Waiters Map<requestId, ...> dispatch is
// the data structure that makes this work.

const RELAY2_PORT = 27787 + Math.floor(Math.random() * 1000);

const fakeRelay2 = await new Promise((resolve) => {
  const callerWsClients = new Set();
  // Queue of pending scripts (FIFO). Each incoming request drains
  // the head of the queue. The next script in the queue is consumed
  // by the next request. Each script's events are tagged with the
  // requestId of the request that consumed the script.
  const scriptQueue = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/relay/v1/messages") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const wrapper = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const body = wrapper.payload || wrapper;
        if (body.type === "remote.coding.request") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 0, data: { accepted: true } }));
          const script = scriptQueue.shift() || [];
          for (const evt of script) {
            for (const c of callerWsClients) c.send(JSON.stringify({ ...evt, requestId: body.requestId }));
          }
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 0, data: { accepted: true } }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/relay/v1/devices/")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const parts = req.url.split("/");
      const deviceId = decodeURIComponent(parts[4] || "");
      ws.send(JSON.stringify({ type: "device.connected", device_id: deviceId }));
      if (deviceId.startsWith("caller-")) callerWsClients.add(ws);
      ws.on("message", (raw) => {
        const body = JSON.parse(String(raw));
        if (body.type === "remote.coding.request") {
          const script = scriptQueue.shift() || [];
          for (const evt of script) {
            ws.send(JSON.stringify({ ...evt, requestId: body.requestId }));
          }
        }
      });
      ws.on("close", () => { callerWsClients.delete(ws); });
    });
  });
  server.unref();
  server.listen(RELAY2_PORT, "127.0.0.1", () => {
    resolve({
      server,
      wss,
      enqueueScript: (script) => { scriptQueue.push(script); },
    });
  });
});

async function makeProxy2(deviceId) {
  const proxy = new RemoteCodingRelayProxy({
    relayUrl: `http://127.0.0.1:${RELAY2_PORT}`,
    deviceId,
  });
  await proxy.start();
  await new Promise((r) => setTimeout(r, 80));
  return proxy;
}

const proxies2 = [];

try {
  // Two scripts, each tagged for its own requestId via the test
  // header. The chunks themselves use a marker (A vs B) so we can
  // assert no cross-talk.
  fakeRelay2.enqueueScript([
    { type: "remote.coding.response.start", status: 200, headers: { "content-type": "text/plain" } },
    { type: "remote.coding.response.chunk", chunk: Buffer.from("A1").toString("base64") },
    { type: "remote.coding.response.chunk", chunk: Buffer.from("A2").toString("base64") },
    { type: "remote.coding.response.chunk", chunk: Buffer.from("A3").toString("base64") },
    { type: "remote.coding.response.end" },
  ]);
  fakeRelay2.enqueueScript([
    { type: "remote.coding.response.start", status: 200, headers: { "content-type": "text/plain" } },
    { type: "remote.coding.response.chunk", chunk: Buffer.from("B1").toString("base64") },
    { type: "remote.coding.response.chunk", chunk: Buffer.from("B2").toString("base64") },
    { type: "remote.coding.response.chunk", chunk: Buffer.from("B3").toString("base64") },
    { type: "remote.coding.response.end" },
  ]);

  const proxy = await makeProxy2("caller-2");
  proxies2.push(proxy);

  const postOnce = (pathTag) => new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1", port: proxy.status().port, path: "/v1/messages", method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-originrouter-target-device": pathTag,
          "x-originrouter-runtime": "claude",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end("{}");
  });

  // Fire both in parallel. The two requests consume the two queued
  // scripts in order; whichever consumes which is racy, but each
  // script's chunks only have one tag (A or B), so the bodies must
  // each be exactly their own three chunks.
  const [bodyX, bodyY] = await Promise.all([postOnce("worker-a"), postOnce("worker-b")]);

  const setX = new Set([bodyX, bodyY]);
  assert.ok(setX.has("A1A2A3"), `missing A1A2A3 in [${JSON.stringify(bodyX)}, ${JSON.stringify(bodyY)}]`);
  assert.ok(setX.has("B1B2B3"), `missing B1B2B3 in [${JSON.stringify(bodyX)}, ${JSON.stringify(bodyY)}]`);

  // Stronger: the A and B bodies must not contain the other's chunks.
  const aBody = bodyX.includes("A1") ? bodyX : bodyY;
  const bBody = bodyX.includes("B1") ? bodyX : bodyY;
  assert.ok(!aBody.includes("B"), `A body leaked B chunks: ${aBody}`);
  assert.ok(!bBody.includes("A"), `B body leaked A chunks: ${bBody}`);
} finally {
  for (const p of proxies2) {
    try { await p.stop(); } catch {}
  }
  fakeRelay2.server.close();
  fakeRelay2.wss.close();
  fakeRelay2.server.unref();
  await new Promise((r) => setTimeout(r, 30));
}

console.log("remote coding relay proxy ok");
