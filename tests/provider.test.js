// Stage 1 provider tests + Stage 7 catalog and migration tests.
// Stage 9.0: wire types are originrouter | proxy | remote. The legacy
// string "litellm" is accepted as a CLI input alias and persisted as
// proxy(engine=litellm). All persisted records on the proxy path are
// type="proxy", engine="litellm"; the test asserts this canonical
// shape. The read-side normalizeProviderForRead is also updated to
// project legacy strings to proxy(engine=litellm, ...).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAgentProviderEnv } from "../src/config/claudeConfig.js";
import {
  ENV_REF_REGEX,
  KNOWN_PROVIDER_META_KEYS,
  PROVIDER_TYPES,
  addProvider,
  applyProviderUpdate,
  buildProviderEnv,
  doctorProvider,
  getCurrentProvider,
  listProviders,
  normalizeProviderForRead,
  removeProvider,
  resolveProvider,
  secretFieldKeysFor,
  setClaudeRouteFromProvider,
  setCurrentProvider,
  showProvider,
  takeUpdateWarnings,
} from "../src/config/providers.js";
import { migrateLegacyConfig } from "../src/config/migration.js";
import { getRoutes } from "../src/config/routes.js";
import { readConfig, writeConfig } from "../src/persistence/state.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-provider-test-"));
process.env.ORIGINROUTER_HOME = home;

// Stage 9.0: helper for the canonical proxy(engine=litellm) shape.
function assertProxyLitellm(p) {
  assert.equal(p.type, "proxy", `expected type=proxy, got ${p.type}`);
  assert.equal(p.engine, "litellm", `expected engine=litellm, got ${p.engine}`);
}

