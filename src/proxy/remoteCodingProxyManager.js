// Stage 9.2 — Caller-side manager for `RemoteCodingRelayProxy`.
// Stage 9.3 — Adds optional Surety token acquisition.
//
// Mirrors the shape of `src/proxy/manager.js:ProxyManager` (start / stop
// / status). On start() it instantiates the bridge on 127.0.0.1:0 and
// opens the SSE subscription. status() returns a frozen snapshot in
// the same shape that `buildAgentProviderEnv` reads.
//
// 9.3 auth behavior is gated by `ORIGINROUTER_RELAY_AUTH`:
//   - "off" (default): no token acquisition. The proxy is constructed
//     with `authToken: null` and behaves exactly like 9.2.
//   - "on": the manager obtains the OriginRouter Relay audience token from
//     the OAuth credential and constructs the proxy with that token. Refresh
//     is scheduled 60 seconds before expiry.

import { readCodingAuth } from "../persistence/codingAuth.js";
import { RemoteCodingRelayProxy } from "../runtime/remoteCodingRelayProxy.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import { OAUTH_RESOURCES } from "../runtime/authContract.js";

const REFRESH_LEAD_MS = 60_000; // refresh 60s before expiresAt

function isAuthOn() {
  return (process.env.ORIGINROUTER_RELAY_AUTH || "off") === "on";
}

export class RemoteCodingProxyManager {
  constructor({
    stateDir,
    relayUrl,
    deviceId,
    targetDeviceId,
    fetchFn = globalThis.fetch,
  }) {
    this.stateDir = stateDir;
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.targetDeviceId = targetDeviceId;
    this.fetchFn = fetchFn;
    this._proxy = null;
    this._refreshTimer = null;
    this._token = null;
    this._tokenExpiresAt = null;
    this._authState = "ok";
    this._status = Object.freeze({
      state: "stopped",
      port: null,
      host: null,
      pid: null,
      runtime: "remote-coding",
    });
  }

  async _acquireToken() {
    try {
      const stored = await ensureFreshAccessToken({
        stateDir: this.stateDir,
        resource: OAUTH_RESOURCES.RELAY,
        fetchFn: this.fetchFn,
      });
      const relay = stored?.accessTokens?.relay;
      if (!stored || !relay?.token || !stored.deviceId) {
        return { ok: false, error: "oauth_login_required" };
      }
      return {
        ok: true,
        token: relay.token,
        expiresAt: relay.expiresAt / 1000,
      };
    } catch (error) {
      return { ok: false, error: error.code || "oauth_refresh_failed" };
    }
  }

  async _acquireWithRetry() {
    let result = await this._acquireToken();
    if (!result.ok && result.error === "surety_unavailable") {
      // One quick retry — Surety may be cold-starting.
      await new Promise((r) => setTimeout(r, 1000));
      result = await this._acquireToken();
    }
    return result;
  }

  async start(_opts = {}) {
    if (this._proxy) {
      return { ok: true, state: "running", port: this._status.port };
    }
    let authToken = null;
    if (isAuthOn()) {
      this._authState = "refreshing";
      const result = await this._acquireWithRetry();
      if (!result.ok) {
        this._authState = "failed";
        return { ok: false, error: result.error, message: result.message };
      }
      authToken = result.token;
      this._token = authToken;
      this._tokenExpiresAt = result.expiresAt;
      this._authState = "ok";
      // Stage 9.5 — when auth=on, the token's deviceId comes from
      // coding-key.json (read inside _acquireToken). The inner proxy must
      // use the same deviceId or the relay returns 403 device_mismatch.
      // Override the constructor-supplied deviceId (which is from
      // ensureDeviceForLogin / device.json) with the stored one.
      const stored = readCodingAuth(this.stateDir);
      if (stored && stored.deviceId) {
        this.deviceId = stored.deviceId;
      }
      this._scheduleRefresh();
    }

    const proxy = new RemoteCodingRelayProxy({
      relayUrl: this.relayUrl,
      stateDir: this.stateDir,
      deviceId: this.deviceId,
      targetDeviceId: this.targetDeviceId,
      authToken,
      fetchFn: this.fetchFn,
    });
    try {
      const result = await proxy.start();
      if (!result.ok) {
        this._status = Object.freeze({ ...this._status, state: "stopped" });
        return { ok: false, error: "start failed" };
      }
      this._proxy = proxy;
      const liveStatus = proxy.status();
      this._status = Object.freeze({
        state: "running",
        port: liveStatus.port,
        host: liveStatus.host,
        pid: liveStatus.pid,
        runtime: "remote-coding",
      });
      return { ok: true, state: "running", port: liveStatus.port };
    } catch (err) {
      this._status = Object.freeze({ ...this._status, state: "stopped" });
      return { ok: false, error: err?.message || String(err) };
    }
  }

  _scheduleRefresh() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (!this._tokenExpiresAt) return;
    const now = Date.now() / 1000;
    const refreshIn = Math.max(5_000, (this._tokenExpiresAt - now) * 1000 - REFRESH_LEAD_MS);
    this._refreshTimer = setTimeout(async () => {
      this._authState = "refreshing";
      const result = await this._acquireWithRetry();
      if (!result.ok) {
        this._authState = "failed";
        return;
      }
      this._token = result.token;
      this._tokenExpiresAt = result.expiresAt;
      this._authState = "ok";
      if (this._proxy && typeof this._proxy.setAuthToken === "function") {
        this._proxy.setAuthToken(result.token);
      }
      this._scheduleRefresh();
    }, refreshIn);
  }

  async stop() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    if (!this._proxy) {
      this._status = Object.freeze({ ...this._status, state: "stopped" });
      return { ok: true, state: "stopped" };
    }
    try {
      await this._proxy.stop();
    } catch {}
    this._proxy = null;
    this._status = Object.freeze({ ...this._status, state: "stopped", port: null });
    return { ok: true, state: "stopped" };
  }

  status() {
    return this._status;
  }
}
