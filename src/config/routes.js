// Stage 7.5: Model routes.
// Stage 8.0: Multi-agent routes (Claude + Codex).
//
// A route binds an agent alias (e.g. originrouter-claude-model,
// originrouter-codex-model) to a provider name + model. The daemon uses
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
//       small: { provider: "deepseek", model: "deepseek-chat-fast" }
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
import { providerModelIds } from "./providerModels.js";

export const ROUTE_AGENTS = Object.freeze(["claude", "codex"]); // Stage 8.0

// Per-agent slot, alias, and inheritance policy table. Slots are listed in
// YAML-emit order.
//
// Claude Code resolves its built-in subagents by *model family*: an agent
// declared `model: opus|sonnet|haiku|fable` reads the matching
// ANTHROPIC_DEFAULT_*_MODEL. So Claude has one primary slot plus four
// auxiliary slots, one per family, each of which may be left unset to
// "inherit" the primary model (see effectiveAgentRoutes).
//
// The primary slot keeps the historical name `main` — renaming it to `model`
// would silently break the twelve getRoutes() call sites outside this file,
// which read `routes.main` directly.
export const ROUTE_DEFS = Object.freeze({
  claude: {
    slots: Object.freeze(["main", "opus", "sonnet", "haiku", "fable"]),
    aliases: Object.freeze({
      main:   "originrouter-claude-model",
      opus:   "originrouter-claude-opus",
      sonnet: "originrouter-claude-sonnet",
      haiku:  "originrouter-claude-haiku",
      fable:  "originrouter-claude-fable",
    }),
    primarySlot: "main",
    inheritsFromPrimary: Object.freeze(["opus", "sonnet", "haiku", "fable"]),
  },
  codex: {
    slots: Object.freeze(["main"]),
    aliases: Object.freeze({
      main: "originrouter-codex-model",
    }),
    primarySlot: "main",
    inheritsFromPrimary: Object.freeze([]),
  },
});

// Claude route alias exports (kept for backward compat with every Stage
// 7.5+ caller). New code can use ROUTE_DEFS[agent].aliases instead.
export const MAIN_ALIAS   = "originrouter-claude-model";
export const OPUS_ALIAS   = "originrouter-claude-opus";
export const SONNET_ALIAS = "originrouter-claude-sonnet";
export const HAIKU_ALIAS  = "originrouter-claude-haiku";
export const FABLE_ALIAS  = "originrouter-claude-fable";

// The four auxiliary Claude aliases keyed by slot, for callers that need the
// alias *per family* (buildClaudeModelEnv's proxy branch).
export const AUX_ALIASES = Object.freeze({
  opus:   OPUS_ALIAS,
  sonnet: SONNET_ALIAS,
  haiku:  HAIKU_ALIAS,
  fable:  FABLE_ALIAS,
});

// Stage 8.0: Codex main alias. This is an OriginRouter-owned stable route
// key, deliberately distinct from any concrete upstream model id.
export const CODEX_MAIN_ALIAS = "originrouter-codex-model";

// Compatibility alias emitted alongside the canonical alias for one upgrade
// cycle. Older Codex wrappers and already-running proxy clients may still
// request this historical key; it must never become the displayed/canonical
// route name again.
export const LEGACY_CODEX_MAIN_ALIAS = "gpt-5.4";

export function aliasesForRoute(agent, slot) {
  if (!ROUTE_AGENTS.includes(agent)) return [];
  const alias = ROUTE_DEFS[agent].aliases[slot];
  if (!alias) return [];
  if (agent === "codex" && slot === "main") {
    return [alias, LEGACY_CODEX_MAIN_ALIAS];
  }
  return [alias];
}

// ROUTE_SLOTS stays the Claude-slot list for backward compat with existing
// callers. New code should use ROUTE_DEFS[agent].slots.
export const ROUTE_SLOTS = ROUTE_DEFS.claude.slots;

// Every `agent.slot` target name, derived from ROUTE_DEFS so the command
// catalog's completion list can never drift from the dispatch table.
export const ROUTE_TARGET_NAMES = Object.freeze(
  ROUTE_AGENTS.flatMap((agent) => ROUTE_DEFS[agent].slots.map((slot) => `${agent}.${slot}`)),
);

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

