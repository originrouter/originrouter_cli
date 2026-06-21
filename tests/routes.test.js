// Stage 7.5: tests for src/config/routes.js
//
// Pure unit tests — no I/O. Covers:
//   - getRoutes read normalization
//   - validateRouteEntry (LiteLLM-renderable enforcement, provider existence, model fallback)
//   - setRoute / clearRoute mutation purity
//   - hashRoutes stability across key reordering (recursive canonical JSON)
//   - resolveAgentRoutes shape

import assert from "node:assert/strict";
import {
  CODEX_MAIN_ALIAS,
  MAIN_ALIAS,
  ROUTE_AGENTS,
  ROUTE_DEFS,
  ROUTE_SLOTS,
  SMALL_ALIAS,
  clearRoute,
  effectiveAgentRoutes,
  effectiveRoutes,
  getAgentRoutes,
  getAllRoutes,
  getRoutes,
  hashRoutes,
  resolveAgentRoutes,
  setRoute,
  validateRouteEntry,
} from "../src/config/routes.js";

// ---- fixtures ----

const PROVIDERS = {
  deepseek: { name: "deepseek", type: "litellm", litellmProvider: "deepseek", apiKey: "sk-ds", model: "deepseek-chat" },
  moonshot: { name: "moonshot", type: "litellm", litellmProvider: "moonshot", apiKey: "sk-ms", model: "moonshot-v1-8k" },
  minimax:  { name: "minimax",  type: "anthropic", baseUrl: "https://api.minimax.example/v1", apiKey: "sk-mm", model: "MiniMax-M3" },
};

const empty = (v) => assert.equal(v, null);

// ---- ROUTE_AGENTS / ROUTE_SLOTS / alias constants ----

assert.deepEqual([...ROUTE_AGENTS], ["claude", "codex"]);
assert.deepEqual([...ROUTE_SLOTS], ["main", "small"]);
assert.equal(MAIN_ALIAS,       "originrouter-claude-model");
assert.equal(SMALL_ALIAS,      "originrouter-claude-fast-model");
assert.equal(CODEX_MAIN_ALIAS, "originrouter-codex-model");

// ---- getRoutes ----

// Empty config returns null slots.
{
  const r = getRoutes({});
  empty(r.main); empty(r.small);
}

// Config with routes returns them verbatim (no projection; routes.js doesn't
// project because routes are a new-shape feature).
{
  const cfg = { routes: { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } } };
  const r = getRoutes(cfg);
  assert.deepEqual(r.main, { provider: "deepseek", model: "deepseek-chat" });
  empty(r.small);
}

// Partially-defined routes.claude returns null for missing slots.
{
  const cfg = { routes: { claude: { small: { provider: "moonshot", model: "moonshot-v1-8k" } } } };
  const r = getRoutes(cfg);
  empty(r.main);
  assert.deepEqual(r.small, { provider: "moonshot", model: "moonshot-v1-8k" });
}

// null / undefined config is tolerated.
{
  const r1 = getRoutes(null);   empty(r1.main); empty(r1.small);
  const r2 = getRoutes(undefined); empty(r2.main); empty(r2.small);
}

// ---- validateRouteEntry ----

// Happy path with explicit model.
{
  const v = validateRouteEntry({ provider: "deepseek", model: "deepseek-chat" }, PROVIDERS);
  assert.deepEqual(v, { provider: "deepseek", model: "deepseek-chat" });
}

// model omitted → falls back to provider.model.
{
  const v = validateRouteEntry({ provider: "deepseek" }, PROVIDERS);
  assert.equal(v.model, "deepseek-chat");
}

// Unknown provider → throws.
assert.throws(
  () => validateRouteEntry({ provider: "ghost" }, PROVIDERS),
  /not a known provider/,
);

// Legacy type=anthropic provider → read-projected to litellm/anthropic.
{
  const v = validateRouteEntry({ provider: "minimax" }, PROVIDERS);
  assert.deepEqual(v, { provider: "minimax", model: "MiniMax-M3" });
}

// Whitespace-only model → throws.
assert.throws(
  () => validateRouteEntry({ provider: "deepseek", model: "   " }, PROVIDERS),
  /non-empty string/,
);

// Non-string model → throws.
assert.throws(
  () => validateRouteEntry({ provider: "deepseek", model: 42 }, PROVIDERS),
  /non-empty string/,
);

