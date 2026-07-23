import { randomUUID } from "node:crypto";

import { readClaudeConversationHistory } from "../runtime/claudeConversationHistory.js";
import { readCodexConversationHistory } from "../adapters/codex/jsonlScanner.js";

const MAX_EVENTS = 500;
const MAX_COMMANDS = 200;
const STALE_AFTER_MS = 90_000;

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

export class ExternalAgentRegistry {
  constructor({ now = () => Date.now(), catalog = null } = {}) {
    this.now = now;
    this.catalog = catalog;
    this.sessions = new Map();
    this.eventCursor = 0;
    this.listeners = new Set();
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(type, sessionId, payload = {}) {
    for (const listener of this.listeners) {
      try { listener({ type, sessionId, payload }); } catch {}
    }
  }

  register(payload) {
    const sessionId = safeText(payload?.sessionId, 64);
    if (!sessionId) throw new Error("sessionId is required");
    const existing = this.sessions.get(sessionId);
    const session = {
      sessionId,
      agent: safeText(payload?.agent, 32) || "unknown",
      title: safeText(payload?.title, 191) || `${payload?.agent || "Agent"} session`,
      deviceId: safeText(payload?.deviceId, 191),
      deviceName: safeText(payload?.deviceName, 191),
      cwd: safeText(payload?.cwd, 1024),
      pid: Number(payload?.pid) || null,
      status: "running",
      transcriptPath: safeText(payload?.transcriptPath, 4096) || existing?.transcriptPath || "",
      startedAt: safeText(payload?.startedAt, 64) || existing?.startedAt || nowIso(),
      lastSeenAtMs: this.now(),
      events: existing?.events || [],
      eventSequence: existing?.eventSequence || 0,
      commands: existing?.commands || [],
      commandSequence: existing?.commandSequence || 0,
      pendingInteractions: existing?.pendingInteractions || new Set(),
      mode: safeText(payload?.mode, 32) || existing?.mode || "default",
      modeControl: safeText(payload?.modeControl, 16) || existing?.modeControl || "unsupported",
      availableModes: Array.isArray(payload?.availableModes)
        ? payload.availableModes.slice(0, 16)
        : existing?.availableModes || [],
      autonomyProfile: safeText(payload?.autonomyProfile, 32) || existing?.autonomyProfile || "manual",
      autonomyControl: safeText(payload?.autonomyControl, 16) || existing?.autonomyControl || "unsupported",
      availableAutonomyProfiles: Array.isArray(payload?.availableAutonomyProfiles)
        ? payload.availableAutonomyProfiles.slice(0, 8)
        : existing?.availableAutonomyProfiles || [],
      allowedAutonomyScopes: Array.isArray(payload?.allowedAutonomyScopes)
        ? payload.allowedAutonomyScopes.slice(0, 32)
        : existing?.allowedAutonomyScopes || [],
      availableAutonomyScopes: Array.isArray(payload?.availableAutonomyScopes)
        ? payload.availableAutonomyScopes.slice(0, 32)
        : existing?.availableAutonomyScopes || [],
      detailProfile: safeText(payload?.detailProfile, 16) || existing?.detailProfile || "concise",
      detailSource: safeText(payload?.detailSource, 32) || existing?.detailSource || "builtin_default",
      currentStep: existing?.currentStep || "Running locally",
    };
    this.sessions.set(sessionId, session);
    try { this.catalog?.upsertSession(payload); } catch {}
    this.notify("registered", sessionId, { ...payload, session: this.project(session) });
    return this.project(session);
  }

  update(sessionId, payload = {}) {
    const session = this.require(sessionId);
    if (payload.transcriptPath) {
      session.transcriptPath = safeText(payload.transcriptPath, 4096);
    }
    if (payload.status) session.status = safeText(payload.status, 32);
    session.lastSeenAtMs = this.now();
    try { this.catalog?.updateSession(sessionId, payload); } catch {}
    this.notify("updated", sessionId, payload);
    return this.project(session);
  }

  heartbeat(sessionId) {
    const session = this.require(sessionId);
    session.lastSeenAtMs = this.now();
    return this.project(session);
  }

  unregister(sessionId, { status = "stopped" } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = safeText(status, 32) || "stopped";
    session.lastSeenAtMs = this.now();
    try {
      this.catalog?.finishSession(sessionId, {
        status: session.status,
        exitedAt: new Date(this.now()).toISOString(),
      });
    } catch {}
    this.sessions.delete(sessionId);
    this.notify("unregistered", sessionId, { status: session.status });
    return true;
  }

  appendEvent(sessionId, event) {
    const session = this.require(sessionId);
    session.eventSequence += 1;
    this.eventCursor += 1;
    session.lastSeenAtMs = this.now();
    const storedEvent = {
      ...event,
      eventId: safeText(event?.eventId, 96) || `local_event_${randomUUID()}`,
      sessionId,
      localSequence: session.eventSequence,
      localCursor: this.eventCursor,
      createdAt: event?.createdAt || Math.floor(this.now() / 1000),
    };
    session.events.push(storedEvent);
    const interactionId = String(event?.interactionId || event?.callId || "");
    if (event?.type === "agent.interaction.requested" && interactionId) {
      session.pendingInteractions.add(interactionId);
    }
    if (
      interactionId
      && [
        "agent.interaction.applied",
        "agent.interaction.expired",
        "agent.interaction.canceled",
        "agent.interaction.failed",
        "agent.permission.resolved",
      ].includes(event?.type)
    ) {
      session.pendingInteractions.delete(interactionId);
    }
    if (
      event?.type === "agent.interaction.result"
      && interactionId
      && ["applied", "expired", "canceled", "failed", "not_found"].includes(event?.status)
    ) {
      session.pendingInteractions.delete(interactionId);
    }
    if (event?.type === "agent.mode.status") {
      session.mode = safeText(event?.mode, 32) || session.mode;
      session.modeControl = safeText(event?.modeControl, 16) || session.modeControl;
      session.availableModes = Array.isArray(event?.availableModes)
        ? event.availableModes.slice(0, 16)
        : session.availableModes;
    }
    if (event?.type === "agent.autonomy.status") {
      session.autonomyProfile = safeText(event?.autonomyProfile, 32) || session.autonomyProfile;
      session.autonomyControl = safeText(event?.autonomyControl, 16) || session.autonomyControl;
      session.availableAutonomyProfiles = Array.isArray(event?.availableAutonomyProfiles)
        ? event.availableAutonomyProfiles.slice(0, 8)
        : session.availableAutonomyProfiles;
      session.allowedAutonomyScopes = Array.isArray(event?.allowedAutonomyScopes)
        ? event.allowedAutonomyScopes.slice(0, 32)
        : session.allowedAutonomyScopes;
      session.availableAutonomyScopes = Array.isArray(event?.availableAutonomyScopes)
        ? event.availableAutonomyScopes.slice(0, 32)
        : session.availableAutonomyScopes;
    }
    if (event?.type === "agent.detail.status") {
      session.detailProfile = safeText(event?.detailProfile, 16) || session.detailProfile;
      session.detailSource = safeText(event?.detailSource, 32) || session.detailSource;
    }
    session.currentStep = this.stepForEvent(event, session.currentStep);
    try { this.catalog?.recordEvent(sessionId, event); } catch {}
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    this.notify("event", sessionId, storedEvent);
    return session.eventSequence;
  }

  eventsAfter(after = 0, { sessionIds = null } = {}) {
    const wanted = Array.isArray(sessionIds) && sessionIds.length > 0
      ? new Set(sessionIds.map(String))
      : null;
    const events = [];
    let cursor = Number(after) || 0;
    for (const session of this.sessions.values()) {
      if (wanted && !wanted.has(session.sessionId)) continue;
      for (const event of session.events) {
        const eventCursor = Number(event.localCursor || 0);
        if (eventCursor > Number(after || 0)) events.push(event);
        cursor = Math.max(cursor, eventCursor);
      }
    }
    events.sort((a, b) => Number(a.localCursor || 0) - Number(b.localCursor || 0));
    return { events, cursor };
  }

  enqueueCommand(sessionId, command) {
    const session = this.requireActive(sessionId);
    session.commandSequence += 1;
    const item = {
      ...command,
      commandId: safeText(command?.commandId, 96) || `local_command_${randomUUID()}`,
      commandSequence: session.commandSequence,
      createdAt: Math.floor(this.now() / 1000),
    };
    session.commands.push(item);
    if (session.commands.length > MAX_COMMANDS) {
      session.commands.splice(0, session.commands.length - MAX_COMMANDS);
    }
    return item;
  }

  commandsAfter(sessionId, after = 0) {
    const session = this.requireActive(sessionId);
    const commands = session.commands.filter(
      (item) => Number(item.commandSequence || 0) > Number(after || 0),
    );
    return { commands, cursor: session.commandSequence };
  }

  history(sessionId, options) {
    const session = this.require(sessionId);
    if (session.agent === "claude") {
      return {
        ...readClaudeConversationHistory(session.transcriptPath, options),
        detailProfile: session.detailProfile,
        detailSource: session.detailSource,
      };
    }
    if (session.agent === "codex") {
      return {
        ...readCodexConversationHistory(session.transcriptPath, options),
        detailProfile: session.detailProfile,
        detailSource: session.detailSource,
      };
    }
    return {
      messages: [],
      nextCursor: null,
      hasMore: false,
      detailProfile: session.detailProfile,
      detailSource: session.detailSource,
    };
  }

  list() {
    this.expireStale();
    return Array.from(this.sessions.values()).map((session) => this.project(session));
  }

  expireStale() {
    const cutoff = this.now() - STALE_AFTER_MS;
    for (const session of this.sessions.values()) {
      if (session.status === "running" && session.lastSeenAtMs < cutoff) {
        session.status = "stopped";
        try {
          this.catalog?.finishSession(session.sessionId, {
            status: "stopped",
            exitedAt: new Date(this.now()).toISOString(),
          });
        } catch {}
      }
    }
  }

  project(session) {
    return {
      session_id: session.sessionId,
      agent_type: session.agent,
      title: session.title,
      status: session.status,
      device_id: session.deviceId,
      device_name: session.deviceName,
      current_step: session.status === "running" ? session.currentStep : "Stopped",
      last_activity_at: new Date(session.lastSeenAtMs).toISOString(),
      pending_approval_count: session.pendingInteractions.size,
      control_path: "local",
      mode: session.mode,
      mode_control: session.modeControl,
      available_modes: session.availableModes,
      autonomy_profile: session.autonomyProfile,
      autonomy_control: session.autonomyControl,
      available_autonomy_profiles: session.availableAutonomyProfiles,
      allowed_autonomy_scopes: session.allowedAutonomyScopes,
      available_autonomy_scopes: session.availableAutonomyScopes,
      detail_profile: session.detailProfile,
      detail_source: session.detailSource,
    };
  }

  stepForEvent(event, fallback) {
    switch (event?.type) {
      case "agent.interaction.requested": return "Waiting for input";
      case "agent.interaction.result":
        return event?.status === "applying" ? "Applying response" : "Running locally";
      case "agent.interaction.auto_resolved": return "Continuing automatically";
      case "agent.thinking": return "Thinking";
      case "agent.tool_call.start": return `Running ${safeText(event?.tool, 64) || "tool"}`;
      case "agent.tool_call.end": return "Running locally";
      case "agent.task.started": return "Working";
      case "agent.task.complete": return "Ready";
      case "agent.task.aborted": return "Interrupted";
      case "agent.ready": return "Ready";
      case "agent.activity": return safeText(event?.summary, 191) || "Running locally";
      case "agent.detail.status": return fallback || "Running locally";
      default: return fallback || "Running locally";
    }
  }

  require(sessionId) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session) {
      const error = new Error("unknown local agent session");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    return session;
  }

  requireActive(sessionId) {
    const session = this.require(sessionId);
    if (session.status !== "running") {
      const error = new Error("local agent session is not active");
      error.code = "SESSION_NOT_ACTIVE";
      throw error;
    }
    return session;
  }
}
