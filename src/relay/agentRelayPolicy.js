import { DEFAULT_RELAY_URL } from "../constants.js";
import {
  buildRelayClientOptions,
  isRelayAuthOn,
} from "./relayAuthBootstrap.js";

const RELAY_MODES = new Set(["auto", "cloud", "local", "custom"]);

function normalizedUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

export function normalizeAgentRelayMode(value, relayUrl = DEFAULT_RELAY_URL) {
  const raw = String(value || process.env.ORIGINROUTER_RELAY_MODE || "auto")
    .trim()
    .toLowerCase();
  if (raw === "off" || raw === "disabled") return "local";
  if (!RELAY_MODES.has(raw)) {
    throw new Error(
      `Unknown Relay mode '${raw}'. Expected auto|cloud|local|custom.`,
    );
  }
  if (
    raw === "auto" &&
    ["off", "local", "none"].includes(
      String(relayUrl || "")
        .trim()
        .toLowerCase(),
    )
  ) {
    return "local";
  }
  return raw;
}

export function isOfficialRelayUrl(relayUrl) {
  return normalizedUrl(relayUrl) === normalizedUrl(DEFAULT_RELAY_URL);
}

export async function buildAgentRelayPlan({
  stateDir,
  relayUrl = DEFAULT_RELAY_URL,
  fallbackDeviceId,
  mode,
  fetchFn = globalThis.fetch,
  ensureFreshAccessTokenFn,
} = {}) {
  const resolvedMode = normalizeAgentRelayMode(mode, relayUrl);
  if (resolvedMode === "local") {
    return {
      enabled: false,
      mode: resolvedMode,
      reason: "local_only",
      relayUrl,
      deviceId: fallbackDeviceId,
      authState: "disabled",
    };
  }

  const forceAuth =
    resolvedMode === "cloud" ||
    isOfficialRelayUrl(relayUrl) ||
    (resolvedMode === "custom" && isRelayAuthOn());
  try {
    const options = await buildRelayClientOptions({
      stateDir,
      relayUrl,
      fallbackDeviceId,
      fetchFn,
      ensureFreshAccessTokenFn,
      forceAuth,
    });
    return {
      enabled: true,
      mode: resolvedMode,
      reason: "",
      ...options,
    };
  } catch (error) {
    return {
      enabled: false,
      mode: resolvedMode,
      reason: error?.code || "relay_auth_unavailable",
      relayUrl,
      deviceId: fallbackDeviceId,
      authState: "unavailable",
    };
  }
}

export function relayModeDescription(plan) {
  if (plan?.enabled) {
    return plan.authState === "on" ? "cloud-authenticated" : "custom-unsecured";
  }
  return plan?.reason === "local_only"
    ? "local-only"
    : "local-only (cloud unavailable)";
}
