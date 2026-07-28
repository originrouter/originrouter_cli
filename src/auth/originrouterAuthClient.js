const DEFAULT_TIMEOUT_MS = 30_000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export class AuthClientError extends Error {
  constructor({ status = 0, code = "oauth_request_failed", message = code }) {
    super(message);
    this.name = "AuthClientError";
    this.status = status;
    this.code = code;
  }
}

function base(value) {
  return String(value || "").replace(/\/+$/, "");
}

async function requestForm(url, entries, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams();
    for (const [key, value] of entries) body.append(key, String(value));
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const code = payload?.error || "oauth_request_failed";
      throw new AuthClientError({
        status: response.status,
        code,
        message: code,
      });
    }
    if (!payload || typeof payload !== "object") {
      throw new AuthClientError({ code: "invalid_oauth_response" });
    }
    return payload;
  } catch (error) {
    if (error instanceof AuthClientError) throw error;
    throw new AuthClientError({ code: "oauth_unavailable" });
  } finally {
    clearTimeout(timer);
  }
}

export async function requestDeviceCode({
  suretyBaseUrl,
  deviceId,
  deviceName,
  fetchFn = globalThis.fetch,
}) {
  return requestForm(
    `${base(suretyBaseUrl)}/api/oauth/device/code`,
    [
      ["client_id", "originrouter_cli"],
      ["scope", "control.read control.write ai.models ai.invoke coding.invoke relay.connect offline_access"],
      ["resource", "originrouter.control"],
      ["resource", "originrouter.ai"],
      ["resource", "originrouter.coding"],
      ["resource", "originrouter.relay"],
      ["device_id", deviceId],
      ["device_name", deviceName || deviceId],
    ],
    { fetchFn },
  );
}

export async function pollDeviceToken({
  suretyBaseUrl,
  deviceCode,
  resource = "originrouter.control",
  fetchFn = globalThis.fetch,
}) {
  return requestForm(
    `${base(suretyBaseUrl)}/api/oauth/token`,
    [
      ["grant_type", DEVICE_GRANT],
      ["client_id", "originrouter_cli"],
      ["device_code", deviceCode],
      ["resource", resource],
    ],
    { fetchFn },
  );
}

export async function bindDeviceE2eeIdentity({
  suretyBaseUrl,
  deviceCode,
  enrollmentChallenge,
  identity,
  bindingSignature,
  fetchFn = globalThis.fetch,
}) {
  return requestForm(
    `${base(suretyBaseUrl)}/api/oauth/device/bind`,
    [
      ["client_id", "originrouter_cli"],
      ["device_code", deviceCode],
      ["enrollment_challenge", enrollmentChallenge],
      ["e2ee_identity", JSON.stringify(identity)],
      ["e2ee_binding_signature", bindingSignature],
    ],
    { fetchFn },
  );
}

export async function refreshOAuthToken({
  tokenEndpoint,
  refreshToken,
  resource,
  fetchFn = globalThis.fetch,
}) {
  return requestForm(
    tokenEndpoint,
    [
      ["grant_type", "refresh_token"],
      ["client_id", "originrouter_cli"],
      ["refresh_token", refreshToken],
      ["resource", resource],
    ],
    { fetchFn },
  );
}

export async function revokeOAuthToken({
  revocationEndpoint,
  token,
  fetchFn = globalThis.fetch,
}) {
  return requestForm(
    revocationEndpoint,
    [
      ["client_id", "originrouter_cli"],
      ["token", token],
    ],
    { fetchFn },
  );
}