try {
  // ---------------- PROVIDER_TYPES (Stage 9.0: 3 canonical wire types) ----------------
  assert.deepEqual(PROVIDER_TYPES, ["originrouter", "proxy", "remote"]);

  // ---------------- addProvider happy path ----------------
  // Stage 9.0: --type is optional. The default is "proxy"(engine=litellm).
  // A caller can pass the legacy alias "litellm" and it is normalized to
  // the canonical shape. The on-disk record is type="proxy", engine="litellm".
  let cfg = {};
  cfg = addProvider(cfg, {
    name: "minimax",
    type: "litellm",
    litellmProvider: "anthropic",
    baseUrl: "https://api.minimax.example/v1",
    apiKey: "sk-mm-1234567890",
    model: "MiniMax-M3",
    smallFastModel: "MiniMax-M2.7",
  });
  assertProxyLitellm(cfg.providers.minimax);
  assert.equal(cfg.providers.minimax.litellmProvider, "anthropic");
  assert.equal(cfg.providers.minimax.smallFastModel, "MiniMax-M2.7");

  // --type omitted → defaults to proxy(engine=litellm).
  cfg = addProvider(cfg, {
    name: "deepseek",
    litellmProvider: "custom_openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-ds-1234567890",
    model: "deepseek-chat",
  });
  assertProxyLitellm(cfg.providers.deepseek);
  assert.equal(cfg.providers.deepseek.litellmProvider, "custom_openai");

  // ---------------- addProvider rejections ----------------
  assert.throws(() => addProvider(cfg, { name: "minimax", type: "proxy", engine: "litellm", litellmProvider: "anthropic", baseUrl: "https://x", apiKey: "sk", model: "m" }), /already exists/);
  assert.throws(() => addProvider(cfg, { name: "BadName!", type: "proxy", engine: "litellm", litellmProvider: "anthropic", baseUrl: "https://x", apiKey: "sk", model: "m" }), /provider name must match/);
  assert.throws(() => addProvider(cfg, { name: "x", type: "wrong", baseUrl: "https://x", apiKey: "sk", model: "m" }), /invalid type/);

  // Legacy type=anthropic is accepted via the write-normalize (the
  // legacy CLI flag --type anthropic still works) and persisted as
  // proxy(engine=litellm, litellmProvider=anthropic). It is NOT
  // rejected outright on add in Stage 9.0 (it is in update only).
  // Re-confirmed: Stage 9.0 only rejects "openai-compatible" on write.

  // Legacy type on add is rejected outright.
  assert.throws(
    () =>
      addProvider(cfg, {
        name: "old",
        type: "openai-compatible",
        baseUrl: "https://x",
        apiKey: "sk",
        model: "m",
      }),
    /openai-compatible.*no longer supported/,
  );

  // ---------------- addProvider proxy happy paths ----------------
  cfg = addProvider(cfg, {
    name: "ds-litellm",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "deepseek",
    apiKey: "sk-ds",
    model: "deepseek-chat",
  });

  cfg = addProvider(cfg, {
    name: "az",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "azure",
    apiKey: "azure-key",
    baseUrl: "https://x.openai.azure.com/",
    apiVersion: "2024-07-01-preview",
    model: "gpt-4",
  });

  cfg = addProvider(cfg, {
    name: "br",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "bedrock",
    awsRegion: "us-east-1",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  });

  cfg = addProvider(cfg, {
    name: "vx",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "vertex_ai",
    vertexProject: "p",
    vertexLocation: "us-central1",
    model: "gemini-1.5-pro",
  });

  // hfToken case (Stage 7.7: HF uses apiKey; hfToken is now an unknown field)
  assert.throws(() => addProvider({}, {
    name: "hf",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "huggingface",
    hfToken: "hf_xxx",
    model: "meta-llama/Meta-Llama-3-8B-Instruct",
  }), /unknown provider field 'hfToken'/);

  // apiKey is the canonical field for huggingface.
  cfg = addProvider(cfg, {
    name: "hf",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "huggingface",
    apiKey: "hf_xxx",
    model: "meta-llama/Meta-Llama-3-8B-Instruct",
  });
  assert.equal(cfg.providers.hf.apiKey, "hf_xxx");

  // ---------------- addProvider proxy rejections ----------------
  assert.throws(() => addProvider({}, {
    name: "x", type: "proxy", engine: "litellm", litellmProvider: "ghost", apiKey: "k", model: "m",
  }), /not a known LiteLLM adapter/);
  assert.throws(() => addProvider({}, {
    name: "x", type: "proxy", engine: "litellm", apiKey: "k", model: "m",
  }), /requires litellmProvider/);
  // Stage 7.7: bedrock awsRegion is runtimeRequired (not required), so save
  // succeeds without it. Doctor warns. proxy-start surfaces the hint.
  {
    const cfg = addProvider({}, {
      name: "br", type: "proxy", engine: "litellm", litellmProvider: "bedrock", model: "m",
    });
    assert.equal(cfg.providers.br.awsRegion, undefined);
    const doc = doctorProvider(cfg.providers.br);
    assert.ok(doc.warnings.some((w) => /awsRegion/.test(w)),
      `expected awsRegion warning; got: ${JSON.stringify(doc.warnings)}`);
  }
  // Stage 7.7: azure.apiVersion is runtimeRequired (not required) so save
  // succeeds. azure.baseUrl is required (no env fallback for the URL).
  // Save succeeds without apiVersion; doctor warns about runtime need.
  {
    const cfg = addProvider({}, {
      name: "az", type: "proxy", engine: "litellm", litellmProvider: "azure",
      baseUrl: "https://x.openai.azure.com/", model: "m",
    });
    assert.equal(cfg.providers.az.apiVersion, undefined);
    const doc = doctorProvider(cfg.providers.az);
    assert.ok(doc.warnings.some((w) => /apiVersion/.test(w)),
      `expected apiVersion warning; got: ${JSON.stringify(doc.warnings)}`);
  }
  // vertex_ai: vertexProject + vertexLocation are runtimeRequired too.
  // Save succeeds without them; doctor warns.
  {
    const cfg = addProvider({}, {
      name: "vx", type: "proxy", engine: "litellm", litellmProvider: "vertex_ai", model: "m",
    });
    const doc = doctorProvider(cfg.providers.vx);
    assert.ok(doc.warnings.some((w) => /vertexProject/.test(w)),
      `expected vertexProject warning; got: ${JSON.stringify(doc.warnings)}`);
  }

  // ---------------- listProviders / showProvider ----------------
  const listed = listProviders(cfg);
  assert.ok(listed.length >= 6);
  for (const item of listed) {
    if (item.apiKey) {
      assert.notEqual(item.apiKey, "sk-mm-1234567890");
      assert.notEqual(item.apiKey, "sk-ds-1234567890");
    }
  }
  const showBr = showProvider(cfg, "br");
  assert.equal(showBr.awsRegion, "us-east-1");
  const show = showProvider(cfg, "minimax");
  assert.equal(show.name, "minimax");
  assert.throws(() => showProvider(cfg, "ghost"), /unknown provider 'ghost'/);

  // ---------------- currentProvider ----------------
  assert.deepEqual(getCurrentProvider(cfg, "claude"), { provider: null, source: "none" });
  cfg = setCurrentProvider(cfg, "claude", "minimax");
  assert.equal(getCurrentProvider(cfg, "claude").provider.name, "minimax");

  const next = removeProvider(cfg, "minimax");
  assert.equal(next.providers.minimax, undefined);
  assert.equal(next.currentProvider.claude, "minimax", "module does not auto-clear dangling current; CLI does");
  cfg = setCurrentProvider(cfg, "claude", "deepseek");

  // ---------------- resolveProvider ----------------
  const rFlag = resolveProvider({ config: cfg, agent: "claude", flagName: "deepseek" });
  assert.equal(rFlag.source, "flag");
  assert.equal(rFlag.provider.name, "deepseek");
  const rCur = resolveProvider({ config: cfg, agent: "claude" });
  assert.equal(rCur.source, "current");
  assert.equal(rCur.provider.name, "deepseek");
  const legacyCfg = { claude: { baseUrl: "https://x", apiKey: "sk-y", model: "m" } };
  const rLeg = resolveProvider({ config: legacyCfg, agent: "claude" });
  assert.equal(rLeg.source, "legacy");
  assert.equal(rLeg.provider.name, "legacy-claude");
  assert.deepEqual(resolveProvider({ config: {}, agent: "claude" }), { provider: null, source: "none" });
  assert.throws(() => resolveProvider({ config: cfg, agent: "claude", flagName: "ghost" }), /not found in providers/);
  const dangling = { providers: {}, currentProvider: { claude: "gone" } };
  assert.throws(() => resolveProvider({ config: dangling, agent: "claude" }), /deleted provider 'gone'/);

  // ---------------- buildProviderEnv (legacy direct path helper) ----------------
  // Stage 7.6: buildProviderEnv is used for codex and other agents only.
  // The claude agent no longer uses direct provider env. type=proxy returns {}.
  // type=anthropic on a legacy record still produces the direct env
  // (the read-side normalizeProviderForRead does not rewrite when this
  // helper is called directly).
  assert.deepEqual(
    buildProviderEnv({ name: "a", type: "anthropic", baseUrl: "https://x", apiKey: "sk", model: "m", smallFastModel: "fast" }),
    { ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_API_KEY: "sk", ANTHROPIC_MODEL: "m", ANTHROPIC_SMALL_FAST_MODEL: "fast" },
  );
  assert.deepEqual(buildProviderEnv({ name: "b", type: "proxy", engine: "litellm", apiKey: "sk", model: "m" }), {});

  // ---------------- buildAgentProviderEnv gating (Stage 7.6) ----------------
  // claude always needs the proxy now. With no proxyStatus option, it
  // throws PROVIDER_UNSUPPORTED.
  cfg = removeProvider(cfg, "minimax");
  cfg = addProvider(cfg, {
    name: "minimax",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "anthropic",
    baseUrl: "https://api.minimax.example/v1",
    apiKey: "sk-mm",
    model: "MiniMax-M3",
  });
  await assert.rejects(
    () => buildAgentProviderEnv("claude", cfg, { provider: "minimax" }),
    (err) => err.code === "PROVIDER_UNSUPPORTED",
  );
  await assert.rejects(
    () => buildAgentProviderEnv("claude", cfg, { provider: "deepseek" }),
    (err) => err.code === "PROVIDER_UNSUPPORTED",
  );
  const curDeepseek = setCurrentProvider(cfg, "claude", "deepseek");
  await assert.rejects(() => buildAgentProviderEnv("claude", curDeepseek), (err) => err.code === "PROVIDER_UNSUPPORTED");
  // Stage 8.0: Codex is route-mode only. routes.codex.main unset →
  // PROVIDER_UNSUPPORTED (no legacy currentProvider.codex fallback).
  await assert.rejects(
    () => buildAgentProviderEnv("codex", cfg),
    (err) => err.code === "PROVIDER_UNSUPPORTED" && /routes\.codex\.main/.test(err.message),
  );

  // ---------------- doctorProvider ----------------
  assert.deepEqual(
    doctorProvider(cfg.providers.minimax),
    { ok: true, errors: [], warnings: [] },
    "complete anthropic provider should be ok",
  );
  const incomplete = { name: "x", type: "anthropic", baseUrl: "https://x", model: "m" };
  // Stage 7.7: anthropic.apiKey is runtimeRequired, not required. Doctor
  // warns only when the value is blank AND the env-var fallback is unset in
  // process.env. Sandbox the test by temporarily unsetting the env var.
  const savedEnv = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    const inc = doctorProvider(incomplete);
    assert.ok(inc.warnings.some((w) => /apiKey/.test(w)),
      `expected apiKey warning; got: ${JSON.stringify(inc)}`);
    assert.ok(!inc.errors.some((e) => /apiKey/.test(e)),
      "apiKey must not be an error under Stage 7.7");
  } finally {
    if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
  }
  // proxy -> ok, no proxy warning (it's the wired path now).
  const docDs = doctorProvider(cfg.providers.deepseek);
  assert.equal(docDs.ok, true);
  // Stage 7.6: smallFastModel on proxy is allowed (it's a seed for the
  // routes.claude.small route). doctor does NOT warn about it. The
  // warning is reserved for the legacy projection case (smallFastModel
  // on a record that read-projects from type=anthropic without routes).
  const proxyWithFast = {
    name: "weird", type: "proxy", engine: "litellm", litellmProvider: "deepseek",
    apiKey: "sk", model: "m", smallFastModel: "fast",
  };
  const docWeird = doctorProvider(proxyWithFast);
  assert.ok(!docWeird.warnings.some((w) => /smallFastModel is ignored/.test(w)),
    "smallFastModel on proxy no longer triggers a doctor warning");
  assert.equal(doctorProvider({ name: "BadName!" }).ok, false);

  // ---------------- migrateLegacyConfig ----------------
  const migrated = migrateLegacyConfig({
    claude: { baseUrl: "https://x", apiKey: "sk", model: "m" },
  });
  assert.equal(migrated.providers["default-claude"].type, "anthropic");
  assert.equal(migrated.currentProvider.claude, "default-claude");
  assert.ok(migrated.claude, "legacy block is preserved");
  assert.ok(migrated.migratedAt);
  const migrated2 = migrateLegacyConfig(migrated);
  assert.deepEqual(migrated2, migrated);
  const empty = {};
  assert.equal(migrateLegacyConfig(empty), empty);

  // ---------------- read/write round-trip ----------------
  writeConfig(cfg);
  const reloaded = readConfig();
  assert.equal(reloaded.providers.minimax.name, "minimax");
  assert.equal(reloaded.currentProvider.claude, "deepseek");
  assert.equal(reloaded.providers["default-claude"], undefined);

  // ---------------- normalizeProviderForRead ----------------
  // Stage 9.0: read-projection now produces type="proxy", engine="litellm".
  const legacyRec = { name: "old", type: "openai-compatible", baseUrl: "https://x", apiKey: "k", model: "m" };
  const projected = normalizeProviderForRead(legacyRec);
  assert.equal(projected.type, "proxy");
  assert.equal(projected.engine, "litellm");
  assert.equal(projected.litellmProvider, "custom_openai");
  assert.equal(projected._legacyType, "openai-compatible");
  assert.equal(projected._legacy, undefined);
  // Also: type=anthropic legacy projects to proxy(engine=litellm)/anthropic.
  const anthropicLegacy = { name: "old-mm", type: "anthropic", baseUrl: "https://x", apiKey: "k", model: "m" };
  const projectedA = normalizeProviderForRead(anthropicLegacy);
  assert.equal(projectedA.type, "proxy");
  assert.equal(projectedA.engine, "litellm");
  assert.equal(projectedA.litellmProvider, "anthropic");
  assert.equal(projectedA._legacyType, "anthropic");
  // Also: type=litellm (the historical wire type) projects to proxy(engine=litellm).
  const litellmLegacy = { name: "old-ds", type: "litellm", litellmProvider: "deepseek", apiKey: "k", model: "m" };
  const projectedL = normalizeProviderForRead(litellmLegacy);
  assert.equal(projectedL.type, "proxy");
  assert.equal(projectedL.engine, "litellm");
  assert.equal(projectedL.litellmProvider, "deepseek");
  assert.equal(projectedL._legacyType, "litellm");
  // Already-canonical records pass through unchanged.
  const ok = normalizeProviderForRead({ name: "x", type: "proxy", engine: "litellm", litellmProvider: "deepseek" });
  assert.equal(ok._legacy, undefined);
  assert.equal(ok._legacyType, undefined);
  const ok2 = normalizeProviderForRead({ name: "y", type: "originrouter", baseUrl: "https://x", auth: { type: "oauth" }, model: "m" });
  assert.equal(ok2.type, "originrouter");
  assert.equal(ok2._legacy, undefined);

  // ---------------- applyProviderUpdate: legacy auto-normalize ----------------
  cfg = addProvider(cfg, {
    name: "old-ds",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "deepseek",
    apiKey: "sk-old",
    model: "deepseek-chat",
  });
  // Hand-edit to legacy literal so we test the migration.
  cfg.providers["old-ds"] = {
    name: "old-ds",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-old",
    model: "deepseek-chat",
  };
  // PUT with no `type` in the patch: auto-normalize to proxy(engine=litellm).
  let result = applyProviderUpdate(cfg, "old-ds", { baseUrl: "https://api.deepseek.com/v2" });
  let warnings = takeUpdateWarnings(result);
  assert.deepEqual(warnings, []);
  assert.equal(result.providers["old-ds"].type, "proxy");
  assert.equal(result.providers["old-ds"].engine, "litellm");
  assert.equal(result.providers["old-ds"].litellmProvider, "custom_openai");
  assert.equal(result.providers["old-ds"].baseUrl, "https://api.deepseek.com/v2");
  // PUT with explicit type=openai-compatible rejects.
  assert.throws(
    () => applyProviderUpdate(cfg, "old-ds", { type: "openai-compatible" }),
    /openai-compatible.*no longer supported/,
  );

  // ---------------- applyProviderUpdate: smallFastModel legacy round-trip ----------------
  // Stage 7.8: smallFastModel is [legacy]. applyProviderUpdate still
  // accepts it (no warning, no drop) for backward compat with existing
  // records and the --small-fast-model CLI flag. The field is NOT read
  // by setClaudeRouteFromProvider (covered in the next block).
  result = applyProviderUpdate(cfg, "deepseek", { type: "proxy", engine: "litellm", litellmProvider: "custom_openai", smallFastModel: "fast" });
  warnings = takeUpdateWarnings(result);
  assert.equal(result.providers.deepseek.smallFastModel, "fast");
  assert.equal(warnings.length, 0);

  // ---------------- setClaudeRouteFromProvider: Stage 7.8 contract ----------------
  // 1. The function writes ONLY routes.claude.main. The provider's
  //    smallFastModel is ignored (legacy).
  {
    const cfg78 = {
      providers: {
        p1: { name: "p1", type: "proxy", engine: "litellm", litellmProvider: "deepseek", model: "m", smallFastModel: "mini" },
      },
    };
    const { next } = setClaudeRouteFromProvider(cfg78, "p1");
    assert.equal(getRoutes(next).main.provider, "p1");
    assert.equal(getRoutes(next).small, null, "small must NOT be seeded by provider use");
  }
  // 2. An externally-set small route is preserved (not overwritten).
  {
    const cfg78b = {
      providers: {
        p1: { name: "p1", type: "proxy", engine: "litellm", litellmProvider: "deepseek", model: "m" },
      },
      routes: { claude: { small: { provider: "x", model: "y" } } },
    };
    const { next: next2 } = setClaudeRouteFromProvider(cfg78b, "p1");
    assert.equal(getRoutes(next2).small.provider, "x", "external small preserved");
  }
  // 3. Return shape no longer carries smallPreserved.
  {
    const cfg78c = { providers: { p1: { name: "p1", type: "proxy", engine: "litellm", litellmProvider: "deepseek", model: "m" } } };
    const out = setClaudeRouteFromProvider(cfg78c, "p1");
    assert.equal(out.smallPreserved, undefined, "smallPreserved is gone in Stage 7.8");
    assert.ok(out.next, "next is still present");
  }

  // ---------------- applyProviderUpdate: HF apiKey mirror (Stage 7.7) ----------------
  cfg = addProvider(cfg, {
    name: "hf-mirror",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "huggingface",
    apiKey: "hf-orig",
    model: "m",
  });
  result = applyProviderUpdate(cfg, "hf-mirror", { apiKey: "hf-new" });
  assert.equal(result.providers["hf-mirror"].apiKey, "hf-new");
  // Stage 7.7: hfToken is an unknown field — update with hfToken in patch is rejected.
  assert.throws(
    () => applyProviderUpdate(cfg, "hf-mirror", { hfToken: "should-reject" }),
    /unknown provider field 'hfToken'/,
  );

  // ---------------- maskSecret still masks apiKey ----------------
  const showMinimax = showProvider(readConfig(), "minimax");
  // For long keys: "sk-xxxx....yyyy"; for short keys (<=10): "set".
  // Either form is acceptable — the raw key never appears.
  assert.notEqual(showMinimax.apiKey, "sk-mm");
  assert.match(showMinimax.apiKey, /^sk-.+\.\.\..+$|^set$/);

