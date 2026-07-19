// src/runtime/agentInteractionContract.js
//
// Stage 8.8 shipped this contract helper. **Stage 8.9 wired it
// into production** for the permission kind (claudeAdapter.js,
// codexAdapter.js, localAgentSession.js, localApi.js).
//
// Pure functions only. No I/O, no spawn, no process access.
// The test file (tests/agentInteractionContract.test.js) and the
// production adapters are the consumers. The reverse map
// (interactionToPermissionEvent) is permission-only.
//
// Stage 8.8 contracts two events: `agent.interaction.requested` and
// `agent.interaction.resolve`. There is no `agent.interaction.canceled`
// in 8.8 or 8.9 — cancellation is expressed by sending
// `{ type: "agent.interaction.resolve", decision: "abort" }`.
// A dedicated canceled event is a future-stage concern if the UI
// ever needs the distinction.
//
// Managed runtimes use permission, confirm, questions, form, and URL.
// The legacy reverse map remains permission-only because the old
// agent.permission.* envelope cannot represent the richer responses.

export const INTERACTION_KINDS = Object.freeze({
  PERMISSION: "permission",
  CONFIRM: "confirm",
  QUESTIONS: "questions",
  FORM: "form",
  URL: "url",
  // Legacy aliases retained for the PTY compatibility path. Managed
  // runtimes emit QUESTIONS/FORM instead.
  SINGLE_SELECT: "single_select",
  MULTI_SELECT: "multi_select",
  FREE_TEXT: "free_text",
  RAW_TERMINAL: "raw_terminal",
});

export const INTERACTION_ACTIONS = Object.freeze({
  ALLOW: "allow",
  DENY: "deny",
  CANCEL: "cancel",
  SUBMIT: "submit",
});

// Where the request originated on the local machine. These are
// surfaced as metadata so a future UI can group/dim cards by source.
// The values are stable so a rename in 9.0+ breaks the test instead
// of silently shipping.
export const INTERACTION_SOURCES = Object.freeze({
  HOOK: "hook",             // Claude PTY PermissionRequest hook (default)
  JSONL: "jsonl",           // reserved for future Claude JSONL scanner
  APP_SERVER: "app-server", // Codex app-server approvals
  PTY: "pty",               // generic PTY fallback
});

// Default decision vocabulary. Matches today's `agent.permission.resolve`
// payload. Stage 9.0+ may widen this for non-permission kinds
// (e.g. `selected`, `typed`); 8.8 does not invent new values.
const DEFAULT_INTERACTION_DECISIONS = Object.freeze([
  "approved",
  "approved_for_session",
  "denied",
  "abort",
]);

function isFrozenMember(table, value) {
  return Object.values(table).includes(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function copyObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

export function buildInteractionRequest(payload = {}) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("buildInteractionRequest: payload is required");
  }
  const {
    provider = null,
    runtime = null,
    sessionId = null,
    interactionId,
    source = INTERACTION_SOURCES.APP_SERVER,
    kind,
    title = null,
    prompt = null,
    payload: requestPayload = {},
    containsSecret = false,
    expiresAt = null,
  } = payload;
  if (!isNonEmptyString(interactionId)) {
    throw new TypeError("buildInteractionRequest: interactionId is required");
  }
  if (!isFrozenMember(INTERACTION_SOURCES, source)) {
    throw new TypeError(`buildInteractionRequest: unknown source ${JSON.stringify(source)}`);
  }
  if (![
    INTERACTION_KINDS.PERMISSION,
    INTERACTION_KINDS.CONFIRM,
    INTERACTION_KINDS.QUESTIONS,
    INTERACTION_KINDS.FORM,
    INTERACTION_KINDS.URL,
  ].includes(kind)) {
    throw new TypeError(`buildInteractionRequest: unsupported managed kind ${JSON.stringify(kind)}`);
  }
  return {
    type: "agent.interaction.requested",
    provider,
    runtime,
    sessionId,
    interactionId,
    source,
    kind,
    title,
    prompt,
    payload: copyObject(requestPayload),
    containsSecret: Boolean(containsSecret),
    expiresAt: Number.isFinite(expiresAt) ? Math.max(0, Math.floor(expiresAt)) : null,
  };
}

