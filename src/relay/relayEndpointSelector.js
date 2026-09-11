import {
  DEFAULT_RELAY_URL,
  OFFICIAL_RELAY_URLS,
} from "../constants.js";

function normalizedUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/**
 * Return the configured Relay unchanged, or choose the quickest healthy
 * official control-plane endpoint. Explicit CLI/environment/config values
 * always win; automatic probing is only for the product default.
 */
export async function resolveRelayEndpoint({
  configuredRelayUrl = "",
  candidates = OFFICIAL_RELAY_URLS,
  fetchFn = globalThis.fetch,
  timeoutMs = 2_000,
  now = () => Date.now(),
} = {}) {
  const explicit = normalizedUrl(configuredRelayUrl);
  if (explicit) {
    return { relayUrl: explicit, source: "configured" };
  }

  const scores = await Promise.all(
    candidates.map((candidate) => probeRelayEndpoint({
      relayUrl: candidate,
      fetchFn,
      timeoutMs,
      now,
    })),
  );
  const viable = scores.filter((item) => item.latencyMs != null);
  if (viable.length === 0) {
    return { relayUrl: DEFAULT_RELAY_URL, source: "default" };
  }
  viable.sort((left, right) => left.latencyMs - right.latencyMs);
  return { relayUrl: viable[0].relayUrl, source: "latency" };
}

async function probeRelayEndpoint({ relayUrl, fetchFn, timeoutMs, now }) {
  const normalized = normalizedUrl(relayUrl);
  if (!normalized) return { relayUrl: normalized, latencyMs: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const startedAt = now();
  try {
    const response = await fetchFn(`${normalized}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    // Match the Flutter selector: an endpoint that answers at all (except a
    // server error) is viable. /health itself is intentionally unauthenticated.
    if (!response || response.status < 200 || response.status >= 500) {
      return { relayUrl: normalized, latencyMs: null };
    }
    return { relayUrl: normalized, latencyMs: Math.max(0, now() - startedAt) };
  } catch {
    return { relayUrl: normalized, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}