// ---------------- Stage 7.7: catalog fidelity ----------------
{
  // secretFieldKeysFor derives the secret set from the catalog (metadata-driven).
  const anthropicSecrets = secretFieldKeysFor({
    name: "x", type: "proxy", engine: "litellm", litellmProvider: "anthropic",
    apiKey: "k", authToken: "t",
  });
  assert.ok(anthropicSecrets.has("apiKey"));
  assert.ok(anthropicSecrets.has("authToken"));
  assert.ok(!anthropicSecrets.has("baseUrl"));

  const bedrockSecrets = secretFieldKeysFor({
    name: "x", type: "proxy", engine: "litellm", litellmProvider: "bedrock",
    awsAccessKeyId: "k", awsSecretAccessKey: "s",
  });
  assert.ok(bedrockSecrets.has("awsSecretAccessKey"));
  assert.ok(bedrockSecrets.has("awsSessionToken"));
  assert.ok(bedrockSecrets.has("awsWebIdentityToken"));

  const vertexSecrets = secretFieldKeysFor({
    name: "x", type: "proxy", engine: "litellm", litellmProvider: "vertex_ai",
    vertexCredentials: "{}", googleApplicationCredentials: "/p",
  });
  assert.ok(vertexSecrets.has("vertexCredentials"));
  assert.ok(vertexSecrets.has("googleApplicationCredentials"));
}

