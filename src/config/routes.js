// Stage 7.5: Model routes.
// Stage 8.0: Multi-agent routes (Claude + Codex).
//
// A route binds an agent alias (e.g. originrouter-claude-model,
// gpt-5.4) to a provider name + model. The daemon uses
// routes to render the LiteLLM proxy config at startup / on route change.
// Routes point at LiteLLM-renderable providers. Legacy type=anthropic and
// type=openai-compatible records are read-projected into type=litellm for
// route validation/rendering so existing configs keep working before the
// user explicitly re-saves them.
//
// Storage shape (Stage 8.0):
//
//   config.routes = {
//     claude: {
//       main:  { provider: "deepseek", model: "deepseek-chat" },
//       small: { provider: "moonshot", model: "moonshot-v1-8k" }
//     },
//     codex: {
//       main:  { provider: "openai-codex", model: "gpt-5-codex" }
//     }
//   }
//
// Per-agent slot rules come from ROUTE_DEFS. Claude has main + small (with
// small→main fallback). Codex 8.0 has main only — codex.small is a hard
// error. Codex and Claude do not share, do not fallback into each other.

import { createHash } from "node:crypto";

export const ROUTE_AGENTS = Object.freeze(["claude", "codex"]); // Stage 8.0

// Per-agent slot, alias, and fallback policy table. Slots are listed in
// YAML-emit order. fallbackSmallToMain drives effectiveAgentRoutes:
// claude true, codex false (Codex never falls back).
export const ROUTE_DEFS = Object.freeze({
  claude: {
    slots: Object.freeze(["main", "small"]),
    aliases: Object.freeze({
      main:  "originrouter-claude-model",
      small: "originrouter-claude-fast-model",
    }),
    fallbackSmallToMain: true,
  },
  codex: {
    slots: Object.freeze(["main"]),
    aliases: Object.freeze({
      main: "gpt-5.4",
    }),
    fallbackSmallToMain: false,
  },
});

// Claude legacy alias exports (kept for backward compat with every Stage
// 7.5+ caller). New code can use ROUTE_DEFS[agent].aliases instead.
export const MAIN_ALIAS  = "originrouter-claude-model";
export const SMALL_ALIAS = "originrouter-claude-fast-model";

// Stage 8.0: Codex main alias.
export const CODEX_MAIN_ALIAS = "gpt-5.4";

// ROUTE_SLOTS stays the Claude-slot list for backward compat with existing
// callers. New code should use ROUTE_DEFS[agent].slots.
export const ROUTE_SLOTS  = Object.freeze(["main", "small"]);

// Stage 8.0: exported so the renderer can apply the same read-projection
// the validator applies. Stage 9.0: legacy records project to
//   { type: "proxy", engine: "litellm", litellmProvider: <id>, _legacyType: <...> }.
// The renderer (litellm.js) consumes the projected shape; it does not
// see the on-disk wire type.
export function routeProviderForRead(provider) {
  if (!provider) return provider;
  if (provider.type === "litellm") {
    return { ...provider, type: "proxy", engine: "litellm", _legacyType: "litellm" };
  }
  if (provider.type === "anthropic") {
    return {
      ...provider,
      type: "proxy",
      engine: "litellm",
      litellmProvider: "anthropic",
      _legacyType: "anthropic",
    };
  }
  if (provider.type === "openai-compatible") {
    return {
      ...provider,
      type: "proxy",
      engine: "litellm",
      litellmProvider: "custom_openai",
      _legacyType: "openai-compatible",
    };
  }
  return provider;
}

// Read Claude routes from config, normalized to { main, small }.
// Missing config or slots become `null` — callers check for null explicitly.
// Stage 8.0: kept as the Claude-only helper. New code should use
// getAgentRoutes(config, "claude") for consistency with other agents.
export function getRoutes(config) {
  const routes = (config && config.routes) || {};
  const claude = routes.claude || {};
  return {
    main:  claude.main  || null,
    small: claude.small || null,
  };
}

// Read all routes for one agent. Only the slots defined in ROUTE_DEFS[agent]
// appear in the returned object; missing slots become null.
export function getAgentRoutes(config, agent) {
  if (!ROUTE_AGENTS.includes(agent)) {
    throw new Error(`unknown route agent '${agent}'`);
  }
  const agentBlock = ((config && config.routes) || {})[agent] || {};
  const slots = ROUTE_DEFS[agent].slots;
  const out = {};
  for (const slot of slots) out[slot] = agentBlock[slot] || null;
  return out;
}

