// Stage 9.7: OriginRouter backend auth client.
//
// Thin wrapper around the global `fetch` (Node 18+) for the
// /auth/v1/* backend routes. The CLI calls these
// as part of the real login flow (RFC 8628 device flow +
// grant / key management).
//
// Stage 9.6's `devMintLoginCode` was retired along with the
// backend's `/login-code/dev-mint` and `/device/approve` routes
// — production wire-up is now the only path.
//
// Security:
// - All helpers throw `AuthClientError` on non-2xx. The error
//   MUST NOT include the raw `Authorization` header value or the
//   raw device grant — see `assertErrorDoesNotLeakAuth(...)` in
//   the test file.
// - The client does not log.

const DEFAULT_TIMEOUT_MS = 30_000;

export class AuthClientError extends Error {
  constructor({ status, body, message }) {
    super(message || `auth request failed with status ${status}`);
    this.name = "AuthClientError";
    this.status = status;
    this.body = body;
  }
}

function _apiBase(apiBaseUrl) {
  return apiBaseUrl.replace(/\/+$/, "");
}

async function _request(method, url, { headers, body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(headers || {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const ct = resp.headers.get("content-type") || "";
    let parsed = null;
    let rawText = null;
    if (ct.includes("application/json")) {
      try { parsed = await resp.json(); }
      catch { parsed = null; }
    } else {
      try { rawText = await resp.text(); }
      catch { rawText = null; }
    }
    if (!resp.ok) {
      const message = (parsed && (parsed.message || parsed.error)) ||
                      rawText ||
                      `auth request failed (${resp.status})`;
      // CRITICAL: do NOT include `headers` in the error object —
      // it carries the Authorization header.
      throw new AuthClientError({
        status: resp.status,
        body: parsed ?? rawText,
        message,
      });
    }
    // Stage 9.7: gateway returns `{ code, msg, data }` envelope
    // (mirrors `enterprise/app.py` `_json_result(...)`). Unwrap so
    // callers see just the data object — `requestDeviceCode`
    // returns `{ user_code, ... }`, `exchangeLoginCode` returns
    // `{ device_grant, managed_coding_key, ... }`, etc.
    return parsed && typeof parsed === "object" && "data" in parsed
      ? parsed.data
      : parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 4 production helpers (Stage 9.8: deprecated paths) ----
//
// exchangeLoginCode / rotateCodingKey / revokeDeviceGrant / listDevices
// all use the legacy Bearer-<device_grant> form. The /device/exchange
// path still works (now returns OAuth shape) — used by tests and
// stage-9.6 backward-compat tooling.
//
// For the production CLI login flow, the recommended path is
// /device/code + /device/token (the helpers above). After login,
// the CLI uses the OAuth refresh_token (via refreshOAuthToken /
// revokeOAuthSession) for all subsequent lifecycle operations.

export async function exchangeLoginCode({ apiBaseUrl, code, deviceId, deviceName, source }) {
  const url = `${_apiBase(apiBaseUrl)}/auth/v1/device/exchange`;
  return _request("POST", url, {
    body: {
      code,
      device_id: deviceId,
      device_name: deviceName,
      client: source,
    },
  });
}

// rotateCodingKey is DEPRECATED in Stage 9.8. Use refreshOAuthToken
// (silent refresh) instead. Kept exported for backward compat with
// the legacy `auth rotate` flow and tests.
export async function rotateCodingKey({ apiBaseUrl, deviceGrant }) {
  const url = `${_apiBase(apiBaseUrl)}/auth/v1/device/rotate-coding-key`;
  return _request("POST", url, {
    headers: { Authorization: `Bearer ${deviceGrant}` },
  });
}

// revokeDeviceGrant is DEPRECATED in Stage 9.8. Use
// revokeOAuthSession (revokes the full session, not just the
// audit row). Kept exported for backward compat.
function _deviceAuthHeaders({ deviceGrant, accessToken, deviceId } = {}) {
  const token = accessToken || deviceGrant;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (accessToken && deviceId) {
    headers["X-OriginRouter-Device-Id"] = deviceId;
  }
  return headers;
}

export async function revokeDeviceGrant({ apiBaseUrl, deviceGrant, accessToken, deviceId }) {
  const url = `${_apiBase(apiBaseUrl)}/auth/v1/device/revoke`;
  return _request("POST", url, {
    headers: _deviceAuthHeaders({ deviceGrant, accessToken, deviceId }),
  });
}

export async function listDevices({ apiBaseUrl, deviceGrant, accessToken, deviceId }) {
  const url = `${_apiBase(apiBaseUrl)}/auth/v1/devices`;
  return _request("GET", url, {
    headers: _deviceAuthHeaders({ deviceGrant, accessToken, deviceId }),
  });
}

// ---- 2 device-flow helpers (Stage 9.7, RFC 8628) ----
//
// These call the new gateway routes:
//   POST /auth/v1/device/code
//   POST /auth/v1/device/token
// The CLI uses them when invoked as `originrouter login --device-flow`.
// No Surety uuid is required (the CLI has no browser uuid). The
// gateway mints an 8-char user_code, the user types it into the H5
// /cli/authorize page, the H5 calls /device/approve, and the CLI's
// polling loop eventually receives the (access_token, refresh_token)
// OAuth 2.0 pair (Stage 9.8).

export async function requestDeviceCode({ apiBaseUrl, deviceId, deviceName, source }) {
  const url = `${_apiBase(apiBaseUrl)}/auth/v1/device/code`;
  return _request("POST", url, {
    body: {
      device_id: deviceId,
      device_name: deviceName,
      source: source || "originrouter_cli",
    },
  });
}

export async function pollDeviceToken({ apiBaseUrl, deviceCode, deviceId, source }) {
  const url = `${_apiBase(apiBaseUrl)}/auth/v1/device/token`;
  // RFC 8628 /token returns errors via the `error` field in the
  // payload (the gateway maps all non-success outcomes to 4xx
  // with `error` in the data body). We unwrap here so callers
  // can branch on `e.code`:
  //   "authorization_pending" | "slow_down" | "expired_token"
  //   | "access_denied" | "invalid_grant"
  try {
    return await _request("POST", url, {
      body: {
        device_code: deviceCode,
        device_id: deviceId,
        source: source || "originrouter_cli",
      },
    });
  } catch (e) {
    if (e instanceof AuthClientError && e.body && typeof e.body === "object") {
      const code = e.body.error || e.body.msg || "device_flow_error";
      const wrapped = new AuthClientError({
        status: e.status, body: null, message: code,
      });
      wrapped.code = code;
      throw wrapped;
    }
    throw e;
  }
}


// ---- 1 test-only helper ----
//
// This helper exists ONLY so test fixtures can mint a code
// against a mock backend. Production CLI code MUST NOT import
// it — grep audit enforces this.
//
// Naming: the explicit `_ForTesting` suffix + JSDoc warning
// makes the test-only intent obvious to anyone reading the
// import site.

/**
 * Test-only helper. Mints a one-time login code by calling
 * `POST /auth/v1/login-code` with a browser uuid.
 *
 * NOT for production CLI use. The CLI does not have a browser
 * uuid; the `/login-code` route is browser-authenticated and
 * the resulting code is intended for the user to paste into
 * the CLI via `originrouter login --manual-code <code>` (or
 * for H5 to redirect to a CLI callback, in a later stage).
 *
 * Tests import this; `src/index.js` does not.
 *
 * @internal
 */
export async function requestBrowserLoginCodeForTesting({ apiBaseUrl, browserUuid }) {
  const url = `${_apiBase(apiBaseUrl)}/auth/v1/login-code`;
  return _request("POST", url, {
    headers: { Authorization: `Bearer uuid:${browserUuid}` },
    body: {},
  });
}

/**
 * Stage 9.6: Convert a `/device/exchange` response into the shape
 * that passes `isManagedKeyShape()`. The response carries seconds;
 * the on-disk shape carries milliseconds.
 *
 * NEVER logs raw grant, raw key, raw code. NEVER puts the raw
 * exchange response into `AuthClientError.body` (it carries the
 * raw grant + key). Errors carry only the missing-field name.
 *
 * `scopes` is intentionally NOT in the required list — when omitted,
 * it defaults to `["coding"]`. The backend always sends scopes; the
 * default is a defensive belt-and-suspenders for older responses.
 */
export function exchangeResponseToManagedKeyShape(exchangeResponse) {
  if (!exchangeResponse || typeof exchangeResponse !== "object") {
    throw new AuthClientError({
      status: 0, body: null, message: "exchangeResponse is required",
    });
  }
  const required = [
    "device_id", "device_grant", "device_grant_id",
    "managed_coding_key", "managed_coding_key_id",
    "managed_coding_key_expires_at",
    "source",
  ];
  for (const f of required) {
    if (!exchangeResponse[f]) {
      throw new AuthClientError({
        status: 0, body: null,  // NEVER body: exchangeResponse — it carries raw grant/key
        message: `exchangeResponse missing field: ${f}`,
      });
    }
  }
  const out = {
    kind: "managed",
    source: exchangeResponse.source,
    keyId: exchangeResponse.managed_coding_key_id,
    key: exchangeResponse.managed_coding_key,
    deviceGrantId: exchangeResponse.device_grant_id,
    deviceGrant: exchangeResponse.device_grant,
    deviceId: exchangeResponse.device_id,
    expiresAt: Math.floor(Number(exchangeResponse.managed_coding_key_expires_at) * 1000),
    scopes: Array.isArray(exchangeResponse.scopes) ? exchangeResponse.scopes : ["coding"],
  };
  if (exchangeResponse.device_grant_idle_expires_at != null) {
    out.deviceGrantIdleExpiresAt =
      Math.floor(Number(exchangeResponse.device_grant_idle_expires_at) * 1000);
  }
  if (exchangeResponse.device_grant_absolute_expires_at != null) {
    out.deviceGrantAbsoluteExpiresAt =
      Math.floor(Number(exchangeResponse.device_grant_absolute_expires_at) * 1000);
  }
  return out;
}
