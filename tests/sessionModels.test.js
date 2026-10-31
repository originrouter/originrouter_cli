import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyLaunchSessionModel,
  clearSessionModel,
  credentialForSession,
  getSessionModel,
  modelControlForTransport,
  readSessionModels,
  resolveLaunchModelTarget,
  resolvePricingTarget,
  sessionIdFromCredential,
  sessionIdFromHeaders,
  setSessionModel,
  validateSessionModelTarget,
} from "../src/proxy/sessionModels.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-session-models-"));

const config = {
  providers: {
    deepseek: {
      name: "deepseek",
      type: "proxy",
      engine: "litellm",
      litellmProvider: "deepseek",
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      models: [
        { id: "deepseek-chat", enabled: true },
        { id: "deepseek-reasoner", enabled: true },
      ],
    },
    "openai-codex": {
      name: "openai-codex",
      type: "proxy",
      engine: "litellm",
      litellmProvider: "openai",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com",
      models: [{ id: "gpt-5-codex", enabled: true }],
    },
    direct: {
      name: "direct",
      type: "anthropic",
      apiKey: "sk-test",
    },
    remote: {
      name: "remote",
      type: "remote",
      target: "proxy",
      deviceId: "dev-1",
      models: [{ id: "remote-model", enabled: true }],
    },
  },
  routes: {
    claude: { main: { provider: "deepseek", model: "deepseek-chat" } },
    codex: { main: { provider: "openai-codex", model: "gpt-5-codex" } },
  },
};

// --- credentials ---------------------------------------------------------

assert.equal(credentialForSession("claude-abc123"), "sk-orlocal-claude-abc123");
assert.equal(credentialForSession(""), null);
assert.equal(credentialForSession("has space"), null);
assert.equal(sessionIdFromCredential("sk-orlocal-claude-abc123"), "claude-abc123");
assert.equal(sessionIdFromCredential("sk-noop-litellm-passthrough"), null);
assert.equal(sessionIdFromCredential(""), null);

// Claude sends x-api-key; Codex sends a bearer token.
assert.equal(sessionIdFromHeaders({ "x-api-key": "sk-orlocal-s1" }), "s1");
assert.equal(sessionIdFromHeaders({ authorization: "Bearer sk-orlocal-s2" }), "s2");
assert.equal(sessionIdFromHeaders({ authorization: "bearer sk-orlocal-s2" }), "s2");
assert.equal(sessionIdFromHeaders({}), null);
assert.equal(sessionIdFromHeaders({ "x-api-key": "sk-noop-litellm-passthrough" }), null);

// --- validation ----------------------------------------------------------

assert.deepEqual(
  validateSessionModelTarget(config, { provider: "deepseek", model: "deepseek-chat" }),
  { ok: true, provider: "deepseek", model: "deepseek-chat" },
);
assert.equal(
  validateSessionModelTarget(config, { provider: "nope", model: "x" }).reason,
  "provider_not_found",
);
assert.equal(
  validateSessionModelTarget(config, { provider: "deepseek", model: "nope" }).reason,
  "model_not_enabled",
);
// A remote provider is not served by the local proxy, so it has no alias the
// gateway could substitute.
assert.equal(
  validateSessionModelTarget(config, { provider: "remote", model: "remote-model" }).reason,
  "provider_not_litellm",
);
// A legacy anthropic provider reads as LiteLLM-renderable but publishes no
// models, so there is nothing to point at.
assert.equal(
  validateSessionModelTarget(config, { provider: "direct", model: "claude-x" }).reason,
  "model_not_enabled",
);

// --- storage -------------------------------------------------------------

setSessionModel(stateDir, "claude-1", { agent: "claude", provider: "deepseek", model: "deepseek-reasoner" });
assert.deepEqual(getSessionModel(stateDir, "claude-1"), {
  agent: "claude",
  provider: "deepseek",
  model: "deepseek-reasoner",
  updated_at: getSessionModel(stateDir, "claude-1").updated_at,
});
assert.equal(getSessionModel(stateDir, "claude-missing"), null);

clearSessionModel(stateDir, "claude-1");
assert.equal(getSessionModel(stateDir, "claude-1"), null);

// A corrupt file degrades to "no overrides" rather than throwing: a bad file
// must not stop an agent from running on its device route.
const { writeFileSync } = await import("node:fs");
writeFileSync(join(stateDir, "session-models.json"), "{not json");
assert.deepEqual(readSessionModels(stateDir).sessions, {});

// --- launch model resolution --------------------------------------------

assert.deepEqual(
  resolveLaunchModelTarget(config, { agent: "claude", model: "deepseek/deepseek-reasoner" }),
  { ok: true, provider: "deepseek", model: "deepseek-reasoner" },
);
// A bare model id resolves against the device route's provider.
assert.deepEqual(
  resolveLaunchModelTarget(config, { agent: "claude", model: "deepseek-reasoner" }),
  { ok: true, provider: "deepseek", model: "deepseek-reasoner" },
);
assert.deepEqual(
  resolveLaunchModelTarget(config, { agent: "codex", model: "gpt-5-codex" }),
  { ok: true, provider: "openai-codex", model: "gpt-5-codex" },
);
assert.equal(
  resolveLaunchModelTarget(config, { agent: "claude", model: "not-a-model" }).reason,
  "model_not_enabled",
);

const applied = applyLaunchSessionModel(config, stateDir, "claude-2", {
  agent: "claude",
  model: "deepseek-reasoner",
});
assert.equal(applied.applied, true);
assert.equal(getSessionModel(stateDir, "claude-2").model, "deepseek-reasoner");

const rejected = applyLaunchSessionModel(config, stateDir, "claude-3", {
  agent: "claude",
  model: "not-a-model",
});
assert.equal(rejected.applied, false);
assert.equal(rejected.reason, "model_not_enabled");
assert.equal(getSessionModel(stateDir, "claude-3"), null);

// --- pricing -------------------------------------------------------------

const priced = resolvePricingTarget(config, { provider: "deepseek", model: "deepseek-reasoner" }, {
  provider: config.providers["openai-codex"],
  model: "gpt-5-codex",
});
assert.equal(priced.model, "deepseek-reasoner");
assert.equal(priced.provider.name, "deepseek");

const fallback = resolvePricingTarget(config, null, {
  provider: config.providers["openai-codex"],
  model: "gpt-5-codex",
});
assert.equal(fallback.model, "gpt-5-codex");
assert.equal(fallback.provider.name, "openai-codex");

// --- what a session may change -------------------------------------------
//
// Changing a session's model needs somewhere to rewrite the request's model on
// the way out. Three transports have such a gateway: route mode (the
// compatibility gateway), the cloud (the per-session coding auth proxy) and a
// remote device (the relay proxy) — each keyed on the per-session credential.
// A transport without one hands the request to an upstream that owns the model
// string, and there is nowhere for the change to take effect.
//
// The gate follows that rewrite point, not direct-vs-bridge: a session
// connected through the account bridge still runs on route mode and still
// changes its own conversation's model.
assert.equal(modelControlForTransport("routes"), "supported");
assert.equal(modelControlForTransport("originrouter-coding"), "supported");
assert.equal(modelControlForTransport("remote-coding"), "supported");
for (const source of ["inherited", "", null, undefined, "ROUTES"]) {
  assert.equal(modelControlForTransport(source), "unsupported", `source ${String(source)}`);
}

rmSync(stateDir, { recursive: true, force: true });
console.log("sessionModels: ok");
