import { readCodingAuth } from "../persistence/codingAuth.js";
import { getStateDir } from "../persistence/state.js";
import { DEFAULT_ORIGINROUTER_CONTROL_BASE_URL } from "../config/providerRoutes.js";
import { ensureFreshAccessToken } from "../runtime/relayTokenRefresher.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_APPROVAL_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TERMINAL_ACTIVITY_INTERVAL_MS = 2_000;

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

function stripAnsi(text) {
  return String(text || "").replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
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
} = {}) {
  return {
    session_id: safeText(sessionId, 64),
    agent_type: safeText(agentType, 32),
    title: safeText(title, 191),
    device_name: safeText(deviceName, 191),
    event_type: safeText(eventType, 64),
    risk_level: riskLevel ? safeText(riskLevel, 16) : undefined,
    summary: summary ? safeText(summary, 512) : undefined,
    event,
  };
}

export async function reportRuntimeEvent(payload, {
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let auth;
  try {
    auth = await ensureFreshAccessTokenFn({ stateDir });
    if (!auth && readCodingAuthFn) auth = readCodingAuthFn(stateDir);
  } catch {
    return { ok: false, error: "no_coding_auth" };
  }
  if (!auth || typeof auth.accessToken !== "string" || !auth.accessToken) {
    return { ok: false, error: "no_access_token" };
  }
  if (!auth.deviceId) {
    return { ok: false, error: "no_device_id" };
  }
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
        Authorization: `Bearer ${auth.accessToken}`,
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

export async function reportLocalControlRuntime(payload, {
  stateDir = getStateDir(),
  fetchFn = globalThis.fetch,
  readCodingAuthFn = readCodingAuth,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let auth;
  try {
    auth = await ensureFreshAccessTokenFn({ stateDir });
    if (!auth && readCodingAuthFn) auth = readCodingAuthFn(stateDir);
  } catch {
    return { ok: false, error: "no_coding_auth" };
  }
  if (!auth || typeof auth.accessToken !== "string" || !auth.accessToken) {
    return { ok: false, error: "no_access_token" };
  }
  if (!auth.deviceId) {
    return { ok: false, error: "no_device_id" };
  }
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "fetch_unavailable" };
  }

  const body = {
    cli_running: payload?.cliRunning !== false,
    cli_version: safeText(payload?.cliVersion, 64),
    cli_uptime_seconds: Math.max(0, Number.parseInt(String(payload?.cliUptimeSeconds ?? 0), 10) || 0),
    proxy_running: Boolean(payload?.proxyRunning),
    proxy_base_url: safeText(payload?.proxyBaseUrl, 255),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${apiBase()}/cli/v1/local-control/runtime`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.accessToken}`,
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
  let auth;
  try {
    auth = await ensureFreshAccessTokenFn({ stateDir });
    if (!auth && readCodingAuthFn) auth = readCodingAuthFn(stateDir);
  } catch {
    return { ok: false, error: "no_coding_auth", approvals: [] };
  }
  if (!auth || typeof auth.accessToken !== "string" || !auth.accessToken) {
    return { ok: false, error: "no_access_token", approvals: [] };
  }
  if (!auth.deviceId) {
    return { ok: false, error: "no_device_id", approvals: [] };
  }
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
        Authorization: `Bearer ${auth.accessToken}`,
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
        seen.add(approval.approvalId);
        onDecision({
          type: "agent.permission.resolve",
          sessionId: approval.sessionId,
          callId: approval.approvalId,
          interactionId: approval.approvalId,
          decision: approval.runtimeDecision,
        });
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
