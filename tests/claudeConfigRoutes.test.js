// Stage 7.6: tests for the single-path buildAgentProviderEnv().
//
// Configured Claude routes use one coherent Provider profile. With no Claude
// routes, OriginRouter returns an empty env overlay so the user's existing
// ANTHROPIC_* variables or official Anthropic subscription remain in control.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentProviderEnv } from "../src/config/claudeConfig.js";
import { addProvider, setCurrentProvider } from "../src/config/providers.js";
import { setRoute, clearRoute, replaceAgentRoutes, CODEX_MAIN_ALIAS, getAllRoutes, hashRoutes, getRoutes, MAIN_ALIAS, SMALL_ALIAS } from "../src/config/routes.js";
import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-claude-routes-"));
process.env.ORIGINROUTER_HOME = home;

try {
  // ---- fixtures ----
  let config = {
    providers: {
      // The proxy-routed providers.
      deepseek: {
        name: "deepseek",
        type: "litellm",
        litellmProvider: "deepseek",
        apiKey: "sk-ds",
        model: "deepseek-chat",
        models: [
          { id: "deepseek-chat", enabled: true },
          { id: "deepseek-chat-fast", enabled: true },
        ],
      },
      moonshot: { name: "moonshot", type: "litellm", litellmProvider: "moonshot", apiKey: "sk-ms", model: "moonshot-v1-8k" },
      // An anthropic-compatible provider in the new shape (type=litellm,
      // litellmProvider=anthropic). This is the canonical way to add MiniMax.
      minimax:  { name: "minimax",  type: "litellm", litellmProvider: "anthropic",
                  baseUrl: "https://api.minimax.example/v1", apiKey: "sk-mm", model: "MiniMax-M3",
                  smallFastModel: "MiniMax-M2.7" },
    },
    currentProvider: { claude: "deepseek" },  // legacy field; should be IGNORED for claude
  };

  // A running route-mode proxy with a matching hash.
  const routeProbe = (cfg) => ({
    state: "running",
    port: 40123,
    host: "127.0.0.1",
    currentProvider: null,
    mode: "route",
    // Stage 8.0: hash uses the all-agent routes object (matches the
    // shape buildAgentProviderEnv hashes).
    routesHash: hashRoutes(getAllRoutes(cfg)),
    aliases: [MAIN_ALIAS, SMALL_ALIAS],
  });

  // ---- (1) No routes → inherit the launch environment unchanged ----
  {
    const out = await buildAgentProviderEnv("claude", config, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.deepEqual(out.env, {});
    assert.equal(out.provider, null);
    assert.equal(out.source, "inherited");
  }

  // ---- (1b) Claude routes are one Provider profile at the CLI core ----
  {
    assert.throws(
      () => setRoute(config, "claude", "small", {
        provider: "deepseek",
        model: "deepseek-chat-fast",
      }),
      /require claude\.main/,
    );
    const mainOnly = setRoute(config, "claude", "main", {
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.throws(
      () => setRoute(mainOnly, "claude", "small", {
        provider: "moonshot",
        model: "moonshot-v1-8k",
      }),
      /must use the same provider/,
    );
    const grouped = replaceAgentRoutes(config, "claude", {
      main: { provider: "deepseek", model: "deepseek-chat" },
      small: { provider: "deepseek", model: "deepseek-chat-fast" },
    });
    assert.equal(getRoutes(grouped).main.provider, "deepseek");
    assert.equal(getRoutes(grouped).small.model, "deepseek-chat-fast");
    assert.equal(getRoutes(clearRoute(grouped, "claude", "main")).main, null);
    assert.equal(getRoutes(clearRoute(grouped, "claude", "main")).small, null);
  }

  // ---- (2) Routes set, route-mode proxy running with matching hash: four fixed env vars ----
  {
    config = setRoute(config, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
    const out = await buildAgentProviderEnv("claude", config, {
      proxyStatus: () => routeProbe(config),
    });
    assert.equal(out.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:40123");
    assert.equal(out.env.ANTHROPIC_API_KEY, "sk-noop-litellm-passthrough");
    assert.equal(out.env.ANTHROPIC_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL_ALIAS);
    assert.equal(out.env.CLAUDE_CODE_SUBAGENT_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_DEFAULT_OPUS_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_DEFAULT_SONNET_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, SMALL_ALIAS);
    assert.equal(out.env.ANTHROPIC_DEFAULT_FABLE_MODEL, MAIN_ALIAS);
  }

  // ---- (3) Routes set, main + small: both fixed aliases (small explicit) ----
  {
    config = setRoute(config, "claude", "small", { provider: "deepseek", model: "deepseek-chat-fast" });
    const out = await buildAgentProviderEnv("claude", config, {
      proxyStatus: () => routeProbe(config),
    });
    assert.equal(out.env.ANTHROPIC_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL_ALIAS);
  }

  // ---- (4) Routes set, only main: small falls back to main; both aliases still present ----
  {
    const cfg2 = clearRoute(config, "claude", "small");
    const out = await buildAgentProviderEnv("claude", cfg2, {
      proxyStatus: () => routeProbe(cfg2),
    });
    assert.equal(out.env.ANTHROPIC_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL_ALIAS);
  }

  // ---- (5) currentProvider.claude is ignored: even if it points at "minimax" (which is
  //          also a valid litellm provider), the env still uses route-mode aliases. ----
  {
    config = setCurrentProvider(config, "claude", "minimax");
    // Note: routes still point at deepseek.
    const out = await buildAgentProviderEnv("claude", config, {
      proxyStatus: () => routeProbe(config),
    });
    assert.equal(out.env.ANTHROPIC_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL_ALIAS);
  }

  // ---- (6) Provider mode (legacy) proxy is rejected: Claude requires route mode. ----
  {
    await assert.rejects(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({
          state: "running",
          port: 40123,
          host: "127.0.0.1",
          mode: "provider",
          currentProvider: "deepseek",
        }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED",
    );
  }

  // ---- (7) Route-mode proxy running but routes hash is stale → throws. ----
  {
    await assert.rejects(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({
          state: "running",
          port: 40123,
          host: "127.0.0.1",
          mode: "route",
          routesHash: "stale-hash",
          aliases: [MAIN_ALIAS, SMALL_ALIAS],
        }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED",
    );
  }

  // ---- (8) Proxy not installed → throws with the "install" hint. ----
  {
    await assert.rejects(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({ state: "not-installed" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED" && /install/.test(err.message),
    );
  }

  // ---- (9) Proxy stopped → throws with the "start" hint. ----
  {
    await assert.rejects(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED" && /proxy start/.test(err.message),
    );
  }

  // ---- (10) codex: no route preserves the user's existing login/env. ----
  {
    const inherited = await buildAgentProviderEnv("codex", config);
    assert.equal(inherited.source, "inherited");
    assert.deepEqual(inherited.env, {});
  }

  // ---- (11) codex: routes.codex.main set + matching hash → proxy env ----
  {
    const codexConfig = setRoute(config, "codex", "main",
      { provider: "deepseek", model: "deepseek-chat" });
    const out = await buildAgentProviderEnv("codex", codexConfig, {
      proxyStatus: () => ({
        state: "running",
        port: 40123,
        host: "127.0.0.1",
        mode: "route",
        routesHash: hashRoutes(getAllRoutes(codexConfig)),
        aliases: [CODEX_MAIN_ALIAS],
      }),
    });
    assert.equal(out.env.OPENAI_BASE_URL, "http://127.0.0.1:40123/v1");
    assert.equal(out.env.OPENAI_API_KEY, "sk-noop-litellm-passthrough");
    assert.equal(out.env.OPENAI_MODEL, CODEX_MAIN_ALIAS);
  }

  // ---- (12) codex: route set, proxy hash mismatch → PROVIDER_UNSUPPORTED ----
  {
    const codexConfig = setRoute(config, "codex", "main",
      { provider: "deepseek", model: "deepseek-chat" });
    await assert.rejects(
      () => buildAgentProviderEnv("codex", codexConfig, {
        proxyStatus: () => ({
          state: "running",
          port: 40123,
          host: "127.0.0.1",
          mode: "route",
          routesHash: "stale-hash-different-from-config",
        }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED",
    );
  }

  // ---- Stage 9.1B: originrouter direct branch smoke (cases 13-14) ----
  //
  // The exhaustive direct-branch coverage lives in
  // tests/runtimeOriginrouterRoute.test.js. These two cases exist in this
  // file to lock in the contract alongside the proxy regression: a route
  // pointing at type=originrouter returns direct env (no proxy required).
  //
  // Seed an originrouter provider, write a valid managed coding key via
  // writeCodingAuth, and assert the env vars are derived from
  // DEFAULT_ORIGINROUTER_BASE_URL ("https://api.easytransnote.com").

  function seedOAuthCredential(home, overrides = {}) {
    writeCodingAuth(home, makeOAuthCredential(overrides));
  }

  // ---- (13) claude originrouter direct smoke ----
  {
    const official = { name: "official", type: "originrouter",
      auth: { type: "oauth" },
      model: "claude-sonnet-4-6" };
    const configWithOfficial = {
      ...config,
      providers: { ...(config.providers || {}), official },
    };
    // Clear the proxy profile before switching the grouped Claude route to
    // the OriginRouter Provider.
    const configWithoutSmall = clearRoute(configWithOfficial, "claude", "small");
    const configRouted = setRoute(configWithoutSmall, "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    seedOAuthCredential(home);
    // proxyStatus returning "stopped" must NOT block originrouter direct.
    const out = await buildAgentProviderEnv("claude", configRouted, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.source, "originrouter-coding");
    assert.equal(out.env.ANTHROPIC_BASE_URL, "https://api.easytransnote.com/coding");
    assert.equal(out.env.ANTHROPIC_API_KEY, "or_at_coding_test");
    assert.equal(out.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
    // small falls back to main
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, "claude-sonnet-4-6");
    assert.equal(out.env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-sonnet-4-6");
    assert.equal(out.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-sonnet-4-6");
    assert.equal(out.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-sonnet-4-6");
  }

  // ---- (14) codex originrouter direct smoke ----
  {
    const officialCodex = { name: "official-codex", type: "originrouter",
      auth: { type: "oauth" },
      model: "gpt-5-codex",
      baseUrl: "https://server.originrouter.com" };
    const configWithOfficialCodex = {
      ...config,
      providers: { ...(config.providers || {}), "official-codex": officialCodex },
    };
    const codexRouted = setRoute(configWithOfficialCodex, "codex", "main",
      { provider: "official-codex", model: "gpt-5-codex" });
    // coding-key.json from case 13 is still on disk; that's fine — both
    // agents read the same file.
    const out = await buildAgentProviderEnv("codex", codexRouted, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.source, "originrouter-coding");
    assert.equal(out.env.OPENAI_BASE_URL, "https://api.easytransnote.com/coding/v1");
    assert.equal(out.env.OPENAI_API_KEY, "or_at_coding_test");
    assert.equal(out.env.OPENAI_MODEL, "gpt-5-codex");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("claudeConfig routes tests ok");
