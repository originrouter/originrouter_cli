// Stage 9.0: pure route resolver. No I/O, no spawn. Decides which
// HTTP transport an agent invocation should use given its
// provider type, runtime, and resolved model id. Lives in
// src/config/ next to routes.js.
//
// Stage 9.0 ships the resolver + tests; the runtime does not yet
// call it. 9.1+ will wire it into buildAgentProviderEnv
// (claudeConfig.js) and the Codex adapter.
//
// The resolver is the single source of truth for:
//   - the /coding prefix on originrouter
//   - the bare /v1 prefix on proxy
//   - the proxy alias table (originrouter-claude-model,
//     originrouter-claude-fast-model, originrouter-codex-model)
//   - the default originrouter base URL
//
// It does NOT resolve auth, fetch a managed key, or perform
// retries. Those are 9.1+ concerns.

import { PROVIDER_TYPE } from "./providers.js";

// Stage 9.0: endpoints ALWAYS include the routing prefix.
// originrouter uses "/coding/..." because the official API is
// mounted under the /coding blueprint. Proxy uses bare "/v1/..."
// because the local LiteLLM proxy serves the standard
// Anthropic / OpenAI routes directly. Mixing the two would
// produce a request the runtime cannot dispatch unambiguously,
// so the prefix is part of the contract.
const CODING_PREFIX = "/coding";

const ORIGINROUTER_ENDPOINTS = Object.freeze({
  "claude":           `${CODING_PREFIX}/v1/messages`,
  "claude-sdk":       `${CODING_PREFIX}/v1/messages`,
  "codex":            `${CODING_PREFIX}/v1/responses`,
  "codex-app-server": `${CODING_PREFIX}/v1/responses`,
});

const PROXY_ENDPOINTS = Object.freeze({
  "claude":           "/v1/messages",
  "claude-sdk":       "/v1/messages",
  "claude-fast":      "/v1/messages",
  "codex":            "/v1/responses",
  "codex-app-server": "/v1/responses",
});

const ALIASES = Object.freeze({
  "claude":      "originrouter-claude-model",
  "claude-fast": "originrouter-claude-fast-model",
  "codex":       "originrouter-codex-model",
});

// Stage 9.0: the official originrouter server. Used when a
// provider record's `baseUrl` is null/undefined. Exported so the
// resolver and the env builder share one source of truth.
export const DEFAULT_ORIGINROUTER_BASE_URL = "https://server.originrouter.com";

/**
 * Pure: given a provider type, runtime, and (optional) explicit
 * model, return the transport / endpoint / model triple.
 *
 * @param {object} opts
 * @param {string} opts.providerType - "originrouter" | "proxy" | "remote"
 * @param {string} [opts.runtime]    - "claude" | "claude-sdk" | "codex"
 *                                      | "codex-app-server" | "claude-fast"
 * @param {string|null} [opts.model]  - explicit model id (e.g. "claude-sonnet-4-6");
 *                                      when omitted, an alias is used for proxy
 *                                      and `null` is returned for originrouter.
 * @param {string} [opts.deviceId]   - required when providerType="remote"
 * @param {"proxy"|"agent"} [opts.target] - remote target; default "proxy"
 * @returns {{
 *   transport: "originrouter-coding" | "proxy" | "remote",
 *   endpoint: string|null,
 *   model: string|null,
 *   deviceId?: string,
 *   target?: "proxy"|"agent",
 * }}
 */
export function resolveRoute({ providerType, runtime, model, target, deviceId }) {
  if (providerType === PROVIDER_TYPE.ORIGINROUTER) {
    const endpoint = runtime && ORIGINROUTER_ENDPOINTS[runtime]
      ? ORIGINROUTER_ENDPOINTS[runtime]
      : `${CODING_PREFIX}/v1/messages`; // default for Claude
    return {
      transport: "originrouter-coding",
      endpoint,
      model: model || null,
    };
  }
  if (providerType === PROVIDER_TYPE.PROXY) {
    const isCodex = runtime && runtime.startsWith("codex");
    const isFastClaude = runtime === "claude-fast";
    return {
      transport: "proxy",
      endpoint: isCodex
        ? PROXY_ENDPOINTS["codex"]
        : PROXY_ENDPOINTS[isFastClaude ? "claude-fast" : "claude"],
      model: model
        || (isCodex
          ? ALIASES.codex
          : isFastClaude
            ? ALIASES["claude-fast"]
            : ALIASES.claude),
    };
  }
  if (providerType === PROVIDER_TYPE.REMOTE) {
    if (!deviceId) {
      throw new Error("resolveRoute: type=remote requires deviceId");
    }
    return {
      transport: "remote",
      endpoint: null, // remote resolves on the device, not locally
      model: model || null,
      deviceId,
      target: target === "agent" ? "agent" : "proxy",
    };
  }
  throw new Error(`resolveRoute: unknown providerType '${providerType}'`);
}
