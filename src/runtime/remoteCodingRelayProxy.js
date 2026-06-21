// Stage 9.2 — Caller-side HTTP ↔ SSE bridge.
//
// Bound to 127.0.0.1:0; the bound port is what `buildAgentProviderEnv`
// points `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at when the route is
// `type=remote, target=proxy`. The proxy translates one inbound HTTP
// request into one `remote.coding.request` envelope, awaits the worker's
// `remote.coding.response.*` events, and writes the response back to
// the HTTP client. Multiple concurrent requests are independent (the
// relay client tracks waiters by requestId).
//
// Translation of error codes → HTTP status:
//   target_offline   → 502 (worker is not on the relay)
//   upstream_error   → 502 (worker reports its local proxy 5xx'd or threw)
//   timeout          → 504 (relay gave up before worker replied)
//   relay_disconnected → 502 (this proxy's own SSE to the relay dropped)

import http from "node:http";
import { newRequestId, RemoteCodingRelayClient } from "../relay/remoteCodingRelayClient.js";

function translateErrorToHttp(evt) {
  const code = evt?.code || "upstream_error";
  const message = evt?.message || "remote coding error";
  if (code === "timeout") {
    return { status: 504, body: { error: "timeout", code, message } };
  }
  if (code === "target_offline") {
    return { status: 502, body: { error: "target_offline", code, message } };
  }
  // upstream_error, relay_disconnected, anything else.
  return { status: 502, body: { error: code, code, message } };
}

