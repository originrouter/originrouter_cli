// Stage 9.9: pure type definitions + lifetime helpers for the
// login credential architecture. No I/O, no spawn, no process access.
//
// Stage 9.9: the on-disk shape is now a surety relay shape. The CLI
// stores ONE device_grant (long-lived) plus a cached access_token
// (short-lived, ~1h, format rt_<base64url>). The access_token is
// silently re-signed by calling surety /api/relay/token when it
// approaches expiry. The legacy `isManagedKeyShape` is kept for
// backward compat with pre-9.9 on-disk files; new writes use the
// relay shape.

export const LOGIN_CODE_TTL_MS_MIN = 5 * 60 * 1000;        // 5 min
export const LOGIN_CODE_TTL_MS_MAX = 10 * 60 * 1000;       // 10 min
export const DEVICE_GRANT_IDLE_MS  = 90 * 24 * 60 * 60 * 1000;  // 90 d
export const DEVICE_GRANT_ABS_MS   = 365 * 24 * 60 * 60 * 1000; // 365 d

// Stage 9.9: relay access token lifetime (1h, surety default).
export const RELAY_TOKEN_TTL_MS = 60 * 60 * 1000;                   // 1 hour
// Pre-9.9 backward compat: legacy managed-key lifetime.
export const MANAGED_KEY_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;
export const MANAGED_KEY_MAX_MS     = 90 * 24 * 60 * 60 * 1000;

// Stage 9.9: relay token prefix (surety 签发格式)
export const RELAY_TOKEN_PREFIX = "rt_";
export const RELAY_TOKEN_REGEX = /^rt_[A-Za-z0-9_-]+$/;

export const KEY_SCOPE = Object.freeze({ CODING: "coding" });
export const KEY_SOURCE = Object.freeze({
  ORIGINROUTER_CLI: "originrouter_cli",
  ORIGINROUTER_APP: "originrouter_app",
});
// Stage 9.9: kind is the storage / shape discriminator.
//   MANAGED: pre-9.8 managed key shape (sk-or-... long-lived) — kept
//            for backward compat during the transition window.
//   RELAY:   Stage 9.9+ surety relay shape (device_grant + rt_ token).
export const KEY_KIND = Object.freeze({
  MANAGED: "managed",
  RELAY: "relay",
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// Stage 9.9: shape check for a surety relay credential. The CLI stores
// this as the durable credential; the accessToken is the short-lived
// Bearer that the env builder uses for LLM calls.
//
// Required fields:
//   kind                       "relay" discriminator
//   deviceGrant                device_grant 明文（长期凭证）
//   deviceId                   device-<fingerprint>
//   tokenEndpoint              surety /api/relay/token URL
//   accessToken                rt_<base64url>  (1h)
//   accessTokenExpiresAt       epoch ms
//   scopes                     ["coding", ...]
//   source                     "originrouter_cli" | "originrouter_app"
export function isRelayShape(p) {
  if (!p) return false;
  if (p.kind !== KEY_KIND.RELAY) return false;
  if (!isNonEmptyString(p.deviceGrant)) return false;
  if (!isNonEmptyString(p.deviceId)) return false;
  if (!isNonEmptyString(p.tokenEndpoint)) return false;
  if (!isNonEmptyString(p.accessToken)) return false;
  if (!RELAY_TOKEN_REGEX.test(p.accessToken)) return false;
  if (typeof p.accessTokenExpiresAt !== "number") return false;
  if (!Array.isArray(p.scopes)) return false;
  if (!p.scopes.includes(KEY_SCOPE.CODING)) return false;
  if (p.source !== KEY_SOURCE.ORIGINROUTER_CLI && p.source !== KEY_SOURCE.ORIGINROUTER_APP) {
    return false;
  }
  return true;
}

// Stage 9.0/9.1A: shape check for a managed key. KEPT for backward
// compat with pre-9.9 on-disk files (transition window).
export function isManagedKeyShape(p) {
  if (!p) return false;
  if (p.kind !== KEY_KIND.MANAGED) return false;
  if (!isNonEmptyString(p.keyId)) return false;
  if (!isNonEmptyString(p.key)) return false;
  if (!isNonEmptyString(p.deviceGrantId)) return false;
  if (!isNonEmptyString(p.deviceGrant)) return false;
  if (!isNonEmptyString(p.deviceId)) return false;
  if (typeof p.expiresAt !== "number") return false;
  if (!Array.isArray(p.scopes)) return false;
  if (!p.scopes.includes(KEY_SCOPE.CODING)) return false;
  if (p.source !== KEY_SOURCE.ORIGINROUTER_CLI && p.source !== KEY_SOURCE.ORIGINROUTER_APP) {
    return false;
  }
  return true;
}

// Stage 9.9: dispatch on either shape. Used by writeCodingAuth to
// accept both pre-9.9 and 9.9+ files during the transition window.
export function isAnyManagedCredentialShape(p) {
  return isRelayShape(p) || isManagedKeyShape(p);
}