export function normalizeInteractionResolve(payload = {}) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("normalizeInteractionResolve: payload is required");
  }
  const interactionId = payload.interactionId || payload.callId;
  const action = String(payload.action || "").trim().toLowerCase();
  if (!isNonEmptyString(interactionId)) {
    throw new TypeError("normalizeInteractionResolve: interactionId is required");
  }
  if (!Object.values(INTERACTION_ACTIONS).includes(action)) {
    throw new TypeError(`normalizeInteractionResolve: unknown action ${JSON.stringify(action)}`);
  }
  return {
    interactionId,
    responseId: payload.responseId || payload.deliveryId || null,
    publicInteractionId: payload.publicInteractionId || null,
    deliveryId: payload.deliveryId || null,
    kind: payload.kind || null,
    action,
    response: copyObject(payload.response),
  };
}

// Forward map: `agent.permission.request.detected` (or any object
// carrying the legacy callId/tool/input/resolution shape) →
// `agent.interaction.requested` envelope.
//
// Non-mutating. Throws TypeError on missing `callId` or unknown
// caller extras (`source`, `kind`).
export function permissionEventToInteraction(event, extras = {}) {
  if (!event || typeof event !== "object") {
    throw new TypeError("permissionEventToInteraction: event is required");
  }
  if (!isNonEmptyString(event.callId)) {
    throw new TypeError(
      "permissionEventToInteraction: event.callId is required (used as interactionId)",
    );
  }
  const source = extras.source || INTERACTION_SOURCES.HOOK;
  const kind = extras.kind || INTERACTION_KINDS.PERMISSION;
  if (!isFrozenMember(INTERACTION_SOURCES, source)) {
    throw new TypeError(
      `permissionEventToInteraction: unknown source ${JSON.stringify(source)}`,
    );
  }
  if (!isFrozenMember(INTERACTION_KINDS, kind)) {
    throw new TypeError(
      `permissionEventToInteraction: unknown kind ${JSON.stringify(kind)}`,
    );
  }

  // The interaction envelope always carries the new eventType,
  // even when the input was a legacy `agent.permission.*` event.
  // This means an `agent.interaction.*` payload must NEVER carry
  // `eventType: "agent.permission.*"` — that would mislead any
  // 9.0 consumer that matches on the wire type to render the card.
  const resolution = {
    eventType: "agent.interaction.resolve",
    decisions: Array.isArray(event.resolution?.decisions)
      ? event.resolution.decisions.slice()
      : DEFAULT_INTERACTION_DECISIONS.slice(),
  };

  const out = {
    type: "agent.interaction.requested",
    provider: event.provider ?? null,
    runtime: extras.runtime ?? null,
    sessionId: extras.sessionId ?? null,
    interactionId: event.callId, // canonical field
    callId: event.callId,        // preserved for back-compat consumers
    source,
    kind,
    title: extras.title || null,
    prompt: extras.prompt || null,
    tool: event.tool ?? null,
    input: event.input ?? null,
    options: extras.options || null,
    defaultOptionId: extras.defaultOptionId ?? null,
    resolution,
    // raw_terminal-only reply envelope; null for all other kinds.
    terminalReply: kind === INTERACTION_KINDS.RAW_TERMINAL
      ? (extras.terminalReply || { strategy: "write_text", submit: "none" })
      : null,
    createdAt: extras.createdAt ?? null,
    timeoutMs: extras.timeoutMs ?? null,
  };

  // permission-only metadata: carry it only when kind=permission AND
  // the input event actually had it. Other kinds omit it to keep the
  // envelope tight.
  if (kind === INTERACTION_KINDS.PERMISSION && event.permissionSuggestions !== undefined) {
    out.permissionSuggestions = event.permissionSuggestions;
  }

  return out;
}

