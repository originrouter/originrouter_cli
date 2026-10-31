// The alias the agent asks for, and the model that answers.
//
// The agent is started holding a route alias — a name that never changes — and
// the gateway in front of it substitutes the concrete model on the way out.
// That substitution is what makes a running session's model changeable.
//
// What this file holds down:
//
//   1. An alias names a slot, and only our own aliases name a slot. A model
//      id that merely looks like one of ours is forwarded untouched.
//   2. The resolution order: the session's own override, then the device
//      route, then the model the session started on.
//   3. An override belongs to one runtime. One written for Codex is not
//      applied to a Claude session, even in the same device.
//   4. The body is only touched when it names one of our aliases and a
//      concrete model is known. Everything else is forwarded byte for byte.
//
// The transports are checked separately: a session's model may be changed only
// where a gateway can carry the substitution.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentAliasSlots,
  createAgentModelResolver,
  rewriteModelInBody,
  slotForAlias,
} from "../src/runtime/agentModelRewrite.js";
import {
  directProvidersForTransport,
  modelControlForTransport,
  setSessionModel,
  validateSessionModelTarget,
} from "../src/proxy/sessionModels.js";
import { activeAccountStateDir } from "../src/persistence/accounts.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-model-rewrite-"));

function writeConfig(config) {
  const dir = activeAccountStateDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

const baseConfig = {
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
    cloud: {
      name: "cloud",
      type: "originrouter",
    },
  },
  routes: {
    claude: { main: { provider: "deepseek", model: "deepseek-chat" } },
    codex: { main: { provider: "deepseek", model: "deepseek-reasoner" } },
  },
};

writeConfig(baseConfig);

function resolver(options = {}) {
  return createAgentModelResolver({
    agent: "claude",
    stateDir,
    ...options,
  });
}

// --- the alias table ----------------------------------------------------

assert.deepEqual(agentAliasSlots("claude"), {
  main: "originrouter-claude-model",
  opus: "originrouter-claude-opus",
  sonnet: "originrouter-claude-sonnet",
  haiku: "originrouter-claude-haiku",
  fable: "originrouter-claude-fable",
});
assert.deepEqual(agentAliasSlots("codex"), { main: "originrouter-codex-model" });
assert.deepEqual(agentAliasSlots("nope"), {});

assert.equal(slotForAlias("claude", "originrouter-claude-model"), "main");
assert.equal(slotForAlias("claude", "originrouter-claude-opus"), "opus");
assert.equal(slotForAlias("claude", "originrouter-claude-sonnet"), "sonnet");
assert.equal(slotForAlias("claude", "originrouter-claude-haiku"), "haiku");
assert.equal(slotForAlias("claude", "originrouter-claude-fable"), "fable");
assert.equal(slotForAlias("codex", "originrouter-codex-model"), "main");

// The historical Codex alias names the same slot as the canonical one: a
// proxy started by an older CLI still asks for it.
assert.equal(slotForAlias("codex", "gpt-5.4"), "main");

// The two tables are disjoint, so the alias itself tells us the runtime.
assert.equal(slotForAlias("codex", "originrouter-claude-model"), null);
assert.equal(slotForAlias("claude", "originrouter-codex-model"), null);

// A concrete model id is not an alias, however it is spelled.
assert.equal(slotForAlias("claude", "deepseek-chat"), null);
assert.equal(slotForAlias("claude", ""), null);
assert.equal(slotForAlias("claude", null), null);
assert.equal(slotForAlias("nope", "originrouter-claude-model"), null);

// --- the resolution chain ----------------------------------------------

const claudeMain = resolver();
assert.equal(claudeMain("originrouter-claude-model"), "deepseek-chat");
assert.equal(claudeMain("originrouter-claude-opus"), "deepseek-chat");
assert.equal(claudeMain("originrouter-claude-sonnet"), "deepseek-chat");

// An alias this runtime does not own resolves to nothing.
assert.equal(claudeMain("originrouter-codex-model"), null);
assert.equal(claudeMain("deepseek-chat"), null);

// The device route wins over the launch-time fallback.
const withFallback = resolver({ fallbackModels: { main: "launched-model" } });
assert.equal(withFallback("originrouter-claude-model"), "deepseek-chat");

