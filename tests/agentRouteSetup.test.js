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

// The catalogue a free or go account receives: the cloud cuts it down to the
// cheap models the request path accepts without downgrading. Nothing here is
// a Claude or a paid Codex model, so the preference lists and the family
// fallback both come up empty — the low tier is what is left, and it is the
// right answer, because those are the models the account's requests run on.
const LOW_TIER_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", origin: "Google" },
  { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", origin: "Google" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", origin: "DeepSeek" },
  { id: "GLM-5.3-flash", name: "GLM 5.3 Flash", origin: "Zhipu" },
  { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", origin: "MiniMax" },
  { id: "gpt-6-luna", name: "GPT 6 Luna", origin: "OpenAI" },
  { id: "composer-2.5", name: "Composer 2.5", origin: "Cursor" },
];

test("a low-tier catalogue resolves to the cheap models instead of failing", () => {
  const selected = recommendedCloudRouteModels(LOW_TIER_MODELS);
  // DeepSeek heads the low tier, and a low-tier account has no Claude model
  // to prefer over it.
  assert.equal(selected.claudeMain.id, "deepseek-v4.1-flash");
  // The Haiku slot is the cheap slot, so it inherits the cheap primary.
  assert.equal(selected.claudeHaiku.id, "deepseek-v4.1-flash");
  // Codex has no `gpt-5.*` here, but `gpt-6-luna` is a `gpt-` model and runs
  // on a low-tier account, so the family fallback finds it before the low
  // tier does.
  assert.equal(selected.codexMain.id, "gpt-6-luna");
});

test("a low-tier catalogue with no Claude or Codex family still resolves", () => {
  const selected = recommendedCloudRouteModels(
    LOW_TIER_MODELS.filter((model) => !model.id.startsWith("gpt-")),
  );
  assert.equal(selected.claudeMain.id, "deepseek-v4.1-flash");
  assert.equal(selected.codexMain.id, "deepseek-v4.1-flash");
});

test("a paid model beats the low tier on an account that has one", () => {
  const selected = recommendedCloudRouteModels([
    ...LOW_TIER_MODELS,
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", origin: "Anthropic" },
  ]);
  assert.equal(selected.claudeMain.id, "claude-sonnet-5");
  assert.equal(selected.claudeHaiku.id, "claude-sonnet-5");
});

test("model ids are matched without regard to case", () => {
  // The server resolves a model id case-insensitively, so the device has to
  // pick the model the server would run — `GLM-5.3-flash` and
  // `glm-5.3-flash` are the same model, and only the first is in the list.
  const selected = recommendedCloudRouteModels([{ id: "GLM-5.3-flash", name: "GLM" }]);
  assert.equal(selected.claudeMain.id, "GLM-5.3-flash");
  assert.equal(selected.codexMain.id, "GLM-5.3-flash");
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

test("default Cloud routes are seeded only while config.json is absent", async () => {
  let written = null;
  const initial = await initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-fresh-state",
    existsFn: () => false,
    writeConfigFn: (config) => { written = config; },
  });
  assert.equal(initial.status, "initialized");
  assert.equal(written.routes.codex.main.model, "gpt-5.6-sol");

  let asked = false;
  const existing = await initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-existing-state",
    existsFn: () => true,
    readConfigFn: () => ({
      routes: {
        claude: {
          main: { provider: "originrouter-cloud", model: "claude-sonnet-5" },
          haiku: { provider: "originrouter-cloud", model: "claude-haiku-4-5" },
        },
        codex: { main: { provider: "originrouter-cloud", model: "gpt-5.6-sol" } },
      },
    }),
    hasCredentialFn: () => ({ accessToken: "a-token" }),
    loadCloudModelsFn: async () => { asked = true; return MODELS; },
    writeConfigFn: () => { throw new Error("existing config must not be overwritten"); },
  });
  assert.deepEqual(existing, { status: "existing" });
  // A complete route table is not asked about: this runs on every command.
  assert.equal(asked, false);
});

