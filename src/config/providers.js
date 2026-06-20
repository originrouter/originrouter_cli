// Pure CRUD + validation + env builder for the new "providers" section of
// ~/.originrouter/config.json. No I/O — callers pass in the loaded config and
// receive a new config back. See docs/agent-protocol.md and the Stage 1 plan
// in the plan file for the full picture.
//
// Two-type model in Stage 7:
//   - "anthropic"        -> direct path; generates ANTHROPIC_* env.
//   - "litellm"          -> routes through the LiteLLM proxy.
//   The catalog of litellm sub-types lives in src/proxy/litellmCatalog.js.
//
// Legacy "openai-compatible" is still readable but no longer writable:
// addProvider rejects it outright. applyProviderUpdate on a legacy record
// auto-normalizes to litellm/custom_openai unless the patch carries
// type=openai-compatible explicitly.
//
// The provider resolver does NOT filter by type. Type compatibility with the
// calling agent is enforced by buildAgentProviderEnv() (claudeConfig.js), which
// throws PROVIDER_UNSUPPORTED rather than silently falling back. This separation
// keeps env print and doctor able to report the situation honestly.

import { maskSecret } from "./claudeConfig.js";
import {
  catalogFieldKeysFor,
  getLitellmProfile,
  LITELLM_PROVIDER_IDS,
  secretFieldKeysFor,
} from "../proxy/litellmCatalog.js";
import { ENV_REF_RE } from "../proxy/litellm.js";
import { setRoute } from "./routes.js";

export const PROVIDER_TYPES = Object.freeze(["litellm"]);

// Legacy types kept only for migration detection.
export const LEGACY_PROVIDER_TYPE = "openai-compatible";
export const LEGACY_PROVIDER_TYPES = Object.freeze(["anthropic", "openai-compatible"]);

// Stage 7.7: keys that may appear on a provider record but are not catalog
// field keys. addProvider / applyProviderUpdate use this list to decide
// whether a payload key is "unknown" (reject) or "expected" (allow).
// - name, type, litellmProvider, model, smallFastModel: meta
// - _legacy, _legacyType, migratedFrom: read-side projection; stripped on save
// - inlineCreds: UI-only state; stripped on save (never persisted)
export const KNOWN_PROVIDER_META_KEYS = Object.freeze(new Set([
  "name", "type", "litellmProvider", "model", "smallFastModel",
  "_legacy", "_legacyType", "migratedFrom",
  "inlineCreds",
]));

// Stage 7.7: env-reference syntax. Re-exported here for callers that import
// from providers.js only.
export const ENV_REF_REGEX = ENV_REF_RE;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ANTHROPIC_KEY_PREFIX_HINT = "sk-";

// Stage 7.7: validate that a value matches the env-ref syntax when it
// looks env-ref-ish. Returns the value as-is when valid; throws otherwise.
// Stage 7.7 also documents that env-refs are a single var only.
function validateEnvRefShape(fieldKey, value) {
  if (typeof value !== "string" || !value.startsWith("os.environ/")) return;
  if (!ENV_REF_RE.test(value)) {
    throw new Error(
      `field '${fieldKey}' has malformed env reference '${value}' ` +
      `(expected os.environ/VAR_NAME matching ${ENV_REF_RE.source})`,
    );
  }
}

// Walk every string value in `payload` and validate env-ref shape. Used on
// add to catch malformed refs up front; the renderer re-validates as a
// defense-in-depth.
function validateAllEnvRefShapes(payload) {
  if (!payload || typeof payload !== "object") return;
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string") validateEnvRefShape(k, v);
  }
}

// Stage 7.7: throw when the payload carries any key that is neither in the
// catalog (for the named litellmProvider) nor in KNOWN_PROVIDER_META_KEYS.
// `where` is "add" or "update" for the error message.
function assertNoUnknownProviderFields(payload, litellmProvider, { where }) {
  if (!payload || typeof payload !== "object") return;
  const catalogKeys = catalogFieldKeysFor(litellmProvider);
  const known = new Set([...catalogKeys, ...KNOWN_PROVIDER_META_KEYS]);
  const unknown = [];
  for (const k of Object.keys(payload)) {
    if (!known.has(k)) unknown.push(k);
  }
  if (unknown.length === 0) return;
  const knownList = [...known].sort();
  throw new Error(
    `unknown provider field${unknown.length === 1 ? "" : "s"} ` +
    `'${unknown.join("', '")}' for litellmProvider='${litellmProvider || "(unset)"}' ` +
    `(${where}). Known: ${knownList.join(", ")}`,
  );
}