// Read all routes for all agents, keyed by agent name. Each agent value is
// the { main, small } shape (only the slots that agent defines).
export function getAllRoutes(config) {
  const out = {};
  for (const agent of ROUTE_AGENTS) out[agent] = getAgentRoutes(config, agent);
  return out;
}

// Validate and normalize a route entry.
//   entry   = { provider: string, model?: string }
//   providers = config.providers (name -> provider record)
//
// Rules:
//   - entry.provider required, must exist in providers, must be LiteLLM-renderable
//   - entry.model optional; if omitted, falls back to provider.model
//   - entry.model when provided must be a non-empty string
//
// Throws with a clear, actionable message on any failure. The renderer in
// litellm.js also re-checks for type=litellm at render time to catch
// post-write drift (provider deleted or type changed).
export function validateRouteEntry(entry, providers) {
  if (!entry || typeof entry !== "object") {
    throw new Error("route entry must be an object { provider, model }");
  }
  if (typeof entry.provider !== "string" || !entry.provider) {
    throw new Error("route entry.provider is required");
  }
  const provider = routeProviderForRead((providers || {})[entry.provider]);
  if (!provider) {
    throw new Error(`route entry.provider '${entry.provider}' is not a known provider`);
  }
  // Stage 9.0: routes accept any of the three canonical wire types
  // (originrouter / proxy / remote). The renderer in
  // src/proxy/litellm.js is what makes a record renderable; that
  // is the gate, not this validator. For proxy, the engine must be
  // "litellm" (the only supported value in 9.0).
  if (provider.type === "proxy" && provider.engine !== "litellm") {
    throw new Error(
      `route entry.provider '${entry.provider}' is type='proxy' with engine='${provider.engine}'. ` +
      `Only engine='litellm' is supported in Stage 9.0.`
    );
  }
  if (entry.model != null && (typeof entry.model !== "string" || entry.model.trim() === "")) {
    throw new Error("route entry.model must be a non-empty string when present");
  }
  return {
    provider: entry.provider,
    model: (entry.model && entry.model.trim()) || provider.model,
  };
}

// Pure: returns a new config with the named route slot set.
// Stage 8.0: agent-aware slot validation via ROUTE_DEFS[agent].slots.
// Throws `unknown route slot 'X' for agent 'Y' (allowed: ...)` when the
// slot is not defined for the agent (e.g. codex.small).
export function setRoute(config, agent, slot, entry) {
  if (!ROUTE_AGENTS.includes(agent)) throw new Error(`unknown route agent '${agent}'`);
  const def = ROUTE_DEFS[agent];
  if (!def.slots.includes(slot)) {
    throw new Error(`unknown route slot '${slot}' for agent '${agent}' ` +
                    `(allowed: ${def.slots.join(", ")})`);
  }
  const providers = (config && config.providers) || {};
  const normalized = validateRouteEntry(entry, providers);
  const routes = { ...((config && config.routes) || {}) };
  const agentBlock = { ...(routes[agent] || {}) };
  agentBlock[slot] = normalized;
  routes[agent] = agentBlock;
  return { ...(config || {}), routes };
}

// Pure: returns a new config with the named route slot removed.
// If the agent's slot block becomes empty, removes `routes[agent]` entirely;
// if `routes` itself becomes empty, removes `routes` entirely.
export function clearRoute(config, agent, slot) {
  if (!ROUTE_AGENTS.includes(agent)) throw new Error(`unknown route agent '${agent}'`);
  const def = ROUTE_DEFS[agent];
  if (!def.slots.includes(slot)) {
    throw new Error(`unknown route slot '${slot}' for agent '${agent}' ` +
                    `(allowed: ${def.slots.join(", ")})`);
  }
  const routes = { ...((config && config.routes) || {}) };
  const agentBlock = { ...(routes[agent] || {}) };
  delete agentBlock[slot];
  if (Object.keys(agentBlock).length === 0) delete routes[agent];
  else routes[agent] = agentBlock;
  // Drop empty `routes: {}` to keep config.json tidy.
  const next = { ...(config || {}) };
  if (Object.keys(routes).length === 0) delete next.routes;
  else next.routes = routes;
  return next;
}

