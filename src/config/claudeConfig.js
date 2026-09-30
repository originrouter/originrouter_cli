import {
  buildProviderEnv,
  resolveProvider,
} from "./providers.js";
import {
  CODEX_MAIN_ALIAS,
  LEGACY_CODEX_MAIN_ALIAS,
  MAIN_ALIAS,
  SMALL_ALIAS,
  assertAgentRouteConsistency,
  effectiveRoutes,
  getAgentRoutes,
  getAllRoutes,
  getRoutes,
  hashRoutes,
  routeProviderForRead,
} from "./routes.js";
import {
  DEFAULT_ORIGINROUTER_BASE_URL,
  resolveRoute,
} from "./providerRoutes.js";
import { readCodingAuth } from "../persistence/codingAuth.js";
import {
  accessTokenFor,
  isOAuthCredentialShape,
  OAUTH_RESOURCES,
} from "../runtime/authContract.js";
import { getStateDir } from "../persistence/state.js";
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

function joinUrlPath(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const suffix = String(path || "").replace(/^\/+/, "");
  return suffix ? `${base}/${suffix}` : base;
}

function originrouterBaseForRuntime(provider, runtime) {
  const route = resolveRoute({
    providerType: "originrouter",
    runtime,
    model: provider?.model,
  });
  const baseUrl = DEFAULT_ORIGINROUTER_BASE_URL;
  if (route.endpoint.endsWith("/v1/messages")) {
    return joinUrlPath(baseUrl, route.endpoint.slice(0, -"/v1/messages".length));
  }
  if (route.endpoint.endsWith("/responses")) {
    return joinUrlPath(baseUrl, route.endpoint.slice(0, -"/responses".length));
  }
  return joinUrlPath(baseUrl, route.endpoint);
}

