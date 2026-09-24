import { readApiToken } from "../persistence/authToken.js";
import { readDaemonState } from "../persistence/state.js";
import { LocalAuditStore } from "../persistence/localAuditStore.js";

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
  if (!response.ok)
    throw new Error(`local agent bridge HTTP ${response.status}`);
  return response.json();
}

export class LocalAgentBridgeClient {
  constructor({
    stateDir,
    sessionId,
    onCommand,
    onConnectionChange = null,
    pollIntervalMs = DEFAULT_POLL_MS,
  }) {
    this.stateDir = stateDir;
    this.sessionId = sessionId;
    this.auditStore = new LocalAuditStore({ stateDir });
    this.sessionMetadata = { sessionId };
    this.onCommand = onCommand;
    this.onConnectionChange = onConnectionChange;
    this.pollIntervalMs = pollIntervalMs;
    this.endpoint = null;
    this.commandCursor = 0;
    this.pollingCommands = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    // Events are produced by the terminal independently of the daemon's
    // availability. Keep a small in-memory outbox so a short daemon restart
    // cannot make a permission/interaction event disappear permanently.
    this.pendingEvents = [];
    this.flushingEvents = false;
    this.maxPendingEvents = 256;
    this.closed = false;
  }

  get connected() {
    return Boolean(this.endpoint);
  }

  setEndpoint(endpoint) {
    const wasConnected = this.connected;
    this.endpoint = endpoint;
    if (wasConnected !== this.connected) {
      try {
        this.onConnectionChange?.(this.connected);
      } catch {}
    }
  }

  async start(metadata) {
    this.sessionMetadata = { ...metadata, sessionId: this.sessionId };
    this.pollTimer = setInterval(
      () => void this.pollCommands(),
      this.pollIntervalMs,
    );
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 20_000);
    return this.connect();
  }

  async connect() {
    if (this.closed) return false;
    if (this.endpoint) return true;
    const endpoint = daemonEndpoint(this.stateDir);
    if (!endpoint) return false;
    try {
      await request(
        endpoint,
        "POST",
        "/agent/local/sessions/register",
        this.sessionMetadata,
      );
      this.setEndpoint(endpoint);
      void this.flushEvents();
      return true;
    } catch {
      this.setEndpoint(null);
      return false;
    }
  }

  async update(payload) {
    // Keep reconnect registration authoritative even when the daemon is
    // temporarily unavailable. Claude can switch its native conversation via
    // /clear or /resume while the bridge is disconnected.
    this.sessionMetadata = { ...this.sessionMetadata, ...payload };
    if (this.closed || !(await this.connect())) return false;
    try {
      await request(
        this.endpoint,
        "POST",
        `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/update`,
        payload,
      );
      return true;
    } catch {
      this.setEndpoint(null);
      return false;
    }
  }

  async sendEvent(event) {
    if (this.closed) return false;
    this.pendingEvents.push(event);
    if (this.pendingEvents.length > this.maxPendingEvents) {
      const dropped = this.pendingEvents.shift();
      // The audit chain remains the durable fallback for events that cannot
      // be delivered before the bounded outbox fills up.
      if (dropped) this.auditStore.appendEvent(this.sessionMetadata, dropped);
    }
    return this.flushEvents();
  }

  async flushEvents() {
    if (this.closed || this.flushingEvents) return this.pendingEvents.length === 0;
    this.flushingEvents = true;
    let delivered = true;
    try {
      if (!(await this.connect())) return false;
      while (this.pendingEvents.length > 0 && this.endpoint && !this.closed) {
        const event = this.pendingEvents[0];
        try {
          await request(
            this.endpoint,
            "POST",
            `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/events`,
            { event },
          );
          this.pendingEvents.shift();
        } catch {
          delivered = false;
          this.setEndpoint(null);
          break;
        }
      }
      return delivered && this.pendingEvents.length === 0;
    } finally {
      this.flushingEvents = false;
    }
  }

  async pollCommands() {
    if (this.closed || this.pollingCommands || !(await this.connect())) return;
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
      this.commandCursor = Math.max(
        this.commandCursor,
        Number(data.cursor || 0),
      );
    } catch {
      // The daemon may be restarting. Remote Relay remains independent.
      this.setEndpoint(null);
    } finally {
      this.pollingCommands = false;
    }
  }

  async heartbeat() {
    if (!(await this.connect())) return false;
    return this.update({ status: "running" });
  }

  async close(status = "stopped") {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const endpoint = this.endpoint;
    this.setEndpoint(null);
    for (const event of this.pendingEvents.splice(0)) {
      this.auditStore.appendEvent(this.sessionMetadata, event);
    }
    if (!endpoint) return;
    try {
      await request(
        endpoint,
        "POST",
        `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/unregister`,
        { status },
      );
    } catch {}
  }
}
