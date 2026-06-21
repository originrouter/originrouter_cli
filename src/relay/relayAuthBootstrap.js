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
//   - On any failure, throws RelayAuthBootstrapError with err.code === the
//     mapped Surety error code. err.message === err.code exactly (no
//     concatenation, no Surety original message, no deviceGrant, no token).
//   - Never logs raw deviceGrant or raw token.

import { readCodingAuth } from "../persistence/codingAuth.js";
import { acquireRelayAccessToken } from "../auth/suretyTokenClient.js";

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
} = {}) {
  if (!isRelayAuthOn()) {
    return {
      relayUrl,
      deviceId: fallbackDeviceId,
      authToken: null,
      authState: "off",
    };
  }

  const suretyUrl = process.env.SURETY_BASE_URL || "";
  if (!suretyUrl) {
    throw new RelayAuthBootstrapError("surety_unavailable");
  }

  let stored;
  try {
    stored = readCodingAuth(stateDir);
  } catch {
    throw new RelayAuthBootstrapError("no_device_grant");
  }
  if (!stored || !stored.deviceGrant || !stored.deviceId) {
    throw new RelayAuthBootstrapError("no_device_grant");
  }

  const result = await acquireRelayAccessToken({
    suretyUrl,
    deviceId: stored.deviceId,
    deviceGrant: stored.deviceGrant,
    fetchFn,
  });

  if (!result.ok) {
    // Throw with the code only; never the Surety original message.
    throw new RelayAuthBootstrapError(result.error || "unexpected_response");
  }

  return {
    relayUrl,
    deviceId: stored.deviceId,
    authToken: result.token,
    authState: "on",
    tokenExpiresAt: result.expiresAt,
  };
}
