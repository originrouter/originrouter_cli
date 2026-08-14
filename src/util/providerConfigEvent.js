// Builds the `providerConfig` field that localAgentSession.js and
// claudeSdkSession.js send on session.started. The shape is consumed by the
// compatible client header.
//
// The legacy `summarizeClaudeConfig` shape only knew about config.claude. The
// new shape is the explicit, fully-resolved view: it names the source so the
// remote UI can render a clear "Provider: minimax (current)" or
// "Provider: legacy-claude (legacy fallback)" line and so legacy users see
// their config represented honestly.

import { maskSecret } from "../config/claudeConfig.js";

export function buildProviderConfigEvent(provider, source) {
  if (!provider) {
    return {
      name: "(none)",
      type: null,
      baseUrl: null,
      apiKey: "not set",
      model: null,
      smallFastModel: null,
      source: source || "none",
    };
  }
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl ?? "(unset)",
    apiKey: maskSecret(provider.apiKey),
    model: provider.model ?? "(unset)",
    smallFastModel: provider.smallFastModel ?? null,
    source: source || "none",
  };
}
