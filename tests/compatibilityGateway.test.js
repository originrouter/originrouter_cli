import assert from "node:assert/strict";
import http from "node:http";

import { CompatibilityEngine } from "../src/compatibility/engine.js";
import { createCompatibilityGateway } from "../src/compatibility/gateway.js";
import { COMPATIBILITY_OPERATORS } from "../src/compatibility/operators.js";
import { COMPATIBILITY_PACK_SCHEMA } from "../src/compatibility/patchPack.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const received = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({ path: req.url, body });
    if (req.url === "/health/liveliness") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    if (parsed.model === "provider/openai-response") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"output":"raw"}');
      return;
    }
    if (parsed.model === "provider/openai-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('event: response.output_text.delta\ndata: {"delta":"raw"}\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body || "{}");
  });
});

const upstreamPort = await listen(upstream);
const logs = [];
const updatePack = {
  schema: COMPATIBILITY_PACK_SCHEMA,
  pack_id: "gateway-phase-test",
  revision: 2,
  min_engine_version: "1.0.0",
  patches: [
    {
      id: "test.response",
      version: "1",
      phase: "response",
      match: { models: ["provider/openai-response"] },
      operations: [{ operator: "test_marker", options: { field: "response_patched" } }],
    },
    {
      id: "test.stream",
      version: "1",
      phase: "stream",
      match: { models: ["provider/openai-stream"] },
      operations: [{ operator: "test_marker", options: { field: "stream_patched" } }],
    },
  ],
};
const engine = new CompatibilityEngine({
  updatePack,
  operators: {
    ...COMPATIBILITY_OPERATORS,
    test_marker(document, options) {
      return { document: { ...document, [options.field]: true }, changed: true, metadata: null };
    },
  },
});
const gateway = createCompatibilityGateway({
  upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
  routeMap: {
    aliases: {
      "provider/claude": {
        provider: "provider",
        provider_family: "anthropic",
        litellm_provider: "anthropic",
        upstream_model: "claude",
        runtime: "codex",
      },
      "provider/openai": {
        provider: "provider",
        provider_family: "openai",
        litellm_provider: "openai",
        upstream_model: "gpt",
        runtime: "codex",
      },
      "provider/openai-response": {
        provider: "provider",
        provider_family: "openai",
        litellm_provider: "openai",
        upstream_model: "gpt",
        runtime: "codex",
      },
      "provider/openai-stream": {
        provider: "provider",
        provider_family: "openai",
        litellm_provider: "openai",
        upstream_model: "gpt",
        runtime: "codex",
      },
    },
  },
  engine,
  logger: { log: (...args) => logs.push(args) },
});
const gatewayPort = await listen(gateway);

try {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "provider/claude",
      tools: [{ type: "namespace", tools: [{ type: "function", name: "read" }] }],
      input: [
        { type: "function_call", call_id: "one", name: "read", arguments: "{}" },
        { type: "message", role: "assistant", content: "remove for compatibility" },
        { type: "function_call_output", call_id: "one", output: "ok" },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-originrouter-compatibility-patches"), "1");
  const body = await response.json();
  assert.deepEqual(body.tools, [{ type: "function", name: "read" }]);
  assert.deepEqual(body.input.map((item) => item.type), ["function_call", "function_call_output"]);
  assert.equal(logs.length, 1);

  const nativeResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "provider/openai",
      tools: [{ type: "namespace", tools: [{ type: "function", name: "native" }] }],
      input: [],
    }),
  });
  const nativeBody = await nativeResponse.json();
  assert.equal(nativeBody.tools[0].type, "namespace");
  assert.equal(nativeResponse.headers.get("x-originrouter-compatibility-patches"), null);

  const patchedResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "provider/openai-response", input: [] }),
  });
  assert.deepEqual(await patchedResponse.json(), { output: "raw", response_patched: true });
  assert.equal(patchedResponse.headers.get("x-originrouter-compatibility-patches"), "1");

  const patchedStream = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "provider/openai-stream", input: [], stream: true }),
  });
  const streamText = await patchedStream.text();
  assert.match(streamText, /"stream_patched":true/);
  assert.match(streamText, /data: \[DONE\]/);

  const health = await fetch(`http://127.0.0.1:${gatewayPort}/health/liveliness`);
  assert.equal(health.status, 200);
  assert.equal(received.at(-1).path, "/health/liveliness");
} finally {
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
}

console.log("compatibilityGateway tests passed");
