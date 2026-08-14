import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { ensureStateDir } from "./state.js";
import { analyzeRuntimeOperation } from "../runtime/operationRisk.js";

const MAX_LINE_BYTES = 64 * 1024;
const MAX_RECORDS_PER_READ = 20_000;

const DESTRUCTIVE_PATTERNS = [
  /(^|[;&|]\s*)rm\s+/i,
  /(^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\b|checkout\s+--|restore\b)/i,
  /\b(?:drop|truncate)\s+(?:database|table)\b/i,
  /(^|[;&|]\s*)(?:mkfs|fdisk|diskutil|dd)(\s|$)/i,
];
const DATABASE_MUTATION_PATTERNS = [
  /\b(?:insert\s+into|update\s+[\w`".]+\s+set|delete\s+from|alter\s+table|create\s+(?:table|database|index)|drop\s+(?:table|database|index)|truncate\s+table|replace\s+into)\b/i,
  /\b(?:alembic|prisma|sequelize|typeorm|knex|django-admin|manage\.py)\b[^\n]*(?:migrate|upgrade|seed)/i,
  /\b(?:mysql|psql|sqlite3)\b[^\n]*(?:-[eEc]\s+|<\s*\S+\.sql\b)/i,
];
const REMOTE_MUTATION_PATTERNS = [
  /(^|[;&|]\s*)(?:ssh|scp|rsync)(\s|$)/i,
  /(^|[;&|]\s*)git\s+push\b/i,
  /(^|[;&|]\s*)(?:kubectl|helm|terraform)(\s|$)/i,
  /(^|[;&|]\s*)curl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
];
const SYSTEM_MUTATION_PATTERNS = [
  /(^|[;&|]\s*)(?:sudo|doas)\s+(?:systemctl|service|launchctl|apt|apt-get|yum|dnf|brew|cp|mv|rm|chmod|chown|tee|sed\s+-i)\b/i,
  /(^|[;&|]\s*)(?:systemctl|service|launchctl)(\s|$)/i,
  /(^|[;&|]\s*)(?:docker|podman)\s+(?:compose\s+)?(?:up|down|restart|rm|run|exec|build)\b/i,
  /(^|[;&|]\s*)(?:chmod|chown)(\s|$)/i,
];
const SCRIPT_MUTATION_PATTERN = /(^|[;&|]\s*)(?:python(?:3)?|node|bash|sh)\s+[^\n]*(?:migrat|deploy|seed|backfill|cleanup|repair|restore|rollback|upgrade|patch|fix)[^\n]*/i;
const SCRIPT_PATH_PATTERN = /(?:^|[;&|]\s*)(?:python(?:3)?|node|bash|sh)\s+['"]?([^\s'"]+\.(?:py|js|mjs|cjs|sh))\b/i;

function safeText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeObject(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeObject(item, depth + 1));
  if (typeof value !== "object") return redactCommand(value).slice(0, 4096);
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    if (/token|secret|password|authorization|api[_-]?key|cookie/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[safeText(key, 128)] = safeObject(child, depth + 1);
    }
  }
  return out;
}

function redactCommand(value) {
  return safeText(value, 1536)
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s'";]+/gi, "$1[redacted]")
    .replace(/\b(sk-[a-z0-9_-]{12,}|or_(?:at|rt|lk)_[a-z0-9_-]{12,})\b/gi, "[redacted]");
}

function normalizedTool(event) {
  return safeText(event?.tool || event?.payload?.tool || event?.input?.tool, 128).toLowerCase();
}

function commandFromEvent(event) {
  return redactCommand(
    event?.input?.command
      || event?.payload?.command
      || event?.command
      || "",
  );
}

function interactionId(event) {
  return safeText(event?.interactionId || event?.callId || event?.id, 191);
}

function eventTime(event, now) {
  const raw = event?.createdAt;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw < 10_000_000_000 ? raw * 1000 : raw).toISOString();
  }
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(now()).toISOString();
}

function isInsideWorkspace(candidate, workspaceRoot) {
  const value = safeText(candidate, 4096);
  if (!value) return true;
  if (value === "~" || value.startsWith("~/") || value.startsWith("$")) return false;
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  const resolved = path.resolve(root, value);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function collectPaths(value, key = "", result = []) {
  if (result.length >= 64 || value == null) return result;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, key, result);
    return result;
  }
  if (typeof value !== "object") {
    if (/^(?:file_?path|path|cwd|destination|target)$/i.test(key)) result.push(String(value));
    return result;
  }
  for (const [childKey, child] of Object.entries(value)) {
    if ((childKey.includes("/") || childKey.startsWith(".")) && childKey.length < 4096) result.push(childKey);
    collectPaths(child, childKey, result);
  }
  return result;
}

function approvalRisk(event, cwd) {
  const tool = normalizedTool(event);
  const payload = event?.payload || event?.input || {};
  const command = commandFromEvent(event);
  if (event?.containsSecret) return "high";
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) return "critical";
  if (
    DATABASE_MUTATION_PATTERNS.some((pattern) => pattern.test(command))
    || REMOTE_MUTATION_PATTERNS.some((pattern) => pattern.test(command))
    || SYSTEM_MUTATION_PATTERNS.some((pattern) => pattern.test(command))
  ) return "high";
  if (["edit", "write", "multiedit", "applypatch", "file_change", "patch"].includes(tool.replace(/[^a-z0-9_]/g, ""))) {
    const paths = collectPaths(payload);
    return paths.every((item) => isInsideWorkspace(item, cwd)) ? "normal" : "high";
  }
  return "normal";
}

function approvalRequest(session, event, now) {
  const id = interactionId(event);
  if (!id) return null;
  const payload = event?.payload || event?.input || {};
  const tool = normalizedTool(event) || safeText(payload?.display_name, 128);
  const command = event?.containsSecret ? "" : commandFromEvent(event);
  const operation = event?.containsSecret ? null : analyzeRuntimeOperation(session, {
    type: "agent.tool_call.start",
    callId: id,
    tool,
    input: payload,
  });
  return {
    category: "approval",
    correlationId: id,
    phase: "requested",
    actionKind: safeText(event?.kind, 32) || "permission",
    title: safeText(event?.title, 256) || (tool ? `${tool} requires approval` : "Agent approval required"),
    summary: event?.containsSecret
      ? "Sensitive approval request"
      : safeText(event?.prompt, 1024) || "Review the requested action before continuing.",
    risk: operation?.risk === "critical"
      ? "critical"
      : operation?.risk === "high"
        ? "high"
        : approvalRisk(event, session?.cwd),
    outcome: "pending",
    decisionSource: safeText(event?.source, 32) || "agent",
    tool,
    commandPreview: command,
    cwd: safeText(payload?.cwd || session?.cwd, 2048),
    detail: event?.containsSecret
      ? { redacted: true }
      : safeObject({
          tool: payload?.tool,
          display_name: payload?.display_name,
          blocked_path: payload?.blocked_path,
          operation,
        }),
    createdAt: eventTime(event, now),
  };
}

function approvalOutcome(event, now) {
  const id = interactionId(event);
  if (!id) return null;
  const type = safeText(event?.type, 96);
  const action = safeText(event?.action || event?.decision, 32).toLowerCase();
  const status = safeText(event?.status, 32).toLowerCase();
  let outcome = status || action || "resolved";
  if (["allow", "approved", "approved_for_session", "applied"].includes(outcome)) outcome = "allowed";
  if (outcome === "applying") outcome = "pending";
  if (["deny", "denied", "decline"].includes(outcome)) outcome = "denied";
  if (["abort", "cancel", "canceled"].includes(outcome)) outcome = "canceled";
  if (type === "agent.interaction.auto_resolved") {
    outcome = ["deny", "denied"].includes(String(event?.decision || "").toLowerCase())
      ? "denied"
      : "allowed";
  }
  return {
    category: "approval",
    correlationId: id,
    phase: type === "agent.interaction.auto_resolved" ? "auto_resolved" : "resolved",
    actionKind: safeText(event?.kind, 32),
    title: safeText(event?.title, 256),
    risk: type === "agent.interaction.auto_resolved"
      ? [
          "additional_permissions",
          "destructive_commands",
          "elevated_commands",
          "network_mutations",
          "outside_workspace",
          "unknown_tools",
        ].includes(event?.autonomyScope)
        ? "high"
        : "normal"
      : "",
    outcome,
    decisionSource: type === "agent.interaction.auto_resolved"
      ? safeText(event?.decisionSource, 32) || "automatic"
      : safeText(event?.decisionSource, 32) || "unknown",
    summary: safeText(event?.reason, 1024),
    detail: safeObject({
      autonomyProfile: event?.autonomyProfile,
      autonomyScope: event?.autonomyScope,
      responseId: event?.responseId,
      decision: event?.decision,
      aiReview: event?.aiReview,
    }),
    createdAt: eventTime(event, now),
  };
}

function changeCandidate(session, event) {
  const tool = normalizedTool(event).replace(/[^a-z0-9_]/g, "");
  const input = event?.input && typeof event.input === "object" ? event.input : {};
  const command = commandFromEvent(event);
  const cwd = safeText(input.cwd || session?.cwd, 2048);
  const paths = collectPaths(input);
  const outsidePaths = paths.filter((item) => !isInsideWorkspace(item, session?.cwd));

  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
    return { actionKind: "destructive_command", risk: "critical", summary: "Destructive command", command, cwd, tool };
  }
  if (DATABASE_MUTATION_PATTERNS.some((pattern) => pattern.test(command))) {
    return { actionKind: "database_mutation", risk: "high", summary: "Database mutation", command, cwd, tool };
  }
  if (REMOTE_MUTATION_PATTERNS.some((pattern) => pattern.test(command))) {
    return { actionKind: "remote_mutation", risk: "high", summary: "Remote or infrastructure change", command, cwd, tool };
  }
  if (SYSTEM_MUTATION_PATTERNS.some((pattern) => pattern.test(command))) {
    return { actionKind: "system_mutation", risk: "high", summary: "System configuration change", command, cwd, tool };
  }
  const scriptPath = command.match(SCRIPT_PATH_PATTERN)?.[1] || "";
  if (
    SCRIPT_MUTATION_PATTERN.test(command)
    || (scriptPath && !isInsideWorkspace(scriptPath, session?.cwd))
  ) {
    return { actionKind: "potential_script_mutation", risk: "elevated", summary: "Potential external change from script", command, cwd, tool };
  }
  if (outsidePaths.length > 0 && ["edit", "write", "multiedit", "applypatch", "file_change", "patch"].includes(tool)) {
    return {
      actionKind: "outside_workspace_change",
      risk: "high",
      summary: "File change outside the workspace",
      command,
      cwd,
      target: safeText(outsidePaths.join(", "), 4096),
      tool,
    };
  }
  return null;
}

function mergeProjectedRecords(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.category}:${record.correlationId}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...record, updatedAt: record.createdAt });
      continue;
    }
    const createdAt = existing.createdAt;
    for (const [field, value] of Object.entries(record)) {
      if (value !== null && value !== undefined && value !== "") existing[field] = value;
    }
    existing.createdAt = createdAt;
    existing.updatedAt = record.createdAt;
    existing.sequence = Math.max(Number(existing.sequence || 0), Number(record.sequence || 0));
  }
  return [...groups.values()];
}

export class LocalAuditStore {
  constructor({
    stateDir = ensureStateDir(),
    now = () => Date.now(),
    operationReviewer = null,
  } = {}) {
    this.root = path.join(stateDir, "audit", "sessions");
    this.now = now;
    this.sessionState = new Map();
    this.pendingChanges = new Map();
    this.operationReviewer = operationReviewer;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    chmodSync(this.root, 0o700);
  }

  appendEvent(session, event = {}) {
    const sessionId = safeText(session?.sessionId || event?.sessionId, 64);
    if (!sessionId) return [];
    const type = safeText(event?.type, 96);
    const records = [];
    if (type === "agent.interaction.requested" || type === "agent.permission.request.detected") {
      const record = approvalRequest(session, event, this.now);
      if (record) records.push(record);
    } else if (
      type === "agent.interaction.result"
      || type === "agent.interaction.auto_resolved"
      || type === "agent.permission.resolved"
      || /^agent\.interaction\.(?:applied|expired|failed|canceled)$/.test(type)
    ) {
      const record = approvalOutcome(event, this.now);
      if (record) records.push(record);
    }

    const callId = safeText(event?.callId || event?.id, 191);
    const pendingKey = `${sessionId}:${callId}`;
    if (type === "agent.tool_call.start" && callId) {
      const operation = analyzeRuntimeOperation(session, event);
      const legacyCandidate = changeCandidate(session, event);
      const semanticCandidate = operation.shouldRecord
        || (operation.needsAiReview && this.operationReviewer);
      const candidate = semanticCandidate
        ? {
            actionKind: legacyCandidate?.actionKind || operation.actions[0] || "contextual_operation",
            risk: operation.risk === "critical" ? "critical" : (legacyCandidate?.risk || operation.risk),
            summary: legacyCandidate?.summary || operation.title,
            command: commandFromEvent(event),
            cwd: safeText(event?.input?.cwd || session?.cwd, 2048),
            target: safeText(operation.resources.map((item) => item.value).join(", "), 4096),
            tool: normalizedTool(event),
            operation,
          }
        : legacyCandidate;
      if (candidate) {
        candidate.outcome = "started";
        this.pendingChanges.set(pendingKey, candidate);
        const auditPayload = ({
          phase = "started",
          outcome = "started",
          decisionSource = "agent",
          summary = "",
          risk = candidate.risk,
          detail = {},
        } = {}) => ({
          category: "change",
          correlationId: callId,
          phase,
          actionKind: candidate.actionKind,
          title: candidate.summary,
          summary,
          risk,
          outcome,
          decisionSource,
          tool: candidate.tool,
          commandPreview: candidate.command,
          cwd: candidate.cwd,
          target: candidate.target || "",
          detail: safeObject({
            result: outcome,
            operation: candidate.operation || null,
            ...detail,
          }),
          createdAt: eventTime(event, this.now),
        });
        const deferred = Boolean(candidate.operation?.needsAiReview && this.operationReviewer);
        if (!deferred) {
          records.push(auditPayload({ detail: { analysis_state: "deterministic" } }));
        }
        if (candidate.operation?.needsAiReview && this.operationReviewer) {
          void this.operationReviewer.review({ session, event, analysis: candidate.operation })
            .then((review) => {
              candidate.reviewResult = review;
              const deterministicHigh = candidate.operation.deterministic?.hardHigh;
              const record = deterministicHigh ? true : Boolean(review.record);
              candidate.reviewShouldRecord = record;
              if (!record) return;
              this.append(sessionId, {
                ...auditPayload({
                  phase: "analyzed",
                  outcome: candidate.outcome,
                  decisionSource: "ai_audit_reviewer",
                  summary: safeText(review.reason, 2048),
                  risk: deterministicHigh ? candidate.risk : safeText(review.risk, 16) || candidate.risk,
                  detail: { aiReview: review, analysis_state: "completed" },
                }),
                actionKind: safeText(review.action_kind, 64) || candidate.actionKind,
                title: safeText(review.title, 256) || candidate.summary,
              });
            })
            .catch(() => {
              candidate.reviewFailed = true;
              this.append(sessionId, auditPayload({
                phase: "analyzed",
                outcome: candidate.outcome,
                decisionSource: "deterministic_fallback",
                summary: candidate.operation.reason,
                detail: {
                  analysis_source: "deterministic_fallback",
                  analysis_state: "ai_exhausted",
                  fallback: true,
                },
              }));
            });
        }
      }
    } else if (type === "agent.tool_call.end" && callId) {
      const candidate = this.pendingChanges.get(pendingKey);
      this.pendingChanges.delete(pendingKey);
      if (candidate) {
        candidate.outcome = event?.isError ? "failed" : "succeeded";
        if (candidate.reviewResult && candidate.reviewShouldRecord) {
          records.push({
            category: "change",
            correlationId: callId,
            phase: "completed",
            actionKind: safeText(candidate.reviewResult.action_kind, 64) || candidate.actionKind,
            title: safeText(candidate.reviewResult.title, 256) || candidate.summary,
            summary: safeText(candidate.reviewResult.reason, 2048),
            risk: safeText(candidate.reviewResult.risk, 16) || candidate.risk,
            outcome: candidate.outcome,
            decisionSource: "ai_audit_reviewer",
            tool: candidate.tool,
            commandPreview: candidate.command,
            cwd: candidate.cwd,
            target: candidate.target || "",
            detail: safeObject({
              result: candidate.outcome,
              operation: candidate.operation,
              aiReview: candidate.reviewResult,
              analysis_state: "completed",
            }),
            createdAt: eventTime(event, this.now),
          });
        } else if (!(candidate.operation?.needsAiReview && this.operationReviewer) || candidate.reviewFailed) records.push({
          category: "change",
          correlationId: callId,
          phase: "completed",
          actionKind: candidate.actionKind,
          title: candidate.summary,
          summary: "",
          risk: candidate.risk,
          outcome: candidate.outcome,
          decisionSource: "agent",
          tool: candidate.tool,
          commandPreview: candidate.command,
          cwd: candidate.cwd,
          target: candidate.target || "",
          detail: safeObject({
            result: event?.isError ? "failed" : "succeeded",
            operation: candidate.operation || null,
          }),
          createdAt: eventTime(event, this.now),
        });
      }
    }

    return records.map((record) => this.append(sessionId, record)).filter(Boolean);
  }

  append(sessionId, payload) {
    const state = this.loadState(sessionId);
    const dedupeKey = `${payload.category}:${payload.correlationId}:${payload.phase}:${payload.outcome || ""}`;
    if (state.seen.has(dedupeKey)) return null;
    const base = {
      auditId: `audit_${randomUUID()}`,
      sessionId,
      sequence: state.sequence + 1,
      ...payload,
      previousHash: state.lastHash,
    };
    if (Buffer.byteLength(`${JSON.stringify(base)}\n`) > MAX_LINE_BYTES) {
      base.detail = { truncated: true };
    }
    const hash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
    const record = { ...base, hash };
    appendFileSync(state.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(state.path, 0o600);
    state.sequence = record.sequence;
    state.lastHash = record.hash;
    state.seen.add(dedupeKey);
    return record;
  }

  list(sessionId, { category = "", beforeCursor = null, limit = 50 } = {}) {
    const file = this.filePath(sessionId);
    const requestedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    if (!existsSync(file)) return { records: [], nextCursor: null, hasMore: false };
    const before = beforeCursor == null || beforeCursor === "" ? Number.POSITIVE_INFINITY : Number(beforeCursor);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const raw = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (category && record.category !== category) continue;
        raw.push(record);
      } catch {}
    }
    const projected = mergeProjectedRecords(raw)
      .filter((record) => Number(record.sequence || 0) < before)
      .sort((a, b) => Number(b.sequence || 0) - Number(a.sequence || 0));
    const records = projected.slice(0, requestedLimit);
    const nextCursor = records.length > 0 ? String(records[records.length - 1].sequence) : null;
    return {
      records,
      nextCursor,
      hasMore: projected.length > records.length,
    };
  }

  loadState(sessionId) {
    const key = safeText(sessionId, 64);
    const cached = this.sessionState.get(key);
    if (cached) return cached;
    const file = this.filePath(key);
    const state = { path: file, sequence: 0, lastHash: "", seen: new Set() };
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-MAX_RECORDS_PER_READ)) {
        try {
          const record = JSON.parse(line);
          state.sequence = Math.max(state.sequence, Number(record.sequence || 0));
          if (Number(record.sequence || 0) === state.sequence) state.lastHash = safeText(record.hash, 128);
          state.seen.add(`${record.category}:${record.correlationId}:${record.phase}:${record.outcome || ""}`);
        } catch {}
      }
    }
    this.sessionState.set(key, state);
    return state;
  }

  filePath(sessionId) {
    const digest = createHash("sha256").update(safeText(sessionId, 64)).digest("hex");
    return path.join(this.root, `${digest}.jsonl`);
  }
}