// Stage 7.7: a value matches the env-ref shape if it is a string of the
// form os.environ/VAR_NAME (single var). Returns false for literal values
// and empty strings.
function isEnvRef(value) {
  return typeof value === "string" && ENV_REF_RE.test(value);
}

// ---------- read-side migration projection ----------

// Stage 7.6 read projection: legacy "anthropic" and "openai-compatible"
// records are returned as { type: "litellm", litellmProvider: <anthropic|custom_openai>, _legacyType: <...> }
// so the UI and catalog lookup see the new shape. The disk record is NOT
// modified. `_legacyType` is a read-side hint for the UI; it is never
// written to disk.
export function normalizeProviderForRead(p) {
  if (!p) return p;
  if (p.type === "anthropic") {
    return { ...p, type: "litellm", litellmProvider: "anthropic", _legacyType: "anthropic" };
  }
  if (p.type === LEGACY_PROVIDER_TYPE) {
    return { ...p, type: "litellm", litellmProvider: "custom_openai", _legacyType: LEGACY_PROVIDER_TYPE };
  }
  return p;
}

// ---------- currentProvider ----------

export function getCurrentProvider(config, agent) {
  const cur = config.currentProvider || {};
  const name = cur[agent];
  if (!name) return { provider: null, source: "none" };
  const provider = (config.providers || {})[name] || null;
  if (!provider) {
    return { provider: null, source: "none", dangling: name };
  }
  return { provider, source: "current" };
}

export function setCurrentProvider(config, agent, name) {
  const cur = { ...(config.currentProvider || {}) };
  if (name == null) delete cur[agent];
  else cur[agent] = name;
  return { ...config, currentProvider: cur };
}

// ---------- internal validation helpers ----------

function requireName(p) {
  const name = String(p.name || "").trim();
  if (!NAME_RE.test(name)) {
    throw new Error(`provider name must match ${NAME_RE} (got '${name}')`);
  }
  return name;
}

function validateAnthropicRecord(p, { name }) {
  if (!p.baseUrl || !/^https?:\/\//.test(p.baseUrl)) {
    throw new Error(`provider '${name}' baseUrl must start with http:// or https:// (got '${p.baseUrl}')`);
  }
  if (!p.apiKey) throw new Error(`provider '${name}' apiKey is required`);
  if (!p.model) throw new Error(`provider '${name}' model is required`);
}

function validateLitellmRecord(p, { name }) {
  if (!p.litellmProvider) {
    throw new Error(`provider '${name}' type=litellm requires litellmProvider`);
  }
  let profile;
  try {
    profile = getLitellmProfile(p.litellmProvider);
  } catch {
    throw new Error(
      `provider '${name}' litellmProvider '${p.litellmProvider}' is not a known LiteLLM adapter. ` +
      `Available: ${LITELLM_PROVIDER_IDS.join(", ")}`,
    );
  }
  // Stage 7.7: save-time validation only enforces `required: true` (the
  // handful of fields with NO env fallback at all, e.g. custom_openai.baseUrl,
  // azure.baseUrl, azure_ai.baseUrl, litellm_proxy.baseUrl). Every other
  // field is `runtimeRequired` only — doctor + proxy-start warn at runtime.
  for (const f of profile.fields) {
    if (!f.required) continue;
    const v = p[f.key];
    if (v == null || v === "") {
      throw new Error(`provider '${name}' (litellmProvider=${p.litellmProvider}) is missing required field '${f.key}'`);
    }
    if (typeof v === "string") validateEnvRefShape(f.key, v);
  }
  if (!p.model) throw new Error(`provider '${name}' model is required`);
}

