// OriginRouter CLI OAuth credential contract.

export const KEY_SOURCE = Object.freeze({
  ORIGINROUTER_CLI: "originrouter_cli",
  ORIGINROUTER_APP: "originrouter_app",
});

export const KEY_KIND = Object.freeze({ OAUTH: "oauth" });

export const OAUTH_RESOURCES = Object.freeze({
  CONTROL: "originrouter.control",
  AI: "originrouter.ai",
  CODING: "originrouter.coding",
  RELAY: "originrouter.relay",
});

export const ACCESS_TOKEN_PREFIX = "or_at_";
export const REFRESH_TOKEN_PREFIX = "or_rt_";

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function validAccess(record) {
  return record &&
    nonEmpty(record.token) &&
    record.token.startsWith(ACCESS_TOKEN_PREFIX) &&
    typeof record.expiresAt === "number" &&
    Array.isArray(record.scopes);
}

export function isOAuthCredentialShape(payload) {
  if (!payload || payload.kind !== KEY_KIND.OAUTH) return false;
  if (payload.clientId !== "originrouter_cli") return false;
  if (payload.source !== KEY_SOURCE.ORIGINROUTER_CLI) return false;
  if (!nonEmpty(payload.deviceId)) return false;
  if (!nonEmpty(payload.sessionId) || !payload.sessionId.startsWith("or_ses_")) return false;
  if (!nonEmpty(payload.refreshToken) || !payload.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return false;
  if (typeof payload.refreshExpiresAt !== "number") return false;
  if (!nonEmpty(payload.tokenEndpoint) || !nonEmpty(payload.revocationEndpoint)) return false;
  const tokens = payload.accessTokens;
  return tokens &&
    validAccess(tokens.control) &&
    validAccess(tokens.ai) &&
    validAccess(tokens.coding) &&
    validAccess(tokens.relay);
}

export function accessTokenFor(payload, resource) {
  const key = Object.entries(OAUTH_RESOURCES).find(([, value]) => value === resource)?.[0]?.toLowerCase();
  return key ? payload?.accessTokens?.[key] ?? null : null;
}
