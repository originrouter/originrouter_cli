// Stage 9.3 — Caller-side SSE client for the remote-coding relay.
//
// This is a purpose-built client (NOT a modification of
// src/relay/relayClient.js, which is on the agent-control hot path).
// It opens the relay SSE, filters events to `remote.coding.response.*`
// and dispatches each by requestId to a waiter kept in a Map.
//
// 9.2 had no auth. 9.3 adds an optional `authToken` constructor
// argument. When set, SSE subscribe and every /device/message POST
// carry `Authorization: Bearer <authToken>`. When unset, the file
// is byte-for-byte compatible with 9.2.

import { randomUUID } from "node:crypto";

export class RemoteCodingRelayClient {
  constructor({ relayUrl, deviceId, authToken = null, fetchFn = globalThis.fetch }) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.authToken = authToken;
    this.fetchFn = fetchFn;
    this._waiters = new Map();
    this._abortController = null;
    this._reader = null;
    this._closed = false;
  }

  /**
   * Update the bearer used for subsequent calls. If the SSE is
   * currently open, close it so the next `subscribe()` re-opens
   * with the new header.
   */
  setAuthToken(token) {
    this.authToken = token;
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
      this._abortController = null;
    }
  }

  /**
   * Open the SSE subscription. Resolves once the underlying response
   * headers are received; events flow into the waiter map as they arrive.
   */
  async subscribe() {
    if (this._abortController) return; // already subscribed
    const ac = new AbortController();
    this._abortController = ac;
    const url = `${this.relayUrl}/device/events?deviceId=${encodeURIComponent(this.deviceId)}`;
    const headers = {};
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    let response;
    try {
      response = await this.fetchFn(url, { signal: ac.signal, headers });
    } catch (err) {
      // Connection error → reject all in-flight waiters with relay_disconnected.
      this._failAllWaiters(err);
      throw err;
    }
    if (!response.ok || !response.body) {
      this._failAllWaiters(new Error(`relay SSE open failed: ${response.status}`));
      throw new Error(`relay SSE open failed: ${response.status}`);
    }
    // Don't await — let the read loop run in the background.
    this._readLoop(response.body).catch((err) => {
      this._failAllWaiters(err);
    });
  }

  async _readLoop(body) {
    const reader = body.getReader();
    this._reader = reader;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!this._closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let evt;
          try { evt = JSON.parse(dataLine.slice(5).trim()); }
          catch { continue; }
          if (typeof evt?.type !== "string" || !evt.type.startsWith("remote.coding.response.")) continue;
          if (!evt.requestId) continue;
          this._dispatch(evt);
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
      // If the loop ended while waiters are still expecting events, fail them.
      this._failAllWaiters(new Error("relay_disconnected"));
    }
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
      try { w.onError?.({ code: "relay_disconnected", message: err?.message || String(err) }); } catch {}
    }
    this._waiters.clear();
  }

  /**
   * Publish a `remote.coding.request` envelope via POST /device/message.
   * The server validates the envelope and returns 200/400/413.
   * The caller proxy translates 400/413 into a 502 upstream_error.
   */
  async publishRequest(envelope) {
    if (this._closed) throw new Error("client closed");
    const url = `${this.relayUrl}/device/message`;
    const headers = { "Content-Type": "application/json" };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
    let body = {};
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  }

  /**
   * Publish `remote.coding.request.cancel` so the relay clears the
   * per-request state and forwards the cancel to the worker. Best-effort:
   * any error is swallowed (the relay will also time the request out).
   */
  async publishCancel(requestId) {
    if (this._closed) return;
    const url = `${this.relayUrl}/device/message`;
    const headers = { "Content-Type": "application/json" };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    return this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "remote.coding.request.cancel",
        requestId,
        deviceId: this.deviceId,
      }),
    }).catch(() => {});
  }

  /**
   * Register a waiter for a given requestId. Returns a `dispose` that
   * removes the waiter (call it from the HTTP handler teardown).
   */
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
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
    if (this._reader) {
      try { await this._reader.cancel(); } catch {}
    }
    this._failAllWaiters(new Error("relay_disconnected"));
  }
}

/**
 * Mint a requestId. The HTTP handler at 127.0.0.1:<port> generates
 * one for each inbound request.
 */
export function newRequestId() {
  return randomUUID();
}
