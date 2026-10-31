// The gateway is where a per-session model override becomes a concrete model.
//
// Without an override, the agent's model string reaches the upstream untouched
// and the proxy resolves it through the device route. With one, the gateway
// substitutes the pinned model — and the substitution happens before the
// compatibility context is built, so the patch engine sees the provider family
// the request will actually reach.

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCompatibilityGateway } from "../src/compatibility/gateway.js";

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
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    received.push({ path: req.url, model: parsed.model, key: req.headers["x-api-key"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body || "{}");
  });
});

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-session-gateway-"));
const routeMap = {
  aliases: {
    "originrouter-claude-model": {
      provider: "deepseek",
      provider_family: "deepseek",
      litellm_provider: "deepseek",
      upstream_model: "deepseek-chat",
      runtime: "claude",
      slot: "main",
    },
    "deepseek/deepseek-reasoner": {
      provider: "deepseek",
      provider_family: "deepseek",
      litellm_provider: "deepseek",
      upstream_model: "deepseek-reasoner",
    },
    "openai-codex/gpt-5-codex": {
      provider: "openai-codex",
      provider_family: "openai",
      litellm_provider: "openai",
      upstream_model: "gpt-5-codex",
    },
  },
};

const gateway = createCompatibilityGateway({
  upstreamBaseUrl: `http://127.0.0.1:${await listen(upstream)}`,
  routeMap,
  sessionModelProvider(headers) {
    const key = headers["x-api-key"];
    const sessionId = String(key || "").replace(/^sk-orlocal-/, "");
    const overrides = {
      "claude-pinned": { provider: "deepseek", model: "deepseek-reasoner" },
      "codex-pinned": { provider: "openai-codex", model: "gpt-5-codex" },
      "claude-stale": { provider: "deepseek", model: "deleted-model" },
    };
    const entry = overrides[sessionId];
    if (!entry) return null;
    const alias = `${entry.provider}/${entry.model}`;
    if (!routeMap.aliases[alias]) return null;
    return { ...entry, alias };
  },
  logger: { log: () => {}, warn: () => {} },
});
const gatewayPort = await listen(gateway);

async function post(model, key) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify({ model, messages: [] }),
  });
  return response.status;
}

try {
  // 1. No override: the agent's alias reaches the upstream untouched.
  await post("originrouter-claude-model", "sk-orlocal-claude-plain");
  assert.equal(received.at(-1).model, "originrouter-claude-model");

  // 2. With an override: the alias is replaced by the pinned model.
  await post("originrouter-claude-model", "sk-orlocal-claude-pinned");
  assert.equal(received.at(-1).model, "deepseek/deepseek-reasoner");

  // 3. The credential is not the only thing that changes — the request body
  //    does. The agent's own model string stays the alias.
  await post("originrouter-claude-opus", "sk-orlocal-claude-pinned");
  assert.equal(received.at(-1).model, "deepseek/deepseek-reasoner");

  // 4. A provider the proxy no longer serves falls back to the device route.
  await post("originrouter-claude-model", "sk-orlocal-claude-stale");
  assert.equal(received.at(-1).model, "originrouter-claude-model");

  // 5. The credential still reaches the upstream; the proxy does not
  //    authenticate it, but it must not be stripped either.
  await post("originrouter-claude-model", "sk-orlocal-claude-pinned");
  assert.equal(received.at(-1).key, "sk-orlocal-claude-pinned");

  // 6. A non-JSON body passes through untouched — the gateway must not break
  //    a request it cannot parse.
  const raw = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-orlocal-claude-pinned" },
    body: "not json",
  });
  assert.equal(raw.status, 200);

  console.log("compatibilitySessionModel: ok");
} finally {
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
  rmSync(stateDir, { recursive: true, force: true });
}
