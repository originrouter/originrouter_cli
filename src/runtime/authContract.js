// Stage 9.0: pure type definitions + lifetime helpers for the
// login credential architecture. No I/O, no spawn, no process access.
//
// The shapes are shared conceptually with the backend (Python
// originrouter_auth_contract.py) and the Flutter App (Dart
// provider_types / provider_config). Each side implements its
// own; the field names and lifetime constants match.

export const LOGIN_CODE_TTL_MS_MIN = 5 * 60 * 1000;        // 5 min
export const LOGIN_CODE_TTL_MS_MAX = 10 * 60 * 1000;       // 10 min
export const DEVICE_GRANT_IDLE_MS  = 90 * 24 * 60 * 60 * 1000;  // 90 d
export const DEVICE_GRANT_ABS_MS   = 365 * 24 * 60 * 60 * 1000; // 365 d
export const MANAGED_KEY_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;  // 30 d
export const MANAGED_KEY_MAX_MS     = 90 * 24 * 60 * 60 * 1000;  // 90 d

export const KEY_SCOPE = Object.freeze({ CODING: "coding" });
export const KEY_SOURCE = Object.freeze({
  ORIGINROUTER_CLI: "originrouter_cli",
  ORIGINROUTER_APP: "originrouter_app",
});
// Stage 9.0: kind is the storage / shape discriminator. The
// canonical value is "managed". KEYS in 9.0 are always managed;
// raw keys are not part of the contract.
export const KEY_KIND = Object.freeze({ MANAGED: "managed" });

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// Stage 9.0: shape check for a managed key. The IO layer
// (codingAuth.js) and any consumer that needs to validate a
// stored / incoming key uses this single source of truth.
// Stage 9.1A: now requires deviceGrant (the raw grant used as
// Authorization: Bearer for rotate / revoke) and deviceId, and
// accepts optional deviceGrantIdleExpiresAt /
// deviceGrantAbsoluteExpiresAt so the CLI can warn before
// expiry without a backend call.
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
  // Optional fields: when present, must be numbers.
  if (p.deviceGrantIdleExpiresAt != null && typeof p.deviceGrantIdleExpiresAt !== "number") {
    return false;
  }
  if (p.deviceGrantAbsoluteExpiresAt != null && typeof p.deviceGrantAbsoluteExpiresAt !== "number") {
    return false;
  }
  return true;
}

// Stage 9.0: shape check for a device grant. Used by tests
// and by future device-pairing flows. Not currently produced
// by the CLI; it appears once the backend exchange endpoint is
// implemented (Stage 9.1+).
export function isDeviceGrantShape(p) {
  return Boolean(
    p
    && isNonEmptyString(p.deviceId)
    && isNonEmptyString(p.userId)
    && typeof p.issuedAt === "number"
    && typeof p.idleExpiresAt === "number"
    && typeof p.absoluteExpiresAt === "number"
    && (p.revokedAt == null || typeof p.revokedAt === "number")
    && (p.lastUsedAt == null || typeof p.lastUsedAt === "number")
  );
}
