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

function relayWsUrl(relayUrl, deviceId) {
  const url = new URL(`${relayUrl.replace(/\/+$/, "")}/relay/v1/devices/${encodeURIComponent(deviceId)}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

export class RemoteCodingRelayClient {
  constructor({ relayUrl, deviceId, authToken = null, fetchFn = globalThis.fetch }) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.authToken = authToken;
    this.fetchFn = fetchFn;
    this._waiters = new Map();
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

  async subscribe() {
    if (this._closed) throw new Error("client closed");
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const headers = {};
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      const ws = new WebSocket(relayWsUrl(this.relayUrl, this.deviceId), { headers });
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
      return;
    }
    if (evt.type === "remote.coding.response.error") {
      w.onError?.(evt);
      this._waiters.delete(evt.requestId);
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
    const headers = { "Content-Type": "application/json" };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    const response = await this.fetchFn(`${this.relayUrl}/relay/v1/messages`, {
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