{
  // Stage 7.7: addProvider STRICT — unknown field rejected.
  assert.throws(
    () => addProvider({}, {
      name: "x", type: "proxy", engine: "litellm", litellmProvider: "deepseek",
      apiKey: "k", model: "m", bogusField: "v",
    }),
    /unknown provider field 'bogusField'/,
  );
}

{
  // Stage 7.7: applyProviderUpdate ASYMMETRIC.
  // (a) existing unknown field round-trips through update with empty patch.
  let cfg = addProvider({}, {
    name: "ds", type: "proxy", engine: "litellm", litellmProvider: "deepseek",
    apiKey: "k", model: "m",
  });
  cfg.providers.ds.foo = "bar"; // legacy unknown key on disk
  const after = applyProviderUpdate(cfg, "ds", { apiKey: "newkey" });
  assert.equal(after.providers.ds.foo, "bar", "unknown disk key must round-trip");
  assert.equal(after.providers.ds.apiKey, "newkey");
  // (b) new unknown field in patch rejected.
  assert.throws(
    () => applyProviderUpdate(cfg, "ds", { bogusField: "v" }),
    /unknown provider field 'bogusField'/,
  );
}

{
  // Stage 7.7: generalized secret preservation.
  let cfg = addProvider({}, {
    name: "br", type: "proxy", engine: "litellm", litellmProvider: "bedrock",
    awsRegion: "us-east-1", awsSecretAccessKey: "orig-secret",
    awsSessionToken: "orig-token",
    model: "m",
  });
  // Empty patch value for awsSecretAccessKey → keep original.
  const result = applyProviderUpdate(cfg, "br", { awsSecretAccessKey: "" });
  assert.equal(result.providers.br.awsSecretAccessKey, "orig-secret");
  // Empty patch value for awsSessionToken → keep original.
  const result2 = applyProviderUpdate(cfg, "br", { awsSessionToken: null });
  assert.equal(result2.providers.br.awsSessionToken, "orig-token");
}