// The session's own override wins over the route.
setSessionModel(stateDir, "sess-1", {
  agent: "claude",
  provider: "deepseek",
  model: "deepseek-reasoner",
});
assert.equal(
  resolver({ sessionId: "sess-1" })("originrouter-claude-model"),
  "deepseek-reasoner",
);
// Another session does not see it.
assert.equal(resolver()("originrouter-claude-model"), "deepseek-chat");

// An override written for the other runtime is not this session's.
setSessionModel(stateDir, "sess-2", {
  agent: "codex",
  provider: "deepseek",
  model: "deepseek-reasoner",
});
assert.equal(
  resolver({ sessionId: "sess-2" })("originrouter-claude-model"),
  "deepseek-chat",
);
// ...unless it names no runtime at all: then it is the session's, whichever
// session asked for it.
setSessionModel(stateDir, "sess-3", {
  provider: "deepseek",
  model: "deepseek-reasoner",
});
assert.equal(
  resolver({ sessionId: "sess-3" })("originrouter-claude-model"),
  "deepseek-reasoner",
);

// An override whose provider has since been deleted falls through to the
// route rather than naming a provider that is gone.
setSessionModel(stateDir, "sess-4", {
  agent: "claude",
  provider: "deleted-provider",
  model: "ghost-model",
});
assert.equal(
  resolver({ sessionId: "sess-4" })("originrouter-claude-model"),
  "deepseek-chat",
);

// No route at all: the device's default model answers. It is the initial
// value of the map — a session that has no route of its own still starts on
// the device default.
writeConfig({
  providers: baseConfig.providers,
  routes: {},
});
assert.equal(resolver()("originrouter-claude-model"), "claude-sonnet-5");
// The model the session started on still wins over the device default: it is
// what this session is demonstrably running.
assert.equal(
  resolver({ fallbackModels: { main: "launched-model" } })("originrouter-claude-model"),
  "launched-model",
);
// A route with a provider but no model still resolves through the provider.
writeConfig({
  providers: {
    ...baseConfig.providers,
    deepseek: { ...baseConfig.providers.deepseek, model: "deepseek-chat" },
  },
  routes: { claude: { main: { provider: "deepseek" } } },
});
assert.equal(resolver()("originrouter-claude-model"), "deepseek-chat");

writeConfig(baseConfig);

// A resolver that consults both runtime tables can still tell them apart,
// because the tables are disjoint.
const bothAgents = resolver({ agent: "codex", agents: ["claude", "codex"] });
assert.equal(bothAgents("originrouter-claude-model"), "deepseek-chat");
assert.equal(bothAgents("originrouter-codex-model"), "deepseek-reasoner");

// --- the body rewrite ---------------------------------------------------

const concrete = resolver();
const body = (model) => Buffer.from(JSON.stringify({ model, messages: [] }), "utf8");

const rewritten = rewriteModelInBody(body("originrouter-claude-model"), concrete);
assert.equal(JSON.parse(rewritten.toString("utf8")).model, "deepseek-chat");

// A body that names no alias of ours is forwarded byte for byte.
const untouched = body("deepseek-chat");
assert.equal(rewriteModelInBody(untouched, concrete), untouched);

// A body that is not JSON is forwarded byte for byte.
const notJson = Buffer.from("this is not json", "utf8");
assert.equal(rewriteModelInBody(notJson, concrete), notJson);

// An empty body, and a body without a model string, are left alone.
const empty = Buffer.alloc(0);
assert.ok(rewriteModelInBody(empty, concrete) === empty);
const noModel = Buffer.from(JSON.stringify({ messages: [] }), "utf8");
assert.equal(rewriteModelInBody(noModel, concrete), noModel);
const numberModel = Buffer.from(JSON.stringify({ model: 7 }), "utf8");
assert.equal(rewriteModelInBody(numberModel, concrete), numberModel);

// An array body is not a request.
const arrayBody = Buffer.from(JSON.stringify([{ model: "originrouter-claude-model" }]), "utf8");
assert.equal(rewriteModelInBody(arrayBody, concrete), arrayBody);

