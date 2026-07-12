// Stage 9.3 — Surety issue-endpoint client.
//
// Used by:
//   * `RemoteCodingProxyManager.start()` (caller side)
//   * the worker daemon (`daemon.js`) — same call, same shape
//
// Exchanges a long-lived `deviceGrant` for a short-lived
// `relayAccessToken`. The token is then attached as
// `Authorization: Bearer <relay-access-token>` to the unified relay
// WebSocket and fallback message calls.
//
// Wire protocol: see surety/surety/surety/v2/relay.py
//   - body.v = "v1"
//   - body.device-id (kebab-case)
//   - body.device-grant (kebab-case)
//   - response { code, msg, data } with `data.relay-access-token`,
//     `data.expires-at`, `data.token-id`, `data.scopes`.
//
// This module NEVER logs the raw `device-grant` or
// `relay-access-token`. If a debug log is unavoidable, the value
// is masked via `maskSecret()` from `src/config/claudeConfig.js`.

import { maskSecret } from "../config/claudeConfig.js";

const DEFAULT_TIMEOUT_MS = 5000;

export class SuretyTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SuretyTokenError";
    this.code = code;
  }
}

const SURETY_CODE_TO_ERROR = {
  "-1": "invalid_grant",
  "-2": "revoked_grant",
  "-3": "expired_grant",
  "-9": "surety_internal",
  "-10": "admin_unauthorized",
  "-11": "invalid_params",
  "-12": "wrong_content_type",
};

export async function acquireRelayAccessToken({
  suretyUrl,
  deviceId,
  deviceGrant,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!suretyUrl) {
    return { ok: false, error: "surety_unavailable", message: "suretyUrl is required" };
  }
  if (typeof deviceId !== "string" || typeof deviceGrant !== "string") {
    return { ok: false, error: "invalid_params", message: "deviceId and deviceGrant must be strings" };
  }
  const url = `${String(suretyUrl).replace(/\/$/, "")}/api/relay/token`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        v: "v1",
        "device-id": deviceId,
        "device-grant": deviceGrant,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    if (err && (err.name === "AbortError" || err.code === "ABORT_ERR")) {
      return { ok: false, error: "surety_timeout", message: "surety verify timeout" };
    }
    return {
      ok: false,
      error: "surety_unavailable",
      message: `surety_unavailable: ${err?.message || String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: "unexpected_response",
      message: `surety returned non-JSON: status=${response.status}`,
    };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, error: "unexpected_response", message: "surety returned empty body" };
  }

  // Surety returns 200 for every well-formed envelope; HTTP 5xx means
  // Surety itself is broken. Map by HTTP status first, then by the
  // Surety code.
  if (response.status >= 500) {
    return { ok: false, error: "surety_unavailable", message: body.msg || `status=${response.status}` };
  }

  if (body.code === 0) {
    return {
      ok: true,
      token: body.data["relay-access-token"],
      expiresAt: body.data["expires-at"],
      tokenId: body.data["token-id"],
      scopes: body.data.scopes,
    };
  }

  const errorCode = SURETY_CODE_TO_ERROR[String(body.code)] || "unexpected_response";
  return { ok: false, error: errorCode, message: body.msg || "" };
}

// Utility used by the manager's logging path to mask a token in any
// log line. Re-exported for convenience so callers don't need to
// import from claudeConfig directly.
export function maskToken(value) {
  return maskSecret(value);
}