function validateRecord(p) {
  const name = requireName(p);
  const type = String(p.type || "").trim();
  if (!PROVIDER_TYPES.includes(type)) {
    throw new Error(
      `provider '${name}' has invalid type '${p.type}'. Must be one of: ${PROVIDER_TYPES.join(", ")}`,
    );
  }
  if (type === "anthropic") validateAnthropicRecord(p, { name });
  if (type === "litellm")   validateLitellmRecord(p, { name });
  return { name, type };
}

// Stage 7.7: huggingface now uses `apiKey` (not the legacy `hfToken`) — the
// LiteLLM HuggingFace adapter accepts both as `api_key` in litellm_params,
// and `apiKey` is the more common shape. No mirror needed.
function pickLitellmProvider(p) {
  return { litellmProvider: p.litellmProvider };
}

// ---------- CRUD ----------

export function addProvider(config, provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("provider must be an object");
  }

  // Stage 7.6: --type is optional. Default to 'litellm' so the user can
  // write `provider add deepseek --litellm-provider deepseek ...` without
  // an explicit --type.
  const effectiveType = provider.type == null || provider.type === ""
    ? "litellm"
    : provider.type;

  // Reject legacy types outright on add. Migration is for update only.
  if (effectiveType === "anthropic") {
    throw new Error(
      `type 'anthropic' is no longer supported. ` +
      `Use --type litellm --litellm-provider anthropic instead. ` +
      `(Set --base-url for Anthropic-compatible endpoints like MiniMax.)`,
    );
  }
  if (effectiveType === LEGACY_PROVIDER_TYPE) {
    throw new Error(
      `type '${LEGACY_PROVIDER_TYPE}' is no longer supported. ` +
      `Use --type litellm --litellm-provider custom_openai instead.`,
    );
  }

  const normalized = effectiveType === "litellm"
    ? { ...provider, type: effectiveType, ...pickLitellmProvider(provider) }
    : { ...provider, type: effectiveType };
  // Stage 7.7: validate env-ref shape across the whole payload up front.
  validateAllEnvRefShapes(normalized);
  // Stage 7.7: strip UI-only state BEFORE the strict unknown-field check so
  // it doesn't pollute the known-key set.
  delete normalized.inlineCreds;
  const { name, type } = validateRecord(normalized);

  // Stage 7.7: strict unknown-field rejection on add. After validation the
  // litellmProvider is known; any payload key not in the catalog or in
  // KNOWN_PROVIDER_META_KEYS is rejected.
  if (type === "litellm") {
    assertNoUnknownProviderFields(normalized, normalized.litellmProvider, { where: "add" });
  }

  const providers = { ...(config.providers || {}) };
  if (providers[name]) {
    throw new Error(`provider '${name}' already exists. Use 'provider remove' first to overwrite.`);
  }

  // Stage 7.6: smallFastModel is stored on type=litellm providers. It is a
  // seed for routes.claude.small when the user runs `provider use`. The
  // Stage 7.5 warning is gone.
  // Stage 7.8: smallFastModel is [legacy]. Kept on disk for backward
  // compat (existing records + the --small-fast-model CLI flag), but it
  // no longer seeds routes.claude.small — that slot is owned by the
  // routes layer (POST /routes/claude/small or `originrouter route set
  // claude.small --provider <name>`).
  const stored = { name, type, ...normalized };
  delete stored._legacy;
  delete stored._legacyType;
  delete stored.inlineCreds;
  providers[name] = stored;
  return { ...config, providers };
}

export function removeProvider(config, name) {
  if (!name) throw new Error("provider name is required");
  const providers = { ...(config.providers || {}) };
  if (!providers[name]) {
    throw new Error(`unknown provider '${name}'`);
  }
  delete providers[name];
  return { ...config, providers };
}