// Empty provider → throws.
assert.throws(
  () => validateRouteEntry({ provider: "" }, PROVIDERS),
  /provider is required/,
);

// Null entry → throws.
assert.throws(
  () => validateRouteEntry(null, PROVIDERS),
  /must be an object/,
);

// model with surrounding whitespace gets trimmed.
{
  const v = validateRouteEntry({ provider: "deepseek", model: "  deepseek-chat  " }, PROVIDERS);
  assert.equal(v.model, "deepseek-chat");
}

// ---- setRoute ----

// setRoute is pure: original config unchanged, and setRoute can see the
// providers in the same config.
{
  const cfg = { providers: PROVIDERS };
  const next = setRoute(cfg, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  assert.notEqual(next, cfg, "setRoute returns a new object");
  assert.equal(cfg.routes, undefined, "original config is not mutated");
  assert.equal(next.routes.claude.main.provider, "deepseek");
}

// Add main to empty config.
{
  const next = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  assert.deepEqual(next.routes.claude.main, { provider: "deepseek", model: "deepseek-chat" });
  assert.equal(next.routes.claude.small, undefined);
}

// Add small alongside main.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  cfg = setRoute(cfg, "claude", "small", { provider: "moonshot", model: "moonshot-v1-8k" });
  assert.equal(cfg.routes.claude.main.provider,  "deepseek");
  assert.equal(cfg.routes.claude.small.provider, "moonshot");
}

// Replace existing slot.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  cfg = setRoute(cfg, "claude", "main", { provider: "moonshot", model: "moonshot-v1-8k" });
  assert.equal(cfg.routes.claude.main.provider, "moonshot");
  assert.equal(cfg.routes.claude.main.model,    "moonshot-v1-8k");
}

// setRoute accepts legacy type=anthropic providers via read projection.
{
  const cfg = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "minimax" });
  assert.equal(cfg.routes.claude.main.provider, "minimax");
  assert.equal(cfg.routes.claude.main.model, "MiniMax-M3");
}

// setRoute rejects unknown agent / slot.
assert.throws(() => setRoute({ providers: PROVIDERS }, "ghost", "main", { provider: "deepseek" }),  /unknown route agent/);
assert.throws(() => setRoute({ providers: PROVIDERS }, "claude", "huge", { provider: "deepseek" }), /unknown route slot/);
// Stage 8.0: codex.small is a hard error (Codex 8.0 has no small slot).
assert.throws(
  () => setRoute({ providers: PROVIDERS }, "codex", "small", { provider: "deepseek" }),
  /unknown route slot 'small' for agent 'codex'/,
);

// ---- clearRoute ----

// Clear small; main survives.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main",  { provider: "deepseek", model: "deepseek-chat" });
  cfg = setRoute(cfg, "claude", "small", { provider: "moonshot", model: "moonshot-v1-8k" });
  cfg = clearRoute(cfg, "claude", "small");
  assert.equal(cfg.routes.claude.main.provider,  "deepseek");
  assert.equal(cfg.routes.claude.small, undefined);
}

// Clear the last slot — routes.claude (and the routes object) disappear.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  cfg = clearRoute(cfg, "claude", "main");
  assert.equal(cfg.routes, undefined, "routes key should be cleaned up when empty");
}

// Clear on missing routes is a no-op (config returned in original shape).
{
  const cfg = { providers: PROVIDERS };
  const next = clearRoute(cfg, "claude", "main");
  assert.equal(next.routes, undefined);
}

// ---- hashRoutes ----

// Same content, different object key order → same hash.
{
  const a = { claude: { main: { provider: "deepseek", model: "deepseek-chat" }, small: null } };
  const b = { claude: { small: null, main: { model: "deepseek-chat", provider: "deepseek" } } };
  assert.equal(hashRoutes(a), hashRoutes(b));
}

// Different content → different hash.
{
  const a = { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } };
  const b = { claude: { main: { provider: "deepseek", model: "deepseek-reasoner" } } };
  assert.notEqual(hashRoutes(a), hashRoutes(b));
}

// null/undefined → deterministic hash (same).
{
  assert.equal(hashRoutes(null),      hashRoutes(null));
  assert.equal(hashRoutes(undefined), hashRoutes(undefined));
}

