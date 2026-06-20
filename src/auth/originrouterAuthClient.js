// Stage 9.1A: OriginRouter backend auth client.
//
// Thin wrapper around the global `fetch` (Node 18+) for the 5
// backend routes. The CLI calls 4 of these as part of the real
// login flow; one (`requestBrowserLoginCodeForTesting`) is
// exported ONLY for tests so they can mint codes against a mock
// backend — production CLI code never imports it.
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
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ---- 4 production helpers ----

export async function exchangeLoginCode({ apiBaseUrl, code, deviceId, deviceName, source }) {
  const url = `${_apiBase(apiBaseUrl)}/originrouter/auth/device/exchange`;
  return _request("POST", url, {
    body: {
      code,
      device_id: deviceId,
      device_name: deviceName,
      client: source,
    },
  });
}

export async function rotateCodingKey({ apiBaseUrl, deviceGrant }) {
  const url = `${_apiBase(apiBaseUrl)}/originrouter/auth/device/rotate-coding-key`;
  return _request("POST", url, {
    headers: { Authorization: `Bearer ${deviceGrant}` },
  });
}

export async function revokeDeviceGrant({ apiBaseUrl, deviceGrant }) {
  const url = `${_apiBase(apiBaseUrl)}/originrouter/auth/device/revoke`;
  return _request("POST", url, {
    headers: { Authorization: `Bearer ${deviceGrant}` },
  });
}

export async function listDevices({ apiBaseUrl, deviceGrant }) {
  const url = `${_apiBase(apiBaseUrl)}/originrouter/auth/devices`;
  return _request("GET", url, {
    headers: { Authorization: `Bearer ${deviceGrant}` },
  });
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
 * `POST /originrouter/auth/login-code` with a browser uuid.
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
  const url = `${_apiBase(apiBaseUrl)}/originrouter/auth/login-code`;
  return _request("POST", url, {
    headers: { Authorization: `Bearer uuid:${browserUuid}` },
    body: {},
  });
}