{
  // Stage 7.7: env-reference values pass through verbatim.
  let cfg = addProvider({}, {
    name: "ds", type: "proxy", engine: "litellm", litellmProvider: "deepseek",
    apiKey: "os.environ/DEEPSEEK_API_KEY", model: "m",
  });
  assert.equal(cfg.providers.ds.apiKey, "os.environ/DEEPSEEK_API_KEY");
  // Malformed env-ref throws on add.
  assert.throws(
    () => addProvider({}, {
      name: "ds2", type: "proxy", engine: "litellm", litellmProvider: "deepseek",
      apiKey: "os.environ/1bad", model: "m",
    }),
    /malformed env reference/,
  );
}

{
  // Stage 7.7: inlineCreds is UI-only — never persisted.
  const cfg = addProvider({}, {
    name: "br", type: "proxy", engine: "litellm", litellmProvider: "bedrock",
    awsRegion: "us-east-1", inlineCreds: true, model: "m",
  });
  assert.equal(cfg.providers.br.inlineCreds, undefined,
    "inlineCreds must be stripped before persistence");
}

{
  // Stage 7.7: ENV_REF_REGEX is re-exported and matches.
  assert.equal(ENV_REF_REGEX.test("os.environ/Foo"), true);
  assert.equal(ENV_REF_REGEX.test("os.environ/1foo"), false);
  // KNOWN_PROVIDER_META_KEYS covers expected meta keys.
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("name"));
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("type"));
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("litellmProvider"));
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("inlineCreds"));
  // Stage 9.0 additions.
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("engine"));
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("auth"));
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("deviceId"));
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("target"));
  assert.ok(KNOWN_PROVIDER_META_KEYS.has("baseUrl"));
}