// Nested array content also reorders stably.
{
  const a = { claude: { providers: [{ name: "a" }, { name: "b" }] } };
  const b = { claude: { providers: [{ name: "b" }, { name: "a" }] } };
  assert.notEqual(hashRoutes(a), hashRoutes(b), "array order should affect hash");
}

// ---- resolveAgentRoutes ----

// Empty config → empty map.
{
  const out = resolveAgentRoutes({}, "claude");
  assert.deepEqual(out, {});
}

// Main + small both set; providerRecord resolves.
{
  const cfg = {
    providers: PROVIDERS,
    routes: {
      claude: {
        main:  { provider: "deepseek", model: "deepseek-chat" },
        small: { provider: "moonshot", model: "moonshot-v1-8k" },
      },
    },
  };
  const out = resolveAgentRoutes(cfg, "claude");
  assert.equal(out[MAIN_ALIAS].provider,  "deepseek");
  assert.equal(out[MAIN_ALIAS].model,     "deepseek-chat");
  // Stage 9.0: routeProviderForRead projects legacy type=litellm to
  // proxy(engine=litellm). The providerRecord carries the projected shape.
  assert.equal(out[MAIN_ALIAS].providerRecord.type, "proxy");
  assert.equal(out[MAIN_ALIAS].providerRecord.engine, "litellm");
  assert.equal(out[SMALL_ALIAS].provider, "moonshot");
  assert.equal(out[SMALL_ALIAS].providerRecord.type, "proxy");
  assert.equal(out[SMALL_ALIAS].providerRecord.engine, "litellm");
}

// Legacy provider records are projected for render-time providerRecord use.
{
  const cfg = {
    providers: PROVIDERS,
    routes: { claude: { main: { provider: "minimax", model: "MiniMax-M3" } } },
  };
  const out = resolveAgentRoutes(cfg, "claude");
  assert.equal(out[MAIN_ALIAS].provider, "minimax");
  assert.equal(out[MAIN_ALIAS].providerRecord.type, "proxy");
  assert.equal(out[MAIN_ALIAS].providerRecord.engine, "litellm");
  assert.equal(out[MAIN_ALIAS].providerRecord.litellmProvider, "anthropic");
}

// Dangling route: provider deleted after save.
{
  const cfg = {
    providers: { moonshot: PROVIDERS.moonshot },
    routes: { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } },
  };
  const out = resolveAgentRoutes(cfg, "claude");
  assert.equal(out[MAIN_ALIAS].provider, "deepseek");
  assert.equal(out[MAIN_ALIAS].providerRecord, null);
}

// Unknown agent → empty.
{
  const out = resolveAgentRoutes({ routes: { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } } }, "ghost");
  assert.deepEqual(out, {});
}

// ---- Stage 8.0: codex routes ----

// codex.main set/clear round-trips; resolveAgentRoutes returns CODEX_MAIN_ALIAS.
{
  const cfg0 = { providers: PROVIDERS };
  const cfg1 = setRoute(cfg0, "codex", "main", { provider: "deepseek", model: "deepseek-chat" });
  assert.equal(cfg1.routes.codex.main.provider, "deepseek");
  assert.equal(cfg1.routes.codex.main.model, "deepseek-chat");

  const resolved = resolveAgentRoutes(cfg1, "codex");
  assert.equal(Object.keys(resolved).length, 1);
  assert.equal(resolved[CODEX_MAIN_ALIAS].alias, "originrouter-codex-model");
  assert.equal(resolved[CODEX_MAIN_ALIAS].slot, "main");

  const cfg2 = clearRoute(cfg1, "codex", "main");
  // When the only route block is empty, the entire `routes` key is removed
  // (the clearRoute helper drops empty parents for config tidiness).
  assert.equal(cfg2.routes, undefined);
}

