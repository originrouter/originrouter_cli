import { getLitellmProfile } from "./litellmCatalog.js";

const DEFAULT_BASE_URLS = Object.freeze({
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  ollama: "http://127.0.0.1:11434/v1",
});

function resolveEnvReference(value, env) {
  if (typeof value !== "string") return value;
  const match = /^os\.environ\/([A-Z_][A-Z0-9_]*)$/.exec(value);
  return match ? env?.[match[1]] || "" : value;
}

function firstEnvironmentValue(hint, env) {
  return String(hint || "")
    .split("/")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => env?.[name])
    .find((value) => typeof value === "string" && value.trim()) || "";
}

function providerField(provider, profile, key, env) {
  const direct = resolveEnvReference(provider?.[key], env);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const field = profile.fields.find((item) => item.key === key);
  return firstEnvironmentValue(field?.envVar, env).trim();
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function candidateModelUrls(baseUrl, providerId) {
  const base = trimSlash(baseUrl);
  if (!base) return [];
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error("Base URL must be a complete http:// or https:// URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Base URL must be a complete http:// or https:// URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL must not contain embedded credentials");
  }
  if (providerId === "ollama" && !/\/v1$/i.test(base)) {
    return [`${base}/api/tags`, `${base}/v1/models`];
  }
  if (/\/v1$/i.test(base) || /\/openai\/v1$/i.test(base)) {
    return [`${base}/models`];
  }
  return [`${base}/models`, `${base}/v1/models`];
}

function modelHeaders(provider, profile, env) {
  const apiKey = providerField(provider, profile, "apiKey", env);
  const authToken = providerField(provider, profile, "authToken", env);
  const headers = { Accept: "application/json" };
  if (profile.id === "anthropic") {
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    else if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (authToken || apiKey) {
    headers.Authorization = `Bearer ${authToken || apiKey}`;
  }
  return headers;
}

function extractModelIds(payload) {
  const candidates = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const seen = new Set();
  const models = [];
  for (const item of candidates) {
    const raw = typeof item === "string"
      ? item
      : item?.id ?? item?.model ?? item?.name;
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: typeof item?.display_name === "string"
        ? item.display_name
        : typeof item?.name === "string" && item.name !== id
          ? item.name
          : id,
      ownedBy: typeof item?.owned_by === "string" ? item.owned_by : null,
    });
    if (models.length >= 500) break;
  }
  return models;
}

export async function discoverProviderModels(provider, {
  fetchFn = globalThis.fetch,
  env = process.env,
  timeoutMs = 12_000,
} = {}) {
  if (!provider || typeof provider !== "object") {
    throw new Error("provider draft is required");
  }
  const providerId = String(provider.litellmProvider || "").trim();
  if (!providerId) throw new Error("litellmProvider is required");
  const profile = getLitellmProfile(providerId);
  const configuredBaseUrl = providerField(provider, profile, "baseUrl", env);
  const baseUrl = configuredBaseUrl || DEFAULT_BASE_URLS[providerId] || "";
  const urls = candidateModelUrls(baseUrl, providerId);
  if (urls.length === 0) {
    throw new Error(
      `model discovery is not available for '${providerId}' without a Base URL; add models manually`,
    );
  }
  const headers = modelHeaders(provider, profile, env);
  let lastStatus = null;
  for (const url of urls) {
    let response;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (url !== urls.at(-1)) continue;
      const reason = error?.name === "TimeoutError" ? "timed out" : "could not connect";
      throw new Error(`model discovery ${reason}`);
    }
    lastStatus = response.status;
    if (!response.ok) {
      if ((response.status === 404 || response.status === 405) && url !== urls.at(-1)) {
        continue;
      }
      throw new Error(`model discovery failed with HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("model discovery returned invalid JSON");
    }
    const models = extractModelIds(payload);
    if (models.length === 0) {
      throw new Error("the endpoint returned no models; add a model manually");
    }
    return {
      models,
      source: url,
      fetchedAt: new Date().toISOString(),
    };
  }
  throw new Error(`model discovery failed${lastStatus ? ` with HTTP ${lastStatus}` : ""}`);
}