{
  // Stage 7.7 polish: doctor iterates ALL env candidates, not just first.
  // bedrock.awsRegion envVar = "AWS_REGION_NAME / AWS_REGION / AWS_DEFAULT_REGION".
  // With NONE set: warn. With ANY set: no warn.
  const savedAll = {
    AWS_REGION_NAME: process.env.AWS_REGION_NAME,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
  };
  try {
    const p = { name: "br", type: "proxy", engine: "litellm", litellmProvider: "bedrock", model: "m" };
    delete process.env.AWS_REGION_NAME;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    const docNone = doctorProvider(p);
    const awrWarn = docNone.warnings.find((w) => /awsRegion/.test(w));
    assert.ok(awrWarn, "awsRegion warning expected when no AWS_REGION* env var is set");
    assert.match(awrWarn, /one of \[AWS_REGION_NAME, AWS_REGION, AWS_DEFAULT_REGION\]/);

    // Set only AWS_REGION (second candidate) — should silence the warning.
    process.env.AWS_REGION = "us-east-1";
    const docOne = doctorProvider(p);
    assert.ok(!docOne.warnings.some((w) => /awsRegion/.test(w)),
      "awsRegion warning should be silenced when one env candidate is set");
    delete process.env.AWS_REGION;

    // Set only AWS_DEFAULT_REGION (third candidate) — also silences.
    process.env.AWS_DEFAULT_REGION = "us-west-2";
    const docOne2 = doctorProvider(p);
    assert.ok(!docOne2.warnings.some((w) => /awsRegion/.test(w)),
      "awsRegion warning should be silenced when another env candidate is set");
    delete process.env.AWS_DEFAULT_REGION;
  } finally {
    for (const [k, v] of Object.entries(savedAll)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("provider tests ok");