// Pure: returns a new config with the named provider's fields updated.
// Stage 5: apiKey rule — absent / null / "" preserves the existing key.
// Stage 7.6: legacy "anthropic" and "openai-compatible" auto-migrate to
// type=litellm with the corresponding litellmProvider. The migration is
// triggered when the existing record is legacy AND the patch does NOT carry
// an explicit legacy type. The disk record never carries _legacyType after
// migration; the API response can include a `migratedFrom` field instead.
// Stage 7.7: asymmetric unknown-field policy:
//   - patch key not in catalog ∪ KNOWN_PROVIDER_META_KEYS → reject
//   - existing record's unknown keys round-trip unchanged (so legacy UI
//     state like `inlineCreds` doesn't brick existing configs)
//   - secret preservation generalizes to every secret: true field
//   - env-reference values pass through verbatim (after regex validation)
//   - inlineCreds is UI-only and never persisted
export function applyProviderUpdate(config, name, patch) {
  if (!patch || typeof patch !== "object") {
    throw new Error("patch must be an object");
  }
  const providers = { ...(config.providers || {}) };
  const existing = providers[name];
  if (!existing) throw new Error(`unknown provider '${name}'`);

  let workingPatch = patch;
  let migratedFrom = null;

  // Legacy migration: type=openai-compatible → type=litellm, litellmProvider=custom_openai
  if (existing.type === LEGACY_PROVIDER_TYPE && patch.type !== LEGACY_PROVIDER_TYPE) {
    workingPatch = { ...patch, type: "litellm", litellmProvider: "custom_openai" };
    migratedFrom = LEGACY_PROVIDER_TYPE;
  }
  // Legacy migration: type=anthropic → type=litellm, litellmProvider=anthropic
  if (existing.type === "anthropic" && patch.type !== "anthropic") {
    workingPatch = { ...workingPatch, type: "litellm", litellmProvider: "anthropic" };
    migratedFrom = "anthropic";
  }

  // Explicit legacy type on the patch is rejected.
  if (workingPatch.type === LEGACY_PROVIDER_TYPE) {
    throw new Error(
      `type '${LEGACY_PROVIDER_TYPE}' is no longer supported. ` +
      `Use type='litellm' litellmProvider='custom_openai' instead.`,
    );
  }
  if (workingPatch.type === "anthropic") {
    throw new Error(
      `type 'anthropic' is no longer supported. ` +
      `Use type='litellm' litellmProvider='anthropic' instead.`,
    );
  }

  // Resolve the litellmProvider we'll validate against. After legacy
  // migration it is forced to the corresponding catalog profile.
  const effectiveLitellmProvider = workingPatch.litellmProvider || existing.litellmProvider;

  // Stage 7.7: strict unknown-field rejection on the patch (after legacy
  // migration has rewritten type/litellmProvider, if applicable). The
  // existing record's unknown keys are preserved by the merge step below;
  // we only reject NEW unknown keys introduced by the patch.
  assertNoUnknownProviderFields(workingPatch, effectiveLitellmProvider, { where: "update" });

  // Stage 7.7: env-reference shape validation across the patch. We do this
  // before merge so the user sees the error pointing at the right key.
  for (const [k, v] of Object.entries(workingPatch)) {
    if (typeof v === "string") validateEnvRefShape(k, v);
  }

  // Stage 7.7: generalized secret preservation. For every catalog field
  // whose `secret: true`, when the patch value is empty / null / undefined /
  // non-string, the existing value is kept. This replaces the previous
  // apiKey-only rule.
  const secrets = secretFieldKeysFor({ ...existing, litellmProvider: effectiveLitellmProvider });
  const patchForMerge = { ...workingPatch };
  for (const f of (function () {
    try { return getLitellmProfile(effectiveLitellmProvider).fields; }
    catch { return []; }
  })()) {
    if (!f.secret) continue;
    if (!patchForMerge.hasOwnProperty(f.key)) continue;
    const v = patchForMerge[f.key];
    if (v == null || v === "") {
      // Empty patch value for a secret → keep existing.
      patchForMerge[f.key] = existing[f.key];
    } else if (typeof v !== "string") {
      throw new Error(`provider '${name}' field '${f.key}' must be a string`);
    }
  }
  // Strip UI-only state from the persisted record.
  delete patchForMerge.inlineCreds;

  // Preserve-existing-unknown-fields: take a snapshot of keys on `existing`
  // that are NOT in the catalog and NOT in KNOWN_PROVIDER_META_KEYS, and
  // make sure they survive the merge. (The strict check above only looked
  // at the patch.)
  const preservedUnknown = {};
  const catalogKeys = catalogFieldKeysFor(effectiveLitellmProvider);
  for (const [k, v] of Object.entries(existing)) {
    if (catalogKeys.has(k)) continue;
    if (KNOWN_PROVIDER_META_KEYS.has(k)) continue;
    preservedUnknown[k] = v;
  }

  // Merge: project existing for legacy, apply patchForMerge, preserve
  // unknown keys from disk.
  const merged = { ...normalizeProviderForRead(existing), ...patchForMerge, ...preservedUnknown };
  const { name: vName, type } = validateRecord(merged);

  // Stage 7.6: smallFastModel is stored on type=litellm providers. It is a
  // seed for routes.claude.small. The Stage 7.5 drop+warning is removed.
  // Stage 7.8: smallFastModel is [legacy]. The field still round-trips
  // on disk so existing records keep their value, but it is not read by
  // setClaudeRouteFromProvider and is not surfaced in the new-provider
  // form.
  let smallFastModel = existing.smallFastModel || null;
  if (workingPatch.smallFastModel !== undefined) {
    const s = workingPatch.smallFastModel == null ? null : String(workingPatch.smallFastModel).trim();
    smallFastModel = s || null;
  }

  // Stage 7.7: huggingface uses apiKey directly; no hfToken mirror.
  const mirrored = pickLitellmProvider(merged);

  const stored = { name: vName, type, ...merged, ...mirrored };
  // Strip read-side projection fields. They are never written to disk.
  delete stored._legacy;
  delete stored._legacyType;
  // inlineCreds is UI-only; never persisted.
  delete stored.inlineCreds;
  // smallFastModel kept on litellm (Stage 7.6). Delete only if it ended up null.
  if (smallFastModel == null) delete stored.smallFastModel;
  providers[vName] = stored;
  return { ...config, providers, _lastUpdateWarnings: [], _migratedFrom: migratedFrom };
}

