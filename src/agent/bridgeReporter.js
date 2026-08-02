import { randomUUID } from "node:crypto";

import { readCodingAuth } from "../persistence/codingAuth.js";
import { getStateDir } from "../persistence/state.js";
import { DEFAULT_ORIGINROUTER_CONTROL_BASE_URL } from "../config/providerRoutes.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_APPROVAL_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TERMINAL_ACTIVITY_INTERVAL_MS = 2_000;
const DEFAULT_AGENT_SESSION_HEARTBEAT_INTERVAL_MS = 30_000;

function apiBase() {
  return (
    process.env.ORIGINROUTER_SERVER_BASE_URL
    || process.env.ORIGINROUTER_CONTROL_BASE_URL
    || DEFAULT_ORIGINROUTER_CONTROL_BASE_URL
  ).replace(/\/+$/, "");
}

function safeText(value, maxLen = 512) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!text) return "";
  return text.slice(0, maxLen);
}

function safeLocalControlProviders(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const providers = [];
  for (const item of value.slice(0, 128)) {
    if (!item || typeof item !== "object") continue;
    const name = safeText(item.name, 64);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const provider = {
      name,
      type: safeText(item.type, 32) || "proxy",
      litellmProvider: safeText(item.litellmProvider, 64),
      model: safeText(item.model, 512),
      target: safeText(item.target, 32),
      deviceId: safeText(item.deviceId, 128),
    };
    const modelIds = new Set();
    const models = [];
    for (const raw of Array.isArray(item.models) ? item.models.slice(0, 256) : []) {
      const object = raw && typeof raw === "object" ? raw : null;
      const id = safeText(object ? object.id : raw, 512);
      if (!id || modelIds.has(id)) continue;
      modelIds.add(id);
      const enabled = object ? object.enabled !== false : true;
      models.push({
        id,
        enabled,
        remoteEnabled: enabled && object?.remoteEnabled === true,
        ...(object?.pricing && typeof object.pricing === "object"
          ? { pricing: object.pricing }
          : {}),
      });
    }
    if (models.length > 0) provider.models = models;
    providers.push(provider);
  }
  return providers;
}

function safeLocalControlRoutes(value) {
  if (!Array.isArray(value)) return [];
  const routes = [];
  for (const item of value.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const agent = safeText(item.agent, 32);
    const slot = safeText(item.slot, 32);
    const provider = safeText(item.provider, 64);
    if (!agent || !slot || !provider) continue;
    routes.push({
      agent,
      slot,
      provider,
      model: safeText(item.model, 256),
    });
  }
  return routes;
}

function safeCompatibilityStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const patches = Array.isArray(value.patches) ? value.patches.slice(0, 128).map((patch) => ({
    id: safeText(patch?.id, 256),
    name: safeText(patch?.name, 128),
    description: safeText(patch?.description, 1024),
    version: safeText(patch?.version, 32),
    phase: safeText(patch?.phase, 16),
    required: patch?.required === true,
    failure_mode: safeText(patch?.failure_mode, 16),
    match: patch?.match && typeof patch.match === "object" ? patch.match : {},
    enabled: patch?.enabled !== false,
  })).filter((patch) => patch.id) : [];
  const operation = value.last_operation && typeof value.last_operation === "object"
    ? {
        id: safeText(value.last_operation.id, 128),
        action: safeText(value.last_operation.action, 16),
        state: safeText(value.last_operation.state, 16),
        started_at: safeText(value.last_operation.started_at, 64),
        completed_at: safeText(value.last_operation.completed_at, 64),
        message: safeText(value.last_operation.message, 512),
      }
    : null;
  return {
    engine_version: safeText(value.engine_version, 32),
    source: safeText(value.source, 16),
    bundle_id: safeText(value.bundle_id, 256),
    revision: Math.max(0, Number.parseInt(String(value.revision || 0), 10) || 0),
    generated_at: safeText(value.generated_at, 64),
    automatic_updates: value.automatic_updates === true,
    last_checked_at: safeText(value.last_checked_at, 64),
    latest_revision: Math.max(0, Number.parseInt(String(value.latest_revision || 0), 10) || 0),
    update_available: value.update_available === true,
    can_rollback: value.can_rollback === true,
    enabled_patch_count: patches.filter((patch) => patch.enabled).length,
    patches,
    last_operation: operation,
  };
}

