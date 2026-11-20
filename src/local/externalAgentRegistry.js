import { randomUUID } from "node:crypto";
import { defaultConversationTitle, looksLikePlaceholderTitle } from "../agent/agentTitleSource.js";
import { workspaceDisplayPath } from "../persistence/agentCatalog.js";

import { readClaudeConversationHistory } from "../runtime/claudeConversationHistory.js";
import { readCodexConversationHistory } from "../adapters/codex/jsonlScanner.js";
import { readAgyConversationHistory } from '../adapters/agy/history.js';
import { isCollaborationSessionPayload } from "../runtime/agentSessionKind.js";

export { isCollaborationSessionPayload } from "../runtime/agentSessionKind.js";

const MAX_EVENTS = 500;
const MAX_COMMANDS = 200;
const STALE_AFTER_MS = 90_000;
// A detached row is retained so durable facts — above all the transcript
// locator — stay answerable after the process is gone. The retention is
// bounded; beyond it the oldest dead rows are evicted.
const MAX_DETACHED_SESSIONS = 200;
// The catalog statuses a live process can still be behind. The presence
// reconcile uses the same set.
const LIVE_STATUSES = new Set([
  "running",
  "starting",
  "waiting_approval",
  "waiting_input",
  "waiting_device",
]);

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

export function canonicalTurnEventType(value) {
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
    // The process itself ended. The turn is over with it — there is nothing
    // left to interrupt — and the App reads this projection to decide
    // whether to show the stop button. Without these two the session kept
    // saying `running` after its runtime was gone.
    "session.exited",
    "session.error",
    "session_runtime_error",
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

// Whether a run now holds a different conversation than it did.
//
// The provider's own id is what says which conversation this is: our own
// conversation id is minted per launch, so it cannot. The label the runtime
// sends is the label of the run, and it can change under the run — the
// catalog finds the row that already holds this conversation and moves the
// run onto it — without the reader going anywhere.
//
// So the provider's id decides whenever both sides know it. The label
// decides only when it is the only evidence there is: the run is learning
// which conversation it is in, or neither side knows the provider's id. A
// payload that says nothing about the conversation is not evidence of a
// change.
function conversationChangedFor(session, payload = {}) {
  const native = safeText(payload.nativeSessionId, 191);
  const held = safeText(session?.nativeSessionId, 191);
  if (native && held) return native !== held;
  if (held && !native) return false;
  const label = safeText(payload.conversationId, 96);
  const heldLabel = safeText(session?.conversationLabel, 96);
  return Boolean(label && heldLabel && label !== heldLabel);
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
  constructor({ now = () => Date.now(), catalog = null, runtimeTaskStore = null } = {}) {
    this.now = now;
    this.catalog = catalog;
    this.runtimeTaskStore = runtimeTaskStore;
    this.sessions = new Map();
    // Cursors are process-local. Consumers use this id to detect a daemon
    // restart before applying a cursor from the previous process.
    this.eventStreamId = `local_stream_${randomUUID()}`;
    this.eventCursor = 0;
    this.listeners = new Set();
    this.rehydrate();
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  has(sessionId) {
    return this.sessions.has(String(sessionId || ""));
  }

  // The registry holds two kinds of fact with different lifetimes. Attachment
  // — is the Agent process here? — is volatile and dies with the daemon. The
  // run's identity — its session id, the conversation it belongs to, where
  // its transcript lives — is durable and already written to the catalog by
  // `register`.
  //
  // Rebuilding the durable half on boot is what keeps a finished session
  // answerable: `history()` reads the transcript the row still names, and
  // `session_not_registered` once again means "this daemon never heard of
  // the run" instead of "the run ended".
  //
  // A run the catalog last saw as `running` is kept `running` for one stale
  // window: if its wrapper survived the restart it calls home within seconds
  // (`noteWrapperContact` re-attaches it), and if it did not, `expireStale`
  // finishes the row and the catalog entry with the same bookkeeping an
  // unregister would have done. Every other status is dead for certain and
  // stays dead.
  rehydrate() {
    if (!this.catalog?.listRunsForRegistry) return;
    let rows;
    try {
      rows = this.catalog.listRunsForRegistry();
    } catch (error) {
      console.error(
        `[agent-registry] rehydrating from the catalog failed: `
        + `${error?.message || error}`,
      );
      return;
    }
    for (const row of rows || []) {
      const sessionId = safeText(row.originrouter_session_id, 64);
      if (!sessionId || this.sessions.has(sessionId)) continue;
      const startedAtMs = Date.parse(row.started_at) || 0;
      const exitedAtMs = Date.parse(row.exited_at) || 0;
      const status = safeText(row.status, 32);
      // Any status that could still describe a live process — the same set
      // the presence reconcile treats as live — earns the re-attach window.
      // It lands as `running` because that is the only live status
      // `expireStale` and `requireActive` understand; the finer waiting
      // states rebuild themselves from the first event after re-attach.
      const live = LIVE_STATUSES.has(status);
      // The field set mirrors `register` minus everything only a live
      // process provides. Both halves must stay in sync: `project` reads all
      // of it, and an unlisted field comes back `undefined` on the wire.
      this.sessions.set(sessionId, {
        sessionId,
        sessionKind: isCollaborationSessionPayload({
          sessionId,
          runId: row.run_id,
          startedBy: row.started_by,
        })
          ? "collaboration"
          : "interactive",
        agent: safeText(row.agent_type, 32) || "unknown",
        runtime: safeText(row.runtime, 64),
        supportsRuntimeRecovery: false,
        supportsDeviceTools: false,
        title:
          safeText(row.title, 191)
          || defaultConversationTitle(row.agent_type || "Agent"),
        deviceId: safeText(row.device_id, 191),
        deviceName: safeText(row.device_name, 191),
        cwd: safeText(row.workspace_path, 1024),
        pid: Number(row.pid) || null,
        status: live ? "running" : status || "stopped",
        conversationId: safeText(row.conversation_id, 96) || sessionId,
        conversationLabel: safeText(row.conversation_id, 96) || sessionId,
        nativeSessionId: safeText(row.native_session_id, 191),
        transcriptPath: safeText(row.transcript_locator, 4096),
        startedAt: safeText(row.started_at, 64) || nowIso(),
        // The grace window is what separates "the catalog thinks it is
        // running" from "it is running": it starts now, and the first
        // wrapper call re-attaches the row before `expireStale` retires it.
        lastSeenAtMs: live ? this.now() : exitedAtMs || startedAtMs || this.now(),
        attached: false,
        attachedAtMs: startedAtMs || null,
        detachedAtMs: live ? null : exitedAtMs || startedAtMs || this.now(),
        events: [],
        eventIds: new Set(),
        eventSequence: 0,
        commands: [],
        commandSequence: 0,
        commandStreamId: `local_commands_${randomUUID()}`,
        pendingInteractions: new Set(),
        pendingInteractionRequests: new Map(),
        pendingInteractionKinds: new Map(),
        mode: "default",
        modeControl: "unsupported",
        availableModes: [],
        model: row.native_config === 1 || row.agent_type === 'agy' ? row.model || null : null,
        modelProvider: null,
        modelSource: row.native_config === 1 || row.agent_type === 'agy' ? 'native' : 'device',
        modelControl: "unsupported",
        effort: null,
        effortControl: "unsupported",
        availableEfforts: [],
        autonomyRevision: 0,
        autonomyProfile: "manual",
        autonomyControl: "unsupported",
        availableAutonomyProfiles: [],
        allowedAutonomyScopes: [],
        availableAutonomyScopes: [],
        approvalPolicy: null,
        aiReviewPolicy: null,
        autonomyStatus: null,
        controlResults: new Map(),
        approvalPolicyCapabilities: null,
        detailProfile: "concise",
        detailSource: "builtin_default",
        currentStep: "Stopped",
        turnState: "idle",
      });
    }
    this.evictDetachedOverflow();
  }

  // The retained half of the map is bounded. Detached rows are evicted oldest
  // first; a detached row that is still `running` is in its re-attach window
  // and is never evicted by retention.
  evictDetachedOverflow() {
    const detached = [...this.sessions.values()].filter(
      (session) => session.attached === false && session.status !== "running",
    );
    if (detached.length <= MAX_DETACHED_SESSIONS) return;
    const evict = detached.length - MAX_DETACHED_SESSIONS;
    detached.sort(
      (a, b) =>
        (Number(a.detachedAtMs) || Number(a.lastSeenAtMs) || 0)
        - (Number(b.detachedAtMs) || Number(b.lastSeenAtMs) || 0),
    );
    for (const session of detached.slice(0, evict)) {
      this.sessions.delete(session.sessionId);
    }
  }

  // Every wrapper endpoint is a live call: a session that asks its daemon
  // anything proves its process is still here. Attachment is authoritative
  // presence, so the proof re-attaches a detached row rather than leaving it
  // to contradict the very call it just answered.
  noteWrapperContact(sessionId) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session || session.attached !== false) return;
    session.attached = true;
    session.attachedAtMs = this.now();
    session.detachedAtMs = null;
    session.lastSeenAtMs = this.now();
    if (session.status !== "running") session.status = "running";
    this.notify("updated", session.sessionId, {
      status: "running",
      attached: true,
      attachedAt: new Date(session.attachedAtMs).toISOString(),
    });
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
    const conversationChanged = existing
      ? conversationChangedFor(existing, {
        conversationId: incomingConversationId,
        nativeSessionId: payload?.nativeSessionId,
      })
      : false;
    const session = {
      sessionId,
      sessionKind: existing?.sessionKind === "collaboration"
        || isCollaborationSessionPayload({ ...payload, sessionId })
        ? "collaboration" : "interactive",
      agent: safeText(payload?.agent, 32) || "unknown",
      runtime: safeText(payload?.runtime, 64) || existing?.runtime || "",
      supportsRuntimeRecovery: payload?.supportsRuntimeRecovery === true,
      supportsDeviceTools: payload?.supportsDeviceTools === true,
      // A session registers before it has a title of its own, so the
      // placeholder stands until the agent produces one.
      title:
        safeText(payload?.title, 191)
        || defaultConversationTitle(payload?.agent || "Agent"),
      deviceId: safeText(payload?.deviceId, 191),
      deviceName: safeText(payload?.deviceName, 191),
      cwd: safeText(payload?.cwd, 1024),
      pid: Number(payload?.pid) || null,
      status: "running",
      conversationId:
        incomingConversationId ||
        existing?.conversationId ||
        sessionId,
      // The label the runtime named. It is the label of this run, and it is
      // kept apart from the conversation's own id: the catalog may find the
      // row that already holds this conversation and move the run onto it,
      // and the label then changes without the reader going anywhere.
      conversationLabel:
        incomingConversationId ||
        existing?.conversationLabel ||
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
      // The command *menu* the session advertises (slash commands it can
      // answer for `agent.command`). Kept apart from `commands`, which is the
      // pending-command queue the session poller drains.
      commandMenu: Array.isArray(payload?.commandMenu)
        ? payload.commandMenu.slice(0, 128)
        : existing?.commandMenu || [],
      promptCapabilities: existing?.promptCapabilities || {},
      usage: existing?.usage || null,
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
      // The session's own model. Null means the session follows the device
      // route, which is the default and the fallback.
      //
      // Not the register payload's `model`: that one names the model the
      // *device* is routed to, which is the device's fact and belongs to the
      // catalog. The session's own model is the runtime's word — it states
      // the model when the session starts and again on every change — and
      // that event is the only thing that writes this field. Reading the
      // payload's model here put a model the session had not chosen on a
      // session that had chosen none, and the two readings disagreed about
      // what the field meant.
      model: existing?.model ?? null,
      modelProvider: existing?.modelProvider ?? null,
      modelSource: existing?.modelSource || (payload.nativeConfig === true || payload.agent === 'agy' ? 'native' : 'device'),
      modelControl: existing?.modelControl || "unsupported",
      availableModels: existing?.availableModels || [],
      // The session's own reasoning effort. Null means the runtime has not
      // said yet — the runtime owns the vocabulary, so the App renders the
      // level list it publishes rather than a list of its own.
      //
      // The control and the list of levels are the runtime's capability, and
      // they are told at registration: a daemon that restarts rebuilds the
      // session record from this payload, and a session that came back
      // without its levels came back without a control.
      effort: existing?.effort ?? null,
      effortControl:
        safeText(payload?.effortControl, 16) ||
        existing?.effortControl ||
        "unsupported",
      availableEfforts: Array.isArray(payload?.availableEfforts)
        ? payload.availableEfforts.slice(0, 8)
        : existing?.availableEfforts || [],
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
      const existingConversation = this.catalog?.listConversations?.({
        conversationId: session.conversationId, includeArchived: true, limit: 1,
      })?.[0];
      const conversation = this.catalog?.upsertSession({
        ...payload, sessionKind: session.sessionKind,
        // A registration can carry an old launch title across reconnects.
        // It may name a new conversation, but it cannot undo a later rename.
        titleIsCustom: payload.titleIsCustom === true && !existingConversation?.title_is_custom,
      });
      // The catalog may know a better label for this conversation: a
      // resumed conversation is the row that already holds it, and every run
      // of one conversation carries the same id.
      //
      // The label is not the identity — the provider's id is — so a label
      // that changes here is not the reader switching conversation, and the
      // run keeps the history it has.
      const adopted = safeText(conversation?.conversation_id, 96);
      if (adopted && adopted !== session.conversationId) {
        session.conversationId = adopted;
      }
      this.adoptConversationTitle(session, conversation);
    } catch (error) {
      // The catalog refused the write. The run still works — it is the
      // App's view of the conversation that is degraded — but a failure
      // that is not reported is a failure nobody can fix.
      console.error(
        `[agent-registry] the catalog refused the write for ${sessionId}: `
        + `${error?.message || error}`,
      );
    }
    this.notify("registered", sessionId, {
      ...payload,
      session: this.project(session),
    });
    return this.project(session);
  }

  update(sessionId, payload = {}) {
    const session = this.require(sessionId);
    this.noteWrapperContact(sessionId);
    const nextConversationId = safeText(payload.conversationId, 96);
    // A run that now holds a different conversation starts over: the events
    // and the pending interactions it collected belong to the conversation it
    // left.
    //
    // Which conversation it holds is decided by the provider's id, not by the
    // label — the label is the run's own, and the catalog may move the run
    // onto the row that already holds this conversation without the reader
    // going anywhere.
    if (conversationChangedFor(session, payload)) {
      if (nextConversationId) {
        session.conversationId = nextConversationId;
        session.conversationLabel = nextConversationId;
      }
      session.events = [];
      session.eventIds = new Set();
      session.eventSequence = 0;
      session.pendingInteractions = new Set();
      session.pendingInteractionRequests = new Map();
      session.pendingInteractionKinds = new Map();
      session.currentStep = "Running locally";
      session.turnState = "idle";
    } else if (nextConversationId && nextConversationId !== session.conversationLabel) {
      session.conversationLabel = nextConversationId;
    }
    if (payload.nativeSessionId) {
      session.nativeSessionId = safeText(payload.nativeSessionId, 191);
    }
    if (payload.transcriptPath) {
      session.transcriptPath = safeText(payload.transcriptPath, 4096);
    }
    if (payload.status) session.status = safeText(payload.status, 32);
    // The title the agent produced, once it has one. The session's own copy
    // is what the rail falls back to when the conversation row has nothing
    // better to say.
    //
    // A placeholder never displaces a real name. Until the agent has named
    // the conversation, the runtime reports the placeholder we wrote — and
    // that must not wipe a name the run already carries.
    if (payload.title !== undefined) {
      const incoming = safeText(payload.title, 191);
      const agent = safeText(session.agent, 32) || "unknown";
      if (incoming && (
        !looksLikePlaceholderTitle(incoming, agent)
        || looksLikePlaceholderTitle(session.title, agent)
      )) {
        session.title = incoming;
      }
    }
    if (payload.turnState || payload.turn_state) {
      session.turnState = safeText(payload.turnState || payload.turn_state, 32);
    }
    session.lastSeenAtMs = this.now();
    try {
      const conversation = this.catalog?.updateSession(sessionId, payload);
      // The label of a conversation can change under a run — a resumed
      // conversation adopts the row that already holds it — without the
      // reader having gone anywhere. The provider's id is what says which
      // conversation this is, so a label the catalog vouches for is taken
      // without treating it as a switch.
      const adopted = safeText(conversation?.conversation_id, 96);
      if (adopted && adopted !== session.conversationId) {
        session.conversationId = adopted;
      }
      this.adoptConversationTitle(session, conversation);
    } catch (error) {
      console.error(
        `[agent-registry] the catalog refused the update for ${sessionId}: `
        + `${error?.message || error}`,
      );
    }
    this.notify("updated", sessionId, payload);
    return this.project(session);
  }

  // The name a run shows is the conversation's name.
  //
  // A resumed run has no name of its own until the agent produces one, and
  // until then the runtime reports the placeholder we wrote. The
  // conversation it resumes does have a name — the catalog holds it — so
  // the run takes it, and a placeholder never displaces a real one.
  //
  // This is the same rule the catalog and the server keep: a name somebody
  // chose is never lost, a placeholder never displaces a name, and between
  // two real names the newest wins.
  adoptConversationTitle(session, conversation) {
    const agent = safeText(session?.agent, 32) || "unknown";
    const conversationTitle = safeText(conversation?.title, 191);
    if (!conversationTitle) return;
    if (looksLikePlaceholderTitle(conversationTitle, agent)) return;
    if (!looksLikePlaceholderTitle(session?.title, agent)) return;
    session.title = conversationTitle;
  }

  heartbeat(sessionId) {
    const session = this.require(sessionId);
    this.noteWrapperContact(sessionId);
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
    // The process is gone but the run is not: the row stays so its durable
    // facts — above all the transcript — remain answerable, exactly as a
    // rehydrated row does after a daemon restart. What does not stay is
    // anything only a live process could still consume: the undelivered
    // commands and the approvals it can no longer resolve. The event tail
    // survives trimmed to the tail a control snapshot would publish.
    session.commands = [];
    session.pendingInteractions.clear();
    session.pendingInteractionRequests.clear();
    session.pendingInteractionKinds.clear();
    if (session.events.length > 100) {
      session.events = session.events.slice(-100);
      session.eventIds = new Set(
        session.events.map((event) => event.eventId).filter(Boolean),
      );
    }
    this.notify("unregistered", sessionId, {
      status: session.status,
      attached: false,
      detachedAt: new Date(session.detachedAtMs).toISOString(),
      session: this.project(session),
    });
    this.evictDetachedOverflow();
    return true;
  }

  appendEvent(sessionId, event) {
    const session = this.require(sessionId);
    // Events are deliberately not proof of life: the wrapper replays its
    // outbox on reconnect, so an arriving event can be stale content from a
    // dead run, and watchers that distrust events from detached sessions
    // would see the replay re-attach the row and then trust every event
    // after it. Attachment is re-established by a direct call — a poll, a
    // heartbeat, a registration — never by the event stream itself.
    const providedEventId = safeText(event?.eventId, 96);
    if (providedEventId && session.eventIds.has(providedEventId)) {
      return session.eventSequence;
    }
    session.eventSequence += 1;
    if (event?.type === 'agent.capabilities') {
      session.promptCapabilities = { image: event.promptCapabilities?.image === true, embeddedContext: event.promptCapabilities?.embeddedContext === true };
    }
    if (event?.type === 'agent.commands' && Array.isArray(event.commands)) session.commandMenu = event.commands.slice(0, 128);
    if (event?.type === 'agent.usage') session.usage = { ...event };
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
    if (event?.type === "agent.model.status") {
      if (Array.isArray(event.availableModels)) session.availableModels = event.availableModels.slice(0, 256);
      // The model is a fact about the session, and it can be cleared: an
      // empty model means the session is back on the device route, so the
      // value is assigned rather than kept when it is blank.
      session.model = safeText(event?.model, 191) || null;
      session.modelProvider = safeText(event?.modelProvider, 191) || null;
      session.modelSource =
        safeText(event?.source, 16) || session.modelSource || "device";
      session.modelControl =
        safeText(event?.modelControl, 16) || session.modelControl;
    }
    if (event?.type === "agent.effort.status") {
      // The runtime publishes the levels it can actually run. An empty
      // effort means the runtime fell back to its own default, so the value
      // is assigned rather than kept when it is blank.
      session.effort = safeText(event?.effort, 16) || null;
      session.effortControl =
        safeText(event?.effortControl, 16) || session.effortControl;
      session.availableEfforts = Array.isArray(event?.availableEfforts)
        ? event.availableEfforts
            .map((item) => safeText(item, 16))
            .filter(Boolean)
            .slice(0, 8)
        : session.availableEfforts;
      if (event.requestId) {
        session.controlResults.set(event.requestId, event);
        while (session.controlResults.size > 32) {
          session.controlResults.delete(session.controlResults.keys().next().value);
        }
      }
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
    // The side conversation's liveness is a session fact the snapshot must
    // restate: an App that opens the session after the thread already exists
    // learns it here, since no event will say so again.
    if (event?.type === "agent.side.opened") {
      session.sideOpen = true;
      session.sideCapability =
        safeText(event?.capability, 32) || session.sideCapability;
    }
    if (event?.type === "agent.side.closed") {
      session.sideOpen = false;
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
    // Watchers that act on a session need to know when someone told it to
    // stop: the runtime supervisor must never "recover" from an interrupt.
    this.notify("command", sessionId, item);
    return item;
  }

  // The few facts a watcher needs about one session, without projecting the
  // whole row. Null when the session is not registered here.
  sessionFacts(sessionId) {
    const session = this.sessions.get(String(sessionId || ""));
    if (!session) return null;
    const status = this.publicStatus(session);
    return {
      sessionId: session.sessionId,
      sessionKind: session.sessionKind,
      agent: session.agent,
      runtime: session.runtime,
      supportsRuntimeRecovery: session.supportsRuntimeRecovery,
      supportsDeviceTools: session.supportsDeviceTools,
      cwd: session.cwd,
      status,
      turnState: resolveTurnState(session, status),
      attached: session.attached !== false,
      pendingInteractions: session.pendingInteractions.size,
    };
  }

  commandsAfter(sessionId, after = 0) {
    const session = this.requireActive(sessionId);
    this.noteWrapperContact(sessionId);
    const commands = session.commands.filter(
      (item) => Number(item.commandSequence || 0) > Number(after || 0),
    );
    return { commands, cursor: session.commandSequence, streamId: session.commandStreamId };
  }

  history(sessionId, options) {
    const session = this.require(sessionId);
    if (session.agent === 'agy') return { ...readAgyConversationHistory(session.transcriptPath, options),
      conversationId: session.conversationId, nativeSessionId: session.nativeSessionId,
      detailProfile: session.detailProfile, detailSource: session.detailSource };
    if (session.agent === "claude") {
      return {
        ...(this.runtimeTaskStore?.annotateHistory(sessionId, readClaudeConversationHistory(session.transcriptPath, options))
          || readClaudeConversationHistory(session.transcriptPath, options)),
        conversationId: session.conversationId,
        nativeSessionId: session.nativeSessionId,
        detailProfile: session.detailProfile,
        detailSource: session.detailSource,
      };
    }
    if (session.agent === "codex") {
      return {
        ...(this.runtimeTaskStore?.annotateHistory(sessionId, readCodexConversationHistory(session.transcriptPath, options))
          || readCodexConversationHistory(session.transcriptPath, options)),
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
      // The session's own model. `null` means the device route answers.
      model: session.model,
      modelProvider: session.modelProvider,
      modelSource: session.modelSource,
      modelControl: session.modelControl,
      ...(session.modelSource === 'native' ? { availableModels: session.availableModels || [] } : {}),
      // The session's own reasoning effort, and the levels the runtime
      // published for it.
      effort: session.effort,
      effortControl: session.effortControl,
      availableEfforts: session.availableEfforts,
      autonomyProfile: session.autonomyProfile,
      autonomy:
        session.autonomyStatus,
      // The session's slash-command menu — the App renders exactly this list.
      commands: session.commandMenu || [],
      promptCapabilities: session.promptCapabilities || {},
      ...(session.usage ? { usage: session.usage } : {}),
      // The side conversation's liveness — the App's surface tracks it, and
      // a snapshot is the only place a late joiner can learn the thread is
      // already open. `null` never reaches the wire: a session that never
      // had a side thread still gets the explicit false.
      sideOpen: session.sideOpen === true,
      sideCapability: session.sideCapability || null,
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
      // The session's own model. `null` means the device route answers, and
      // the App offers that as the first row rather than hiding it.
      model: session.model,
      model_provider: session.modelProvider,
      model_source: session.modelSource,
      model_control: session.modelControl,
      effort: session.effort,
      effort_control: session.effortControl,
      available_efforts: session.availableEfforts,
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