// Helper for the API layer to read the warnings that applyProviderUpdate attached.
export function takeUpdateWarnings(result) {
  if (!result || !Array.isArray(result._lastUpdateWarnings)) return [];
  const ws = result._lastUpdateWarnings;
  delete result._lastUpdateWarnings;
  return ws;
}

// Stage 7.8: provider use for claude writes ONLY routes.claude.main.
// routes.claude.small is independent state owned by the routes layer
// (POST /routes/claude/small or `originrouter route set claude.small
// --provider <name>`). The legacy smallFastModel field on the provider
// is kept on disk for backward compat but is no longer read here.
//
// Cleanup of routes that point at a removed provider lives in
// handleProviderRemove (localApi.js) and `provider remove` (index.js).
// Returns { next } — `next` is the new config with routes.claude.main
// pointing at { provider: name, model: provider.model }.
export function setClaudeRouteFromProvider(config, name) {
  const provider = (config.providers || {})[name];
  if (!provider) throw new Error(`unknown provider '${name}'`);
  const next = setRoute(config, "claude", "main", { provider: name, model: provider.model });
  return { next };
}

export function listProviders(config) {
  const providers = config.providers || {};
  return Object.keys(providers)
    .sort()
    .map((name) => summarizeProvider(providers[name]));
}

export function showProvider(config, name) {
  const providers = config.providers || {};
  const provider = providers[name];
  if (!provider) throw new Error(`unknown provider '${name}'`);
  return summarizeProvider(provider);
}

