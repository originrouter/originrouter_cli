import { enabledProviderModelEntries, remoteShareModelEntries } from "../config/providerModels.js";
import { ROUTE_AGENTS, resolveAgentRoutes, routeProviderForRead } from "../config/routes.js";

const OPENAI_PROVIDER_IDS = new Set(["openai", "azure"]);

export function compatibilityProviderFamily(provider) {
  const record = routeProviderForRead(provider) || provider || {};
  const litellmProvider = String(record.litellmProvider || "unknown").trim().toLowerCase();
  return OPENAI_PROVIDER_IDS.has(litellmProvider) ? "openai" : litellmProvider || "unknown";
}

function routeEntry(providerName, provider, model) {
  const projected = routeProviderForRead(provider) || provider || {};
  return {
    provider: providerName || projected.name || "unknown",
    provider_family: compatibilityProviderFamily(projected),
    litellm_provider: projected.litellmProvider || null,
    upstream_model: model || null,
  };
}

export function buildCompatibilityRouteMap({
  config,
  mode = "route",
  providerName = null,
  providerNames = [],
  litellmVersion = null,
} = {}) {
  const providers = config?.providers || {};
  const aliases = {};

  const addProviderModels = (name) => {
    const provider = routeProviderForRead(providers[name]) || providers[name];
    if (!provider) return;
    for (const model of enabledProviderModelEntries(provider)) {
      aliases[`${name}/${model.id}`] = routeEntry(name, provider, model.id);
    }
  };

  if (mode === "provider" && providerName) addProviderModels(providerName);
  if (mode === "share") {
    for (const name of providerNames) {
      const provider = routeProviderForRead(providers[name]) || providers[name];
      if (!provider) continue;
      for (const entry of remoteShareModelEntries(provider, { legacyRemoteEnabled: true })) {
        aliases[entry.provider] = routeEntry(name, provider, entry.model);
      }
    }
  }
  if (mode === "route") {
    for (const name of Object.keys(providers)) addProviderModels(name);
    for (const agent of ROUTE_AGENTS) {
      const resolved = resolveAgentRoutes(config, agent);
      for (const entry of Object.values(resolved)) {
        if (!entry?.providerRecord) continue;
        aliases[entry.alias] = {
          ...routeEntry(entry.provider, entry.providerRecord, entry.model),
          runtime: agent,
          slot: entry.slot,
        };
      }
    }
  }
  return {
    schema: "originrouter-compatibility-route-map-v1",
    generated_at: new Date().toISOString(),
    litellm_version: litellmVersion,
    aliases,
  };
}

export function compatibilityContextForRequest(routeMap, { method, path, protocol, body } = {}) {
  const model = typeof body?.model === "string" ? body.model : null;
  const route = model ? routeMap?.aliases?.[model] : null;
  return {
    method: String(method || "GET").toUpperCase(),
    path: String(path || "/"),
    protocol: protocol || "http.unknown",
    runtime: route?.runtime || null,
    provider: route?.provider || null,
    providerFamily: route?.provider_family || "unknown",
    litellmProvider: route?.litellm_provider || null,
    model,
    upstreamModel: route?.upstream_model || null,
    litellmVersion: routeMap?.litellm_version || null,
    stream: body?.stream === true,
  };
}
