// Stage 7.6: tests for the single-path buildAgentProviderEnv().
//
// All paths are single-path: claude always needs the route-mode proxy running
// with a matching hash. There is no direct path, no provider-name fallback,
// no `currentProvider.claude` lookup. resolveProvider() is NOT called for
// claude.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentProviderEnv } from "../src/config/claudeConfig.js";
import { addProvider, setCurrentProvider } from "../src/config/providers.js";
import { setRoute, clearRoute, CODEX_MAIN_ALIAS, getAllRoutes, hashRoutes, getRoutes, MAIN_ALIAS, SMALL_ALIAS } from "../src/config/routes.js";
import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import { KEY_KIND, KEY_SCOPE, KEY_SOURCE } from "../src/runtime/authContract.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-claude-routes-"));
process.env.ORIGINROUTER_HOME = home;

try {
  // ---- fixtures ----
  let config = {
    providers: {
      // The proxy-routed providers.
      deepseek: { name: "deepseek", type: "litellm", litellmProvider: "deepseek", apiKey: "sk-ds", model: "deepseek-chat" },
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

  // ---- (1) No routes, no proxy → throws ----
  {
    await assert.rejects(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED",
    );
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
  }

  // ---- (3) Routes set, main + small: both fixed aliases (small explicit) ----
  {
    config = setRoute(config, "claude", "small", { provider: "moonshot", model: "moonshot-v1-8k" });
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

  // ---- (10) codex: route-mode only (Stage 8.0). No routes.codex.main →
  // PROVIDER_UNSUPPORTED. No legacy currentProvider.codex fallback. ----
  {
    await assert.rejects(
      () => buildAgentProviderEnv("codex", config),
      (err) => err.code === "PROVIDER_UNSUPPORTED" && /routes\.codex\.main/.test(err.message),
    );
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
  // DEFAULT_ORIGINROUTER_BASE_URL ("https://server.easytransnote.com").

  // helper: write a well-formed managed key matching isManagedKeyShape
  function seedManagedKey(home, overrides = {}) {
    const key = {
      kind: KEY_KIND.MANAGED,                 // "managed"
      keyId: "ok_test_key",
      key: "sk-or-v1-ok-test-key",
      deviceGrantId: "og_test_grant_id",
      deviceGrant: "og_test_grant_token_for_unit_tests_only",
      deviceId: "device-test-001",
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      source: KEY_SOURCE.ORIGINROUTER_CLI,    // "originrouter_cli"
      scopes: [KEY_SCOPE.CODING],             // ["coding"]
      ...overrides,
    };
    writeCodingAuth(home, key);
  }

  // ---- (13) claude originrouter direct smoke ----
  {
    const official = { name: "official", type: "originrouter",
      auth: { type: "managed_originrouter_key", keyRef: "current" },
      model: "claude-sonnet-4-6" };
    const configWithOfficial = {
      ...config,
      providers: { ...(config.providers || {}), official },
    };
    // Earlier cases (3, 5) left claude.small pointing at moonshot (litellm).
    // An originrouter main + non-originrouter small is rejected by the
    // runtime guard. Clear small before the originrouter direct smoke.
    const configWithoutSmall = clearRoute(configWithOfficial, "claude", "small");
    const configRouted = setRoute(configWithoutSmall, "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    seedManagedKey(home);
    // proxyStatus returning "stopped" must NOT block originrouter direct.
    const out = await buildAgentProviderEnv("claude", configRouted, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.source, "originrouter-coding");
    assert.equal(out.env.ANTHROPIC_BASE_URL, "https://server.easytransnote.com/coding");
    assert.equal(out.env.ANTHROPIC_API_KEY, "sk-or-v1-ok-test-key");
    assert.equal(out.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
    // small falls back to main
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, "claude-sonnet-4-6");
  }

  // ---- (14) codex originrouter direct smoke ----
  {
    const officialCodex = { name: "official-codex", type: "originrouter",
      auth: { type: "managed_originrouter_key", keyRef: "current" },
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
    assert.equal(out.env.OPENAI_BASE_URL, "https://server.originrouter.com/coding/v1");
    assert.equal(out.env.OPENAI_API_KEY, "sk-or-v1-ok-test-key");
    assert.equal(out.env.OPENAI_MODEL, "gpt-5-codex");
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("claudeConfig routes tests ok");