function summarizeProvider(provider) {
  const norm = normalizeProviderForRead(provider);
  // Stage 7.7: derive the set of secret keys from the catalog rather than
  // hardcoding a list. Every field with `secret: true` is masked.
  const secrets = secretFieldKeysFor(norm);
  const maskIfSecret = (key, value) => (secrets.has(key) ? maskSecret(value) : (value == null || value === "" ? null : value));
  // Include every catalog field dynamically so newly-added fields surface
  // in summarize output without explicit allowlist maintenance.
  const dynamic = {};
  try {
    const profile = getLitellmProfile(norm.litellmProvider);
    for (const f of profile.fields) {
      if (outFields.has(f.key)) continue; // already in the static set below
      dynamic[f.key] = maskIfSecret(f.key, norm[f.key]);
    }
  } catch {
    // unknown litellmProvider → leave dynamic empty
  }
  const out = {
    name: norm.name,
    type: norm.type,
    litellmProvider: norm.litellmProvider || null,
    baseUrl: norm.baseUrl || "(unset)",
    apiKey: maskSecret(norm.apiKey), // kept for backward-compat with existing tests
    model: norm.model || "(unset)",
    smallFastModel: norm.smallFastModel || null,
    apiVersion: norm.apiVersion || null,
    awsRegion: norm.awsRegion || null,
    awsAccessKeyId: norm.awsAccessKeyId || null,
    awsSecretAccessKey: maskSecret(norm.awsSecretAccessKey),
    awsSessionToken: maskSecret(norm.awsSessionToken),
    awsProfileName: norm.awsProfileName || null,
    vertexProject: norm.vertexProject || null,
    vertexLocation: norm.vertexLocation || null,
    googleApplicationCredentials: maskSecret(norm.googleApplicationCredentials),
    hfToken: maskSecret(norm.hfToken),
    authToken: maskSecret(norm.authToken),
    azureAdToken: maskSecret(norm.azureAdToken),
    awsWebIdentityToken: maskSecret(norm.awsWebIdentityToken),
    awsBedrockRuntimeEndpoint: norm.awsBedrockRuntimeEndpoint || null,
    awsRoleName: norm.awsRoleName || null,
    awsSessionName: norm.awsSessionName || null,
    awsStsEndpoint: norm.awsStsEndpoint || null,
    sagemakerBaseUrl: norm.sagemakerBaseUrl || null,
    vertexCredentials: maskSecret(norm.vertexCredentials),
    organization: norm.organization || null,
    ...dynamic,
  };
  if (norm._legacy) out._legacy = true;
  return out;
}

// Set of field keys that are explicitly handled in the static object above.
// Used by summarizeProvider to avoid double-emitting a field.
const outFields = new Set([
  "baseUrl", "apiKey", "model", "smallFastModel", "apiVersion",
  "awsRegion", "awsAccessKeyId", "awsSecretAccessKey", "awsSessionToken",
  "awsProfileName", "vertexProject", "vertexLocation",
  "googleApplicationCredentials", "hfToken", "authToken", "azureAdToken",
  "awsWebIdentityToken", "awsBedrockRuntimeEndpoint", "awsRoleName",
  "awsSessionName", "awsStsEndpoint", "sagemakerBaseUrl",
  "vertexCredentials", "organization",
]);

// ---------- resolution + env ----------

// Returns { provider, source: "flag" | "current" | "legacy" | "none" }.
// Does NOT filter by provider.type. The caller decides what to do with
// wrong-type providers.
export function resolveProvider({ config, agent, flagName }) {
  if (flagName) {
    const providers = config.providers || {};
    const provider = providers[flagName];
    if (!provider) {
      throw new Error(`--provider '${flagName}' not found in providers. Run 'originrouter provider list'.`);
    }
    return { provider, source: "flag" };
  }

  const cur = getCurrentProvider(config, agent);
  if (cur.provider) return cur;
  if (cur.dangling) {
    throw new Error(
      `currentProvider.${agent} points to deleted provider '${cur.dangling}'. ` +
      `Run 'originrouter provider use <name>' to pick a valid one.`,
    );
  }

  // Legacy fallback ONLY for claude and ONLY when nothing else matched.
  if (agent === "claude" && config.claude) {
    const legacy = config.claude;
    if (legacy.baseUrl || legacy.apiKey || legacy.model) {
      return {
        provider: {
          name: "legacy-claude",
          type: "anthropic",
          baseUrl: legacy.baseUrl,
          apiKey: legacy.apiKey,
          model: legacy.model,
          smallFastModel: legacy.smallFastModel,
        },
        source: "legacy",
      };
    }
  }

  return { provider: null, source: "none" };
}

export function buildProviderEnv(provider) {
  if (!provider) return {};
  if (provider.type === "anthropic") {
    const env = {};
    if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl;
    if (provider.apiKey) env.ANTHROPIC_API_KEY = provider.apiKey;
    if (provider.model) env.ANTHROPIC_MODEL = provider.model;
    if (provider.smallFastModel) env.ANTHROPIC_SMALL_FAST_MODEL = provider.smallFastModel;
    return env;
  }
  // litellm -> no direct env; proxy handles routing.
  return {};
}

