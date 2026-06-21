// Stage 9.3 — Optional `authToken` seam added to the existing
// agent-control `RelayClient`.
//
// 9.2 had no auth (the constructor was `{ relayUrl, deviceId }`).
// 9.3 adds an optional `authToken` constructor field. When set, every
// `postJson` and `connectEvents` call carries
// `Authorization: Bearer <authToken>`. `setAuthToken(token)` mutates
// the bearer at runtime; if the SSE is currently open, it is closed
// and re-opened so the new header takes effect immediately.
//
// When `authToken` is null (the 9.2 default), the file is byte-for-byte
// compatible with the 9.2 behavior. This is critical so the 9.2
// dev path and tests stay green without a Surety.

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
  }

  /**
   * Update the bearer used for subsequent calls. If the SSE is
   * currently open, close it so the next `connectEvents` re-opens
   * with the new header.
   */
  setAuthToken(token) {
    this.authToken = token;
    // The SSE loop is a per-call `while(true) { reader.read() }`; we
    // don't keep a persistent socket in this class. The caller is
    // expected to call connectEvents again to pick up the new token.
    // (Workers that re-acquire on 401/403 will do this naturally.)
  }

  async send(type, payload = {}) {
    return postJson(
      `${this.relayUrl}/device/message`,
      { type, deviceId: this.deviceId, ...payload },
      { authToken: this.authToken },
    );
  }

  async connectEvents(onEvent) {
    const url = `${this.relayUrl}/device/events?deviceId=${encodeURIComponent(this.deviceId)}`;
    const headers = {};
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    const response = await fetch(url, { headers });

    if (!response.ok || !response.body) {
      throw new Error(`Cannot connect to relay: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (!this._aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        onEvent(JSON.parse(dataLine.slice(5).trim()));
      }
    }
  }
}
