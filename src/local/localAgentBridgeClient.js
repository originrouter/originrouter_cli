import { readApiToken } from "../persistence/authToken.js";
import { readDaemonState } from "../persistence/state.js";

const DEFAULT_POLL_MS = 250;

function daemonEndpoint(stateDir) {
  const state = readDaemonState();
  const token = readApiToken(stateDir);
  const baseUrl = String(state?.localApiBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

async function request(endpoint, method, path, body = null) {
  const response = await fetch(`${endpoint.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`local agent bridge HTTP ${response.status}`);
  return response.json();
}

export class LocalAgentBridgeClient {
  constructor({ stateDir, sessionId, onCommand, pollIntervalMs = DEFAULT_POLL_MS }) {
    this.stateDir = stateDir;
    this.sessionId = sessionId;
    this.onCommand = onCommand;
    this.pollIntervalMs = pollIntervalMs;
    this.endpoint = null;
    this.commandCursor = 0;
    this.pollingCommands = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    this.closed = false;
  }

  async start(metadata) {
    this.endpoint = daemonEndpoint(this.stateDir);
    if (!this.endpoint) return false;
    try {
      await request(this.endpoint, "POST", "/agent/local/sessions/register", {
        ...metadata,
        sessionId: this.sessionId,
      });
    } catch {
      this.endpoint = null;
      return false;
    }
    this.pollTimer = setInterval(() => void this.pollCommands(), this.pollIntervalMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 20_000);
    return true;
  }

  async update(payload) {
    if (!this.endpoint || this.closed) return false;
    try {
      await request(
        this.endpoint,
        "POST",
        `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/update`,
        payload,
      );
      return true;
    } catch {
      return false;
    }
  }

  async sendEvent(event) {
    if (!this.endpoint || this.closed) return false;
    try {
      await request(
        this.endpoint,
        "POST",
        `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/events`,
        { event },
      );
      return true;
    } catch {
      return false;
    }
  }

  async pollCommands() {
    if (!this.endpoint || this.closed || this.pollingCommands) return;
    this.pollingCommands = true;
    try {
      const result = await request(
        this.endpoint,
        "GET",
        `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/commands?after=${this.commandCursor}`,
      );
      const data = result?.data || result || {};
      for (const command of data.commands || []) {
        const sequence = Number(command?.commandSequence || 0);
        if (sequence > 0 && sequence <= this.commandCursor) continue;
        if (sequence > 0) {
          // Advance before applying the command so a slow handler cannot cause
          // the same terminal input to be replayed by another poll.
          this.commandCursor = Math.max(this.commandCursor, sequence);
        }
        await this.onCommand?.(command);
      }
      this.commandCursor = Math.max(this.commandCursor, Number(data.cursor || 0));
    } catch {
      // The daemon may be restarting. Remote Relay remains independent.
    } finally {
      this.pollingCommands = false;
    }
  }

  async heartbeat() {
    return this.update({ status: "running" });
  }

  async close(status = "stopped") {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!this.endpoint) return;
    try {
      await request(
        this.endpoint,
        "POST",
        `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/unregister`,
        { status },
      );
    } catch {}
  }
}
