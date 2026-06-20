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
    assert.throws(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED",
    );
  }

  // ---- (2) Routes set, route-mode proxy running with matching hash: four fixed env vars ----
  {
    config = setRoute(config, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
    const out = buildAgentProviderEnv("claude", config, {
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
    const out = buildAgentProviderEnv("claude", config, {
      proxyStatus: () => routeProbe(config),
    });
    assert.equal(out.env.ANTHROPIC_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL_ALIAS);
  }

  // ---- (4) Routes set, only main: small falls back to main; both aliases still present ----
  {
    const cfg2 = clearRoute(config, "claude", "small");
    const out = buildAgentProviderEnv("claude", cfg2, {
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
    const out = buildAgentProviderEnv("claude", config, {
      proxyStatus: () => routeProbe(config),
    });
    assert.equal(out.env.ANTHROPIC_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL_ALIAS);
  }

  // ---- (6) Provider mode (legacy) proxy is rejected: Claude requires route mode. ----
  {
    assert.throws(
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
    assert.throws(
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
    assert.throws(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({ state: "not-installed" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED" && /install/.test(err.message),
    );
  }

  // ---- (9) Proxy stopped → throws with the "start" hint. ----
  {
    assert.throws(
      () => buildAgentProviderEnv("claude", config, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED" && /proxy start/.test(err.message),
    );
  }

  // ---- (10) codex: route-mode only (Stage 8.0). No routes.codex.main →
  // PROVIDER_UNSUPPORTED. No legacy currentProvider.codex fallback. ----
  {
    assert.throws(
      () => buildAgentProviderEnv("codex", config),
      (err) => err.code === "PROVIDER_UNSUPPORTED" && /routes\.codex\.main/.test(err.message),
    );
  }

  // ---- (11) codex: routes.codex.main set + matching hash → proxy env ----
  {
    const codexConfig = setRoute(config, "codex", "main",
      { provider: "deepseek", model: "deepseek-chat" });
    const out = buildAgentProviderEnv("codex", codexConfig, {
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
    assert.throws(
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
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("claudeConfig routes tests ok");