// ---------- doctor ----------

export function doctorProvider(provider) {
  const errors = [];
  const warnings = [];

  if (!provider || !provider.name) {
    return { ok: false, errors: ["provider is empty"], warnings };
  }

  // Re-validate against the new shape (legacy gets projected to litellm first).
  const norm = normalizeProviderForRead(provider);
  if (!NAME_RE.test(norm.name)) {
    errors.push(`name '${norm.name}' must match ${NAME_RE}`);
  }
  if (!PROVIDER_TYPES.includes(norm.type)) {
    errors.push(`type '${norm.type}' must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }

  if (norm.type === "anthropic") {
    if (!norm.baseUrl || !/^https?:\/\//.test(norm.baseUrl)) {
      errors.push("baseUrl must start with http:// or https://");
    }
    if (!norm.apiKey) errors.push("apiKey is missing");
    if (!norm.model) errors.push("model is missing");
  } else if (norm.type === "litellm") {
    try {
      const profile = getLitellmProfile(norm.litellmProvider);
      for (const f of profile.fields) {
        if (f.required && !norm[f.key]) errors.push(`missing required field '${f.key}' for litellmProvider='${norm.litellmProvider}'`);
      }
      // Stage 7.7: runtimeRequired warnings. For each field that LiteLLM
      // will need at runtime but which has an env-var fallback, warn when
      // (a) the saved value is blank AND (b) every env-var fallback name
      // is unset in process.env. Multi-env strings like
      // `AWS_REGION_NAME / AWS_REGION / AWS_DEFAULT_REGION` are checked
      // against ALL candidates: warn only when NONE of them is set.
      for (const f of profile.fields) {
        if (!f.runtimeRequired) continue;
        const v = norm[f.key];
        if (v != null && v !== "") continue;
        const envNames = (f.envVar || "").split("/").map((s) => s.trim()).filter(Boolean);
        if (envNames.length === 0) {
          // No documented env fallback. Recommend setting the field directly.
          warnings.push(`field '${f.key}' is missing; set it on this provider`);
          continue;
        }
        const envSatisfied = envNames.some(
          (n) => typeof process !== "undefined" && process.env
            && Object.prototype.hasOwnProperty.call(process.env, n)
            && process.env[n] !== "",
        );
        if (envSatisfied) continue;
        const candidates = envNames.join(", ");
        warnings.push(`field '${f.key}' is missing; set it on this provider or export one of [${candidates}]`);
      }
    } catch {
      errors.push(`unknown litellmProvider '${norm.litellmProvider}'`);
    }
    if (!norm.model) errors.push("model is missing");
  }

  // Soft warnings.
  if (norm.baseUrl && /^http:\/\//.test(norm.baseUrl)) {
    const host = norm.baseUrl.replace(/^https?:\/\//, "").split("/")[0];
    const isLoopback = host.startsWith("127.") || host.startsWith("localhost") || host.startsWith("[::1]");
    if (!isLoopback) warnings.push(`baseUrl uses plaintext http:// against non-loopback host '${host}'`);
  }
  if (norm.type === "anthropic" && norm.apiKey && !norm.apiKey.startsWith(ANTHROPIC_KEY_PREFIX_HINT)) {
    warnings.push(`apiKey does not start with '${ANTHROPIC_KEY_PREFIX_HINT}' — verify this is an Anthropic-compatible key`);
  }
  // Stage 7.6: smallFastModel on litellm is allowed (it seeds
  // routes.claude.small on provider use). No doctor warning.
  if (norm.type === "litellm" && norm.smallFastModel) {
    // Informational only — not a warning.
  }
  // Legacy hint.
  if (norm._legacy) {
    warnings.push("This record is on the legacy openai-compatible shape; it will be auto-migrated to type=litellm on next edit.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Re-export catalog ids for callers (CLI help, validation).
export { LITELLM_PROVIDER_IDS };

// Stage 7.7: re-export catalog-derived helpers so index.js / localApi.js
// can import them from a single module.
export { secretFieldKeysFor, catalogFieldKeysFor } from "../proxy/litellmCatalog.js";