// Reverse map: `agent.interaction.requested` (kind: permission) →
// legacy `agent.permission.request.detected`.
//
// Permission-only in Stage 8.8 (per design decision). Throws TypeError
// when called with a non-permission interaction.
//
// `sessionId` is intentionally dropped: the legacy
// `agent.permission.request.detected` did not carry `sessionId`
// historically; the relay attaches `sessionId` at the `agent.event`
// wrapper level, not on the inner event.
export function interactionToPermissionEvent(interaction) {
  if (!interaction || typeof interaction !== "object") {
    throw new TypeError("interactionToPermissionEvent: interaction is required");
  }
  if (interaction.type !== "agent.interaction.requested") {
    throw new TypeError(
      `interactionToPermissionEvent: unexpected type ${JSON.stringify(interaction.type)}`,
    );
  }
  if (interaction.kind !== INTERACTION_KINDS.PERMISSION) {
    throw new TypeError(
      `interactionToPermissionEvent: cannot round-trip kind ${JSON.stringify(interaction.kind)} (only "permission" is reversible in Stage 8.8)`,
    );
  }
  if (!isNonEmptyString(interaction.interactionId)) {
    throw new TypeError(
      "interactionToPermissionEvent: interaction.interactionId is required",
    );
  }

  // Symmetric to the forward map: the legacy eventType is always
  // emitted on the legacy envelope, regardless of what the
  // interaction envelope carried. Keeps a future dual-emit
  // adapter's legacy consumer path identical to today's wire shape.
  const resolution = {
    eventType: "agent.permission.resolve",
    decisions: Array.isArray(interaction.resolution?.decisions)
      ? interaction.resolution.decisions.slice()
      : DEFAULT_INTERACTION_DECISIONS.slice(),
  };

  return {
    type: "agent.permission.request.detected",
    provider: interaction.provider ?? null,
    callId: interaction.interactionId,
    tool: interaction.tool ?? null,
    input: interaction.input ?? null,
    permissionSuggestions: Array.isArray(interaction.permissionSuggestions)
      ? interaction.permissionSuggestions.slice()
      : [],
    resolution,
  };
}

// Build an `agent.interaction.resolve` payload.
//
// Throws TypeError when sessionId, interactionId, or decision is
// missing or not a non-empty string. `value` and `data` are emitted
// only when caller passes them — this keeps the shape tight for
// permission (where they are unused) and opens up the wire for
// 9.0+ kinds that need them.
export function buildInteractionResolved(payload = {}) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("buildInteractionResolved: payload is required");
  }
  const { sessionId, interactionId, decision, value, data } = payload;
  if (!isNonEmptyString(sessionId)) {
    throw new TypeError("buildInteractionResolved: sessionId is required");
  }
  if (!isNonEmptyString(interactionId)) {
    throw new TypeError("buildInteractionResolved: interactionId is required");
  }
  if (!isNonEmptyString(decision)) {
    throw new TypeError("buildInteractionResolved: decision is required");
  }
  const out = {
    type: "agent.interaction.resolve",
    sessionId,
    interactionId,
    decision,
  };
  if (value !== undefined) out.value = value;
  if (data !== undefined) out.data = data;
  return out;
}

// Lightweight type guards. These check the `type` field and the
// presence of a non-empty `interactionId`; they do not enforce
// payload shape. That is the test suite's job plus any future
// schema validator.
export function isInteractionRequest(event) {
  return Boolean(
    event
      && typeof event === "object"
      && event.type === "agent.interaction.requested"
      && isNonEmptyString(event.interactionId),
  );
}

export function isInteractionResolve(event) {
  return Boolean(
    event
      && typeof event === "object"
      && event.type === "agent.interaction.resolve"
      && isNonEmptyString(event.interactionId),
  );
}