// Read Claude routes from config, normalized to { main, opus, sonnet, haiku,
// fable } plus a legacy `small` key. Missing config or auxiliary slots become
// `null` — callers check for null explicitly, and null on an auxiliary slot
// means "inherit main".
//
// `main` deliberately keeps its historical name: twelve call sites outside
// this module read `routes.main`, so renaming it would silently disable
// Claude routing for every existing user.
//
// `small` is no longer a slot. It is still *read* so `effectiveRoutes` and
// `setRoute`-based callers keep working, but nothing writes it and no new
// code should consume it. Existing on-disk `claude.small` values are left in
// place (inert) rather than deleted, so a rollback stays possible.
// Stage 8.0: kept as the Claude-only helper. New code should use
// getAgentRoutes(config, "claude") for consistency with other agents.
export function getRoutes(config) {
  const routes = (config && config.routes) || {};
  const claude = routes.claude || {};
  return {
    main:   claude.main   || null,
    opus:   claude.opus   || null,
    sonnet: claude.sonnet || null,
    haiku:  claude.haiku  || null,
    fable:  claude.fable  || null,
    small:  claude.small  || null,
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
//   - proxy routes require an explicit enabled model from provider.models
//   - originrouter / remote compatibility records may still fall back to
//     their own model field
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
  const hasModelPolicy = Array.isArray(provider.models)
    && provider.models.some((model) => model && typeof model === "object");
  const requestedModel = (entry.model && entry.model.trim())
    || (!hasModelPolicy && typeof provider.model === "string" ? provider.model.trim() : "");
  if (provider.type === "proxy") {
    if (!requestedModel) {
      throw new Error(`route entry.model is required for provider '${entry.provider}'`);
    }
    const enabledModels = providerModelIds(provider, { enabledOnly: true });
    if (!enabledModels.includes(requestedModel)) {
      throw new Error(
        `route model '${requestedModel}' is not enabled on provider '${entry.provider}'`,
      );
    }
  }
  return {
    provider: entry.provider,
    model: requestedModel || provider.model,
  };
}

// Claude Code exposes five model aliases, but they are one routing profile.
// Every configured (non-null) slot must resolve through the same Provider. A
// missing auxiliary slot is valid and means "inherit main"; an auxiliary slot
// without main, or two different Providers, is invalid. This protects stored
// legacy configs and every mutation surface, not just the App UI.
export function assertAgentRouteConsistency(agent, routeSet) {
  if (!ROUTE_AGENTS.includes(agent)) {
    throw new Error(`unknown route agent '${agent}'`);
  }
  if (agent !== "claude") return routeSet || {};
  const routes = routeSet || {};
  const def = ROUTE_DEFS[agent];
  const primary = def.primarySlot;
  // Legacy `small` still participates: a stored config with only claude.small
  // is malformed under either shape, and it is the shape most configs on disk
  // still have, so it must keep being rejected.
  const auxSlots = [...def.inheritsFromPrimary, "small"];
  const configuredAux = auxSlots.filter((slot) => routes[slot]);
  if (!routes[primary] && configuredAux.length > 0) {
    const err = new Error(
      `Claude routes require claude.${primary} when an auxiliary slot is configured. ` +
      `Set claude.${primary} or clear the auxiliary routes.`,
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  const providers = new Set();
  for (const slot of [primary, ...auxSlots]) {
    if (routes[slot] && routes[slot].provider) providers.add(routes[slot].provider);
  }
  if (providers.size > 1) {
    const err = new Error(
      "All Claude routes must use the same provider. " +
      "Update them together with PUT /routes/claude or clear the Claude routes.",
    );
    err.code = "PROVIDER_UNSUPPORTED";
    throw err;
  }
  return routes;
}

function writeAgentRouteSet(config, agent, routeSet) {
  const routes = { ...((config && config.routes) || {}) };
  const agentBlock = {};
  for (const slot of ROUTE_DEFS[agent].slots) {
    if (routeSet[slot]) agentBlock[slot] = routeSet[slot];
  }
  if (Object.keys(agentBlock).length === 0) delete routes[agent];
  else routes[agent] = agentBlock;
  const next = { ...(config || {}) };
  if (Object.keys(routes).length === 0) delete next.routes;
  else next.routes = routes;
  return next;
}

// Atomically replace every route slot owned by one Agent. The final state is
// validated before anything is written, so Claude cannot be persisted with
// main and small pointing at different Providers.
export function replaceAgentRoutes(config, agent, routeSet) {
  if (!ROUTE_AGENTS.includes(agent)) {
    throw new Error(`unknown route agent '${agent}'`);
  }
  if (!routeSet || typeof routeSet !== "object" || Array.isArray(routeSet)) {
    throw new Error("route set must be an object keyed by slot");
  }
  const def = ROUTE_DEFS[agent];
  for (const slot of Object.keys(routeSet)) {
    if (!def.slots.includes(slot)) {
      throw new Error(
        `unknown route slot '${slot}' for agent '${agent}' ` +
        `(allowed: ${def.slots.join(", ")})`,
      );
    }
  }
  const providers = (config && config.providers) || {};
  const normalized = {};
  for (const slot of def.slots) {
    const entry = routeSet[slot];
    if (entry != null) normalized[slot] = validateRouteEntry(entry, providers);
  }
  assertAgentRouteConsistency(agent, normalized);
  return writeAgentRouteSet(config, agent, normalized);
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
  const nextRoutes = getAgentRoutes(config, agent);
  nextRoutes[slot] = normalized;
  assertAgentRouteConsistency(agent, nextRoutes);
  return writeAgentRouteSet(config, agent, nextRoutes);
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
  const nextRoutes = getAgentRoutes(config, agent);
  if (agent === "claude" && slot === def.primarySlot) {
    // Clearing the primary Claude route means "do not override Claude Code".
    // An auxiliary-only route would still inject routing state, so clear the
    // whole group.
    for (const s of def.slots) nextRoutes[s] = null;
    nextRoutes.small = null;
  } else {
    nextRoutes[slot] = null;
  }
  assertAgentRouteConsistency(agent, nextRoutes);
  return writeAgentRouteSet(config, agent, nextRoutes);
}

// Effective routes for Claude. The renderer always emits every configured
// alias; an auxiliary slot that is unset means "inherit main", so it is
// materialized as a copy of main's entry carrying the renderer-internal
// `_fallback: true` flag. That gives the proxy YAML one `model_name` per
// alias — originrouter-claude-model / -opus / -sonnet / -haiku / -fable —
// all pointing at the same upstream when they inherit.
//
// The flag is stripped by hashRoutes before stringifying, so "opus inherits"
// and "opus explicitly set to exactly main's value" produce identical hashes
// and the proxy does not restart on no-op toggles.
//
// Input is a Claude routes-shaped object (from getRoutes() or
// getAgentRoutes(config, "claude")). Do NOT pass a config-shaped object
// directly.
//
// Stage 8.0: kept as a Claude-only thin wrapper around effectiveAgentRoutes.
// Codex 8.0 has no auxiliary slots, so the Codex branch never falls back.
export function effectiveRoutes(routeSet) {
  // Stage 8.0: legacy Claude-only helper. Tolerates null/undefined input by
  // normalizing to an all-null shape so callers can keep doing
  // `effectiveRoutes(null).main === null` (used by tests and by the env
  // print CLI path).
  const r = routeSet || Object.fromEntries(ROUTE_DEFS.claude.slots.map((s) => [s, null]));
  return effectiveAgentRoutes("claude", r);
}

// Per-agent effective routes. Slots listed in ROUTE_DEFS[agent]
// .inheritsFromPrimary are materialized from the primary slot when unset
// (Claude: opus/sonnet/haiku/fable; Codex: none). The renderer iterates
// ROUTE_DEFS[agent].slots, so Codex only ever sees its `main` slot.
export function effectiveAgentRoutes(agent, routeSet) {
  const def = ROUTE_DEFS[agent];
  const r = routeSet || {};
  assertAgentRouteConsistency(agent, r);
  const primary = r[def.primarySlot];
  if (!primary) return r;
  let out = null;
  for (const slot of def.inheritsFromPrimary) {
    if (r[slot]) continue;
    if (!out) out = { ...r };
    out[slot] = { ...primary, _fallback: true };
  }
  return out || r;
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

// Resolve all routes for an agent into { alias → { alias, slot, provider, providerRecord, model } }.
// Stage 8.0: agent-aware via ROUTE_DEFS[agent].aliases. Each agent's
// configured slots are projected under its own alias names. Claude emits
// MAIN_ALIAS plus one alias per auxiliary family; Codex emits
// CODEX_MAIN_ALIAS. providerRecord may be null if the provider has been
// deleted since the route was saved (caller decides how to surface this —
// render-time error, UI warning).
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
