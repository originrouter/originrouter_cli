import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentProviderEnv,
  buildClaudeEnv,
  maskSecret,
  setClaudeConfigValue,
  summarizeClaudeConfig,
  unsetClaudeConfigValue,
} from "../src/config/claudeConfig.js";
import {
  addProvider,
  setCurrentProvider,
} from "../src/config/providers.js";
import { setRoute, hashRoutes, getAllRoutes, getRoutes, MAIN_ALIAS, OPUS_ALIAS, SONNET_ALIAS, HAIKU_ALIAS, FABLE_ALIAS } from "../src/config/routes.js";
import { readConfig, writeConfig } from "../src/persistence/state.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-config-test-"));
process.env.ORIGINROUTER_HOME = home;

try {
  let config = {};
  config = setClaudeConfigValue(config, "baseUrl", "https://api.easytransnote.com/coding");
  config = setClaudeConfigValue(config, "apiKey", "sk-v1-1234567890abcdef");
  config = setClaudeConfigValue(config, "model", "MiniMax-M3");
  // `smallFastModel` is no longer a supported config.claude key, and the
  // legacy block no longer maps it to ANTHROPIC_SMALL_FAST_MODEL — that
  // variable is not part of the injected set at all.
  assert.throws(
    () => setClaudeConfigValue(config, "smallFastModel", "MiniMax-M2.7"),
    /Unsupported Claude config key: smallFastModel/,
  );
  assert.deepEqual(buildClaudeEnv(config), {
    ANTHROPIC_BASE_URL: "https://api.easytransnote.com/coding",
    ANTHROPIC_API_KEY: "sk-v1-1234567890abcdef",
    ANTHROPIC_MODEL: "MiniMax-M3",
  });

  assert.equal(maskSecret("sk-v1-1234567890abcdef"), "sk-v1-...cdef");
  assert.equal(summarizeClaudeConfig(config).apiKey, "sk-v1-...cdef");

  config = unsetClaudeConfigValue(config, "apiKey");
  assert.equal(buildClaudeEnv(config).ANTHROPIC_API_KEY, undefined);

  writeConfig(config);
  assert.equal(readConfig().claude.model, "MiniMax-M3");

  // ----- Unset Claude routes inherit the launch environment -----
  // The legacy config block is not copied into the overlay, but OriginRouter
  // also does not inject a proxy route or block Claude Code from using its
  // existing shell environment / Anthropic subscription.
  assert.deepEqual((await buildAgentProviderEnv("claude", config)).env, {});

  // currentProvider[claude] is also ignored for claude.
  config = addProvider(config, {
    name: "minimax",
    type: "litellm",
    litellmProvider: "anthropic",
    baseUrl: "https://api.minimax.example/v1",
    apiKey: "sk-mm-1234567890",
    model: "MiniMax-M3",
    smallFastModel: "MiniMax-M2.7",
  });
  config = setCurrentProvider(config, "claude", "minimax");
  assert.equal((await buildAgentProviderEnv("claude", config)).source, "inherited");

  // Explicit --provider flag is also ignored for claude.
  config = addProvider(config, {
    name: "alt",
    type: "litellm",
    litellmProvider: "anthropic",
    baseUrl: "https://api.alt.example/v1",
    apiKey: "sk-alt-1234567890",
    model: "alt-model",
  });
  assert.equal(
    (await buildAgentProviderEnv("claude", config, { provider: "alt" })).source,
    "inherited",
  );

  // Merely defining a LiteLLM provider does not opt Claude into routing.
  config = addProvider(config, {
    name: "deepseek",
    type: "litellm",
    litellmProvider: "deepseek",
    apiKey: "sk-ds-1234567890",
    model: "deepseek-chat",
  });
  assert.equal(
    (await buildAgentProviderEnv("claude", config, { provider: "deepseek" })).source,
    "inherited",
  );

  // ----- Stage 7.6: route-mode proxy with matching hash -> four fixed env vars -----
  // Set routes to point at the deepseek provider first.
  config = setRoute(config, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  const runningRouteProbe = {
    state: "running",
    port: 40123,
    host: "127.0.0.1",
    currentProvider: null,
    mode: "route",
    pid: 54321,
    version: "1.83.0",
    routesHash: hashRoutes(getAllRoutes(config)),
    aliases: [MAIN_ALIAS, OPUS_ALIAS, SONNET_ALIAS, HAIKU_ALIAS, FABLE_ALIAS],
  };
  const routed = await buildAgentProviderEnv("claude", config, {
    provider: "deepseek",
    proxyStatus: () => runningRouteProbe,
  });
  assert.equal(routed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:40123");
  assert.equal(routed.env.ANTHROPIC_API_KEY, "sk-noop-litellm-passthrough");
  assert.equal(routed.env.ANTHROPIC_MODEL, MAIN_ALIAS);
  assert.equal(routed.env.ANTHROPIC_DEFAULT_OPUS_MODEL, OPUS_ALIAS);
  assert.equal(routed.proxy, runningRouteProbe);
  // No real provider credentials leak into the proxy-routed env.
  assert.equal(routed.env.ANTHROPIC_BASE_URL.includes("sk-ds-"), false);

  // (b) Proxy stopped -> still throws PROVIDER_UNSUPPORTED.
  await assert.rejects(
    () => buildAgentProviderEnv("claude", config, {
      provider: "deepseek",
      proxyStatus: () => ({ state: "stopped", currentProvider: "deepseek", port: null }),
    }),
    (err) => err.code === "PROVIDER_UNSUPPORTED",
    "stopped proxy must still throw",
  );

  // (c) Proxy running but for a DIFFERENT provider -> throws (wrong provider).
  await assert.rejects(
    () => buildAgentProviderEnv("claude", config, {
      provider: "deepseek",
      proxyStatus: () => ({ state: "running", currentProvider: "other-provider", port: 40123, host: "127.0.0.1" }),
    }),
    (err) => err.code === "PROVIDER_UNSUPPORTED",
    "proxy running for another provider must throw",
  );

  // (d) No proxyStatus option at all -> legacy behavior (throw).
  await assert.rejects(
    () => buildAgentProviderEnv("claude", config, { provider: "deepseek" }),
    (err) => err.code === "PROVIDER_UNSUPPORTED",
  );

  // (e) smallFastModel on the provider never affects the injected env: the
  // per-family aliases are fixed constants and the provider's smallFastModel
  // is inert legacy metadata. Regression guard: the removed fast-model
  // variables must not reappear just because a provider still carries the
  // field.
  config.providers.deepseek.smallFastModel = "deepseek-chat-small";
  const routedFast = await buildAgentProviderEnv("claude", config, {
    provider: "deepseek",
    proxyStatus: () => runningRouteProbe,
  });
  assert.equal(routedFast.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, HAIKU_ALIAS);
  assert.equal(routedFast.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
  assert.equal(routedFast.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("config tests ok");
