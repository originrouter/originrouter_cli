const MAX_PROVIDER_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 512;
const PRICE_FIELDS = Object.freeze([
  "input",
  "output",
  "reasoning",
  "cacheReadInput",
  "cacheWriteInput",
  "cacheWrite5mInput",
  "cacheWrite1hInput",
]);

function normalizeCurrency(value, { strict = true } = {}) {
  const currency = String(value || "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(currency)) return currency;
  if (strict) throw new Error("model pricing currency must be a 3-letter ISO code");
  return null;
}

function normalizePrice(value, field, { strict = true } = {}) {
  if (value == null || value === "") return null;
  if (typeof value === "boolean") {
    if (strict) throw new Error(`model pricing ${field} must be a non-negative number`);
    return null;
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(text)) {
    if (strict) throw new Error(`model pricing ${field} must be a non-negative decimal`);
    return null;
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 1_000_000_000) {
    if (strict) throw new Error(`model pricing ${field} is out of range`);
    return null;
  }
  return text;
}

export function normalizeModelPricing(value, { strict = true } = {}) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new Error("model pricing must be an object");
    return null;
  }
  if (value.enabled === false) return null;
  const currency = normalizeCurrency(value.currency || "USD", { strict });
  const pricing = {
    enabled: true,
    currency: currency || "USD",
    unit: "per_million_tokens",
  };
  for (const field of PRICE_FIELDS) {
    const normalized = normalizePrice(value[field], field, { strict });
    if (normalized != null) pricing[field] = normalized;
  }
  if (pricing.input == null || pricing.output == null) {
    if (strict) throw new Error("model pricing requires input and output prices");
    return null;
  }
  return pricing;
}

function normalizeModelId(value, { strict = true } = {}) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id) return null;
  if (id.length > MAX_MODEL_ID_LENGTH) {
    if (!strict) return null;
    throw new Error(`model id exceeds ${MAX_MODEL_ID_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(id)) {
    if (!strict) return null;
    throw new Error("model id contains a control character");
  }
  return id;
}

export function normalizeProviderModelEntries(value, {
  strict = true,
  legacyModel = null,
  legacyRemoteEnabled = false,
} = {}) {
  if (value == null) value = [];
  if (!Array.isArray(value)) {
    if (strict) throw new Error("provider models must be an array");
    value = [];
  }
  const entries = [];
  const seen = new Set();
  const add = (raw, legacy = false) => {
    const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    const id = normalizeModelId(object ? object.id : raw, { strict });
    if (!id) {
      if (strict && raw != null && raw !== "") {
        throw new Error("provider models must contain model ids or model objects");
      }
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    const enabled = object ? object.enabled !== false : true;
    const remoteEnabled = enabled && (object
      ? object.remoteEnabled === true
      : legacyRemoteEnabled && legacy);
    const pricing = object
      ? normalizeModelPricing(object.pricing, { strict })
      : null;
    entries.push({
      id,
      enabled,
      remoteEnabled,
      ...(pricing ? { pricing } : {}),
    });
    if (entries.length > MAX_PROVIDER_MODELS) {
      throw new Error(`provider models cannot exceed ${MAX_PROVIDER_MODELS} entries`);
    }
  };

  const legacyId = normalizeModelId(legacyModel, { strict });
  if (legacyId) add(legacyId, true);
  for (const item of value) add(item, typeof item === "string");
  return entries;
}

// Compatibility helper retained for callers that only need ids.
export function normalizeModelIds(value, { strict = true } = {}) {
  return normalizeProviderModelEntries(value, { strict }).map((entry) => entry.id);
}

// New provider records persist only model objects. The legacy top-level
// `model` field and string-array `models` shape are read and migrated here,
// but are never emitted by this normalizer.
export function normalizeProviderModels(provider, {
  strict = true,
  legacyRemoteEnabled = false,
} = {}) {
  if (!provider || typeof provider !== "object") return provider;
  const isLiteLlmProvider = ["proxy", "remote", "litellm", "anthropic", "openai-compatible"]
    .includes(provider.type)
    || (provider.type == null && (provider.model != null || provider.models != null));
  if (!isLiteLlmProvider) return { ...provider };
  const models = normalizeProviderModelEntries(provider.models, {
    strict,
    legacyModel: provider.model,
    legacyRemoteEnabled,
  });
  const normalized = { ...provider, models };
  delete normalized.model;
  return normalized;
}

export function providerModelEntries(provider, options = {}) {
  return normalizeProviderModels(provider, { strict: false, ...options })?.models || [];
}

export function providerModelIds(provider, { enabledOnly = false, remoteOnly = false } = {}) {
  return providerModelEntries(provider)
    .filter((entry) => (!enabledOnly || entry.enabled) && (!remoteOnly || entry.remoteEnabled))
    .map((entry) => entry.id);
}

export function enabledProviderModelEntries(provider) {
  return providerModelEntries(provider).filter((entry) => entry.enabled);
}

export function remoteShareModelEntries(provider, { legacyRemoteEnabled = false } = {}) {
  return providerModelEntries(provider, { legacyRemoteEnabled })
    .filter((entry) => entry.enabled && entry.remoteEnabled)
    .map((entry) => ({
      provider: `${provider.name}/${entry.id}`,
      sourceProvider: provider.name,
      model: entry.id,
      ...(entry.pricing ? { pricing: entry.pricing } : {}),
    }));
}

export function hasRemoteEnabledModels(provider, options = {}) {
  return remoteShareModelEntries(provider, options).length > 0;
}
