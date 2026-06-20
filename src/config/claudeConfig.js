import {
  buildProviderEnv,
  resolveProvider,
} from "./providers.js";
import {
  CODEX_MAIN_ALIAS,
  MAIN_ALIAS,
  SMALL_ALIAS,
  effectiveRoutes,
  getAgentRoutes,
  getAllRoutes,
  getRoutes,
  hashRoutes,
} from "./routes.js";
import { NOOP_ANTHROPIC_API_KEY } from "../proxy/litellm.js";

// Stage 8.0: placeholder API key we inject into OPENAI_API_KEY when routing
// Codex through the local LiteLLM proxy. LiteLLM does not validate this —
// it only validates the api_key in the model_list config — but Codex
// refuses to start if OPENAI_API_KEY is empty. Matches the Claude
// NOOP_ANTHROPIC_API_KEY pattern.
export const NOOP_OPENAI_API_KEY = "sk-noop-litellm-passthrough";

const CLAUDE_ENV_MAP = {
  baseUrl: "ANTHROPIC_BASE_URL",
  apiKey: "ANTHROPIC_API_KEY",
  model: "ANTHROPIC_MODEL",
  smallFastModel: "ANTHROPIC_SMALL_FAST_MODEL",
};

export const CLAUDE_CONFIG_KEYS = Object.freeze(Object.keys(CLAUDE_ENV_MAP));

// ---------- Legacy direct helpers (unchanged signatures) ----------

// Reads the flat `config.claude` block. Used by:
//   - `config set claude.<k>` / `claude-config` CLI commands (write path)
//   - legacy callers that haven't migrated to the providers flow
export function buildClaudeEnv(config = {}) {
  const claude = config.claude || {};
  const env = {};

  for (const [key, envName] of Object.entries(CLAUDE_ENV_MAP)) {
    if (typeof claude[key] === "string" && claude[key].length > 0) {
      env[envName] = claude[key];
    }
  }

  return env;
}