function compactText(value, maxLen = 512) {
  return safeText(value, maxLen).replace(/\s+/g, " ");
}

export function redactAgentActivityText(value, maxLen = 4096) {
  return compactText(value, maxLen)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]")
    .replace(/\b(?:sk[-_]|or_at_|or_rt_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._~-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function normalizeAgentActivityEventType(event = {}) {
  const type = String(event.type || event.eventType || "").trim();
  return ({
    agent_message: "agent.text",
    user_message: "user.text",
    task_started: "agent.task.started",
    "agent.task.completed": "agent.task.complete",
  })[type] || type;
}

export function shouldSyncAgentActivitySnapshot(event = {}) {
  return ["user.text", "agent.text", "agent.task.complete"].includes(
    normalizeAgentActivityEventType(event),
  );
}

export function updateAgentActivitySnapshot(snapshot, event = {}) {
  const target = snapshot && typeof snapshot === "object" ? snapshot : {};
  const normalizedType = normalizeAgentActivityEventType(event);
  let text = redactAgentActivityText(
    event.text || event.message || event.content || event.result || event.detail
      || event.summary || event.reason,
    normalizedType === "agent.task.complete" ? 4096 : 1024,
  );
  if (
    normalizedType === "agent.task.complete"
    && (!text || /^(?:complete|completed|done|success)$/i.test(text))
  ) {
    text = target.lastAgentPreview || "";
  }
  if (!text) return target;
  if (normalizedType === "user.text") {
    if (!target.firstPromptPreview) target.firstPromptPreview = text;
    target.lastMessagePreview = text;
  } else if (normalizedType === "agent.text") {
    target.lastMessagePreview = text;
    target.lastAgentPreview = text;
  } else if (["agent.task.started", "agent.task.complete"].includes(normalizedType)) {
    target.summary = text;
  }
  return target;
}

function safeIsoTimestamp(value) {
  if (value == null || value === "") return "";
  const normalized = typeof value === "number" && value > 0 && value < 1e12
    ? value * 1000
    : value;
  const parsed = normalized instanceof Date ? normalized : new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString();
}

function approvalInteractionId(event) {
  return safeText(event?.interactionId || event?.callId || event?.id, 191);
}

function approvalCommandPreview(event) {
  const input = event?.input;
  if (!input || typeof input !== "object") return "";
  const candidate = input.command
    || input.cmd
    || input.file_path
    || input.path
    || input.description;
  return compactText(candidate, 512);
}

function approvalRiskLevel(event) {
  const tool = String(event?.tool || event?.action || "").trim().toLowerCase();
  const preview = approvalCommandPreview(event).toLowerCase();
  if (
    ["bash", "shell", "write", "edit", "apply_patch", "delete", "computer"].some(
      (item) => tool.includes(item),
    )
    || /(^|\s)(sudo|rm|chmod|chown|kill|shutdown|reboot)(\s|$)/.test(preview)
  ) {
    return "high";
  }
  if (["read", "glob", "grep", "search", "list", "fetch"].some((item) => tool.includes(item))) {
    return "low";
  }
  return "medium";
}

function displaySummaryForAgentEvent(event) {
  const type = String(event?.type || "");
  const tool = compactText(event?.tool || event?.name || event?.action, 64);
  if (type === "agent.ready") return "Agent is ready";
  if (type === "agent.thinking") return "Agent is thinking";
  if (type === "agent.text") return "Assistant response received";
  if (type === "user.text") return "User message received";
  if (type === "token_count") return "Token usage updated";
  if (type === "agent.mode.status") return "Agent mode updated";
  if (type === "agent.autonomy.status") return "Unattended execution updated";
  if (type === "agent.interaction.auto_resolved") return "Blocking action continued automatically";
  if (type === "agent.task.started") return "Task started";
  if (type === "agent.task.complete") return "Task completed";
  if (type === "agent.task.aborted") return "Task aborted";
  if (type === "agent.tool_call.start") return tool ? `Started ${tool}` : "Tool started";
  if (type === "agent.tool_call.end") return tool ? `Finished ${tool}` : "Tool finished";
  if (type === "agent.adapter.status") return "Agent runtime status changed";
  if (type === "agent.activity") {
    return compactText(event?.summary || event?.message || event?.activity, 512) || "Agent activity updated";
  }
  if (type === "agent.session.start") return "Agent session started";
  return "Agent update";
}

function projectRuntimeEvent({ eventType, event, summary, riskLevel }) {
  if (eventType === "session.started") {
    return {
      eventType: "session_started",
      status: "running",
      summary: "Agent session started",
      currentStep: "Running",
    };
  }
  if (eventType === "session.exited") {
    const signal = String(event?.signal ?? "").trim().toUpperCase();
    const stoppedBySignal = ["SIGHUP", "SIGINT", "SIGTERM", "1", "2", "15"]
      .includes(signal);
    const succeeded = Number(event?.code ?? 0) === 0 && !event?.signal;
    return {
      eventType: stoppedBySignal
        ? "session_stopped"
        : succeeded
          ? "session_completed"
          : "session_failed",
      status: stoppedBySignal ? "stopped" : succeeded ? "completed" : "failed",
      summary: stoppedBySignal
        ? "Agent session stopped"
        : succeeded
          ? "Agent session completed"
          : "Agent session exited with an error",
      detail: event?.signal
        ? `signal=${compactText(event.signal, 32)}`
        : `exit_code=${Number(event?.code ?? 1)}`,
      currentStep: stoppedBySignal ? "Stopped" : succeeded ? "Completed" : "Failed",
    };
  }
  if (eventType === "session.error") {
    return {
      eventType: "session_failed",
      status: "failed",
      summary: "Agent session failed",
      detail: "",
      currentStep: "Failed",
    };
  }
  if (eventType !== "agent.event") {
    return {
      eventType: safeText(eventType, 64),
      status: "running",
      summary: compactText(summary, 512) || "Agent update",
      currentStep: compactText(summary, 255) || "Running",
    };
  }

  const rawNestedType = safeText(event?.type, 64);
  const nestedType = ({
    "agent.task.completed": "agent.task.complete",
    agent_message: "agent.text",
    task_started: "agent.task.started",
    exec_command_begin: "agent.tool_call.start",
    exec_command_end: "agent.tool_call.end",
    patch_apply_begin: "agent.tool_call.start",
    patch_apply_end: "agent.tool_call.end",
  })[rawNestedType] || rawNestedType;
  if (!nestedType) return null;
  if (
    nestedType === "agent.interaction.requested"
    && event?.payload
    && ["confirm", "questions", "form", "url"].includes(event?.kind)
  ) {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    return {
      eventType: "interaction_requested",
      status: "waiting_input",
      summary: "Agent input required",
      currentStep: "Waiting for input",
      interactionId,
      action: safeText(event.kind, 32),
    };
  }
  if (nestedType === "agent.permission.request.detected" || nestedType === "agent.interaction.requested") {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    const tool = compactText(event?.tool || event?.kind || "permission", 64);
    return {
      eventType: "approval_requested",
      status: "waiting_approval",
      summary: tool ? `Permission required for ${tool}` : "Agent permission required",
      currentStep: "Waiting for approval",
      interactionId,
      action: tool || "permission_request",
      riskLevel: riskLevel || approvalRiskLevel(event),
      commandPreview: "",
    };
  }
  if (nestedType === "agent.permission.resolved") {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    const resolutionReason = String(event?.reason || "").toLowerCase();
    const expired = /(timeout|abort|cleanup|stopped|session ended)/.test(
      resolutionReason,
    );
    return {
      eventType: expired ? "approval_expired" : "approval_applied",
      status: "running",
      summary: expired ? "Approval request expired" : "Approval applied on device",
      detail: compactText(event?.reason, 512),
      currentStep: expired ? "Approval expired" : "Running",
      interactionId,
    };
  }
  if (nestedType === "agent.permission.resolve.error") {
    return {
      eventType: "approval_failed",
      // This is an operation-level delivery failure. The long-lived Agent
      // process remains online until a session.failed/session.exited event
      // says otherwise.
      status: "running",
      summary: "Approval could not be applied on device",
      detail: "",
      currentStep: "Approval delivery failed",
      interactionId: approvalInteractionId(event),
    };
  }
  if ([
    "agent.interaction.applied",
    "agent.interaction.expired",
    "agent.interaction.failed",
    "agent.interaction.canceled",
  ].includes(nestedType)) {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    const suffix = nestedType.split(".").at(-1);
    return {
      eventType: `interaction_${suffix}`,
      status: "running",
      summary: `Interaction ${suffix}`,
      detail: compactText(event?.reason, 512),
      currentStep: suffix === "failed" ? "Interaction failed" : "Running",
      interactionId,
    };
  }

  const displaySafeEventTypes = new Set([
    "agent.session.start",
    "agent.text",
    "agent.thinking",
    "user.text",
    "token_count",
    "agent.mode.status",
    "agent.autonomy.status",
    "agent.interaction.auto_resolved",
    "agent.ready",
    "agent.task.started",
    "agent.tool_call.start",
    "agent.tool_call.end",
    "agent.task.complete",
    "agent.task.aborted",
    "agent.adapter.status",
    "agent.activity",
  ]);
  if (!displaySafeEventTypes.has(nestedType)) return null;

  // A task is one conversational turn. Completing or interrupting it does
  // not close the long-lived Claude/Codex session.
  const status = "running";
  const displayEvent = { ...event, type: nestedType };
  return {
    eventType: nestedType,
    status,
    summary: displaySummaryForAgentEvent(displayEvent),
    detail: compactText(event?.detail || event?.message || event?.reason, 512),
    currentStep: displaySummaryForAgentEvent(displayEvent),
    mode: nestedType === "agent.mode.status" ? safeText(event?.mode, 32) : "",
    modeControl: nestedType === "agent.mode.status" ? safeText(event?.modeControl, 16) : "",
    availableModes: nestedType === "agent.mode.status"
      ? (Array.isArray(event?.availableModes) ? event.availableModes : [])
        .slice(0, 16)
        .map((item) => typeof item === "string"
          ? { id: safeText(item, 32), label: safeText(item, 64) }
          : {
              id: safeText(item?.id, 32),
              label: safeText(item?.label || item?.id, 64),
              description: safeText(item?.description, 256),
            })
        .filter((item) => item.id)
      : [],
  };
}

function safeRemoteShareCatalog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const catalog = [];
  for (const item of value.slice(0, 256)) {
    const provider = safeText(item?.provider, 640);
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    catalog.push({ provider, model: safeText(item?.model, 512) });
  }
  return catalog;
}

function stripAnsi(text) {
  return String(text || "").replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

async function resolveRelayAuth({
  stateDir,
  readCodingAuthFn,
  ensureFreshAccessTokenFn,
}) {
  let credential;
  try {
    credential = await ensureFreshAccessTokenFn({
      stateDir,
      resource: OAUTH_RESOURCES.RELAY,
    });
    if (!credential && readCodingAuthFn) credential = readCodingAuthFn(stateDir);
  } catch {
    return { error: "no_coding_auth" };
  }
  const token = accessTokenFor(credential, OAUTH_RESOURCES.RELAY)?.token;
  if (!token) return { error: "no_access_token" };
  if (!credential.deviceId) return { error: "no_device_id" };
  return { credential, token };
}

export function buildRuntimeEventEnvelope({
  sessionId,
  agentType,
  title,
  deviceName,
  eventType,
  event = null,
  riskLevel = null,
  summary = null,
  sequence = 0,
  clientEventId = null,
} = {}) {
  const projected = projectRuntimeEvent({ eventType, event, summary, riskLevel });
  if (!projected) return null;
  return {
    session_id: safeText(sessionId, 64),
    agent_type: safeText(agentType, 32),
    title: safeText(title, 191),
    device_name: safeText(deviceName, 191),
    event_type: safeText(projected.eventType, 64),
    status: safeText(projected.status, 32),
    summary: compactText(projected.summary, 512),
    detail: compactText(projected.detail, 512),
    current_step: compactText(projected.currentStep, 255),
    interaction_id: safeText(projected.interactionId, 191),
    action: safeText(projected.action, 64),
    risk_level: safeText(projected.riskLevel, 16) || "medium",
    command_preview: compactText(projected.commandPreview, 512),
    mode: safeText(projected.mode, 32),
    mode_control: safeText(projected.modeControl, 16),
    available_modes: projected.availableModes || [],
    sequence: Math.max(0, Number.parseInt(String(sequence || 0), 10) || 0),
    client_event_id: safeText(clientEventId, 96),
  };
}

export function createRuntimeEventReporter({
  sessionId,
  agentType,
  title,
  deviceName,
  stateDir = getStateDir(),
  reportRuntimeEventFn = reportRuntimeEvent,
} = {}) {
  let sequence = 0;
  let tail = Promise.resolve();
  const deliveredDedupeKeys = new Set();
  const pendingDedupeKeys = new Set();

  const sendWithRetry = async (payload) => {
    let result = { ok: false, error: "request_failed" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await reportRuntimeEventFn(payload, { stateDir }).catch(() => ({
        ok: false,
        error: "request_failed",
      }));
      if (result?.ok) return result;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    return result;
  };

  const report = (eventType, extra = {}) => {
    const payload = buildRuntimeEventEnvelope({
      sessionId,
      agentType,
      title,
      deviceName,
      eventType,
      event: eventType === "agent.event" ? extra.event : extra,
      riskLevel: extra.riskLevel,
      summary: extra.summary,
      sequence: sequence + 1,
      clientEventId: eventType === "agent.event" && extra.event?.eventId
        ? extra.event.eventId
        : `orev_${randomUUID()}`,
    });
    if (!payload) return tail;
    let dedupeKey = "";
    if (payload.event_type === "approval_requested" || payload.event_type === "interaction_requested") {
      dedupeKey = `approval_requested:${payload.interaction_id}`;
    }
    if ([
      "approval_applied", "approval_expired", "approval_failed",
      "interaction_applied", "interaction_expired", "interaction_failed", "interaction_canceled",
    ].includes(payload.event_type)) {
      dedupeKey = `${payload.event_type}:${payload.interaction_id}`;
    }
    if (
      dedupeKey
      && (deliveredDedupeKeys.has(dedupeKey) || pendingDedupeKeys.has(dedupeKey))
    ) {
      return tail;
    }
    if (dedupeKey) pendingDedupeKeys.add(dedupeKey);
    sequence += 1;
    tail = tail
      .then(() => sendWithRetry(payload))
      .then((result) => {
        if (dedupeKey && result?.ok) deliveredDedupeKeys.add(dedupeKey);
        return result;
      })
      .catch(() => ({ ok: false, error: "request_failed" }))
      .finally(() => {
        if (dedupeKey) pendingDedupeKeys.delete(dedupeKey);
      });
    return tail;
  };

  return {
    report,
    flush: () => tail,
  };
}

export async function reportRuntimeEvent(payload, {
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!payload) return { ok: false, error: "empty_runtime_event" };
  const resolved = await resolveRelayAuth({
    stateDir,
    readCodingAuthFn,
    ensureFreshAccessTokenFn,
  });
  if (resolved.error) return { ok: false, error: resolved.error };
  const { credential: auth, token } = resolved;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "fetch_unavailable" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${apiBase()}/cli/v1/agent/runtime-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-OriginRouter-Device-Id": auth.deviceId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, error: "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function buildAgentConversationMetadata(payload = {}) {
  const createdAt = safeIsoTimestamp(payload.createdAt || payload.created_at);
  const lastActivityAt = safeIsoTimestamp(
    payload.lastActivityAt || payload.last_activity_at,
  );
  const archivedAt = safeIsoTimestamp(payload.archivedAt || payload.archived_at);
  return {
    conversation_id: safeText(payload.conversationId || payload.conversation_id, 96),
    agent_type: safeText(payload.agentType || payload.agent_type, 32) || "unknown",
    native_session_id: safeText(payload.nativeSessionId || payload.native_session_id, 191),
    title: redactAgentActivityText(payload.title, 191) || "Agent session",
    summary: redactAgentActivityText(payload.summary, 4096),
    first_prompt_preview: redactAgentActivityText(
      payload.firstPromptPreview || payload.first_prompt_preview,
      1024,
    ),
    last_message_preview: redactAgentActivityText(
      payload.lastMessagePreview || payload.last_message_preview,
      1024,
    ),
    status: safeText(payload.status, 32) || "running",
    workspace_id: safeText(payload.workspaceId || payload.workspace_id, 96),
    workspace_name: safeText(payload.workspaceName || payload.workspace_name, 191),
    runtime: safeText(payload.runtime, 64),
    provider: safeText(payload.provider, 191),
    model: safeText(payload.model, 191),
    permission_profile: safeText(
      payload.permissionProfile || payload.permission_profile,
      64,
    ),
    artifact_count: Math.max(0, Number.parseInt(String(payload.artifactCount || 0), 10) || 0),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(lastActivityAt ? { last_activity_at: lastActivityAt } : {}),
    ...(archivedAt ? { archived_at: archivedAt } : {}),
  };
}

export async function reportAgentConversationMetadata(payload, {
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const body = buildAgentConversationMetadata(payload);
  if (!body.conversation_id) return { ok: false, error: "invalid_conversation_id" };
  const resolved = await resolveRelayAuth({
    stateDir,
    readCodingAuthFn,
    ensureFreshAccessTokenFn,
  });
  if (resolved.error) return { ok: false, error: resolved.error };
  const { credential: auth, token } = resolved;
  if (typeof fetchFn !== "function") return { ok: false, error: "fetch_unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const send = (candidate) => fetchFn(
      `${apiBase()}/cli/v1/agent/catalog/conversations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-OriginRouter-Device-Id": auth.deviceId,
        },
        body: JSON.stringify(candidate),
        signal: controller.signal,
      },
    );
    let resp = await send(body);
    let legacyFallback = false;
    if (
      resp.status === 422
      && (body.created_at || body.last_activity_at || body.archived_at)
    ) {
      const legacyBody = { ...body };
      delete legacyBody.created_at;
      delete legacyBody.last_activity_at;
      delete legacyBody.archived_at;
      resp = await send(legacyBody);
      legacyFallback = resp.ok;
    }
    return { ok: resp.ok, status: resp.status, legacyFallback };
  } catch {
    return { ok: false, error: "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export async function reportAgentSessionHeartbeat(sessionId, {
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedSessionId = safeText(sessionId, 64);
  if (!normalizedSessionId) return { ok: false, error: "invalid_session_id" };
  const resolved = await resolveRelayAuth({
    stateDir,
    readCodingAuthFn,
    ensureFreshAccessTokenFn,
  });
  if (resolved.error) return { ok: false, error: resolved.error };
  const { credential: auth, token } = resolved;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "fetch_unavailable" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const encodedSessionId = encodeURIComponent(normalizedSessionId);
    const resp = await fetchFn(
      `${apiBase()}/cli/v1/agent/sessions/${encodedSessionId}/heartbeat`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-OriginRouter-Device-Id": auth.deviceId,
        },
        signal: controller.signal,
      },
    );
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, error: "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function startAgentSessionHeartbeat({
  sessionId,
  stateDir = getStateDir(),
  intervalMs = DEFAULT_AGENT_SESSION_HEARTBEAT_INTERVAL_MS,
  reportHeartbeatFn = reportAgentSessionHeartbeat,
} = {}) {
  let stopped = false;
  let inFlight = false;
  let timer = null;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await reportHeartbeatFn(sessionId, { stateDir });
    } catch {
      // Presence is best-effort. The stale-session timeout is the fallback.
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, Math.max(5_000, intervalMs));

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export async function reportLocalControlRuntime(payload, {
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const resolved = await resolveRelayAuth({
    stateDir,
    readCodingAuthFn,
    ensureFreshAccessTokenFn,
  });
  if (resolved.error) return { ok: false, error: resolved.error };
  const { credential: auth, token } = resolved;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "fetch_unavailable" };
  }

  const compatibility = safeCompatibilityStatus(payload?.compatibility);
  const body = {
    cli_running: payload?.cliRunning !== false,
    cli_version: safeText(payload?.cliVersion, 64),
    cli_uptime_seconds: Math.max(0, Number.parseInt(String(payload?.cliUptimeSeconds ?? 0), 10) || 0),
    proxy_running: Boolean(payload?.proxyRunning),
    proxy_base_url: safeText(payload?.proxyBaseUrl, 255),
    remote_share_running: Boolean(payload?.remoteShareRunning),
    remote_share_base_url: safeText(payload?.remoteShareBaseUrl, 255),
    remote_share_catalog: safeRemoteShareCatalog(payload?.remoteShareCatalog),
    remote_share_e2ee_policy:
      payload?.remoteShareE2eePolicy === "required" ? "required" : "off",
    remote_share_e2ee_public_key: safeText(payload?.remoteShareE2eePublicKey, 256),
    agent_detail_profile: safeText(payload?.agentDetailProfile, 16) || "concise",
    providers: safeLocalControlProviders(payload?.providers),
    routes: safeLocalControlRoutes(payload?.routes),
    ...(compatibility ? { compatibility } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${apiBase()}/cli/v1/local-control/runtime`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-OriginRouter-Device-Id": auth.deviceId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, error: "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function createTerminalActivityReporter({
  sessionId,
  agentType,
  title,
  deviceName,
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  flushIntervalMs = DEFAULT_TERMINAL_ACTIVITY_INTERVAL_MS,
  reportRuntimeEventFn = reportRuntimeEvent,
} = {}) {
  let timer = null;
  let stopped = false;
  let stats = {
    chunkCount: 0,
    lineCount: 0,
    byteCount: 0,
  };

  const flush = async () => {
    if (stopped || stats.chunkCount <= 0) return;
    const payload = buildRuntimeEventEnvelope({
      sessionId,
      agentType,
      title,
      deviceName,
      eventType: "terminal.activity",
      summary: "Terminal activity detected",
      event: {
        chunk_count: stats.chunkCount,
        line_count: stats.lineCount,
        byte_count: stats.byteCount,
      },
    });
    stats = { chunkCount: 0, lineCount: 0, byteCount: 0 };
    await reportRuntimeEventFn(payload, {
      stateDir,
      fetchFn,
      readCodingAuthFn,
      timeoutMs,
    }).catch(() => {});
  };

  const schedule = () => {
    if (timer || stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      await flush();
    }, Math.max(50, flushIntervalMs));
  };

  return {
    ingest(data) {
      if (stopped) return;
      const raw = String(data || "");
      if (!raw) return;
      const sanitized = stripAnsi(raw);
      const lines = sanitized
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      stats.chunkCount += 1;
      stats.lineCount += lines.length;
      stats.byteCount += Buffer.byteLength(raw, "utf8");
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function approvalDecisionToRuntimeDecision(approval) {
  const decision = String(approval?.decision || "").trim().toLowerCase();
  if (decision === "allow") {
    return approval?.remember_for_session ? "approved_for_session" : "approved";
  }
  if (decision === "deny") {
    return "denied";
  }
  return "";
}

export async function pollResolvedApprovals({
  sessionId,
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  limit = 20,
} = {}) {
  const normalizedSessionId = safeText(sessionId, 64);
  if (!normalizedSessionId) {
    return { ok: false, error: "invalid_session_id", approvals: [] };
  }
  const resolved = await resolveRelayAuth({
    stateDir,
    readCodingAuthFn,
    ensureFreshAccessTokenFn,
  });
  if (resolved.error) {
    return { ok: false, error: resolved.error, approvals: [] };
  }
  const { credential: auth, token } = resolved;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "fetch_unavailable", approvals: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(`${apiBase()}/cli/v1/agent/approvals/decisions`);
    url.searchParams.set("session_id", normalizedSessionId);
    url.searchParams.set("limit", String(limit));
    const resp = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-OriginRouter-Device-Id": auth.deviceId,
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, approvals: [] };
    }
    const json = await resp.json().catch(() => ({}));
    const items = Array.isArray(json?.data?.approvals) ? json.data.approvals : [];
    const approvals = items
      .map((item) => {
        const approvalId = safeText(item?.approval_id, 64);
        const runtimeDecision = approvalDecisionToRuntimeDecision(item);
        if (!approvalId || !runtimeDecision) return null;
        return {
          approvalId,
          interactionId: safeText(item?.interaction_id, 191) || approvalId,
          sessionId: safeText(item?.session_id, 64) || normalizedSessionId,
          runtimeDecision,
          rememberForSession: Boolean(item?.remember_for_session),
          decidedAt: Number(item?.decided_at || 0),
        };
      })
      .filter(Boolean);
    return { ok: true, approvals };
  } catch {
    return { ok: false, error: "request_failed", approvals: [] };
  } finally {
    clearTimeout(timer);
  }
}

export function startApprovalDecisionPolling({
  sessionId,
  onDecision,
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  intervalMs = DEFAULT_APPROVAL_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  limit = 20,
} = {}) {
  if (typeof onDecision !== "function") {
    return () => {};
  }
  const seen = new Set();
  let timer = null;
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await pollResolvedApprovals({
        sessionId,
        stateDir,
        fetchFn,
        readCodingAuthFn,
        ensureFreshAccessTokenFn,
        timeoutMs,
        limit,
      });
      if (!result.ok) return;
      for (const approval of result.approvals) {
        if (!approval || seen.has(approval.approvalId)) continue;
        try {
          const applied = await onDecision({
            type: "agent.permission.resolve",
            sessionId: approval.sessionId,
            approvalId: approval.approvalId,
            callId: approval.interactionId,
            interactionId: approval.interactionId,
            decision: approval.runtimeDecision,
            decisionSource: "app_remote",
          });
          if (applied !== false) seen.add(approval.approvalId);
        } catch {
          // Keep the approval unseen so the next poll can retry delivery.
        }
      }
    } finally {
      inFlight = false;
    }
  };

  void tick();
  timer = setInterval(() => {
    void tick();
  }, Math.max(500, intervalMs));

  return () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
