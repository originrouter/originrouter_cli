export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json().catch(() => ({}));
}

export class RelayClient {
  constructor({ relayUrl, deviceId }) {
    this.relayUrl = relayUrl;
    this.deviceId = deviceId;
  }

  async send(type, payload = {}) {
    return postJson(`${this.relayUrl}/device/message`, {
      type,
      deviceId: this.deviceId,
      ...payload,
    });
  }

  async connectEvents(onEvent) {
    const url = `${this.relayUrl}/device/events?deviceId=${encodeURIComponent(this.deviceId)}`;
    const response = await fetch(url);

    if (!response.ok || !response.body) {
      throw new Error(`Cannot connect to relay: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
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
