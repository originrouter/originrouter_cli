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
  LEGACY_CODEX_MAIN_ALIAS,
  aliasesForRoute,
  MAIN_ALIAS,
  ROUTE_AGENTS,
  ROUTE_DEFS,
  OPUS_ALIAS,
  SONNET_ALIAS,
  HAIKU_ALIAS,
  FABLE_ALIAS,
  AUX_ALIASES,
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
assert.deepEqual([...ROUTE_DEFS.claude.slots], ["main", "opus", "sonnet", "haiku", "fable"]);
assert.deepEqual([...ROUTE_DEFS.claude.inheritsFromPrimary], ["opus", "sonnet", "haiku", "fable"]);
assert.equal(ROUTE_DEFS.claude.primarySlot, "main");
assert.equal(MAIN_ALIAS,       "originrouter-claude-model");
assert.equal(OPUS_ALIAS,       "originrouter-claude-opus");
assert.equal(SONNET_ALIAS,     "originrouter-claude-sonnet");
assert.equal(HAIKU_ALIAS,      "originrouter-claude-haiku");
assert.equal(FABLE_ALIAS,      "originrouter-claude-fable");
assert.deepEqual(AUX_ALIASES, { opus: OPUS_ALIAS, sonnet: SONNET_ALIAS, haiku: HAIKU_ALIAS, fable: FABLE_ALIAS });
assert.equal(CODEX_MAIN_ALIAS, "originrouter-codex-model");
  assert.equal(LEGACY_CODEX_MAIN_ALIAS, "gpt-5.4");
assert.deepEqual(aliasesForRoute("codex", "main"), [
  "originrouter-codex-model",
  "gpt-5.4",
]);

// ---- getRoutes ----

// Empty config returns null slots.
{
  const r = getRoutes({});
  empty(r.main); empty(r.opus); empty(r.sonnet); empty(r.haiku); empty(r.fable);
}

// Config with routes returns them verbatim (no projection; routes.js doesn't
// project because routes are a new-shape feature).
{
  const cfg = { routes: { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } } };
  const r = getRoutes(cfg);
  assert.deepEqual(r.main, { provider: "deepseek", model: "deepseek-chat" });
  empty(r.opus); empty(r.sonnet); empty(r.haiku); empty(r.fable);
}

// Partially-defined routes.claude returns null for missing slots.
{
  const cfg = { routes: { claude: { haiku: { provider: "moonshot", model: "moonshot-v1-8k" } } } };
  const r = getRoutes(cfg);
  empty(r.main);
  assert.deepEqual(r.haiku, { provider: "moonshot", model: "moonshot-v1-8k" });
  empty(r.opus); empty(r.sonnet); empty(r.fable);
}

// Legacy claude.small is still readable so pre-upgrade configs do not crash,
// but it is NOT a route slot: it is never materialised into the new shape.
{
  const cfg = { routes: { claude: { main: { provider: "deepseek", model: "deepseek-chat" }, small: { provider: "deepseek", model: "deepseek-chat-fast" } } } };
  const r = getRoutes(cfg);
  assert.equal(r.main.provider, "deepseek");
  assert.equal(r.small.model, "deepseek-chat-fast", "legacy small stays readable");
  empty(r.opus); empty(r.haiku);
}

// null / undefined config is tolerated.
{
  const r1 = getRoutes(null);   empty(r1.main); empty(r1.opus);
  const r2 = getRoutes(undefined); empty(r2.main); empty(r2.haiku);
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
  assert.equal(next.routes.claude.opus, undefined);
  assert.equal(next.routes.claude.haiku, undefined);
}

// Add an auxiliary slot alongside main.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  cfg = setRoute(cfg, "claude", "opus", { provider: "deepseek", model: "deepseek-chat" });
  assert.equal(cfg.routes.claude.main.provider, "deepseek");
  assert.equal(cfg.routes.claude.opus.provider, "deepseek");
}

// Every auxiliary family is an independent slot.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  for (const slot of ["opus", "sonnet", "haiku", "fable"]) {
    cfg = setRoute(cfg, "claude", slot, { provider: "deepseek", model: "deepseek-chat" });
  }
  for (const slot of ["opus", "sonnet", "haiku", "fable"]) {
    assert.equal(cfg.routes.claude[slot].provider, "deepseek", slot);
  }
}

assert.throws(
  () => {
    const cfg = setRoute({ providers: PROVIDERS }, "claude", "main", {
      provider: "deepseek",
      model: "deepseek-chat",
    });
    return setRoute(cfg, "claude", "opus", {
      provider: "moonshot",
      model: "moonshot-v1-8k",
    });
  },
  /must use the same provider/,
);

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
// `small` is no longer a claude slot — it must be rejected, not silently accepted.
assert.throws(() => setRoute({ providers: PROVIDERS }, "claude", "small", { provider: "deepseek" }), /unknown route slot 'small' for agent 'claude'/);
// Stage 8.0: codex.small is a hard error (Codex 8.0 has no small slot).
assert.throws(
  () => setRoute({ providers: PROVIDERS }, "codex", "small", { provider: "deepseek" }),
  /unknown route slot 'small' for agent 'codex'/,
);

