import { randomUUID } from "node:crypto";
import { workspaceDisplayPath } from "../persistence/agentCatalog.js";

import { readClaudeConversationHistory } from "../runtime/claudeConversationHistory.js";
import { readCodexConversationHistory } from "../adapters/codex/jsonlScanner.js";
import { isCollaborationSessionPayload } from "../runtime/agentSessionKind.js";

export { isCollaborationSessionPayload } from "../runtime/agentSessionKind.js";

const MAX_EVENTS = 500;
const MAX_COMMANDS = 200;
const STALE_AFTER_MS = 90_000;

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function canonicalTurnEventType(value) {
  const type = safeText(value, 96).trim();
  return ({
    "agent.task.completed": "agent.task.complete",
    task_complete: "agent.task.complete",
    task_completed: "agent.task.complete",
    task_result_ready: "agent.task.complete",
    task_failed: "agent.task.failed",
    turn_aborted: "agent.task.aborted",
    task_aborted: "agent.task.aborted",
    "agent.task.interrupted": "agent.task.aborted",
    task_started: "agent.task.started",
    "agent.task.start": "agent.task.started",
  })[type] || type;
}

function turnStateForEvent(event, fallback = "unknown") {
  const type = canonicalTurnEventType(event?.type);
  if ([
    "agent.interaction.requested",
    "approval_requested",
    "interaction_requested",
  ].includes(type)) {
    return safeText(event?.kind, 32) === "permission"
      || safeText(event?.status, 32) === "waiting_approval"
      ? "waiting_approval"
      : "waiting_input";
  }
  if ([
    "agent.task.started",
    "agent.tool_call.start",
    "tool_call",
  ].includes(type)) return "running";
  if ([
    "agent.task.complete",
    "agent.task.failed",
    "agent.task.aborted",
    "agent.ready",
    "session_completed",
    "session_failed",
    "session_stopped",
    "session_terminated",
  ].includes(type)) return "idle";
  if ([
    "agent.interaction.applied",
    "agent.interaction.expired",
    "agent.interaction.canceled",
    "agent.interaction.failed",
    "agent.permission.resolved",
    "agent.interaction.auto_resolved",
    "approval_applied",
    "approval_expired",
    "approval_failed",
    "interaction_applied",
    "interaction_expired",
    "interaction_canceled",
    "interaction_failed",
    "agent.interaction.result",
    // `agent.thinking` may only LIFT an active turn, never open one. A thinking
    // block is content inside an assistant message, not a turn boundary, and
    // the SDK's result message can land before it, so a turn routinely looks
    // like `agent.task.started → task_result_ready → agent.thinking →
    // agent.text`. Reading that trailing thinking as a fresh turn start
    // re-latched a finished turn to "running" and left the App showing a stop
    // button for an idle Agent. Production agrees it never opens a turn: of 198
    // `agent.thinking` rows, 0 lacked an earlier `agent.task.started` in the
    // same session.
    "agent.thinking",
  ].includes(type)) {
    if (type === "agent.interaction.result" &&
        !["applied", "expired", "canceled", "failed", "not_found"].includes(event?.status)) {
      return fallback;
    }
    // A delayed permission timeout/result must not restart a completed turn.
    // Same rule for a trailing thinking block.
    return fallback === "idle" ? "idle" : "running";
  }
  return fallback;
}

// Turn activity is latched by turn events alone (see `turnStateForEvent`).
// `session.status` describes the long-lived CLI process: a healthy idle Agent
// sits at `running` for hours, so it must never imply an active turn. Pending
// interactions are the authoritative source for the waiting states because the
// latch cannot observe an approval that expired without an event.
function resolveTurnState(session, publicStatus) {
  if (publicStatus === "waiting_approval" || publicStatus === "waiting_input") {
    return publicStatus;
  }
  if (publicStatus === "waiting_device") return "waiting_device";
  // A process that is gone cannot own a turn, whatever the latch last saw.
  if (publicStatus !== "running") return "idle";
  const latched = safeText(session?.turnState, 32);
  return latched === "running" ? "running" : "idle";
}

function isInternalTelemetryActivity(event) {
  if (event?.type !== "agent.activity") return false;
  return new Set([
    "commands_changed",
    "hook",
    "mcp_status",
    "memory_recall",
    "notification",
    "rate_limit",
    "settings_applied",
  ]).has(safeText(event?.activity, 64));
}