// An alias we cannot resolve is left alone rather than blanked out.
// (The other runtime's alias is the case: this resolver serves Claude.)
const unresolvable = body("originrouter-codex-model");
assert.ok(rewriteModelInBody(unresolvable, concrete) === unresolvable);

// The auxiliary Claude slots inherit the primary route, so they resolve too.
const fable = body("originrouter-claude-fable");
assert.equal(
  JSON.parse(rewriteModelInBody(fable, concrete).toString("utf8")).model,
  "deepseek-chat",
);

// A resolver that is not a function changes nothing.
const aliasBody = body("originrouter-claude-model");
assert.ok(rewriteModelInBody(aliasBody, null) === aliasBody);

// --- the transports -----------------------------------------------------

// A session's model may be changed only where a gateway can carry the
// substitution.
assert.equal(modelControlForTransport("routes"), "supported");
assert.equal(modelControlForTransport("originrouter-coding"), "supported");
assert.equal(modelControlForTransport("remote-coding"), "supported");
assert.equal(modelControlForTransport("inherited"), "unsupported");
assert.equal(modelControlForTransport(""), "unsupported");
assert.equal(modelControlForTransport(null), "unsupported");

// Route mode reaches only the LiteLLM profiles on this device, and those are
// checked against the local table.
assert.deepEqual(directProvidersForTransport({ source: "routes" }), []);
assert.deepEqual(directProvidersForTransport({ source: "inherited" }), []);

// The cloud and the remote device serve their own catalogue.
assert.deepEqual(
  directProvidersForTransport({
    source: "originrouter-coding",
    routes: { main: { provider: "cloud", model: "originrouter-cloud-model" } },
  }),
  ["cloud"],
);
assert.deepEqual(
  directProvidersForTransport({
    source: "remote-coding",
    routes: { main: { provider: "cloud", model: "originrouter-cloud-model" } },
  }),
  ["cloud"],
);
assert.deepEqual(directProvidersForTransport({ source: "originrouter-coding" }), []);

// A direct upstream is the authority on its own model ids: the device cannot
// enumerate them, so an id it has never heard of is accepted.
const cloudTarget = validateSessionModelTarget(baseConfig, {
  provider: "cloud",
  model: "a-model-the-device-never-heard-of",
  allowedProviders: ["cloud"],
});
assert.deepEqual(cloudTarget, {
  ok: true,
  provider: "cloud",
  model: "a-model-the-device-never-heard-of",
});

// But a provider that does not exist is still refused.
assert.deepEqual(
  validateSessionModelTarget(baseConfig, {
    provider: "not-a-provider",
    model: "anything",
    allowedProviders: ["not-a-provider"],
  }),
  { ok: false, reason: "provider_not_found" },
);

// A provider that publishes a model list is checked against it — that list is
// what the device offered, and an id outside it is an id the device refuses.
const withRemote = {
  providers: {
    ...baseConfig.providers,
    remote: {
      name: "remote",
      type: "remote",
      target: "proxy",
      deviceId: "dev-1",
      models: [{ id: "remote-model", enabled: true }],
    },
  },
};
assert.deepEqual(
  validateSessionModelTarget(withRemote, {
    provider: "remote",
    model: "remote-model",
    allowedProviders: ["remote"],
  }),
  { ok: true, provider: "remote", model: "remote-model" },
);
assert.deepEqual(
  validateSessionModelTarget(withRemote, {
    provider: "remote",
    model: "not-offered",
    allowedProviders: ["remote"],
  }),
  { ok: false, reason: "model_not_enabled" },
);

// A provider outside the transport's direct set is checked against the local
// table, as before.
assert.deepEqual(
  validateSessionModelTarget(baseConfig, {
    provider: "deepseek",
    model: "deepseek-chat",
    allowedProviders: ["cloud"],
  }),
  { ok: true, provider: "deepseek", model: "deepseek-chat" },
);
assert.deepEqual(
  validateSessionModelTarget(baseConfig, {
    provider: "deepseek",
    model: "never-enabled",
    allowedProviders: ["cloud"],
  }),
  { ok: false, reason: "model_not_enabled" },
);

rmSync(stateDir, { recursive: true, force: true });

console.log("agentModelRewrite: ok");