// getAgentRoutes / getAllRoutes / effectiveAgentRoutes / hashRoutes shape.
{
  const cfg = setRoute({ providers: PROVIDERS }, "codex", "main",
    { provider: "deepseek", model: "deepseek-chat" });

  const agent = getAgentRoutes(cfg, "codex");
  assert.equal(agent.main.provider, "deepseek");
  // Codex has no small slot.
  assert.equal(Object.keys(agent).length, 1);

  const all = getAllRoutes(cfg);
  assert.deepEqual(Object.keys(all).sort(), ["claude", "codex"]);
  assert.equal(all.codex.main.provider, "deepseek");
  assert.equal(all.claude.main, null);

  // Codex: no small fallback (fallbackSmallToMain: false).
  const codexEff = effectiveAgentRoutes("codex", agent);
  assert.equal(codexEff.main.provider, "deepseek");
  assert.equal(codexEff.small, undefined);

  // hashRoutes reflects codex changes (Stage 8.0).
  const h1 = hashRoutes(getAllRoutes(cfg));
  const cfg2 = clearRoute(cfg, "codex", "main");
  const h2 = hashRoutes(getAllRoutes(cfg2));
  assert.notEqual(h1, h2, "codex route change must perturb hashRoutes");

  // Legacy backward compat: hashRoutes({main, small}) still works and
  // is stable regardless of whether it's passed as legacy or all-agent shape.
  const legacy = { main: { provider: "deepseek", model: "deepseek-chat" }, small: null };
  const hLegacy = hashRoutes(legacy);
  const hLegacyAll = hashRoutes({ claude: legacy });
  assert.equal(hLegacy, hLegacyAll, "legacy {main, small} hash matches all-agent shape with same Claude data");
}

// ROUTE_DEFS sanity.
{
  assert.equal(ROUTE_DEFS.codex.slots.length, 1);
  assert.equal(ROUTE_DEFS.codex.slots[0], "main");
  assert.equal(ROUTE_DEFS.codex.fallbackSmallToMain, false);
  assert.equal(ROUTE_DEFS.codex.aliases.main, "originrouter-codex-model");
  assert.equal(ROUTE_DEFS.claude.slots.length, 2);
  assert.equal(ROUTE_DEFS.claude.fallbackSmallToMain, true);
}

// ---- effectiveRoutes (Stage 7.6) ----

{
  // No main → pass through.
  const r = effectiveRoutes({ main: null, small: null });
  assert.equal(r.main, null);
  assert.equal(r.small, null);
}

{
  // Main + small both set → pass through unchanged.
  const routes = {
    main:  { provider: "deepseek", model: "deepseek-chat" },
    small: { provider: "moonshot", model: "moonshot-v1-8k" },
  };
  const r = effectiveRoutes(routes);
  assert.equal(r.main.provider, "deepseek");
  assert.equal(r.small.provider, "moonshot");
  assert.equal(r.small._fallback, undefined);
}

{
  // Main only → small is a copy of main with _fallback: true.
  const r = effectiveRoutes({ main: { provider: "deepseek", model: "deepseek-chat" }, small: null });
  assert.equal(r.main.provider, "deepseek");
  assert.equal(r.small.provider, "deepseek");
  assert.equal(r.small.model,    "deepseek-chat");
  assert.equal(r.small._fallback, true);
}

{
  // Tolerate null / undefined input.
  assert.equal(effectiveRoutes(null).main, null);
  assert.equal(effectiveRoutes(undefined).small, null);
}

// ---- hashRoutes with effective routes (Stage 7.6) ----

{
  // "small unset" and "small explicitly set to the same as main" → identical hashes.
  const a = { main: { provider: "deepseek", model: "deepseek-chat" } };
  const b = {
    main:  { provider: "deepseek", model: "deepseek-chat" },
    small: { provider: "deepseek", model: "deepseek-chat" },
  };
  assert.equal(hashRoutes(a), hashRoutes(b), "small unset should hash identically to small=main");
}

{
  // Different small → different hash.
  const a = { main: { provider: "deepseek", model: "deepseek-chat" } };
  const b = {
    main:  { provider: "deepseek", model: "deepseek-chat" },
    small: { provider: "moonshot", model: "moonshot-v1-8k" },
  };
  assert.notEqual(hashRoutes(a), hashRoutes(b));
}

{
  // _fallback is stripped from the hash.
  const a = hashRoutes({ main: { provider: "deepseek", model: "deepseek-chat" } });
  const b = hashRoutes({
    main:  { provider: "deepseek", model: "deepseek-chat" },
    small: { provider: "deepseek", model: "deepseek-chat", _fallback: true },
  });
  assert.equal(a, b, "_fallback flag must not perturb the hash");
}

console.log("routes.test.js ok");
