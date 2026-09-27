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
    endpointProvider = daemonEndpoint,
  }) {
    this.stateDir = stateDir;
    this.sessionId = sessionId;
    this.auditStore = new LocalAuditStore({ stateDir });
    this.sessionMetadata = { sessionId };
    this.latestStatusEvents = new Map();
    this.onCommand = onCommand;
    this.onConnectionChange = onConnectionChange;
    this.pollIntervalMs = pollIntervalMs;
    this.endpointProvider = endpointProvider;
    this.endpoint = null;
    this.commandCursor = 0;
    this.commandStreamId = null;
    this.pollingCommands = false;
    this.pollTimer = null;
    this.heartbeatTimer = null;
    // Events are produced by the terminal independently of the daemon's
    // availability. Keep a small in-memory outbox so a short daemon restart
    // cannot make a permission/interaction event disappear permanently.
    this.pendingEvents = [];
    this.pendingInteractions = new Map();
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
    const endpoint = this.endpointProvider(this.stateDir);
    if (!endpoint) return false;
    try {
      await request(
        endpoint,
        "POST",
        "/agent/local/sessions/register",
        this.sessionMetadata,
      );
      this.setEndpoint(endpoint);
      // Delivered requests are no longer in the outbox, but can still be
      // waiting in the native terminal when the daemon loses its memory.
      // Rehydrate them on reconnect. Stable event ids deduplicate a normal
      // reconnect to the same daemon.
      for (const event of [...this.latestStatusEvents.values(), ...this.pendingInteractions.values()]) {
        if (!this.pendingEvents.some((queued) => queued === event ||
            (event.eventId && queued.eventId === event.eventId))) {
          this.pendingEvents.push(event);
        }
      }
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
    if (payload.conversationId && this.sessionMetadata.conversationId &&
        payload.conversationId !== this.sessionMetadata.conversationId) {
      this.pendingInteractions.clear();
    }
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
    if (["agent.autonomy.status", "agent.mode.status", "agent.detail.status"].includes(event?.type)) {
      // The runtime outlives the daemon. Reconnect must rehydrate current
      // configuration even when its original telemetry was delivered.
      this.latestStatusEvents.set(event.type, event);
      if (event.type === "agent.autonomy.status") {
        this.sessionMetadata = { ...this.sessionMetadata,
          autonomyProfile: event.autonomyProfile,
          autonomyRevision: event.autonomyRevision,
          autonomyControl: event.autonomyControl,
          availableAutonomyProfiles: event.availableAutonomyProfiles,
          allowedAutonomyScopes: event.allowedAutonomyScopes,
          availableAutonomyScopes: event.availableAutonomyScopes,
          approvalPolicy: event.approvalPolicy, aiReviewPolicy: event.aiReviewPolicy,
        };
      }
    }
    const interactionId = event?.interactionId || event?.callId;
    if (interactionId && event.type === "agent.interaction.requested") {
      this.pendingInteractions.set(interactionId, event);
    } else if (interactionId && (
      (event.type === "agent.interaction.result" &&
        ["applied", "expired", "canceled", "failed", "not_found"].includes(event.status)) ||
      ["agent.permission.resolved", "agent.interaction.applied", "agent.interaction.expired",
        "agent.interaction.canceled", "agent.interaction.failed", "agent.interaction.auto_resolved"].includes(event.type)
    )) {
      this.pendingInteractions.delete(interactionId);
    }
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
      let data;
      // Sequence numbers belong to one daemon/session command stream, not
      // the lifetime of this terminal wrapper. A restarted daemon starts at
      // one again, even when the wrapper has already consumed many commands.
      for (let attempt = 0; attempt < 2; attempt++) {
        const after = this.commandCursor;
        const result = await request(
          this.endpoint,
          "GET",
          `/agent/local/sessions/${encodeURIComponent(this.sessionId)}/commands?after=${after}`,
        );
        data = result?.data || result || {};
        const streamId = data.streamId || null;
        if (streamId && streamId !== this.commandStreamId) {
          this.commandStreamId = streamId;
          this.commandCursor = 0;
          if (after > 0) {
            // The first response was filtered using the old cursor. Fetch
            // from zero rather than treating that empty response as an ack.
            if (attempt === 1) return;
            continue;
          }
        }
        break;
      }
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
