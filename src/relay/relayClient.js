import WebSocket from "ws";

// OriginRouter unified server relay client.
//
// The unified FastAPI server exposes:
//   WSS  /relay/v1/devices/{device_id}/ws
//   POST /relay/v1/messages

/**
 * The bearer a request is sent with.
 *
 * It may be given as the token itself or as a function that is asked at the
 * moment the request goes out. The function is the honest way to hold a
 * token that expires: a token that was fresh when the connection opened is
 * stale ten minutes later, and a request that carries a stale token is
 * refused as unauthorized — the proof cannot save it, because the proof is
 * bound to the very token that expired.
 */
async function resolveAuthToken(authToken) {
  if (typeof authToken === "function") {
    const token = await authToken();
    return token || null;
  }
  return authToken || null;
}

export async function postJson(url, body, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const token = await resolveAuthToken(options.authToken);
  if (token) {
    // The proof is made here rather than left to the fetch wrapper, so that
    // the request is held to the key whichever fetch it is sent with. It is
    // made over the token this request carries, so the two agree.
    const proof = await options.proofProvider?.({
      method: "POST",
      url,
      token,
    });
    if (proof) {
      Object.assign(headers, proof);
    } else {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json().catch(() => ({}));
}

export class RelayClient {
  constructor({
    relayUrl,
    deviceId,
    authToken = null,
    proofProvider = null,
    authTokenProvider = null,
    heartbeatIntervalMs = 15_000,
    heartbeatTimeoutMs = 45_000,
    e2eeAckTimeoutMs = 30_000,
    now = () => Date.now(),
  }) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.authToken = authToken;
    // The WebSocket handshake cannot go through `fetch`, so it cannot be
    // covered by the fetch wrapper. It asks this instead, and gets the same
    // answer for the same reasons.
    this.proofProvider = proofProvider;
    // Where the bearer is asked for, when it has to be fresh at the moment
    // the request is sent. See [_resolveAuthToken].
    this.authTokenProvider = authTokenProvider;
    this.heartbeatIntervalMs = Math.max(10, Number(heartbeatIntervalMs) || 15_000);
    this.heartbeatTimeoutMs = Math.max(
      this.heartbeatIntervalMs * 2,
      Number(heartbeatTimeoutMs) || 45_000,
    );
    this.now = now;
    this.e2eeAckTimeoutMs = Math.max(1_000, Number(e2eeAckTimeoutMs) || 30_000);
    this._aborted = false;
    this._ws = null;
    this._e2eeAcks = new Map();
  }

  /**
   * Update the bearer used for subsequent calls. If the WebSocket is
   * currently open, close it so the next `connectEvents` re-opens
   * with the new header.
   */
  setAuthToken(token) {
    this.authToken = token;
    if (this._ws) {
      try {
        this._ws.close();
      } catch {}
      this._ws = null;
    }
  }

  /**
   * Ask for the bearer when a request is sent, rather than holding the one
   * that was current when the connection was opened.
   *
   * The client used to keep a single token and use it for every request.
   * That token was fresh when the relay connection opened and stale ten
   * minutes later, and only a reconnect replaced it — so every request made
   * in between was refused as unauthorized. The provider is asked instead,
   * and the token it returns is the one the proof is made over.
   *
   * A provider that has no token to give (a relay that runs without auth, or
   * a credential that has gone) falls back to the token the client already
   * holds, so a request that would have gone out still goes out.
   */
  setAuthTokenProvider(provider) {
    this.authTokenProvider = typeof provider === "function" ? provider : null;
  }

  async _resolveAuthToken() {
    if (this.authTokenProvider) {
      const token = await this.authTokenProvider();
      if (token) return token;
    }
    return this.authToken || null;
  }

  /**
   * Close the events socket for good and let `connectEvents` return.
   *
   * A wrapper opens its own relay socket while its daemon is unreachable and
   * hands relaying to the daemon once it connects. That socket used to stay
   * open: `connectEvents` only returns when its socket goes away, and nothing
   * closed it. It then kept the device "online" at the relay while every
   * frame it received was ignored — and when the daemon later dropped, the
   * cloud still had a live socket for the device, so a command sent to it
   * vanished instead of being refused as offline.
   */
  disconnect() {
    this._aborted = true;
    const ws = this._ws;
    this._ws = null;
    if (!ws) return;
    try {
      ws.close();
    } catch {}
  }

  async send(type, payload = {}) {
    const envelope = { type, deviceId: this.deviceId, ...payload };
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(envelope));
      return { ok: true, accepted: true, via: "ws" };
    }
    return postJson(
      `${this.relayUrl}/relay/v1/messages`,
      {
        target_device_id: payload.targetDeviceId || payload.deviceId || this.deviceId,
        payload: envelope,
      },
      { authToken: () => this._resolveAuthToken(), proofProvider: this.proofProvider },
    );
  }

  async sendAcknowledged(type, payload = {}) {
    const envelope = { type, deviceId: this.deviceId, ...payload };
    return postJson(`${this.relayUrl}/relay/v1/messages`, {
      target_device_id: payload.targetDeviceId || payload.deviceId || this.deviceId,
      payload: envelope,
    }, { authToken: () => this._resolveAuthToken(), proofProvider: this.proofProvider });
  }

  async sendEnvelope(envelope) {
    if (!envelope || envelope.protocol !== "e2ee-v2") {
      throw new Error("invalid E2EE relay envelope");
    }
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      const key = this._e2eeAckKey(envelope);
      if (this._e2eeAcks.has(key)) {
        throw new Error("duplicate pending E2EE relay envelope");
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._e2eeAcks.delete(key);
          resolve({
            ok: false,
            accepted: false,
            reason: "relay_ack_timeout",
            via: "ws",
          });
        }, this.e2eeAckTimeoutMs);
        timer.unref?.();
        this._e2eeAcks.set(key, { resolve, timer });
        try {
          this._ws.send(JSON.stringify(envelope), (error) => {
            if (!error) return;
            const pending = this._e2eeAcks.get(key);
            if (!pending) return;
            this._e2eeAcks.delete(key);
            clearTimeout(pending.timer);
            pending.resolve({
              ok: false,
              accepted: false,
              reason: "relay_send_failed",
              via: "ws",
            });
          });
        } catch {
          const pending = this._e2eeAcks.get(key);
          if (pending) {
            this._e2eeAcks.delete(key);
            clearTimeout(pending.timer);
            pending.resolve({
              ok: false,
              accepted: false,
              reason: "relay_send_failed",
              via: "ws",
            });
          }
        }
      });
    }
    return postJson(
      `${this.relayUrl}/relay/v1/messages`,
      {
        target_device_id: envelope.target_device_id,
        payload: envelope,
      },
      { authToken: () => this._resolveAuthToken(), proofProvider: this.proofProvider },
    );
  }

  _e2eeAckKey(payload) {
    return [
      String(payload?.session_id || ""),
      String(payload?.direction || ""),
      Number(payload?.sequence ?? -1),
    ].join(":");
  }

  _handleE2eeAck(payload) {
    if (payload?.type !== "ack" || !payload?.session_id) return false;
    const key = this._e2eeAckKey(payload);
    const pending = this._e2eeAcks.get(key);
    if (!pending) return false;
    this._e2eeAcks.delete(key);
    clearTimeout(pending.timer);
    pending.resolve({
      ok: payload.accepted === true,
      accepted: payload.accepted === true,
      reason: String(payload.reason || ""),
      via: "ws",
    });
    return true;
  }

  _failPendingE2eeAcks(reason = "relay_disconnected") {
    for (const pending of this._e2eeAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, accepted: false, reason, via: "ws" });
    }
    this._e2eeAcks.clear();
  }

  async connectEvents(onEvent, { onOpen, onClose, onAlive } = {}) {
    const url = new URL(`${this.relayUrl.replace(/\/+$/, "")}/relay/v1/devices/${encodeURIComponent(this.deviceId)}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const headers = {};
    // The handshake is the one request that cannot be retried with a
    // different token later, so it asks for one that is fresh now.
    const token = await this._resolveAuthToken();
    if (token) {
      const proof = await this.proofProvider?.({
        method: "GET",
        url: url.toString(),
        token,
      });
      if (proof) {
        Object.assign(headers, proof);
      } else {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      let heartbeatTimer = null;
      let lastActivityAt = this.now();
      const markActivity = () => {
        lastActivityAt = this.now();
        try { onAlive?.(); } catch {}
      };
      const stopHeartbeat = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      };
      this._ws = ws;
      ws.once("open", () => {
        markActivity();
        // WebSocket close notifications are best-effort across mobile
        // networks, reverse proxies, and worker restarts. Keep the server's
        // connection-scoped presence lease alive explicitly instead of
        // relying on a device-wide Redis flag.
        const renewPresence = () => {
          if (this._ws !== ws || ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.send(JSON.stringify({ type: "device.presence" }), (error) => {
              if (error) ws.terminate();
            });
          } catch {
            ws.terminate();
          }
        };
        renewPresence();
        heartbeatTimer = setInterval(() => {
          if (this._ws !== ws || ws.readyState !== WebSocket.OPEN) {
            stopHeartbeat();
            return;
          }
          if (this.now() - lastActivityAt >= this.heartbeatTimeoutMs) {
            ws.terminate();
            return;
          }
          renewPresence();
          try { ws.ping(); } catch { ws.terminate(); }
        }, this.heartbeatIntervalMs);
        heartbeatTimer.unref?.();
        try { onOpen?.(); } catch {}
        resolve();
      });
      ws.once("error", reject);
      ws.on("pong", markActivity);
      ws.on("message", (data) => {
        if (this._aborted) return;
        markActivity();
        try {
          const payload = JSON.parse(String(data));
          if (!this._handleE2eeAck(payload)) onEvent(payload);
        } catch {}
      });
      ws.once("close", () => {
        stopHeartbeat();
        if (this._ws === ws) this._ws = null;
        this._failPendingE2eeAcks();
        try { onClose?.(); } catch {}
      });
    });
    const connectedSocket = this._ws;
    while (!this._aborted && this._ws === connectedSocket) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