test("a fresh install is seeded with the models its account may run", async () => {
  let written = null;
  const result = await initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-fresh-free-state",
    existsFn: () => false,
    hasCredentialFn: () => ({ accessToken: "a-token" }),
    loadCloudModelsFn: async () => LOW_TIER_MODELS,
    writeConfigFn: (config) => { written = config; },
  });
  assert.equal(result.status, "initialized");
  assert.deepEqual(written.routes, {
    claude: {
      main: { provider: "originrouter-cloud", model: "deepseek-v4.1-flash" },
      haiku: { provider: "originrouter-cloud", model: "deepseek-v4.1-flash" },
    },
    codex: {
      main: { provider: "originrouter-cloud", model: "gpt-6-luna" },
    },
  });
  assert.equal(written.providers["originrouter-cloud"].model, "deepseek-v4.1-flash");
});

test("before login a fresh install is seeded with the bundled profile", async () => {
  let written = null;
  let asked = false;
  await initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-fresh-anonymous-state",
    existsFn: () => false,
    hasCredentialFn: () => null,
    loadCloudModelsFn: async () => { asked = true; return LOW_TIER_MODELS; },
    writeConfigFn: (config) => { written = config; },
  });
  assert.equal(asked, false);
  assert.equal(written.routes.codex.main.model, "gpt-5.6-sol");
});

test("a catalogue that cannot be reached still leaves the agent a model", async () => {
  let written = null;
  const result = await initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-fresh-offline-state",
    existsFn: () => false,
    hasCredentialFn: () => ({ accessToken: "a-token" }),
    loadCloudModelsFn: async () => { throw new Error("offline"); },
    writeConfigFn: (config) => { written = config; },
  });
  // A device with no route cannot start a session at all; the bundled
  // profile is a better answer than none, and the next `agent setup` fixes
  // it with the catalogue in hand.
  assert.equal(result.status, "initialized");
  assert.equal(written.routes.codex.main.model, "gpt-5.6-sol");
});

test("default Cloud routes preserve an existing active-account config", async (t) => {
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

  const result = await initializeDefaultCloudRoutes({
    stateDir,
    hasCredentialFn: () => null,
    loadCloudModelsFn: async () => {
      throw new Error("an account with no credential must not be asked about");
    },
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

test("an upgraded device gets the default the alias map needs", async () => {
  // The device's config predates the route table: the map has nothing to
  // read, so the session has no model to start on. The default has to
  // arrive on its own — the person did not ask for a route, they inherited
  // one.
  let written = null;
  const result = await initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-upgraded-state",
    existsFn: () => true,
    readConfigFn: () => ({ providers: {} }),
    hasCredentialFn: () => ({ accessToken: "a-token" }),
    loadCloudModelsFn: async () => { throw new Error("offline"); },
    writeConfigFn: (config) => { written = config; },
  });
  assert.equal(result.status, "carried");
  assert.equal(written.routes.claude.main.model, "claude-sonnet-5");
  assert.equal(written.routes.claude.haiku.model, "claude-haiku-4-5");
  assert.equal(written.routes.codex.main.model, "gpt-5.6-sol");
});

test("an upgraded low-tier device is carried over to models it can run", async () => {
  // The same upgrade, on an account whose catalogue holds only the cheap
  // models. The bundled profile would name a paid model the account's
  // requests are downgraded away from, so the catalogue answers instead.
  let written = null;
  const result = await initializeDefaultCloudRoutes({
    stateDir: "/tmp/originrouter-upgraded-free-state",
    existsFn: () => true,
    readConfigFn: () => ({ providers: {} }),
    hasCredentialFn: () => ({ accessToken: "a-token" }),
    loadCloudModelsFn: async () => LOW_TIER_MODELS,
    writeConfigFn: (config) => { written = config; },
  });
  assert.equal(result.status, "carried");
  assert.equal(written.routes.claude.main.model, "deepseek-v4.1-flash");
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
