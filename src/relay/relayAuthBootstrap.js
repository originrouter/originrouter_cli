// Stage 9.5 — Worker/control-side token acquisition.
//
// The 9.3 caller-side wiring (RemoteCodingProxyManager) reads coding-key.json
// and acquires a Surety token. The 9.5 gap: the worker/control side
// (daemon.js, localAgentSession.js, claudeSdkSession.js) constructs
// RelayClient with no authToken, so an auth=on relay returns 401 for any
// worker connection. This helper centralizes the same "read coding-key,
// acquire token, build options" pattern so all three call sites share
// the same contract.
//
// Design rules (locked):
//   - isRelayAuthOn() — boolean, mirrors isAuthOn() in remoteCodingProxyManager.js:26.
//   - buildRelayClientOptions() — pure async; returns a fresh options object on
//     every call. Callers use it for both initial construction AND reconnect
//     refresh. The returned { deviceId, authToken } is the source of truth
//     for what the RelayClient should use right now.
//   - On any failure, throws RelayAuthBootstrapError with err.code ===
//     err.message. Never includes OAuth credentials in the message.

import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";

export class RelayAuthBootstrapError extends Error {
  constructor(code) {
    super(code); // err.message is exactly the code string; no concatenation
    this.code = code;
    this.name = "RelayAuthBootstrapError";
  }
}

export function isRelayAuthOn() {
  return (process.env.ORIGINROUTER_RELAY_AUTH || "off") === "on";
}

export async function buildRelayClientOptions({
  stateDir,
  relayUrl,
  fallbackDeviceId,
  fetchFn = globalThis.fetch,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  forceAuth = false,
} = {}) {
  if (!forceAuth && !isRelayAuthOn()) {
    return {
      relayUrl,
      deviceId: fallbackDeviceId,
      authToken: null,
      authState: "off",
    };
  }

  let stored = null;
  try {
    stored = await ensureFreshAccessTokenFn({
      stateDir,
      resource: OAUTH_RESOURCES.RELAY,
      fetchFn,
    });
  } catch (err) {
    throw new RelayAuthBootstrapError(err?.code || "oauth_refresh_failed");
  }
  if (!stored || !stored.deviceId) {
    throw new RelayAuthBootstrapError("login_required");
  }
  const relayToken = accessTokenFor(stored, OAUTH_RESOURCES.RELAY);
  if (!relayToken?.token) throw new RelayAuthBootstrapError("relay_token_missing");

  return {
    relayUrl,
    deviceId: stored.deviceId,
    authToken: relayToken.token,
    authState: "on",
    tokenExpiresAt: Math.floor(relayToken.expiresAt / 1000),
  };
}
