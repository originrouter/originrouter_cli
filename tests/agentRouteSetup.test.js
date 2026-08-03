import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRecommendedCloudRoutes,
  clearOriginrouterCloudRoutes,
  handleAgentRouteSetup,
  maybeConfigureAgentRoutesAfterLogin,
  recommendedCloudRouteModels,
  resetCloudRoutesOnLogout,
} from "../src/commands/agentRouteSetup.js";

const MODELS = [
  { id: "claude-opus-5", name: "Claude Opus 5", origin: "Anthropic" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", origin: "Anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", origin: "Anthropic" },
  { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", origin: "OpenAI" },
];

test("recommended Cloud setup chooses separate Claude and Codex defaults", () => {
  const selected = recommendedCloudRouteModels(MODELS);
  assert.equal(selected.claudeMain.id, "claude-sonnet-5");
  assert.equal(selected.claudeSmall.id, "claude-haiku-4-5");
  assert.equal(selected.codexMain.id, "gpt-5.6-sol");
});

test("recommended Cloud setup falls back within compatible model families", () => {
  const selected = recommendedCloudRouteModels([
    { id: "claude-custom", name: "Claude Custom", origin: "Anthropic" },
    { id: "gpt-custom", name: "GPT Custom", origin: "OpenAI" },
  ]);
  assert.equal(selected.claudeMain.id, "claude-custom");
  assert.equal(selected.claudeSmall.id, "claude-custom");
  assert.equal(selected.codexMain.id, "gpt-custom");
});

test("applying recommended Cloud setup atomically configures every Agent slot", () => {
  const result = applyRecommendedCloudRoutes({}, MODELS);
  assert.equal(result.config.providers["originrouter-cloud"].type, "originrouter");
  assert.deepEqual(result.config.routes, {
    claude: {
      main: { provider: "originrouter-cloud", model: "claude-sonnet-5" },
      small: { provider: "originrouter-cloud", model: "claude-haiku-4-5" },
    },
    codex: {
      main: { provider: "originrouter-cloud", model: "gpt-5.6-sol" },
    },
  });
});

test("logout removes only OriginRouter Cloud routes and preserves private Providers", () => {
  const initial = applyRecommendedCloudRoutes({
    providers: {
      private: {
        name: "private",
        type: "proxy",
        engine: "litellm",
        litellmProvider: "ollama",
        model: "qwen3-coder",
        models: [{ id: "qwen3-coder", enabled: true }],
      },
    },
  }, MODELS).config;
  const mixed = {
    ...initial,
    routes: {
      ...initial.routes,
      codex: { main: { provider: "private", model: "qwen3-coder" } },
    },
  };
  const result = clearOriginrouterCloudRoutes(mixed);
  assert.equal(result.changed, true);
  assert.deepEqual(result.clearedAgents, ["claude"]);
  assert.equal(result.config.providers.private.name, "private");
  assert.equal(result.config.providers["originrouter-cloud"], undefined);
  assert.equal(result.config.routes.claude, undefined);
  assert.deepEqual(result.config.routes.codex.main, {
    provider: "private",
    model: "qwen3-coder",
  });
});

test("logout persists removal of an unused login-backed Cloud provider", () => {
  let written = null;
  const result = resetCloudRoutesOnLogout({
    readConfigFn: () => ({
      providers: {
        "originrouter-cloud": {
          name: "originrouter-cloud",
          type: "originrouter",
          model: "claude-sonnet-5",
          auth: { type: "oauth" },
        },
      },
    }),
    writeConfigFn: (config) => { written = config; },
    printFn: () => {},
  });
  assert.equal(result.changed, true);
  assert.deepEqual(written, {});
});

test("non-interactive login preserves the native environment by default", async () => {
  let loaded = false;
  let written = false;
  const messages = [];
  const result = await maybeConfigureAgentRoutesAfterLogin({
    args: [],
    stateDir: "/tmp/not-used",
    inputStream: { isTTY: false },
    outputStream: { isTTY: false },
    loadCloudModelsFn: async () => { loaded = true; return MODELS; },
    readConfigFn: () => ({}),
    writeConfigFn: () => { written = true; },
    printFn: (message) => messages.push(message),
  });
  assert.equal(result.status, "non_interactive");
  assert.equal(loaded, false);
  assert.equal(written, false);
  assert.match(messages.join("\n"), /agent setup/);
});

test("interactive login defaults to Cloud only when no routes exist", async () => {
  let written = null;
  let defaultYes = null;
  const result = await maybeConfigureAgentRoutesAfterLogin({
    args: [],
    stateDir: "/tmp/not-used",
    inputStream: { isTTY: true },
    outputStream: { isTTY: true, write() {} },
    confirmFn: async (_question, options) => {
      defaultYes = options.defaultYes;
      return true;
    },
    loadCloudModelsFn: async () => MODELS,
    readConfigFn: () => ({}),
    writeConfigFn: (config) => { written = config; },
    printFn: () => {},
  });
  assert.equal(defaultYes, true);
  assert.equal(result.status, "configured");
  assert.equal(written.routes.codex.main.model, "gpt-5.6-sol");
});

test("interactive login protects existing private routes by default", async () => {
  let defaultYes = null;
  let written = false;
  const existing = {
    providers: {
      private: {
        name: "private",
        type: "proxy",
        engine: "litellm",
        litellmProvider: "ollama",
        model: "qwen3-coder",
        models: [{ id: "qwen3-coder", enabled: true }],
      },
    },
    routes: { codex: { main: { provider: "private", model: "qwen3-coder" } } },
  };
  const result = await maybeConfigureAgentRoutesAfterLogin({
    args: [],
    inputStream: { isTTY: true },
    outputStream: { isTTY: true, write() {} },
    confirmFn: async (_question, options) => {
      defaultYes = options.defaultYes;
      return false;
    },
    readConfigFn: () => existing,
    writeConfigFn: () => { written = true; },
    printFn: () => {},
  });
  assert.equal(defaultYes, false);
  assert.equal(result.status, "declined");
  assert.equal(written, false);
});

test("agent setup --native clears route overrides without deleting Providers", async () => {
  const configured = applyRecommendedCloudRoutes({}, MODELS).config;
  let written = null;
  const result = await handleAgentRouteSetup(["--native"], {
    readConfigFn: () => configured,
    writeConfigFn: (config) => { written = config; },
    printFn: () => {},
  });
  assert.equal(result.status, "native");
  assert.equal(written.routes, undefined);
  assert.ok(written.providers["originrouter-cloud"]);
});
