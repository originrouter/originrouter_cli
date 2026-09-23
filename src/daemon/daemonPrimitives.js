import { getAllRoutes } from "../config/routes.js";
import { normalizeProviderForRead } from "../config/providers.js";
import { buildAgentRelayPlan } from "../relay/agentRelayPolicy.js";

export function httpHost(address) {
  return String(address).includes(":") && !String(address).startsWith("[")
    ? `[${address}]`
    : address;
}

export function parsePort(value, label) {
  if (value == null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${label} must be an integer in [0, 65535] (got '${value}')`);
  }
  return parsed;
}

export function buildProxyBaseUrl(status) {
  if (!status || status.state !== "running" || !status.port) return "";
  return `http://${httpHost(status.host || "127.0.0.1")}:${status.port}`;
}

export function localControlProviderSnapshot(config) {
  return Object.entries(config?.providers || {}).map(([key, provider]) => {
    const normalized = normalizeProviderForRead(provider, {
      legacyRemoteEnabled: (config.remoteShare?.providers || []).includes(key),
    }) || {};
    return {
      name: normalized.name || key,
      type: normalized.type || "proxy",
      litellmProvider: normalized.litellmProvider || "",
      model: normalized.type === "proxy" ? "" : (normalized.model || ""),
      models: normalized.models || [],
      target: normalized.target || "",
      deviceId: normalized.deviceId || "",
    };
  });
}

export function localControlRouteSnapshot(config) {
  const routes = getAllRoutes(config);
  const result = [];
  for (const [agent, slots] of Object.entries(routes)) {
    for (const [slot, route] of Object.entries(slots || {})) {
      if (!route?.provider) continue;
      result.push({ agent, slot, provider: route.provider, model: route.model || "" });
    }
  }
  return result;
}

export async function tryBuildRelayClientOptions({ stateDir, relayUrl, fallbackDeviceId, mode }) {
  try {
    const plan = await buildAgentRelayPlan({ stateDir, relayUrl, fallbackDeviceId, mode });
    if (!plan.enabled) return { ok: false, code: plan.reason, plan };
    return { ok: true, options: plan, plan };
  } catch (err) {
    return { ok: false, code: err?.code || "unknown" };
  }
}
