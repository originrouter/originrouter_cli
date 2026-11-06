// Caller-side WebSocket client for the unified OriginRouter relay.
//
// The FastAPI relay exposes:
//   WSS  /relay/v1/devices/{device_id}/ws
//   POST /relay/v1/messages
//
// The client subscribes as the caller device, publishes
// `remote.coding.request`, and dispatches `remote.coding.response.*` by
// requestId to per-request waiters.

import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { decryptRemoteCodingResponse } from "../crypto/remoteCodingE2ee.js";

function relayWsUrl(relayUrl, deviceId) {
  const url = new URL(`${relayUrl.replace(/\/+$/, "")}/relay/v1/devices/${encodeURIComponent(deviceId)}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export class RemoteCodingRelayClient {
  constructor({
    relayUrl,
    deviceId,
    authToken = null,
    fetchFn = globalThis.fetch,
    proofProvider = null,
  }) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.authToken = authToken;
    this.fetchFn = fetchFn;
    // The WebSocket handshake cannot go through `fetch`, so it cannot be
    // covered by the fetch wrapper. It asks this instead, and gets the same
    // answer for the same reasons.
    this.proofProvider = proofProvider;
    this._waiters = new Map();
    this._cryptoContexts = new Map();
    this._closed = false;
    this._ws = null;
    this._connectPromise = null;
  }

  setAuthToken(token) {
    this.authToken = token;
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._connectPromise = null;
  }

  /**
   * The headers a relay request should carry.
   *
   * The proof is made here rather than left to the fetch wrapper, because
   * this client's fetch is injected: a caller that hands it a plain fetch
   * would otherwise send a bearer request to a server that has learned to
   * ask for one.
   */
  async _authHeaders(method, url) {
    if (!this.authToken) return {};
    const proof = await this.proofProvider?.({ method, url, token: this.authToken });
    if (proof) return proof;
    return { Authorization: `Bearer ${this.authToken}` };
  }

  async subscribe() {
    if (this._closed) throw new Error("client closed");
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
    if (this._connectPromise) return this._connectPromise;
    const headers = {};
    const url = relayWsUrl(this.relayUrl, this.deviceId);
    if (this.authToken) {
      const proof = await this.proofProvider?.({
        method: "GET",
        url: url.toString(),
        token: this.authToken,
      });
      if (proof) {
        Object.assign(headers, proof);
      } else {
        headers.Authorization = `Bearer ${this.authToken}`;
      }
    }
    this._connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      this._ws = ws;
      ws.once("open", () => {
        this._connectPromise = null;
        resolve();
      });
      ws.once("error", (err) => {
        this._connectPromise = null;
        this._failAllWaiters(err);
        reject(err);
      });
      ws.on("message", (data) => {
        let evt;
        try { evt = JSON.parse(String(data)); } catch { return; }
        if (typeof evt?.type !== "string" || !evt.type.startsWith("remote.coding.response.")) return;
        if (!evt.requestId) return;
        this._dispatch(evt);
      });
      ws.once("close", () => {
        if (this._ws === ws) this._ws = null;
        if (!this._closed) {
          this._failAllWaiters(new Error("relay_disconnected"));
        }
      });
    });
    return this._connectPromise;
  }

  _dispatch(evt) {
    const w = this._waiters.get(evt.requestId);
    if (!w) return;
    const cryptoContext = this._cryptoContexts.get(evt.requestId);
    if (cryptoContext) {
      const serverControlError = evt.type === "remote.coding.response.error"
        && !evt.protocol
        && ["target_offline", "timeout"].includes(evt.code);
      if (!serverControlError) {
        try {
          evt = decryptRemoteCodingResponse(cryptoContext, evt);
        } catch (error) {
          w.onError?.({
            code: error?.code || "e2ee_decryption_failed",
            message: error?.message || "encrypted response could not be verified",
          });
          this._waiters.delete(evt.requestId);
          this._cryptoContexts.delete(evt.requestId);
          return;
        }
      }
    }
    if (evt.type === "remote.coding.response.start") {
      w.onStart?.(evt);
      return;
    }
    if (evt.type === "remote.coding.response.chunk") {
      w.onChunk?.(evt);
      return;
    }
    if (evt.type === "remote.coding.response.end") {
      w.onEnd?.(evt);
      this._waiters.delete(evt.requestId);
      this._cryptoContexts.delete(evt.requestId);
      return;
    }
    if (evt.type === "remote.coding.response.error") {
      w.onError?.(evt);
      this._waiters.delete(evt.requestId);
      this._cryptoContexts.delete(evt.requestId);
    }
  }

  _failAllWaiters(err) {
    for (const [, w] of this._waiters) {
      try {
        w.onError?.({
          code: "relay_disconnected",
          message: err?.message || String(err),
        });
      } catch {}
    }
    this._waiters.clear();
    this._cryptoContexts.clear();
  }

  setCryptoContext(requestId, context) {
    if (context) this._cryptoContexts.set(requestId, context);
    else this._cryptoContexts.delete(requestId);
  }

  async getTargetE2ee(targetDeviceId) {
    const url = `${this.relayUrl}/relay/v1/devices/${encodeURIComponent(targetDeviceId)}/e2ee`;
    const headers = await this._authHeaders("GET", url);
    const response = await this.fetchFn(url, { method: "GET", headers });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(body?.detail?.code || body?.error || `e2ee directory returned ${response.status}`);
      error.code = body?.detail?.code || "e2ee_directory_unavailable";
      throw error;
    }
    return body?.data || body;
  }

  async publishRequest(envelope) {
    if (this._closed) throw new Error("client closed");
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(envelope));
      return { status: 200, body: { ok: true, accepted: true } };
    }
    return this._postRelayMessage(envelope);
  }

  async publishCancel(requestId) {
    if (this._closed) return;
    const envelope = {
      type: "remote.coding.request.cancel",
      requestId,
      deviceId: this.deviceId,
    };
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify(envelope)); } catch {}
      return;
    }
    return this._postRelayMessage(envelope).catch(() => {});
  }

  async _postRelayMessage(envelope) {
    const url = `${this.relayUrl}/relay/v1/messages`;
    const headers = {
      "Content-Type": "application/json",
      ...(await this._authHeaders("POST", url)),
    };
    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target_device_id: envelope.targetDeviceId || envelope.deviceId || envelope.target_device_id,
        payload: envelope,
      }),
    });
    let body = {};
    try { body = await response.json(); } catch {}
    const data = body?.data && typeof body.data === "object" ? body.data : body;
    return {
      status: response.status,
      body: {
        ...body,
        accepted: data.accepted,
        reason: data.reason,
        error: data.reason || body.error,
      },
    };
  }

  registerWaiter(requestId, callbacks) {
    this._waiters.set(requestId, callbacks);
    return () => {
      if (this._waiters.get(requestId) === callbacks) {
        this._waiters.delete(requestId);
      }
      this._cryptoContexts.delete(requestId);
    };
  }

  async close() {
    this._closed = true;
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._failAllWaiters(new Error("relay_disconnected"));
  }
}

export function newRequestId() {
  return randomUUID();
}
