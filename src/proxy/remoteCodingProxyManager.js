// Stage 9.2 — Caller-side manager for `RemoteCodingRelayProxy`.
//
// Mirrors the shape of `src/proxy/manager.js:ProxyManager` (start / stop
// / status). On start() it instantiates the bridge on 127.0.0.1:0 and
// opens the SSE subscription. status() returns a frozen snapshot in
// the same shape that `buildAgentProviderEnv` reads.

import { RemoteCodingRelayProxy } from "../runtime/remoteCodingRelayProxy.js";

export class RemoteCodingProxyManager {
  constructor({ stateDir, relayUrl, deviceId, fetchFn = globalThis.fetch }) {
    this.stateDir = stateDir;
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.fetchFn = fetchFn;
    this._proxy = null;
    this._status = Object.freeze({
      state: "stopped",
      port: null,
      host: null,
      pid: null,
      runtime: "remote-coding",
    });
  }

  async start(_opts = {}) {
    if (this._proxy) {
      return { ok: true, state: "running", port: this._status.port };
    }
    const proxy = new RemoteCodingRelayProxy({
      relayUrl: this.relayUrl,
      deviceId: this.deviceId,
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

  async stop() {
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