export class RemoteCodingRelayProxy {
  constructor({ relayUrl, deviceId, authToken = null, fetchFn = globalThis.fetch }) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.fetchFn = fetchFn;
    this._client = new RemoteCodingRelayClient({ relayUrl, deviceId, authToken, fetchFn });
    this._server = null;
    this._port = null;
    // Stage 9.2.1: track in-flight sockets so stop() can destroy them
    // and let server.close() actually resolve. Without this, the
    // bridge can hang on caller-side abort tests where the response
    // socket stays open.
    this._sockets = new Set();
  }

  /**
   * Stage 9.3 — pass through to the underlying client. The SSE is
   * closed and re-opened on the next subscribe.
   */
  setAuthToken(token) {
    this._client.setAuthToken(token);
  }

  /**
   * Bind 127.0.0.1:0 and open the SSE subscription. Returns the bound
   * port (ephemeral). Throws on bind failure.
   */
  async start() {
    if (this._server) return { ok: true, port: this._port };
    const server = http.createServer((req, res) => this._handle(req, res));
    this._server = server;
    server.on("connection", (sock) => {
      this._sockets.add(sock);
      sock.on("close", () => this._sockets.delete(sock));
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const { port } = server.address();
        this._port = port;
        resolve();
      });
    });
    // Open the SSE subscription. The first publishRequest will await
    // the first `start` event; we don't wait for it here so the proxy
    // is ready to accept HTTP traffic immediately.
    this._client.subscribe().catch(() => {
      // Errors are surfaced to in-flight waiters via _failAllWaiters
      // in the client. Nothing to do here.
    });
    return { ok: true, port: this._port };
  }

  status() {
    return {
      state: this._server ? "running" : "stopped",
      port: this._port,
      host: "127.0.0.1",
      pid: process.pid,
      runtime: "remote-coding",
    };
  }

  async stop() {
    if (!this._server) return;
    // Stage 9.2.1: destroy all in-flight sockets so server.close() can
    // actually return. Without this, the bridge hangs on caller-side
    // abort tests where the response socket stays open even after
    // the client destroyed the request.
    for (const sock of this._sockets) {
      try { sock.destroy(); } catch {}
    }
    this._sockets.clear();
    try { await new Promise((resolve) => this._server.close(resolve)); } catch {}
    try { await this._client.close(); } catch {}
    this._server = null;
    this._port = null;
  }

  _handle(req, res) {
    // The runtime is OpenAI-compatible (Codex) or Anthropic (Claude);
    // either way the body is JSON or SSE. We don't care which — the
    // worker just gets a verbatim forward.
    const requestId = newRequestId();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const rawBody = Buffer.concat(chunks);
        const base64Body = rawBody.length === 0 ? "" : rawBody.toString("base64");

        // Forwarded headers: drop hop-by-hop / credential headers that
        // are caller-side concerns only. The worker still gets its own
        // strip pass (src/daemon/remoteCodingServer.js).
        const forwardedHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const lk = k.toLowerCase();
          if (lk === "host" || lk === "content-length" || lk === "connection") continue;
          forwardedHeaders[k] = v;
        }

        const envelope = {
          type: "remote.coding.request",
          requestId,
          sourceDeviceId: this.deviceId,
          targetDeviceId: req.headers["x-originrouter-target-device"] || this._resolveTargetDeviceId(),
          runtime: req.headers["x-originrouter-runtime"] === "codex" ? "codex" : "claude",
          method: req.method,
          path: req.url,
          headers: forwardedHeaders,
          body: base64Body,
        };

        // Publish first; 400/413/202 from the relay. We also have to
        // register the waiter BEFORE publishing so a fast worker
        // reply is not lost.
        const { onStart, onChunk, onEnd, onError, dispose } = this._registerWaiter(requestId, res);
        let publishResult;
        try {
          publishResult = await this._client.publishRequest(envelope);
        } catch (err) {
          dispose();
          onError({ code: "relay_disconnected", message: err?.message || String(err) });
          return;
        }
        if (publishResult.status === 400) {
          dispose();
          onError({
            code: "upstream_error",
            message: `relay rejected request: ${publishResult.body?.error || "invalid_envelope"}`,
          });
          return;
        }
        if (publishResult.status === 413) {
          dispose();
          onError({
            code: "upstream_error",
            message: "relay rejected request: request_too_large",
          });
          return;
        }
        if (publishResult.status >= 500) {
          dispose();
          onError({
            code: "relay_disconnected",
            message: `relay returned ${publishResult.status}`,
          });
          return;
        }
        if (publishResult.body?.accepted === false) {
          // target_offline.
          dispose();
          onError({
            code: "target_offline",
            message: "worker is not online on the relay",
          });
          return;
        }
        // Accepted. Waiter is registered; the worker reply will fire
        // onStart / onChunk* / onEnd / onError.
        // Stage 9.2.1: if the caller-side HTTP request is aborted
        // (client disconnect, response side closed, server-side
        // timeout via res.on('close')), publish a cancel so the
        // relay clears the per-request state and the worker aborts
        // its in-flight fetch.
        let cancelled = false;
        const cancelIfPending = () => {
          if (cancelled) return;
          cancelled = true;
          this._client.publishCancel(requestId).catch(() => {});
          dispose();
        };
        req.on("aborted", cancelIfPending);
        req.on("close", () => {
          // If end was already sent, the waiter is already removed
          // and dispose is a no-op.
          if (!res.writableEnded) cancelIfPending();
        });
        res.on("close", () => {
          if (!res.writableEnded) cancelIfPending();
        });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        try { res.end(JSON.stringify({ error: "internal", message: err?.message || String(err) })); } catch {}
      }
    });
    req.on("error", (err) => {
      try { res.destroy(err); } catch {}
    });
  }

  /**
   * The local wrapper passes the route's target deviceId through a
   * header so this proxy doesn't have to read config. The header is
   * `x-originrouter-target-device`. If absent (e.g. env print path
   * that doesn't set it), we fall back to the runtime's `deviceId`
   * which is the caller's own — the request will be refused as
   * `target_offline` since the caller isn't listening as a worker.
   */
  _resolveTargetDeviceId() {
    return this.deviceId;
  }

  _registerWaiter(requestId, res) {
    let started = false;
    let disposed = false;
    const onStart = (evt) => {
      started = true;
      try {
        res.writeHead(evt.status || 502, evt.headers || { "Content-Type": "application/json" });
      } catch (err) {
        // Client disconnected.
        dispose();
      }
    };
    const onChunk = (evt) => {
      if (!started) {
        // Defensive: chunk arrived before start. Treat as a 502.
        try {
          res.writeHead(502, { "Content-Type": "application/json" });
        } catch {}
        started = true;
      }
      try {
        const buf = Buffer.from(evt.chunk, "base64");
        res.write(buf);
      } catch {}
    };
    const onEnd = (evt) => {
      try { res.end(); } catch {}
    };
    const onError = (evt) => {
      const { status, body } = translateErrorToHttp(evt);
      try {
        if (!res.headersSent) {
          res.writeHead(status, { "Content-Type": "application/json" });
        } else {
          // Headers already sent — best we can do is end; the client
          // sees a truncated body. This is rare (only happens if the
          // worker started streaming then errored mid-stream).
        }
        res.end(JSON.stringify(body));
      } catch {}
    };
    const dispose = this._client.registerWaiter(requestId, { onStart, onChunk, onEnd, onError });
    return { onStart, onChunk, onEnd, onError, dispose: () => { if (!disposed) { disposed = true; dispose(); } } };
  }
}