function approvalPolicySummary(value) {
  if (!value || typeof value !== "object") return null;
  const id = safeText(value.id, 64);
  const revision = safeText(value.revision, 128);
  if (!id || !revision) return null;
  return {
    id,
    name: safeText(value.name, 128) || id,
    revision,
    source: safeText(value.source, 32) || "device",
  };
}

function aiReviewPolicySummary(value) {
  if (!value || typeof value !== "object") return null;
  const templateId = safeText(value.templateId, 84);
  const contentHash = safeText(value.contentHash, 64);
  const version = Number(value.version);
  if (!templateId || !/^[a-f0-9]{64}$/.test(contentHash) || !Number.isSafeInteger(version) || version < 0) return null;
  return { templateId, contentHash, version, name: safeText(value.name, 128) || templateId };
}

function approvalPolicyCapabilitiesSummary(value) {
  if (!value || typeof value !== "object") return null;
  const versions = Array.isArray(value.versions)
    ? value.versions.map(Number).filter(Number.isInteger).slice(0, 8)
    : [];
  const latestVersion = Number(value.latest_version);
  if (!versions.length || !Number.isInteger(latestVersion)) return null;
  return {
    versions,
    latest_version: latestVersion,
    registry_hash: safeText(value.registry_hash, 64),
  };
}