// Resolve a fresh OriginRouter Coding audience token for Claude/Codex.
async function readManagedCodingKeyForRuntime(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  if (typeof options.readCodingAuthForRuntime === "function") {
    return options.readCodingAuthForRuntime(stateDir);
  }
  const stored = typeof options.readCodingAuth === "function"
    ? options.readCodingAuth(stateDir)
    : readCodingAuth(stateDir);
  if (!stored) {
    const err = new Error(
      "OriginRouter provider requires a local credential. " +
      "Run `originrouter login` first.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  if (!isOAuthCredentialShape(stored)) {
    const err = new Error(
      "Stored OriginRouter credential has an unknown shape. " +
      "Run `originrouter login` again to refresh.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  if (
    (typeof options.readCodingAuthForRuntime === "function" ||
      typeof options.readCodingAuth === "function") &&
    typeof options.ensureFreshAccessToken !== "function"
  ) {
    return stored;
  }
  const ensure = options.ensureFreshAccessToken || (await import("../runtime/oauthTokenRefresher.js")).ensureFreshAccessToken;
  try {
    const fresh = await ensure({ stateDir, resource: OAUTH_RESOURCES.CODING });
    if (!fresh) throw new Error("OAuth credential is unavailable");
    return fresh;
  } catch (refreshErr) {
    const err = new Error(
      "OriginRouter coding credential is unavailable. " +
      "Run `originrouter login` again.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    err.cause = refreshErr;
    throw err;
  }
}

function routeProvider(config, routeEntry) {
  if (!routeEntry || !routeEntry.provider) return null;
  return routeProviderForRead((config.providers || {})[routeEntry.provider]);
}

function assertClaudeOriginrouterRoutes(config, eff) {
  const mainProvider = routeProvider(config, eff.main);
  const smallProvider = eff.small ? routeProvider(config, eff.small) : null;
  if (!mainProvider || mainProvider.type !== "originrouter") return null;
  if (smallProvider && smallProvider.type !== "originrouter") {
    const err = new Error(
      "Claude originrouter direct routing requires claude.small to use an originrouter provider too. " +
      "Clear claude.small or point it at an originrouter provider.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  return { mainProvider, smallProvider: smallProvider || mainProvider };
}

// Stage 9.2: validate the type=remote branch on Claude routes. Returns
// the mainProvider + smallProvider if the route is remote, target=proxy,
// and the caller-side relay proxy is up. Returns null otherwise so the
// caller falls through to the originrouter / proxy paths. Throws
// PROVIDER_UNSUPPORTED on misconfiguration (target=agent, mixed routing,
// relay proxy not running).
function assertClaudeRemoteRoutes(config, eff, remoteCodingProbe) {
  const mainProvider = routeProvider(config, eff.main);
  if (!mainProvider || mainProvider.type !== "remote") return null;
  if (mainProvider.target === "agent") {
    const err = new Error(
      "Remote target=agent is not supported in Stage 9.2. Use --target proxy.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  if (!mainProvider.deviceId) {
    const err = new Error(
      `Remote provider '${mainProvider.name}' requires a deviceId.`,
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  const smallProvider = eff.small ? routeProvider(config, eff.small) : null;
  if (smallProvider && smallProvider.type !== "remote") {
    const err = new Error(
      "Claude remote routing requires claude.small to use a remote provider too. " +
      "Clear claude.small or point it at a remote provider.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  if (smallProvider?.deviceId && smallProvider.deviceId !== mainProvider.deviceId) {
    const err = new Error(
      "Claude remote main and small routes must use the same target device.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  if (!remoteCodingProbe || remoteCodingProbe.state !== "running") {
    const err = new Error(
      "Remote-coding relay proxy is not running. The local wrapper or " +
      "`originrouter env print` will start it automatically; if you see this " +
      "in another context, ensure `RemoteCodingProxyManager.start()` ran.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  return { mainProvider, smallProvider: smallProvider || mainProvider };
}

// Stage 9.2: pure helper used by the local wrapper and env print to
// decide whether to start a `RemoteCodingProxyManager` before resolving
// the env. Returns true when the resolved `routes[agent].main.provider`
// is a record of `type: "remote"` AND `target === "proxy"` (the only
// supported remote target in 9.2).
export function willRouteRemoteCoding(config, agent) {
  const routes = getRoutes(config);
  const agentRoutes = agent === "codex" ? getAgentRoutes(config, "codex") : effectiveRoutes(routes);
  const mainEntry = agentRoutes && agentRoutes.main;
  if (!mainEntry || !mainEntry.provider) return false;
  const provider = routeProvider(config, mainEntry);
  if (!provider) return false;
  return provider.type === "remote" && (provider.target || "proxy") === "proxy";
}

export function remoteCodingRouteTarget(config, agent) {
  const routes = getRoutes(config);
  const agentRoutes = agent === "codex"
    ? getAgentRoutes(config, "codex")
    : effectiveRoutes(routes);
  const mainEntry = agentRoutes?.main;
  if (!mainEntry?.provider) return null;
  const provider = routeProvider(config, mainEntry);
  if (!provider || provider.type !== "remote" || (provider.target || "proxy") !== "proxy") {
    return null;
  }
  return provider.deviceId || null;
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

// Claude Code resolves built-in agent definitions independently from the
// main-loop model. In particular, an agent declared with `model: opus`,
// `model: sonnet`, or `model: haiku` consults the matching
// ANTHROPIC_DEFAULT_* variable, while agents without an explicit model may
// consult CLAUDE_CODE_SUBAGENT_MODEL. Keep every one of those paths inside
// the configured OriginRouter route instead of allowing a subagent to fall
// back to Claude Code's first-party defaults.
function buildClaudeModelEnv(mainModel, smallModel = mainModel) {
  return {
    ANTHROPIC_MODEL: mainModel,
    ANTHROPIC_SMALL_FAST_MODEL: smallModel,
    CLAUDE_CODE_SUBAGENT_MODEL: mainModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: mainModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: mainModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
    // Claude Code 2.1.x also exposes the newer Fable family. Treat it as a
    // primary-capability model so future built-in agents cannot escape the
    // configured main route either.
    ANTHROPIC_DEFAULT_FABLE_MODEL: mainModel,
  };
}

// ---------- Claude Code settings override (transport ownership) ----------
//
// Why this exists: passing our env to the Claude Code child process is not
// enough. Claude Code merges settings layers in this order, later winning:
//
//   userSettings -> projectSettings -> localSettings -> flagSettings -> policySettings
//
// A `~/.claude/settings.json` with an `env` block therefore outranks
// everything we put in the subprocess environment, silently replacing the
// resolved OriginRouter route with a stale base URL, model or key. The
// `--settings` file we already pass for hooks is the `flagSettings` layer,
// which sits above all three filesystem layers, so the override rides along
// in that same file. Verified against Claude Code 2.1.283: the `env` block
// merges per key, so keys we do not name still fall back to the user's own
// settings — which is exactly the behavior we want.
//
// The dividing line, applied to every key below and to any key added later:
//
//   OriginRouter owns the transport — where the request goes, which
//   credential it carries, and which model answers it.
//   The user owns their workspace — theme, permissions, statusLine,
//   output style, their own hooks, plugins.
//
// `policySettings` (enterprise managed-settings.json) outranks flagSettings
// by design and cannot be overridden from here; callers surface a warning
// instead of pretending the override took effect.

// Transport keys we force whenever a route is resolved. Superset of every
// key buildClaudeModelEnv can emit plus the base URL and both credential
// variables. Claude Code matches the model-family defaults with
// /^ANTHROPIC_DEFAULT_[A-Z]+_MODEL$/, so this list grows whenever a new
// family ships — keep it aligned with buildClaudeModelEnv above.
export const CLAUDE_TRANSPORT_ENV_KEYS = Object.freeze([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
]);

// Third-party provider switches. Claude Code reads these straight off the
// environment and, when any is truthy, sends the request to Bedrock /
// Vertex / Foundry instead of ANTHROPIC_BASE_URL. Measured: a single
// CLAUDE_CODE_USE_BEDROCK=1 in ~/.claude/settings.json diverts every request
// away from our proxy even when base URL, token and models are all pinned.
// Empty string is how Claude Code reads "off".
//
// Deliberately enumerated rather than matched with a CLAUDE_CODE_* wildcard:
// most CLAUDE_CODE_* variables are legitimate user preferences
// (CLAUDE_CODE_MAX_CONTEXT_TOKENS, the CLAUDE_CODE_DISABLE_* family) and
// blanking keys we do not understand would break things we do not own.
export const CLAUDE_PROVIDER_REDIRECT_ENV_KEYS = Object.freeze([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
]);

// Settings fields, not env vars, that inject a credential of their own.
// apiKeyHelper is the important one: measured against 2.1.283, a helper
// configured in ~/.claude/settings.json still adds its key as `x-api-key`
// on the very same request our ANTHROPIC_AUTH_TOKEN authorizes, so the
// user's key leaves the machine for whatever endpoint we routed to. Setting
// the field to "" in the flagSettings layer removes that header.
// The *AuthRefresh / *CredentialExport hooks are the cloud-provider
// equivalents, and forceLoginMethod can push an interactive re-login that
// replaces the credential we just installed.
export const CLAUDE_CREDENTIAL_SETTINGS_FIELDS = Object.freeze([
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "gcpCredentialExport",
  "forceLoginMethod",
]);

// Builds the flagSettings payload for a resolved provider result.
// Returns null when there is nothing to pin, so "no OriginRouter route
// configured" stays byte-for-byte native behavior.
export function buildClaudeSettingsOverride(providerResult = {}) {
  const source = String(providerResult?.source || "");
  if (!source || source === "inherited" || source === "native-config") return null;

  const sourceEnv = providerResult?.env || {};
  const env = {};
  for (const key of CLAUDE_TRANSPORT_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(sourceEnv, key)) {
      env[key] = String(sourceEnv[key] ?? "");
    }
  }
  if (Object.keys(env).length === 0) return null;

  // OriginRouter owns both credential variables, so whichever one the route
  // does not use is pinned empty rather than left absent. An absent key is
  // supplied by a lower settings layer instead, and Claude Code then sends it:
  // measured against 2.1.283, a stale ANTHROPIC_AUTH_TOKEN in
  // ~/.claude/settings.json rides out as `Bearer` alongside our own
  // ANTHROPIC_API_KEY, and Claude Code prefers that bearer token — so the
  // proxy is handed the user's stale credential and the user's key leaves the
  // machine. Pinning both also keeps Claude Code's "both ANTHROPIC_AUTH_TOKEN
  // and ANTHROPIC_API_KEY set" warning from coming back.
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) env[key] = "";
  }
  for (const key of CLAUDE_PROVIDER_REDIRECT_ENV_KEYS) env[key] = "";

  const settings = { env };
  for (const field of CLAUDE_CREDENTIAL_SETTINGS_FIELDS) settings[field] = "";
  return settings;
}

// Keys from `override` that a lower settings layer had also set, so callers
// can tell the user what was replaced. Today's failure mode was not the
// wrong precedence but a silent one: the route was correct, the session used
// something else, and nothing said so.
export function describeClaudeSettingsConflicts(override, foreignSettings) {
  if (!override || !foreignSettings) return [];
  const foreignEnv = foreignSettings.env && typeof foreignSettings.env === "object"
    ? foreignSettings.env
    : {};
  const conflicts = [];
  for (const key of Object.keys(override.env || {})) {
    // Only report keys we actually change: a provider switch the user never
    // set, blanked to "", is not a conflict worth a line of output.
    if (!Object.prototype.hasOwnProperty.call(foreignEnv, key)) continue;
    if (String(foreignEnv[key] ?? "") === String(override.env[key] ?? "")) continue;
    conflicts.push(key);
  }
  for (const field of CLAUDE_CREDENTIAL_SETTINGS_FIELDS) {
    const value = foreignSettings[field];
    if (typeof value === "string" && value.length > 0) conflicts.push(field);
  }
  return conflicts;
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
export async function buildAgentProviderEnv(agent, config, options = {}) {
  if (agent === "claude") {
    const probe = typeof options.proxyStatus === "function" ? options.proxyStatus() : null;
    const remoteCodingProbe = typeof options.remoteCodingStatus === "function"
      ? options.remoteCodingStatus()
      : null;
    const routes = getRoutes(config);
    assertAgentRouteConsistency("claude", routes);
    // No OriginRouter route means no OriginRouter override. The empty overlay
    // preserves the caller's ANTHROPIC_* variables and Claude Code's own
    // Anthropic subscription/login behavior.
    if (!routes.main && !routes.small) {
      return {
        env: {},
        routes,
        provider: null,
        source: "inherited",
      };
    }
    const eff = effectiveRoutes(routes);
    // Stage 9.2: a route of type=remote, target=proxy is the third transport.
    // The runtime env points at a caller-side `RemoteCodingRelayProxy` on
    // 127.0.0.1:<port>; the proxy bridges to the worker over the relay.
    const remoteRoutes = assertClaudeRemoteRoutes(config, eff, remoteCodingProbe);
    if (remoteRoutes) {
      const mainModel = eff.main.model || remoteRoutes.mainProvider.model;
      const smallModel = (eff.small && (eff.small.model || remoteRoutes.smallProvider.model))
        || mainModel;
      const env = {
        ANTHROPIC_BASE_URL: `http://${remoteCodingProbe.host || "127.0.0.1"}:${remoteCodingProbe.port}`,
        ANTHROPIC_API_KEY: NOOP_ANTHROPIC_API_KEY,
        ...buildClaudeModelEnv(mainModel, smallModel),
      };
      return {
        env,
        routes: eff,
        provider: remoteRoutes.mainProvider,
        source: "remote-coding",
      };
    }
    const originrouterRoutes = assertClaudeOriginrouterRoutes(config, eff);
    if (originrouterRoutes) {
      const managed = await readManagedCodingKeyForRuntime(options);
      const apiKey = accessTokenFor(managed, OAUTH_RESOURCES.CODING)?.token;
      const mainModel = eff.main.model || originrouterRoutes.mainProvider.model;
      const smallModel = (eff.small && (eff.small.model || originrouterRoutes.smallProvider.model))
        || mainModel;
      const env = {
        ANTHROPIC_BASE_URL: originrouterBaseForRuntime(originrouterRoutes.mainProvider, "claude"),
        ANTHROPIC_API_KEY: apiKey,
        ...buildClaudeModelEnv(mainModel, smallModel),
      };
      return {
        env,
        routes: eff,
        provider: originrouterRoutes.mainProvider,
        source: "originrouter-coding",
      };
    }
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
        ...buildClaudeModelEnv(MAIN_ALIAS, SMALL_ALIAS),
      };
      return {
        env,
        routes: eff,
        proxy: probe,
        provider: routeProvider(config, eff.main),
        source: "routes",
      };
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
    const remoteCodingProbe = typeof options.remoteCodingStatus === "function"
      ? options.remoteCodingStatus()
      : null;
    const codexRoutes = getAgentRoutes(config, "codex");
    if (!codexRoutes.main) {
      return {
        env: {},
        routes: codexRoutes,
        provider: null,
        source: "inherited",
      };
    }
    const mainProvider = routeProvider(config, codexRoutes.main);
    // Stage 9.2: remote provider, target=proxy. Codex has no small slot.
    if (mainProvider?.type === "remote") {
      if (mainProvider.target === "agent") {
        const err = new Error(
          "Remote target=agent is not supported in Stage 9.2. Use --target proxy.",
        );
        err.code = "PROVIDER_UNSUPPORTED";
        throw err;
      }
      if (!mainProvider.deviceId) {
        const err = new Error(
          `Remote provider '${mainProvider.name}' requires a deviceId.`,
        );
        err.code = "PROVIDER_UNSUPPORTED";
        throw err;
      }
      if (!remoteCodingProbe || remoteCodingProbe.state !== "running") {
        const err = new Error(
          "Remote-coding relay proxy is not running. The local wrapper or " +
          "`originrouter env print` will start it automatically.",
        );
        err.code = "PROVIDER_UNSUPPORTED";
        throw err;
      }
      const env = {
        OPENAI_BASE_URL: `http://${remoteCodingProbe.host || "127.0.0.1"}:${remoteCodingProbe.port}/v1`,
        OPENAI_API_KEY: NOOP_OPENAI_API_KEY,
        OPENAI_MODEL: codexRoutes.main.model || mainProvider.model,
      };
      return {
        env,
        routes: codexRoutes,
        provider: mainProvider,
        source: "remote-coding",
      };
    }
    if (mainProvider?.type === "originrouter") {
      const managed = await readManagedCodingKeyForRuntime(options);
      const apiKey = accessTokenFor(managed, OAUTH_RESOURCES.CODING)?.token;
      const env = {
        OPENAI_BASE_URL: originrouterBaseForRuntime(mainProvider, "codex-app-server"),
        OPENAI_API_KEY: apiKey,
        OPENAI_MODEL: codexRoutes.main.model || mainProvider.model,
      };
      return {
        env,
        routes: codexRoutes,
        provider: mainProvider,
        source: "originrouter-coding",
      };
    }
    const currentHash = hashRoutes(getAllRoutes(config));
    const proxyHash = probe && typeof probe.routesHash === "string" ? probe.routesHash : null;
    const hashMatches = probe
      && probe.state === "running"
      && probe.mode === "route"
      && proxyHash === currentHash;
    if (hashMatches) {
      // A proxy started by an older CLI may still advertise only the
      // historical gpt-5.4 alias. Prefer the new namespaced alias, but keep
      // that already-running proxy usable until it is regenerated.
      const advertisedAliases = Array.isArray(probe.aliases) ? probe.aliases : [];
      const codexProxyAlias = advertisedAliases.includes(CODEX_MAIN_ALIAS)
        ? CODEX_MAIN_ALIAS
        : advertisedAliases.includes(LEGACY_CODEX_MAIN_ALIAS)
          ? LEGACY_CODEX_MAIN_ALIAS
          : CODEX_MAIN_ALIAS;
      const env = {
        OPENAI_BASE_URL: `http://${probe.host || "127.0.0.1"}:${probe.port}/v1`,
        OPENAI_API_KEY: NOOP_OPENAI_API_KEY,
        OPENAI_MODEL: codexProxyAlias,
      };
      return {
        env,
        routes: codexRoutes,
        proxy: probe,
        provider: mainProvider,
        source: "routes",
      };
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