// ---- clearRoute ----

// Clear an auxiliary slot; main survives.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main",  { provider: "deepseek", model: "deepseek-chat" });
  cfg = setRoute(cfg, "claude", "haiku", { provider: "deepseek", model: "deepseek-chat" });
  cfg = clearRoute(cfg, "claude", "haiku");
  assert.equal(cfg.routes.claude.main.provider, "deepseek");
  assert.equal(cfg.routes.claude.haiku, undefined);
}

// Clearing the primary slot also clears every auxiliary slot: an auxiliary
// left alone would still inject a partial routing profile.
{
  let cfg = setRoute({ providers: PROVIDERS }, "claude", "main", { provider: "deepseek", model: "deepseek-chat" });
  cfg = setRoute(cfg, "claude", "opus", { provider: "deepseek", model: "deepseek-chat" });
  cfg = clearRoute(cfg, "claude", "main");
  assert.equal(cfg.routes, undefined, "routes key should be cleaned up when empty");
}

// Clearing the primary slot drops auxiliaries even when they are the only
// remaining entries in an otherwise-populated claude block.
{
  const cfg = {
    providers: PROVIDERS,
    routes: {
      claude: {
        main: { provider: "deepseek", model: "deepseek-chat" },
        fable: { provider: "deepseek", model: "deepseek-chat" },
      },
    },
  };
  const next = clearRoute(cfg, "claude", "main");
  assert.equal(next.routes, undefined, "aux slots must not survive a main clear");
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
  const a = { claude: { main: { provider: "deepseek", model: "deepseek-chat" }, opus: null } };
  const b = { claude: { opus: null, main: { model: "deepseek-chat", provider: "deepseek" } } };
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

// Main + an explicit auxiliary; per-family aliases resolve.
{
  const cfg = {
    providers: PROVIDERS,
    routes: {
      claude: {
        main:  { provider: "deepseek", model: "deepseek-chat" },
        opus:  { provider: "deepseek", model: "deepseek-chat" },
        haiku: { provider: "deepseek", model: "deepseek-chat-fast" },
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
  assert.equal(out[OPUS_ALIAS].provider, "deepseek");
  assert.equal(out[OPUS_ALIAS].providerRecord.type, "proxy");
  assert.equal(out[OPUS_ALIAS].providerRecord.engine, "litellm");
  assert.equal(out[HAIKU_ALIAS].model, "deepseek-chat-fast");
}

// Inherited auxiliaries materialise as their OWN alias (same upstream as main).
// This is required: proxy-mode env points each family at its own alias.
{
  const cfg = {
    providers: PROVIDERS,
    routes: { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } },
  };
  const out = resolveAgentRoutes(cfg, "claude");
  // resolveAgentRoutes reads the *stored* routes: an inherited auxiliary is
  // absent here, and only appears once effectiveAgentRoutes materialises it.
  for (const alias of Object.values(AUX_ALIASES)) {
    assert.equal(out[alias], undefined, alias);
  }

  const eff = effectiveAgentRoutes("claude", getAgentRoutes(cfg, "claude"));
  const effOut = resolveAgentRoutes({ ...cfg, routes: { claude: eff } }, "claude");
  for (const alias of Object.values(AUX_ALIASES)) {
    assert.equal(effOut[alias].provider, "deepseek", alias);
    assert.equal(effOut[alias].model, "deepseek-chat", alias);
  }
  // Each family keeps its OWN alias even when it inherits the same upstream:
  // proxy-mode env points Claude Code at the per-family alias.
  assert.notEqual(effOut[OPUS_ALIAS].alias, effOut[MAIN_ALIAS].alias);
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

  // Codex has no auxiliary slots, so nothing is materialised.
  const codexEff = effectiveAgentRoutes("codex", agent);
  assert.equal(codexEff.main.provider, "deepseek");
  assert.equal(codexEff.small, undefined);
  assert.equal(codexEff.opus, undefined);

  // hashRoutes reflects codex changes (Stage 8.0).
  const h1 = hashRoutes(getAllRoutes(cfg));
  const cfg2 = clearRoute(cfg, "codex", "main");
  const h2 = hashRoutes(getAllRoutes(cfg2));
  assert.notEqual(h1, h2, "codex route change must perturb hashRoutes");

  // Legacy backward compat: hashRoutes({main, small}) still works and
  // is stable regardless of whether it's passed as legacy or all-agent shape.
  const legacy = { main: { provider: "deepseek", model: "deepseek-chat" }, opus: null };
  const hLegacy = hashRoutes(legacy);
  const hLegacyAll = hashRoutes({ claude: legacy });
  assert.equal(hLegacy, hLegacyAll, "bare {main} hash matches all-agent shape with same Claude data");
}

// ROUTE_DEFS sanity.
{
  assert.equal(ROUTE_DEFS.codex.slots.length, 1);
  assert.equal(ROUTE_DEFS.codex.slots[0], "main");
  assert.deepEqual(ROUTE_DEFS.codex.inheritsFromPrimary, []);
  assert.equal(ROUTE_DEFS.codex.aliases.main, "originrouter-codex-model");
  assert.equal(ROUTE_DEFS.claude.slots.length, 5);
  assert.deepEqual([...ROUTE_DEFS.claude.inheritsFromPrimary], ["opus", "sonnet", "haiku", "fable"]);
}

// ---- effectiveRoutes (Stage 7.6) ----

{
  // No main → pass through.
  const r = effectiveRoutes({ main: null, opus: null, sonnet: null, haiku: null, fable: null });
  assert.equal(r.main, null);
  assert.equal(r.opus, null);
}

{
  // Main + explicit auxiliaries → pass through unchanged.
  const routes = {
    main:  { provider: "deepseek", model: "deepseek-chat" },
    opus:  { provider: "deepseek", model: "deepseek-chat" },
    haiku: { provider: "deepseek", model: "deepseek-chat-fast" },
  };
  const r = effectiveRoutes(routes);
  assert.equal(r.main.provider, "deepseek");
  assert.equal(r.opus.provider, "deepseek");
  assert.equal(r.opus._fallback, undefined);
  assert.equal(r.haiku.model, "deepseek-chat-fast");
}

{
  // Main only → every auxiliary is a copy of main with _fallback: true.
  const r = effectiveRoutes({ main: { provider: "deepseek", model: "deepseek-chat" } });
  assert.equal(r.main.provider, "deepseek");
  for (const slot of ["opus", "sonnet", "haiku", "fable"]) {
    assert.equal(r[slot].provider, "deepseek", slot);
    assert.equal(r[slot].model,    "deepseek-chat", slot);
    assert.equal(r[slot]._fallback, true, slot);
  }
}

{
  // An explicitly set auxiliary is never overridden by the primary.
  const r = effectiveRoutes({
    main:  { provider: "deepseek", model: "deepseek-chat" },
    sonnet: { provider: "deepseek", model: "deepseek-reasoner" },
  });
  assert.equal(r.sonnet.model, "deepseek-reasoner");
  assert.equal(r.sonnet._fallback, undefined);
  assert.equal(r.opus._fallback, true);
}

{
  // No main but an auxiliary set → rejected. An auxiliary alone would still
  // inject a partial routing profile, so it is never a legal shape.
  assert.throws(
    () => effectiveRoutes({ main: null, haiku: { provider: "deepseek", model: "deepseek-chat-fast" } }),
    /require claude\.main when an auxiliary slot is configured/,
  );
}

{
  // Tolerate null / undefined input.
  assert.equal(effectiveRoutes(null).main, null);
  assert.equal(effectiveRoutes(undefined).haiku, null);
}

// ---- hashRoutes with effective routes (Stage 7.6) ----

{
  // "opus unset" and "opus explicitly set to the same as main" → identical hashes.
  const a = { main: { provider: "deepseek", model: "deepseek-chat" } };
  const b = {
    main: { provider: "deepseek", model: "deepseek-chat" },
    opus: { provider: "deepseek", model: "deepseek-chat" },
  };
  assert.equal(hashRoutes(a), hashRoutes(b), "opus unset should hash identically to opus=main");
}

{
  // Different auxiliary → different hash.
  const a = { main: { provider: "deepseek", model: "deepseek-chat" } };
  const b = {
    main: { provider: "deepseek", model: "deepseek-chat" },
    opus: { provider: "deepseek", model: "deepseek-chat-fast" },
  };
  assert.notEqual(hashRoutes(a), hashRoutes(b));
}

{
  // _fallback is stripped from the hash: a materialised inherit must not
  // perturb it, or every read would restart the proxy.
  const a = hashRoutes({ main: { provider: "deepseek", model: "deepseek-chat" } });
  const b = hashRoutes({
    main: { provider: "deepseek", model: "deepseek-chat" },
    opus: { provider: "deepseek", model: "deepseek-chat", _fallback: true },
    haiku: { provider: "deepseek", model: "deepseek-chat", _fallback: true },
  });
  assert.equal(a, b, "_fallback flag must not perturb the hash");
}

{
  // All-inherit and main-only must agree, since effectiveAgentRoutes produces
  // the former from the latter.
  const mainOnly = getAllRoutes({ providers: PROVIDERS, routes: { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } } });
  const eff = { claude: effectiveAgentRoutes("claude", mainOnly.claude), codex: mainOnly.codex };
  assert.equal(hashRoutes(mainOnly), hashRoutes(eff));
}

console.log("routes.test.js ok");
