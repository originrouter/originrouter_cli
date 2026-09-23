import { randomUUID } from "node:crypto";

import { readCodingAuth } from "../persistence/codingAuth.js";
import { getStateDir } from "../persistence/state.js";
import { DEFAULT_ORIGINROUTER_CONTROL_BASE_URL } from "../config/providerRoutes.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";
import {
  compactText,
  projectRuntimeEvent,
  redactAgentActivityText,
  normalizeAgentActivityEventType,
  shouldSyncAgentActivitySnapshot,
  updateAgentActivitySnapshot,
  safeAgentBudgets,
  safeCompatibilityStatus,
  safeIsoTimestamp,
  safeLocalControlProviders,
  safeLocalControlRoutes,
  safeRemoteShareCatalog,
  safeText,
  stripAnsi,
} from "./bridgeProjections.js";

export {
  normalizeAgentActivityEventType,
  redactAgentActivityText,
  shouldSyncAgentActivitySnapshot,
  updateAgentActivitySnapshot,
} from "./bridgeProjections.js";

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
  workspaceDisplayPath,
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
    ...(safeText(workspaceDisplayPath, 4096)
      ? { workspace_display_path: safeText(workspaceDisplayPath, 4096) }
      : {}),
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
  workspaceDisplayPath = "",
  stateDir = getStateDir(),
  reportRuntimeEventFn = reportRuntimeEvent,
  telemetryQueue = null,
  telemetryUploader = null,
  telemetryContext = null,
} = {}) {
  let sequence = 0;
  let tail = Promise.resolve();
  const deliveredDedupeKeys = new Set();
  const pendingDedupeKeys = new Set();
  // Agent runtimes are generally single-turn per session. Keep this state at
  // the reporting boundary so a clean process exit cannot masquerade as a
  // completed task, while still allowing real structured turn results to
  // notify the user.
  let taskActive = false;
  let activeDirectRootTaskId = "";

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
      workspaceDisplayPath,
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
    if (telemetryQueue?.enqueue) {
      const rawEvent = eventType === "agent.event" ? extra.event : extra;
      const context = typeof telemetryContext === "function"
        ? telemetryContext()
        : (telemetryContext || {});
      const rawTaskId = rawEvent?.taskId || rawEvent?.task_id
        || (String(rawEvent?.type || "").startsWith("agent.task.") ? rawEvent?.id : "");
      const isDirectWrapper = context?.bundleOrigin === "direct_wrapper"
        || context?.bundle_origin === "direct_wrapper";
      if (isDirectWrapper && String(rawEvent?.type || "") === "agent.task.started" && rawTaskId) {
        activeDirectRootTaskId = String(rawTaskId);
      }
      const rootTaskId = rawEvent?.rootTaskId || rawEvent?.root_task_id
        || (isDirectWrapper ? activeDirectRootTaskId || rawTaskId : "");
      telemetryQueue.enqueue({
        eventId: payload.client_event_id,
        idempotencyKey: `runtime:${sessionId}:${payload.sequence}:${payload.event_type}`,
        eventType: payload.event_type,
        occurredAt: rawEvent?.createdAt || rawEvent?.created_at || new Date().toISOString(),
        sessionId,
        agentType,
        eventSeq: payload.sequence,
        taskId: rawTaskId || undefined,
        rootTaskId: rootTaskId || undefined,
        parentTaskId: rawEvent?.parentTaskId || rawEvent?.parent_task_id,
        agentId: rawEvent?.agentId || rawEvent?.agent_id,
        parentAgentId: rawEvent?.parentAgentId || rawEvent?.parent_agent_id,
        delegationId: rawEvent?.delegationId || rawEvent?.delegation_id || rawEvent?.parentToolUseId,
        delegationDepth: rawEvent?.delegationDepth || rawEvent?.delegation_depth,
        delegationDetected: rawEvent?.delegationDetected ?? rawEvent?.delegation_detected
          ?? ["subagent", "subagent_started", "subagent_stopped"].includes(rawEvent?.activity),
        taskRole: rawEvent?.taskRole || rawEvent?.task_role,
        taskKind: rawEvent?.taskKind || rawEvent?.task_kind,
        modelTier: rawEvent?.modelTier || rawEvent?.model_tier,
        attempt: rawEvent?.attempt,
        provider: rawEvent?.provider,
        model: rawEvent?.model,
        responseId: rawEvent?.responseId || rawEvent?.response_id,
        gatewayResponseIds: rawEvent?.gatewayResponseIds
          || rawEvent?.gateway_response_ids
          || (rawEvent?.gatewayResponseId || rawEvent?.gateway_response_id
            ? [rawEvent.gatewayResponseId || rawEvent.gateway_response_id]
            : undefined),
        payload: {
          summary: rawEvent?.summary || payload.summary,
          status: rawEvent?.status || payload.status,
          type: rawEvent?.type || eventType,
          activity: rawEvent?.activity,
          visibility: rawEvent?.visibility,
          metadata: rawEvent?.metadata,
          tool: rawEvent?.tool,
          call_id: rawEvent?.callId || rawEvent?.call_id,
          is_error: rawEvent?.isError ?? rawEvent?.is_error,
          token_usage: rawEvent?.tokenUsage || rawEvent?.token_usage,
          sampled_tokens: rawEvent?.sampledTokens || rawEvent?.sampled_tokens,
          amount_micros: rawEvent?.amountMicros ?? rawEvent?.amount_micros,
          currency: rawEvent?.currency,
          cost_source: rawEvent?.costSource || rawEvent?.cost_source,
          duration_ms: rawEvent?.durationMs ?? rawEvent?.duration_ms,
          num_turns: rawEvent?.numTurns ?? rawEvent?.num_turns,
          stop_reason: rawEvent?.stopReason || rawEvent?.stop_reason,
          retry: rawEvent?.retry,
          retry_count: rawEvent?.retryCount ?? rawEvent?.retry_count,
          verification_passed: rawEvent?.verificationPassed ?? rawEvent?.verification_passed,
          task_completed: rawEvent?.taskCompleted
            ?? rawEvent?.task_completed
            ?? ["agent.task.complete", "agent.task.completed", "task_complete"].includes(rawEvent?.type),
          task_failed: rawEvent?.taskFailed
            ?? rawEvent?.task_failed
            ?? ["agent.task.failed", "task_failed", "turn_aborted"].includes(rawEvent?.type),
          retry_attempt: rawEvent?.retryAttempt
            ?? rawEvent?.retry_attempt
            ?? rawEvent?.metadata?.attempt,
          event_seq: payload.sequence,
          task_role: rawEvent?.taskRole || rawEvent?.task_role,
          task_kind: rawEvent?.taskKind || rawEvent?.task_kind,
          model_tier: rawEvent?.modelTier || rawEvent?.model_tier,
          risk_level: rawEvent?.riskLevel || rawEvent?.risk_level,
          decision: rawEvent?.decision,
          confidence: rawEvent?.confidence,
          success: rawEvent?.success,
          response_id: rawEvent?.responseId || rawEvent?.response_id,
          gateway_response_ids: rawEvent?.gatewayResponseIds
            || rawEvent?.gateway_response_ids
            || (rawEvent?.gatewayResponseId || rawEvent?.gateway_response_id
              ? [rawEvent.gatewayResponseId || rawEvent.gateway_response_id]
              : undefined),
        },
      }, {
        ...context,
        sessionId,
        agentType,
        provider: rawEvent?.provider || context.provider,
        model: rawEvent?.model || context.model,
      });
      if (telemetryUploader?.schedule) telemetryUploader.schedule();
      else if (telemetryUploader?.flush) void telemetryUploader.flush().catch(() => {});
    }
    if (payload.event_type === "agent.task.started") {
      // Launching a runtime and receiving the provider's structured turn
      // start can describe the same task. One activity event is enough.
      if (taskActive) return tail;
      taskActive = true;
    } else if (
      payload.event_type === "agent.task.complete" ||
      payload.event_type === "agent.task.failed"
    ) {
      if (taskActive) {
        payload.event_type = payload.event_type === "agent.task.complete"
          ? "task_result_ready"
          : "task_failed";
        payload.summary = payload.event_type === "task_result_ready"
          ? "Task result ready"
          : "Task needs attention";
        payload.current_step = payload.summary;
        taskActive = false;
      }
    } else if (
      eventType === "session.exited" &&
      payload.status === "failed" &&
      taskActive
    ) {
      // If an active task loses its runtime before it can emit a structured
      // failure, report one actionable task failure. A later clean exit
      // cannot emit another notification because taskActive is now false.
      payload.event_type = "task_failed";
      payload.summary = "Task interrupted before completion";
      payload.current_step = payload.summary;
      taskActive = false;
    }
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
    workspace_display_path: safeText(
      payload.workspaceDisplayPath || payload.workspace_display_path,
      4096,
    ),
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
    let resp;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        resp = await send(body);
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
      if (resp.ok || !retryable || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
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

export async function reportAgentHistoryChunk(document, {
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = 30_000,
} = {}) {
  if (!document || typeof document !== "object") {
    return { ok: false, error: "invalid_history_chunk" };
  }
  const resolved = await resolveRelayAuth({
    stateDir,
    readCodingAuthFn,
    ensureFreshAccessTokenFn,
  });
  if (resolved.error) return { ok: false, error: resolved.error };
  const { credential: auth, token } = resolved;
  if (document.device_id !== auth.deviceId) {
    return { ok: false, error: "device_mismatch" };
  }
  if (typeof fetchFn !== "function") return { ok: false, error: "fetch_unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${apiBase()}/cli/v1/agent/history/chunks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-OriginRouter-Device-Id": auth.deviceId,
      },
      body: JSON.stringify({ document }),
      signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    return {
      ok: response.ok,
      status: response.status,
      data: payload?.data,
      error: response.ok ? null : payload?.detail?.code || payload?.code || `http_${response.status}`,
      retryable: response.status >= 500 || response.status === 429,
    };
  } catch {
    return { ok: false, error: "request_failed", retryable: true };
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
    agent_budgets: safeAgentBudgets(payload?.agentBudgets),
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
