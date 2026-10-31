import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_ROUTE_MODE_NATIVE,
  applyDefaultCloudRoutes,
  applyRecommendedCloudRoutes,
  carryOverDefaultRoutes,
  clearOriginrouterCloudRoutes,
  handleAgentRouteSetup,
  initializeDefaultCloudRoutes,
  maybeConfigureAgentRoutesAfterLogin,
  recommendedCloudRouteModels,
  resetCloudRoutesOnLogout,
} from "../src/commands/agentRouteSetup.js";
import { accountStateDir, activateAccount } from "../src/persistence/accounts.js";

const MODELS = [
  { id: "claude-opus-5", name: "Claude Opus 5", origin: "Anthropic" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", origin: "Anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", origin: "Anthropic" },
  { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", origin: "OpenAI" },
];

test("recommended Cloud setup chooses separate Claude and Codex defaults", () => {
  const selected = recommendedCloudRouteModels(MODELS);
  assert.equal(selected.claudeMain.id, "claude-sonnet-5");
  assert.equal(selected.claudeHaiku.id, "claude-haiku-4-5");
  assert.equal(selected.codexMain.id, "gpt-5.6-sol");
});

test("recommended Cloud setup falls back within compatible model families", () => {
  const selected = recommendedCloudRouteModels([
    { id: "claude-custom", name: "Claude Custom", origin: "Anthropic" },
    { id: "gpt-custom", name: "GPT Custom", origin: "OpenAI" },
  ]);
  assert.equal(selected.claudeMain.id, "claude-custom");
  assert.equal(selected.claudeHaiku.id, "claude-custom");
  assert.equal(selected.codexMain.id, "gpt-custom");
});

test("applying recommended Cloud setup atomically configures every Agent slot", () => {
  const result = applyRecommendedCloudRoutes({}, MODELS);
  assert.equal(result.config.providers["originrouter-cloud"].type, "originrouter");
  // The primary slot and the Haiku family are written. The remaining three
  // auxiliary families are left unset on purpose: unset == "inherit the
  // primary model". Haiku is not one of them — it is the cheap model the
  // device answers its small tasks with, and inheriting the primary model
  // would make it cost the same.
  assert.deepEqual(result.config.routes, {
    claude: {
      main: { provider: "originrouter-cloud", model: "claude-sonnet-5" },
      haiku: { provider: "originrouter-cloud", model: "claude-haiku-4-5" },
    },
    codex: {
      main: { provider: "originrouter-cloud", model: "gpt-5.6-sol" },
    },
  });
});

test("fresh CLI defaults are bundled exact Cloud route values", () => {
  const result = applyDefaultCloudRoutes();
  assert.deepEqual(result.config.routes, {
    claude: {
      main: { provider: "originrouter-cloud", model: "claude-sonnet-5" },
      haiku: { provider: "originrouter-cloud", model: "claude-haiku-4-5" },
    },
    codex: {
      main: { provider: "originrouter-cloud", model: "gpt-5.6-sol" },
    },
  });
});

test("default Cloud routes are seeded only while config.json is absent", () => {
  let written = null;
  const initial = initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-fresh-state",
    existsFn: () => false,
    writeConfigFn: (config) => { written = config; },
  });
  assert.equal(initial.status, "initialized");
  assert.equal(written.routes.codex.main.model, "gpt-5.6-sol");

  const existing = initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-existing-state",
    existsFn: () => true,
    readConfigFn: () => ({
      routes: { claude: { main: { provider: "originrouter-cloud", model: "claude-sonnet-5" } } },
    }),
    hasCredentialFn: () => null,
    writeConfigFn: () => { throw new Error("existing config must not be overwritten"); },
  });
  assert.deepEqual(existing, { status: "existing" });
});

test("default Cloud routes preserve an existing active-account config", (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-account-routes-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const accountScope = "outer-account-a";
  activateAccount(stateDir, accountScope);
  const scopedStateDir = accountStateDir(stateDir, accountScope);
  writeFileSync(join(scopedStateDir, "config.json"), JSON.stringify({
    routes: {
      claude: {
        main: { provider: "originrouter-cloud", model: "deepseek-v4-flash" },
        haiku: { provider: "originrouter-cloud", model: "deepseek-v4-flash" },
      },
    },
  }));

  const result = initializeDefaultCloudRoutes({
    stateDir,
    hasCredentialFn: () => null,
    writeConfigFn: () => {
      throw new Error("active-account config must not be overwritten");
    },
  });

  assert.deepEqual(result, { status: "existing" });
});

test("the device default is carried over to an agent with no route", () => {
  // The alias map reads the route table. An agent with no route leaves the
  // map with no initial value, and the session with no model to start on.
  const result = carryOverDefaultRoutes({}, { hasCredential: true });
  assert.equal(result.changed, true);
  assert.deepEqual(result.config.routes, {
    claude: {
      main: { provider: "originrouter-cloud", model: "claude-sonnet-5" },
      haiku: { provider: "originrouter-cloud", model: "claude-haiku-4-5" },
    },
    codex: {
      main: { provider: "originrouter-cloud", model: "gpt-5.6-sol" },
    },
  });
  assert.equal(result.config.providers["originrouter-cloud"].type, "originrouter");
});

test("a route the person set is never touched by the carry-over", () => {
  const result = carryOverDefaultRoutes(
    {
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
      routes: { claude: { main: { provider: "private", model: "qwen3-coder" } } },
    },
    { hasCredential: true },
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.config.routes.claude.main, {
    provider: "private",
    model: "qwen3-coder",
  });
  // The agent that has no route at all still gets the default.
  assert.equal(result.config.routes.codex.main.model, "gpt-5.6-sol");
});

test("a device that asked for the native environment keeps that answer", () => {
  const config = { agentRouteMode: AGENT_ROUTE_MODE_NATIVE };
  const result = carryOverDefaultRoutes(config, { hasCredential: true });
  assert.equal(result.changed, false);
  assert.deepEqual(result.config, config);
});

test("a device that cannot reach the Cloud keeps its own agents", () => {
  const result = carryOverDefaultRoutes({}, { hasCredential: false });
  assert.equal(result.changed, false);
  assert.deepEqual(result.config, {});
});

test("an upgraded device gets the default the alias map needs", () => {
  // The device's config predates the route table: the map has nothing to
  // read, so the session has no model to start on. The default has to
  // arrive on its own — the person did not ask for a route, they inherited
  // one.
  let written = null;
  const result = initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-upgraded-state",
    existsFn: () => true,
    readConfigFn: () => ({ providers: {} }),
    hasCredentialFn: () => ({ accessToken: "a-token" }),
    writeConfigFn: (config) => { written = config; },
  });
  assert.equal(result.status, "carried");
  assert.equal(written.routes.claude.main.model, "claude-sonnet-5");
  assert.equal(written.routes.claude.haiku.model, "claude-haiku-4-5");
  assert.equal(written.routes.codex.main.model, "gpt-5.6-sol");
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
  // The answer has to outlive this run: the device default is carried over
  // to any agent that has no route, and this one is the person saying that
  // OriginRouter does not speak for their agents.
  assert.equal(written.agentRouteMode, AGENT_ROUTE_MODE_NATIVE);
});