// Stage 7.6: effective routes for Claude. Renderer always emits both
// aliases; when small is missing, it copies main's entry into small so
// the proxy YAML has both `model_name: originrouter-claude-model` and
// `model_name: originrouter-claude-fast-model` pointing at the same
// upstream. The `_fallback: true` flag is renderer-internal only;
// hashRoutes strips it before stringifying so "small unset" and "small
// explicitly set to the same as main" produce identical hashes — the
// proxy doesn't restart on no-op toggles.
//
// Input is a Claude routes-shaped object ({ main, small } from getRoutes()
// or getAgentRoutes(config, "claude")). Do NOT pass a config-shaped object
// directly.
//
// Stage 8.0: kept as a Claude-only thin wrapper around effectiveAgentRoutes.
// Codex 8.0 has no small slot, so the Codex branch never falls back.
export function effectiveRoutes(routeSet) {
  // Stage 8.0: legacy Claude-only helper. Tolerates null/undefined input
  // by normalizing to { main: null, small: null } so callers can keep
  // doing `effectiveRoutes(null).main === null` (used by tests and by
  // the env print CLI path).
  const r = routeSet || { main: null, small: null };
  return effectiveAgentRoutes("claude", r);
}

// Per-agent effective routes. Codex's fallbackSmallToMain is false, so it
// never duplicates main into a non-existent small. The renderer iterates
// ROUTE_DEFS[agent].slots so Codex only ever sees its `main` slot.
export function effectiveAgentRoutes(agent, routeSet) {
  const def = ROUTE_DEFS[agent];
  const r = routeSet || {};
  if (!def.fallbackSmallToMain) return r;
  if (!r.main) return r;
  if (r.small) return r;
  return { main: r.main, small: { ...r.main, _fallback: true } };
}

// Stable hash for fingerprint / mismatch detection. Stage 8.0: hashes the
// all-agent shape so a Codex route change perturbs the hash alongside any
// Claude change.
//
// Backward compat: if `input` is a Claude-only `{ main, small }` (no
// `claude` or `codex` keys), treat it as Claude and hash Claude-only. This
// preserves every existing direct caller and existing test.
//
// `JSON.stringify(value, Object.keys(value).sort())` only sorts the top
// level, so we use stableJsonStringify for nested key ordering.
export function hashRoutes(input) {
  if (input == null) input = {};
  const looksLikeAll = ("claude" in input) || ("codex" in input);
  const allRoutes = looksLikeAll ? input : { claude: input };
  const canonical = {};
  for (const agent of ROUTE_AGENTS) {
    const eff = effectiveAgentRoutes(agent, allRoutes[agent] || {});
    canonical[agent] = JSON.parse(JSON.stringify(eff, (k, v) => (k === "_fallback" ? undefined : v)));
  }
  return createHash("sha256").update(stableJsonStringify(canonical)).digest("hex").slice(0, 16);
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableJsonStringify(v)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys
    .map((k) => JSON.stringify(k) + ":" + stableJsonStringify(value[k]))
    .join(",") + "}";
}

// Resolve all routes for an agent into { alias → { alias, provider, providerRecord, model } }.
// Stage 8.0: agent-aware via ROUTE_DEFS[agent].aliases. Each agent's
// configured slots are projected under its own alias names. Claude emits
// MAIN_ALIAS / SMALL_ALIAS; Codex emits CODEX_MAIN_ALIAS. providerRecord
// may be null if the provider has been deleted since the route was saved
// (caller decides how to surface this — render-time error, UI warning).
export function resolveAgentRoutes(config, agent) {
  if (!ROUTE_AGENTS.includes(agent)) return {};
  const routes = getAgentRoutes(config, agent);
  const providers = (config && config.providers) || {};
  const aliases = ROUTE_DEFS[agent].aliases;
  const out = {};
  for (const slot of ROUTE_DEFS[agent].slots) {
    const entry = routes[slot];
    if (!entry) continue;
    const provider = routeProviderForRead(providers[entry.provider]) || null;
    out[aliases[slot]] = {
      alias: aliases[slot],
      slot,
      provider: entry.provider,
      providerRecord: provider,
      model: entry.model,
    };
  }
  return out;
}