export function maskSecret(value, alwaysMask = false) {
  if (!value) return "not set";
  if (alwaysMask || value.length <= 10) return alwaysMask ? `${value.slice(0, 4)}...${value.slice(-2)}` : "set";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function summarizeClaudeConfig(config = {}) {
  const claude = config.claude || {};
  return {
    baseUrl: claude.baseUrl || "not set",
    apiKey: maskSecret(claude.apiKey),
    model: claude.model || "not set",
    smallFastModel: claude.smallFastModel || "not set",
  };
}

export function setClaudeConfigValue(config, key, value) {
  if (!CLAUDE_CONFIG_KEYS.includes(key)) {
    throw new Error(`Unsupported Claude config key: ${key}`);
  }

  return {
    ...config,
    claude: {
      ...(config.claude || {}),
      [key]: value,
    },
  };
}

export function unsetClaudeConfigValue(config, key) {
  if (!CLAUDE_CONFIG_KEYS.includes(key)) {
    throw new Error(`Unsupported Claude config key: ${key}`);
  }

  const claude = { ...(config.claude || {}) };
  delete claude[key];

  return {
    ...config,
    claude,
  };
}

// ---------- New unified entry point (Stage 7.6: single path) ----------

// Returns { env, provider, source } (or { env, routes, proxy, source } for claude).
// Callers that only want the env map read `.env`. The richer shape lets
// `env print`, the relay's `providerConfig` event field, and the launchers
// all share one resolver.
//
// Stage 7.6: claude no longer has a direct path. The resolver does NOT
// call resolveProvider() for claude — it only consults routes + the proxy
// snapshot. currentProvider.claude is irrelevant.
export function buildAgentProviderEnv(agent, config, options = {}) {
  if (agent === "claude") {
    const probe = typeof options.proxyStatus === "function" ? options.proxyStatus() : null;
    const routes = getRoutes(config);
    const eff = effectiveRoutes(routes);
    // Stage 8.0: hash uses the full all-agent routes object so a Codex-only
    // change also breaks the Claude hash match — correct because any route
    // change requires a proxy restart, and the proxy renders both agents'
    // aliases from the same YAML.
    const currentHash = hashRoutes(getAllRoutes(config));
    const proxyHash = probe && typeof probe.routesHash === "string" ? probe.routesHash : null;
    const hashMatches = probe
      && probe.state === "running"
      && probe.mode === "route"
      && proxyHash === currentHash;
    if (hashMatches) {
      const env = {
        ANTHROPIC_BASE_URL: `http://${probe.host || "127.0.0.1"}:${probe.port}`,
        ANTHROPIC_API_KEY: NOOP_ANTHROPIC_API_KEY,
        ANTHROPIC_MODEL: MAIN_ALIAS,
        ANTHROPIC_SMALL_FAST_MODEL: SMALL_ALIAS,
      };
      return { env, routes: eff, proxy: probe, source: "routes" };
    }

    // Build a helpful error. Do not consult currentProvider.claude.
    const detail = probe?.state === "running"
      ? "The local proxy is running, but its routes hash does not match the current config (it may be a stale routes-mode proxy from before a recent change)."
      : probe?.state === "not-installed"
        ? "The local proxy is not running. If this is your first setup, run `originrouter proxy install` first."
        : probe?.state === "stopped" || !probe
          ? "The local proxy is not running."
          : `The local proxy is in mode='${probe?.mode || "unknown"}' (Claude requires mode='route').`;
    const err = new Error(
      `Claude requires the local LiteLLM proxy. ${detail} ` +
      `Run \`originrouter proxy start --port 40123\`.`,
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }

  // Stage 8.0: Codex routes-mode branch. Codex 8.0 has no small/fast slot
  // and never falls back to Claude. routes.codex.main is the sole entry
  // point. There is no legacy currentProvider.codex fallback — existing
  // users with currentProvider.codex set see the new error and run
  // `route set codex.main`. currentProvider.codex is preserved on disk
  // but ignored by `originrouter codex`.
  if (agent === "codex") {
    const probe = typeof options.proxyStatus === "function" ? options.proxyStatus() : null;
    const codexRoutes = getAgentRoutes(config, "codex");
    if (!codexRoutes.main) {
      const err = new Error(
        `Codex requires routes.codex.main. ` +
        `Run \`originrouter route set codex.main --provider <name> --model <model>\`.`,
      );
      err.code = "PROVIDER_UNSUPPORTED";
      throw err;
    }
    const currentHash = hashRoutes(getAllRoutes(config));
    const proxyHash = probe && typeof probe.routesHash === "string" ? probe.routesHash : null;
    const hashMatches = probe
      && probe.state === "running"
      && probe.mode === "route"
      && proxyHash === currentHash;
    if (hashMatches) {
      const env = {
        OPENAI_BASE_URL: `http://${probe.host || "127.0.0.1"}:${probe.port}/v1`,
        OPENAI_API_KEY: NOOP_OPENAI_API_KEY,
        OPENAI_MODEL: CODEX_MAIN_ALIAS,
      };
      return { env, routes: codexRoutes, proxy: probe, source: "routes" };
    }
    const detail = probe?.state === "running"
      ? "The local proxy is running, but its routes hash does not match the current config (it may be a stale routes-mode proxy from before a recent change)."
      : probe?.state === "not-installed"
        ? "The local proxy is not running. If this is your first setup, run `originrouter proxy install` first."
        : probe?.state === "stopped" || !probe
          ? "The local proxy is not running."
          : `The local proxy is in mode='${probe?.mode || "unknown"}' (Codex requires mode='route').`;
    const err = new Error(
      `Codex requires the local LiteLLM proxy. ${detail} ` +
      `Run \`originrouter proxy start --port 40123\`.`,
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }

  // Other agents: legacy resolveProvider path (unchanged).
  const { provider, source } = resolveProvider({ config, agent, flagName: options.provider });
  return { env: {}, provider, source };
}