export class ExternalAgentRegistry {
  constructor({ now = () => Date.now(), catalog = null } = {}) {
    this.now = now;
    this.catalog = catalog;
    this.sessions = new Map();
    // Cursors are process-local. Consumers use this id to detect a daemon
    // restart before applying a cursor from the previous process.
    this.eventStreamId = `local_stream_${randomUUID()}`;
    this.eventCursor = 0;
    this.listeners = new Set();
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  has(sessionId) {
    return this.sessions.has(String(sessionId || ""));
  }

  isCollaborationSession(sessionId) {
    return this.sessions.get(String(sessionId || ""))?.sessionKind === "collaboration";
  }

  notify(type, sessionId, payload = {}) {
    for (const listener of this.listeners) {
      try {
        listener({ type, sessionId, payload });
      } catch {}
    }
  }

  // Attachment is the CLI's first-class presence fact: an Agent process is
  // attached from registration until it unregisters or goes stale. Cloud and
  // App state are projections of this, never a second source of truth.
  attachmentOf(sessionId) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      attached: session.attached !== false,
      attachedAtMs: Number(session.attachedAtMs) || null,
      detachedAtMs: Number(session.detachedAtMs) || null,
      lastSeenAtMs: Number(session.lastSeenAtMs) || null,
    };
  }

  register(payload) {
    const sessionId = safeText(payload?.sessionId, 64);
    if (!sessionId) throw new Error("sessionId is required");
    const existing = this.sessions.get(sessionId);
    const incomingConversationId = safeText(payload?.conversationId, 96);
    const conversationChanged = Boolean(
      existing &&
        incomingConversationId &&
        incomingConversationId !== existing.conversationId,
    );
    const session = {
      sessionId,
      sessionKind: existing?.sessionKind === "collaboration"
        || isCollaborationSessionPayload({ ...payload, sessionId })
        ? "collaboration" : "interactive",
      agent: safeText(payload?.agent, 32) || "unknown",
      title:
        safeText(payload?.title, 191) || `${payload?.agent || "Agent"} session`,
      deviceId: safeText(payload?.deviceId, 191),
      deviceName: safeText(payload?.deviceName, 191),
      cwd: safeText(payload?.cwd, 1024),
      pid: Number(payload?.pid) || null,
      status: "running",
      conversationId:
        incomingConversationId ||
        existing?.conversationId ||
        sessionId,
      nativeSessionId:
        safeText(payload?.nativeSessionId, 191) ||
        existing?.nativeSessionId ||
        "",
      transcriptPath:
        safeText(payload?.transcriptPath, 4096) ||
        existing?.transcriptPath ||
        "",
      startedAt:
        safeText(payload?.startedAt, 64) || existing?.startedAt || nowIso(),
      lastSeenAtMs: this.now(),
      // Re-registration is a fresh attach. The previous detach (if any) is
      // cleared so the cloud projection flips back to attached on one fact
      // instead of inferring it from a later event.
      attached: true,
      attachedAtMs: this.now(),
      detachedAtMs: null,
      events: conversationChanged ? [] : existing?.events || [],
      eventIds:
        (!conversationChanged && existing?.eventIds) ||
        new Set(
          (conversationChanged ? [] : existing?.events || [])
            .map((event) => safeText(event?.eventId, 96))
            .filter(Boolean),
        ),
      eventSequence: conversationChanged ? 0 : existing?.eventSequence || 0,
      commands: existing?.commands || [],
      commandSequence: existing?.commandSequence || 0,
      commandStreamId: existing?.commandStreamId || `local_commands_${randomUUID()}`,
      pendingInteractions:
        conversationChanged
          ? new Set()
          : existing?.pendingInteractions || new Set(),
      pendingInteractionRequests:
        conversationChanged
          ? new Map()
          : existing?.pendingInteractionRequests || new Map(),
      pendingInteractionKinds:
        conversationChanged
          ? new Map()
          : existing?.pendingInteractionKinds || new Map(),
      mode: safeText(payload?.mode, 32) || existing?.mode || "default",
      modeControl:
        safeText(payload?.modeControl, 16) ||
        existing?.modeControl ||
        "unsupported",
      availableModes: Array.isArray(payload?.availableModes)
        ? payload.availableModes.slice(0, 16)
        : existing?.availableModes || [],
      autonomyRevision: existing?.autonomyRevision || 0,
      autonomyProfile:
        existing?.autonomyStatus?.autonomyProfile || safeText(payload?.autonomyProfile, 32) ||
        existing?.autonomyProfile ||
        "manual",
      autonomyControl:
        safeText(payload?.autonomyControl, 16) ||
        existing?.autonomyControl ||
        "unsupported",
      availableAutonomyProfiles: Array.isArray(
        payload?.availableAutonomyProfiles,
      )
        ? payload.availableAutonomyProfiles.slice(0, 8)
        : existing?.availableAutonomyProfiles || [],
      allowedAutonomyScopes: Array.isArray(payload?.allowedAutonomyScopes)
        ? payload.allowedAutonomyScopes.slice(0, 32)
        : existing?.allowedAutonomyScopes || [],
      availableAutonomyScopes: Array.isArray(payload?.availableAutonomyScopes)
        ? payload.availableAutonomyScopes.slice(0, 32)
        : existing?.availableAutonomyScopes || [],
      approvalPolicy:
        Object.hasOwn(payload, "approvalPolicy")
          ? approvalPolicySummary(payload.approvalPolicy)
          : existing?.approvalPolicy || null,
      aiReviewPolicy: Object.hasOwn(payload || {}, "aiReviewPolicy")
        ? aiReviewPolicySummary(payload.aiReviewPolicy)
        : existing?.aiReviewPolicy || null,
      autonomyStatus: existing?.autonomyStatus || null,
      controlResults: existing?.controlResults || new Map(),
      approvalPolicyCapabilities:
        approvalPolicyCapabilitiesSummary(payload?.approvalPolicyCapabilities) ||
        existing?.approvalPolicyCapabilities ||
        null,
      detailProfile:
        safeText(payload?.detailProfile, 16) ||
        existing?.detailProfile ||
        "concise",
      detailSource:
        safeText(payload?.detailSource, 32) ||
        existing?.detailSource ||
        "builtin_default",
      currentStep: conversationChanged
        ? "Running locally"
        : existing?.currentStep || "Running locally",
      // Registration means a freshly attached Agent process, so no turn can be
      // in flight yet. Inheriting `running` here left a reconnected session
      // showing a stop button until the next terminal event arrived — which
      // never comes when the turn ended while the App was away. A genuinely
      // running turn re-arms the latch on its next event.
      turnState: "idle",
    };
    this.sessions.set(sessionId, session);
    try {
      this.catalog?.upsertSession({ ...payload, sessionKind: session.sessionKind });
    } catch {}
    this.notify("registered", sessionId, {
      ...payload,
      session: this.project(session),
    });
    return this.project(session);
  }

  update(sessionId, payload = {}) {
    const session = this.require(sessionId);
    const nextConversationId = safeText(payload.conversationId, 96);
    if (nextConversationId && nextConversationId !== session.conversationId) {
      session.conversationId = nextConversationId;
      session.events = [];
      session.eventIds = new Set();
      session.eventSequence = 0;
      session.pendingInteractions = new Set();
      session.pendingInteractionRequests = new Map();
      session.pendingInteractionKinds = new Map();
      session.currentStep = "Running locally";
      session.turnState = "idle";
    }
    if (payload.nativeSessionId) {
      session.nativeSessionId = safeText(payload.nativeSessionId, 191);
    }
    if (payload.transcriptPath) {
      session.transcriptPath = safeText(payload.transcriptPath, 4096);
    }
    if (payload.status) session.status = safeText(payload.status, 32);
    if (payload.turnState || payload.turn_state) {
      session.turnState = safeText(payload.turnState || payload.turn_state, 32);
    }
    session.lastSeenAtMs = this.now();
    try {
      this.catalog?.updateSession(sessionId, payload);
    } catch {}
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
    session.attached = false;
    session.detachedAtMs = this.now();
    try {
      this.catalog?.finishSession(sessionId, {
        status: session.status,
        exitedAt: new Date(this.now()).toISOString(),
      });
    } catch {}
    // Keep the session in the registry briefly so the detach notification can
    // be forwarded before any later lookup fails. It is removed on the next
    // pass once the projection has been emitted.
    this.notify("unregistered", sessionId, {
      status: session.status,
      attached: false,
      detachedAt: new Date(session.detachedAtMs).toISOString(),
      session: this.project(session),
    });
    this.sessions.delete(sessionId);
    return true;
  }

  appendEvent(sessionId, event) {
    const session = this.require(sessionId);
    const providedEventId = safeText(event?.eventId, 96);
    if (providedEventId && session.eventIds.has(providedEventId)) {
      return session.eventSequence;
    }
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
    session.eventIds.add(storedEvent.eventId);
    const interactionId = String(event?.interactionId || event?.callId || "");
    if ([
      "agent.interaction.requested",
      "approval_requested",
      "interaction_requested",
    ].includes(event?.type) && interactionId) {
      session.pendingInteractions.add(interactionId);
      session.pendingInteractionRequests.set(interactionId, storedEvent);
      session.pendingInteractionKinds.set(
        interactionId,
        safeText(event?.kind, 32) || "input",
      );
    }
    if (
      interactionId &&
      [
        "agent.interaction.applied",
        "agent.interaction.expired",
        "agent.interaction.canceled",
        "agent.interaction.failed",
        "agent.permission.resolved",
        "agent.interaction.auto_resolved",
      ].includes(event?.type)
    ) {
      session.pendingInteractions.delete(interactionId);
      session.pendingInteractionRequests.delete(interactionId);
      session.pendingInteractionKinds.delete(interactionId);
    }
    if (
      event?.type === "agent.interaction.result" &&
      interactionId &&
      ["applied", "expired", "canceled", "failed", "not_found"].includes(
        event?.status,
      )
    ) {
      session.pendingInteractions.delete(interactionId);
      session.pendingInteractionRequests.delete(interactionId);
      session.pendingInteractionKinds.delete(interactionId);
    }
    if (event?.type === "agent.mode.status") {
      session.mode = safeText(event?.mode, 32) || session.mode;
      session.modeControl =
        safeText(event?.modeControl, 16) || session.modeControl;
      session.availableModes = Array.isArray(event?.availableModes)
        ? event.availableModes.slice(0, 16)
        : session.availableModes;
    }
    if (event?.type === "agent.autonomy.status" &&
        (Number(event.autonomyRevision || 0) >= Number(session.autonomyRevision || 0))) {
      session.autonomyRevision = Number(event.autonomyRevision || 0);
      session.autonomyProfile =
        safeText(event?.autonomyProfile, 32) || session.autonomyProfile;
      session.autonomyControl =
        safeText(event?.autonomyControl, 16) || session.autonomyControl;
      session.availableAutonomyProfiles = Array.isArray(
        event?.availableAutonomyProfiles,
      )
        ? event.availableAutonomyProfiles.slice(0, 8)
        : session.availableAutonomyProfiles;
      session.allowedAutonomyScopes = Array.isArray(
        event?.allowedAutonomyScopes,
      )
        ? event.allowedAutonomyScopes.slice(0, 32)
        : session.allowedAutonomyScopes;
      session.availableAutonomyScopes = Array.isArray(
        event?.availableAutonomyScopes,
      )
        ? event.availableAutonomyScopes.slice(0, 32)
        : session.availableAutonomyScopes;
      session.approvalPolicy = approvalPolicySummary(event?.approvalPolicy);
      session.aiReviewPolicy = aiReviewPolicySummary(event?.aiReviewPolicy);
      session.autonomyStatus = event;
      if (event.requestId) {
        session.controlResults.set(event.requestId, event);
        while (session.controlResults.size > 32) {
          session.controlResults.delete(session.controlResults.keys().next().value);
        }
      }
      session.approvalPolicyCapabilities =
        approvalPolicyCapabilitiesSummary(event?.approvalPolicyCapabilities) ||
        session.approvalPolicyCapabilities;
    }
    if (event?.type === "agent.detail.status") {
      session.detailProfile =
        safeText(event?.detailProfile, 16) || session.detailProfile;
      session.detailSource =
        safeText(event?.detailSource, 32) || session.detailSource;
    }
    session.turnState = turnStateForEvent(event, session.turnState || "idle");
    session.currentStep = session.turnState === "idle" &&
      (String(event?.type || "").startsWith("agent.interaction.") ||
        event?.type === "agent.permission.resolved")
      ? session.currentStep
      : this.stepForEvent(event, session.currentStep);
    try {
      this.catalog?.recordEvent(sessionId, event);
    } catch {}
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
      session.eventIds = new Set(
        session.events.map((item) => item.eventId).filter(Boolean),
      );
    }
    this.notify("event", sessionId, storedEvent);
    return session.eventSequence;
  }

  eventsAfter(after = 0, { sessionIds = null, includeCollaboration = true } = {}) {
    const wanted =
      Array.isArray(sessionIds) && sessionIds.length > 0
        ? new Set(sessionIds.map(String))
        : null;
    const events = [];
    let cursor = Number(after) || 0;
    for (const session of this.sessions.values()) {
      if (wanted && !wanted.has(session.sessionId)) continue;
      for (const event of session.events) {
        const eventCursor = Number(event.localCursor || 0);
        if (
          eventCursor > Number(after || 0)
          && (includeCollaboration || session.sessionKind !== "collaboration")
        ) events.push(event);
        // Hidden events still advance the cursor so ordinary clients do not
        // repeatedly scan a collaboration-only tail of the shared stream.
        cursor = Math.max(cursor, eventCursor);
      }
    }
    events.sort(
      (a, b) => Number(a.localCursor || 0) - Number(b.localCursor || 0),
    );
    return {
      events,
      cursor,
      latestCursor: this.eventCursor,
      streamId: this.eventStreamId,
    };
  }

  enqueueCommand(sessionId, command) {
    const session = this.requireActive(sessionId);
    session.commandSequence += 1;
    const item = {
      ...command,
      commandId:
        safeText(command?.commandId, 96) || `local_command_${randomUUID()}`,
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
    return { commands, cursor: session.commandSequence, streamId: session.commandStreamId };
  }

  history(sessionId, options) {
    const session = this.require(sessionId);
    if (session.agent === "claude") {
      return {
        ...readClaudeConversationHistory(session.transcriptPath, options),
        conversationId: session.conversationId,
        nativeSessionId: session.nativeSessionId,
        detailProfile: session.detailProfile,
        detailSource: session.detailSource,
      };
    }
    if (session.agent === "codex") {
      return {
        ...readCodexConversationHistory(session.transcriptPath, options),
        conversationId: session.conversationId,
        nativeSessionId: session.nativeSessionId,
        detailProfile: session.detailProfile,
        detailSource: session.detailSource,
      };
    }
    return {
      messages: [],
      nextCursor: null,
      hasMore: false,
      conversationId: session.conversationId,
      nativeSessionId: session.nativeSessionId,
      detailProfile: session.detailProfile,
      detailSource: session.detailSource,
    };
  }

  controlSnapshot(sessionId) {
    const session = this.require(sessionId);
    // Pending requests must outlive the bounded telemetry/event tail. An
    // App returning from Settings may subscribe after hundreds of events.
    const interactions = [...session.pendingInteractionRequests.values()];
    const projected = this.project(session);
    return {
      interactions,
      events: session.events.slice(-100),
      session: projected,
      // Must stay identical to `session.turn_state`. Publishing the raw latch
      // here made the snapshot contradict the session projection, and the App
      // alternated between them on every refresh.
      turn_state: projected.turn_state,
      event_cursor: this.eventCursor,
      stream_id: this.eventStreamId,
      mode: session.mode,
      autonomyProfile: session.autonomyProfile,
      autonomy:
        session.autonomyStatus,
      controlResults: [...session.controlResults.values()],
    };
  }

  list({ includeCollaboration = true } = {}) {
    this.expireStale();
    return Array.from(this.sessions.values())
      .filter((session) => includeCollaboration || session.sessionKind !== "collaboration")
      .map((session) =>
      this.project(session),
      );
  }

  expireStale() {
    const cutoff = this.now() - STALE_AFTER_MS;
    for (const session of this.sessions.values()) {
      if (session.status === "running" && session.lastSeenAtMs < cutoff) {
        session.status = "stopped";
        session.attached = false;
        session.detachedAtMs = this.now();
        try {
          this.catalog?.finishSession(session.sessionId, {
            status: "stopped",
            exitedAt: new Date(this.now()).toISOString(),
          });
        } catch {}
        // The detach is a fact the cloud must learn even though the local
        // listener only runs while a relay connection is up; the next relay
        // open replays it through the presence reconcile.
        this.notify("updated", session.sessionId, {
          status: "stopped",
          attached: false,
          detachedAt: new Date(session.detachedAtMs).toISOString(),
        });
      }
    }
  }

  project(session) {
    const status = this.publicStatus(session);
    const conversation = this.catalog?.getConversation?.(session.conversationId);
    const turnState = resolveTurnState(session, status);
    return {
      session_id: session.sessionId,
      session_kind: session.sessionKind,
      conversation_id: session.conversationId,
      native_session_id: session.nativeSessionId,
      agent_type: session.agent,
      title: conversation?.title || session.title,
      summary: conversation?.summary || "",
      status,
      turn_state: turnState,
      device_id: session.deviceId,
      device_name: session.deviceName,
      workspace_path: session.cwd,
      workspace_display_path: conversation?.workspace_display_path || workspaceDisplayPath(session.cwd),
      current_step: status === "waiting_approval"
        ? "Waiting for approval"
        : status === "waiting_input"
          ? "Waiting for input"
          : status === "running"
            ? session.currentStep
            : "Stopped",
      last_activity_at: new Date(session.lastSeenAtMs).toISOString(),
      // Attachment is the authoritative presence fact. `status` describes the
      // turn; `attached` describes whether the Agent process is still here.
      // The cloud mirrors both and must never derive one from the other.
      attached: session.attached !== false,
      attached_at: session.attachedAtMs
        ? new Date(session.attachedAtMs).toISOString()
        : null,
      detached_at: session.detachedAtMs
        ? new Date(session.detachedAtMs).toISOString()
        : null,
      pending_approval_count: session.pendingInteractions.size,
      control_path: "local",
      mode: session.mode,
      mode_control: session.modeControl,
      available_modes: session.availableModes,
      autonomy_profile: session.autonomyProfile,
      autonomy_revision: session.autonomyRevision,
      autonomy_control: session.autonomyControl,
      available_autonomy_profiles: session.availableAutonomyProfiles,
      allowed_autonomy_scopes: session.allowedAutonomyScopes,
      available_autonomy_scopes: session.availableAutonomyScopes,
      approval_policy: session.approvalPolicy,
      ai_review_policy: session.aiReviewPolicy,
      approval_policy_capabilities: session.approvalPolicyCapabilities,
      detail_profile: session.detailProfile,
      detail_source: session.detailSource,
    };
  }

  publicStatus(session) {
    if (session.status !== "running" || session.pendingInteractions.size === 0) {
      return session.status;
    }
    for (const interactionId of session.pendingInteractions) {
      if (session.pendingInteractionKinds.get(interactionId) === "permission") {
        return "waiting_approval";
      }
    }
    return "waiting_input";
  }

  stepForEvent(event, fallback) {
    switch (canonicalTurnEventType(event?.type)) {
      case "agent.interaction.requested":
        return "Waiting for input";
      case "approval_requested":
        return "Waiting for approval";
      case "interaction_requested":
        return "Waiting for input";
      case "agent.interaction.result":
        return event?.status === "applying"
          ? "Applying response"
          : "Running locally";
      case "agent.interaction.auto_resolved":
        return "Continuing automatically";
      case "agent.thinking":
        return "Thinking";
      case "agent.tool_call.start":
        return `Running ${safeText(event?.tool, 64) || "tool"}`;
      case "agent.tool_call.end":
        return "Running locally";
      case "agent.task.started":
        return "Working";
      case "agent.task.complete":
        return "Ready";
      case "agent.task.aborted":
        return "Interrupted";
      case "agent.task.failed":
        return "Task needs attention";
      case "agent.ready":
        return "Ready";
      case "agent.activity":
        if (isInternalTelemetryActivity(event)) {
          return fallback || "Running locally";
        }
        return safeText(event?.summary, 191) || "Running locally";
      case "agent.detail.status":
        return fallback || "Running locally";
      default:
        return fallback || "Running locally";
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
