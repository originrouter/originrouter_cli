import WebSocket from "ws";

// OriginRouter unified server relay client.
//
// The unified FastAPI server exposes:
//   WSS  /relay/v1/devices/{device_id}/ws
//   POST /relay/v1/messages

export async function postJson(url, body, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.authToken) {
    headers.Authorization = `Bearer ${options.authToken}`;
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
  constructor({ relayUrl, deviceId, authToken = null }) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
    this.authToken = authToken;
    this._aborted = false;
    this._ws = null;
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
      { authToken: this.authToken },
    );
  }

  async connectEvents(onEvent, { onOpen, onClose } = {}) {
    const url = new URL(`${this.relayUrl.replace(/\/+$/, "")}/relay/v1/devices/${encodeURIComponent(this.deviceId)}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const headers = {};
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      this._ws = ws;
      ws.once("open", () => {
        try { onOpen?.(); } catch {}
        resolve();
      });
      ws.once("error", reject);
      ws.on("message", (data) => {
        if (this._aborted) return;
        try {
          onEvent(JSON.parse(String(data)));
        } catch {}
      });
      ws.once("close", () => {
        if (this._ws === ws) this._ws = null;
        try { onClose?.(); } catch {}
      });
    });
    while (!this._aborted && this._ws) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
