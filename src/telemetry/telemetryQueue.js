import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { ensureStateDir } from "../persistence/state.js";
import { readCodingAuth } from "../persistence/codingAuth.js";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_GATEWAY_IDS = 16;
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DROPPED_RETENTION_MS = 24 * 60 * 60 * 1000;
const INTERNAL_ID_PREFIX = /^(?:terminal|policy|ai|auto|legacy):/i;
const BUNDLE_ORIGINS = new Set(["collaboration_run", "direct_wrapper"]);
const CONTENT_AVAILABILITY = new Set(["gateway_linked", "metadata_only"]);

const FACT_KEYS = new Set([
  "status", "type", "activity", "tool", "call_id", "is_error",
  "provider", "model", "provider_type",
  "sampled_tokens", "amount_micros", "currency", "cost_source",
  "duration_ms", "num_turns", "stop_reason", "retry", "retry_count",
  "rework_requested", "retry_scheduled",
  "verification_passed", "task_completed", "task_failed", "retry_attempt",
  "event_seq", "task_role", "task_kind", "model_tier", "risk_level",
  "decision", "success", "confidence", "response_id", "gateway_response_ids",
  "category", "severity", "visibility", "attempt", "metadata", "token_usage",
  "plan_version", "task_count", "dependency_count", "depends_on_task_ids",
  "agent_id", "parent_agent_id", "delegation_id", "delegation_depth", "delegation_detected",
  "message_id", "message_type", "message_sequence", "correlation_id",
  "parent_message_id", "causation_id", "sender_kind", "recipient_kind",
  "requires_ack", "artifact_ref_count", "evidence_ref_count", "sensitivity",
  "artifact_kind", "artifact_owner_agent_id",
  "assignment_id", "assignment_phase", "assignment_status", "assignment_runtime",
  "assignment_role", "assignment_attempt", "assignment_fence",
  "assignment_source_device_id", "assignment_target_device_id",
]);
const METADATA_FACT_KEYS = new Set([
  "task_id", "tool_use_id", "status", "subagent_type", "task_type",
  "workflow_name", "last_tool_name", "is_backgrounded", "skip_transcript",
  "kind", "agent_thread_id", "agent_id", "agent_type", "parent_agent_id",
  "parent_tool_use_id", "hook_event", "permission_mode", "outcome", "exit_code",
  "attempt", "max_retries", "retry_delay_ms", "error_status", "trigger",
  "pre_tokens", "post_tokens", "duration_ms", "count", "mode", "phase",
  "from_model", "to_model", "model_provider_id", "model", "provider",
  "reasoning_effort", "service_tier", "wire_api", "response_id",
  "gateway_response_id",
]);
const TOKEN_FACT_KEYS = new Set([
  "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_input_tokens",
  "cache_write_input_tokens", "cache_write_5m_input_tokens", "cache_write_1h_input_tokens",
]);

function text(value, max = 4096) {
  return String(value ?? "").trim().slice(0, max);
}

function iso(value) {
  const parsed = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function safeFactScalar(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return text(value, 191);
  return undefined;
}

function safeFactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const facts = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) continue;
    const scalar = safeFactScalar(item);
    if (scalar !== undefined) facts[key] = scalar;
  }
  return facts;
}

function safePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const facts = {};
  for (const [key, item] of Object.entries(value)) {
    if (!FACT_KEYS.has(key)) continue;
    if (key === "metadata") {
      const metadata = safeFactObject(item, METADATA_FACT_KEYS);
      if (Object.keys(metadata).length) facts.metadata = metadata;
      continue;
    }
    if (key === "token_usage") {
      const usage = safeFactObject(item, TOKEN_FACT_KEYS);
      if (Object.keys(usage).length) facts.token_usage = usage;
      continue;
    }
    if (key === "gateway_response_ids" && Array.isArray(item)) {
      facts.gateway_response_ids = item.map((entry) => text(entry, 255)).filter(Boolean).slice(0, MAX_GATEWAY_IDS);
      continue;
    }
    if (key === "depends_on_task_ids" && Array.isArray(item)) {
      facts.depends_on_task_ids = item.map((entry) => text(entry, 195)).filter(Boolean).slice(0, 128);
      continue;
    }
    const scalar = safeFactScalar(item);
    if (scalar !== undefined) facts[key] = scalar;
  }
  const encoded = JSON.stringify(facts);
  if (Buffer.byteLength(encoded, "utf8") <= MAX_PAYLOAD_BYTES) return facts;
  return {
    truncated: true,
    original_bytes: Buffer.byteLength(encoded, "utf8"),
  };
}

function gatewayIds(input, providerSource) {
  if (providerSource !== "originrouter-coding") return [];
  const values = input.gatewayResponseIds
    || input.gateway_response_ids
    || input.responseIds
    || input.response_ids
    || (input.responseId || input.response_id ? [input.responseId || input.response_id] : []);
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => text(value, 255)))]
    .filter((value) => value && !INTERNAL_ID_PREFIX.test(value))
    .slice(0, MAX_GATEWAY_IDS);
}

export function normalizeTelemetryEvent(input = {}, context = {}) {
  const providerSource = text(
    input.providerSource || input.provider_source || context.providerSource || context.provider_source,
    64,
  );
  const providerType = text(
    input.providerType || input.provider_type || context.providerType || context.provider_type,
    32,
  );
  const eventId = text(input.eventId || input.event_id, 96)
    || `te_${randomUUID().replaceAll("-", "")}`;
  const idempotencyKey = text(input.idempotencyKey || input.idempotency_key, 191)
    || eventId;
  const runId = text(
    input.runId || input.run_id || context.runId || context.run_id
      || input.sessionId || input.session_id || context.sessionId || context.session_id,
    96,
  );
  const requestedBundleOrigin = text(
    input.bundleOrigin || input.bundle_origin || context.bundleOrigin || context.bundle_origin,
    32,
  );
  const bundleOrigin = BUNDLE_ORIGINS.has(requestedBundleOrigin)
    ? requestedBundleOrigin
    : /^acr_/.test(runId)
      ? "collaboration_run"
      : "direct_wrapper";
  const trainingEligible = input.trainingEligible ?? input.training_eligible
    ?? context.trainingEligible ?? context.training_eligible
    ?? (/^acr_/.test(runId) || requestedBundleOrigin === "direct_wrapper");
  const eventType = text(input.eventType || input.event_type || input.type, 96) || "agent.event";
  const resolvedGatewayIds = gatewayIds(input, providerSource);
  const requestedContentAvailability = text(
    input.contentAvailability || input.content_availability
      || context.contentAvailability || context.content_availability,
    32,
  );
  const contentAvailability = CONTENT_AVAILABILITY.has(requestedContentAvailability)
    ? requestedContentAvailability
    : resolvedGatewayIds.length ? "gateway_linked" : "metadata_only";
  const event = {
    schema_version: 1,
    event_id: eventId,
    idempotency_key: idempotencyKey,
    event_type: eventType,
    occurred_at: iso(input.occurredAt || input.occurred_at || context.occurredAt),
    device_id: text(input.deviceId || input.device_id || context.deviceId || context.device_id, 191),
    session_id: text(input.sessionId || input.session_id || context.sessionId || context.session_id, 96),
    conversation_id: text(input.conversationId || input.conversation_id || context.conversationId || context.conversation_id, 96),
    run_id: runId,
    account_session_id: text(
      input.accountSessionId || input.account_session_id || context.accountSessionId || context.account_session_id,
      191,
    ),
    task_id: text(input.taskId || input.task_id || context.taskId || context.task_id, 195),
    agent_id: text(input.agentId || input.agent_id || context.agentId || context.agent_id, 195),
    root_task_id: text(
      input.rootTaskId || input.root_task_id || context.rootTaskId || context.root_task_id
        || input.taskId || input.task_id || context.taskId || context.task_id
        || (bundleOrigin === "direct_wrapper" ? runId : ""),
      195,
    ),
    parent_task_id: text(input.parentTaskId || input.parent_task_id || context.parentTaskId || context.parent_task_id, 195),
    parent_agent_id: text(input.parentAgentId || input.parent_agent_id || context.parentAgentId || context.parent_agent_id, 195),
    delegation_id: text(input.delegationId || input.delegation_id || context.delegationId || context.delegation_id, 195),
    delegation_depth: Math.max(0, Number(input.delegationDepth ?? input.delegation_depth ?? context.delegationDepth ?? context.delegation_depth ?? 0) || 0),
    delegation_detected: Boolean(input.delegationDetected ?? input.delegation_detected
      ?? context.delegationDetected ?? context.delegation_detected),
    agent_type: text(input.agentType || input.agent_type || context.agentType || context.agent_type, 32),
    event_seq: Math.max(0, Number(input.eventSeq ?? input.event_seq ?? context.eventSeq ?? context.event_seq ?? 0) || 0),
    attempt: Math.max(0, Number(input.attempt ?? context.attempt ?? 0) || 0),
    task_role: text(input.taskRole || input.task_role || context.taskRole || context.task_role, 64),
    task_kind: text(input.taskKind || input.task_kind || context.taskKind || context.task_kind, 96),
    model_tier: text(input.modelTier || input.model_tier || context.modelTier || context.model_tier, 64),
    provider: text(input.provider || context.provider, 191),
    model: text(input.model || context.model, 191),
    provider_type: providerType,
    provider_source: providerSource,
    bundle_origin: bundleOrigin,
    content_availability: contentAvailability,
    training_eligible: Boolean(trainingEligible),
    // New events use the resolved Provider type as the source of truth.
    // The source fallback keeps older callers/events compatible until they
    // are naturally replaced by the new schema.
    cloud_route: trainingEligible && (providerType
      ? providerType === "originrouter"
      : providerSource === "originrouter-coding"),
    control_origin: ["cli", "app_remote"].includes(
      text(input.controlOrigin || input.control_origin || context.controlOrigin || context.control_origin, 16),
    )
      ? text(input.controlOrigin || input.control_origin || context.controlOrigin || context.control_origin, 16)
      : "cli",
    gateway_response_ids: resolvedGatewayIds,
    payload: safePayload(input.payload || input.data || {}),
  };
  return event;
}

export class TelemetryQueue {
  constructor({ stateDir = ensureStateDir(), dbPath = null, now = () => Date.now() } = {}) {
    this.stateDir = stateDir;
    this.dbPath = dbPath || join(stateDir, "telemetry.sqlite3");
    this.now = now;
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.installSchema();
    try { chmodSync(this.dbPath, 0o600); } catch {}
  }

  installSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        event_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        device_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        account_session_id TEXT NOT NULL DEFAULT '',
        task_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        root_task_id TEXT NOT NULL DEFAULT '',
        parent_task_id TEXT NOT NULL DEFAULT '',
        parent_agent_id TEXT NOT NULL DEFAULT '',
        delegation_id TEXT NOT NULL DEFAULT '',
        delegation_depth INTEGER NOT NULL DEFAULT 0,
        delegation_detected INTEGER NOT NULL DEFAULT 0,
        agent_type TEXT NOT NULL DEFAULT '',
        event_seq INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 0,
        task_role TEXT NOT NULL DEFAULT '',
        task_kind TEXT NOT NULL DEFAULT '',
        model_tier TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        provider_source TEXT NOT NULL DEFAULT '',
        provider_type TEXT NOT NULL DEFAULT '',
        bundle_origin TEXT NOT NULL DEFAULT 'collaboration_run',
        content_availability TEXT NOT NULL DEFAULT 'metadata_only',
        cloud_route INTEGER NOT NULL DEFAULT 0,
        control_origin TEXT NOT NULL DEFAULT 'cli',
        gateway_response_ids_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        dropped_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_telemetry_pending
        ON telemetry_events(state, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_telemetry_run
        ON telemetry_events(run_id, occurred_at);
    `);
    for (const statement of [
      "ALTER TABLE telemetry_events ADD COLUMN event_seq INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE telemetry_events ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE telemetry_events ADD COLUMN task_role TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN task_kind TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN model_tier TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN provider_type TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN root_task_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN parent_task_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN parent_agent_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN delegation_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE telemetry_events ADD COLUMN delegation_depth INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE telemetry_events ADD COLUMN delegation_detected INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE telemetry_events ADD COLUMN bundle_origin TEXT NOT NULL DEFAULT 'collaboration_run'",
      "ALTER TABLE telemetry_events ADD COLUMN content_availability TEXT NOT NULL DEFAULT 'metadata_only'",
      "ALTER TABLE telemetry_events ADD COLUMN account_session_id TEXT NOT NULL DEFAULT ''",
    ]) {
      try { this.db.exec(statement); } catch {}
    }
  }

  enqueue(input, context = {}) {
    const accountSessionId = text(
      input.accountSessionId || input.account_session_id || context.accountSessionId || context.account_session_id
        || readCodingAuth(this.stateDir)?.sessionId,
      191,
    );
    input = { ...input, accountSessionId };
    const event = normalizeTelemetryEvent(input, context);
    if (!event.training_eligible) return { event, inserted: false, skipped: "non_collaboration_run" };
    if (event.bundle_origin !== "collaboration_run") {
      return { event, inserted: false, skipped: "direct_wrapper_excluded" };
    }
    const now = iso(this.now());
    const result = this.db.prepare(`
      INSERT INTO telemetry_events(
        event_id, idempotency_key, schema_version, event_type, occurred_at,
        device_id, session_id, conversation_id, run_id, account_session_id, task_id, agent_id,
        root_task_id, parent_task_id, parent_agent_id, delegation_id, delegation_depth, delegation_detected,
        agent_type, provider, model, provider_type, provider_source, cloud_route, control_origin,
        bundle_origin, content_availability,
        event_seq, attempt, task_role, task_kind, model_tier,
        gateway_response_ids_json, payload_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      event.event_id,
      event.idempotency_key,
      event.schema_version,
      event.event_type,
      event.occurred_at,
      event.device_id,
      event.session_id,
      event.conversation_id,
      event.run_id,
      event.account_session_id,
      event.task_id,
      event.agent_id,
      event.root_task_id,
      event.parent_task_id,
      event.parent_agent_id,
      event.delegation_id,
      event.delegation_depth,
      event.delegation_detected ? 1 : 0,
      event.agent_type,
      event.provider,
      event.model,
      event.provider_type,
      event.provider_source,
      event.cloud_route ? 1 : 0,
      event.control_origin,
      event.bundle_origin,
      event.content_availability,
      event.event_seq,
      event.attempt,
      event.task_role,
      event.task_kind,
      event.model_tier,
      JSON.stringify(event.gateway_response_ids),
      JSON.stringify(event.payload),
      now,
      now,
    );
    return {
      event,
      inserted: result.changes > 0,
    };
  }

  pending({ limit = 50, now = this.now(), accountSessionId = null } = {}) {
    const account = text(accountSessionId, 191);
    const rows = this.db.prepare(`
      SELECT * FROM telemetry_events
      WHERE state = 'pending' AND next_attempt_at <= ?
        AND (? = '' OR account_session_id = ?)
      ORDER BY created_at ASC LIMIT ?
    `).all(Number(now) || Date.now(), account, account, Math.max(1, Math.min(200, Number(limit) || 50)));
    return rows.map((row) => this.publicEvent(row));
  }

  pendingRunIds({ limit = 20, now = this.now(), accountSessionId = null } = {}) {
    const account = text(accountSessionId, 191);
    return this.db.prepare(`
      SELECT run_id FROM telemetry_events
      WHERE state = 'pending' AND run_id <> '' AND next_attempt_at <= ?
        AND (? = '' OR account_session_id = ?)
      GROUP BY run_id ORDER BY MIN(created_at) ASC LIMIT ?
    `).all(Number(now) || Date.now(), account, account, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((row) => row.run_id);
  }

  pendingForRun(runId, { limit = 1_000_000, accountSessionId = null } = {}) {
    const value = text(runId, 96);
    if (!value) return [];
    const account = text(accountSessionId, 191);
    const rows = this.db.prepare(`
      SELECT * FROM telemetry_events
      WHERE state = 'pending' AND run_id = ? AND (? = '' OR account_session_id = ?)
      ORDER BY occurred_at ASC, created_at ASC LIMIT ?
    `).all(value, account, account, Math.max(1, Math.min(1_000_000, Number(limit) || 1_000_000)));
    return rows.map((row) => this.publicEvent(row));
  }

  markSent(eventIds = []) {
    const ids = [...new Set(eventIds.map((value) => text(value, 96)).filter(Boolean))];
    if (!ids.length) return 0;
    const statement = this.db.prepare(
      "UPDATE telemetry_events SET state='sent', sent_at=?, updated_at=? WHERE event_id=? AND state='pending'",
    );
    const now = iso(this.now());
    const tx = this.db.transaction(() => ids.reduce((count, id) => count + statement.run(now, now, id).changes, 0));
    return tx();
  }

  markDropped(eventIds = [], reason = "privacy_disabled") {
    const ids = [...new Set(eventIds.map((value) => text(value, 96)).filter(Boolean))];
    if (!ids.length) return 0;
    const statement = this.db.prepare(
      "UPDATE telemetry_events SET state='dropped', dropped_at=?, updated_at=?, last_error=? WHERE event_id=? AND state='pending'",
    );
    const now = iso(this.now());
    const tx = this.db.transaction(() => ids.reduce((count, id) => count + statement.run(now, now, reason, id).changes, 0));
    return tx();
  }

  markBlocked(eventIds = [], reason = "archive_blocked") {
    const ids = [...new Set(eventIds.map((value) => text(value, 96)).filter(Boolean))];
    if (!ids.length) return 0;
    const statement = this.db.prepare(
      "UPDATE telemetry_events SET state='blocked', updated_at=?, last_error=? WHERE event_id=? AND state='pending'",
    );
    const now = iso(this.now());
    const tx = this.db.transaction(() => ids.reduce((count, id) => count + statement.run(now, text(reason, 512), id).changes, 0));
    return tx();
  }

  dropAllPending(reason = "privacy_disabled") {
    const now = iso(this.now());
    return this.db.prepare(`
      UPDATE telemetry_events
      SET state = 'dropped', dropped_at = ?, updated_at = ?, last_error = ?
      WHERE state = 'pending'
    `).run(now, now, text(reason, 512)).changes;
  }

  dropPendingForAccount(accountSessionId, reason = "account_logged_out") {
    const account = text(accountSessionId, 191);
    if (!account) return 0;
    const now = iso(this.now());
    return this.db.prepare(`
      UPDATE telemetry_events
      SET state='dropped', dropped_at=?, updated_at=?, last_error=?
      WHERE state='pending' AND account_session_id=?
    `).run(now, now, text(reason, 512), account).changes;
  }

  prune({
    now = this.now(),
    sentRetentionMs = SENT_RETENTION_MS,
    droppedRetentionMs = DROPPED_RETENTION_MS,
    limit = 2000,
  } = {}) {
    const nowMs = Number(now) || Date.now();
    const sentBefore = iso(nowMs - Math.max(0, Number(sentRetentionMs) || SENT_RETENTION_MS));
    const droppedBefore = iso(nowMs - Math.max(0, Number(droppedRetentionMs) || DROPPED_RETENTION_MS));
    const boundedLimit = Math.max(1, Math.min(10_000, Number(limit) || 2000));
    return this.db.transaction(() => {
      const sent = this.db.prepare(`
        DELETE FROM telemetry_events
        WHERE state = 'sent' AND sent_at IS NOT NULL AND sent_at < ?
        LIMIT ?
      `).run(sentBefore, boundedLimit).changes;
      const dropped = this.db.prepare(`
        DELETE FROM telemetry_events
        WHERE state = 'dropped' AND dropped_at IS NOT NULL AND dropped_at < ?
        LIMIT ?
      `).run(droppedBefore, boundedLimit).changes;
      return sent + dropped;
    })();
  }

  markRetry(eventIds = [], error = "request_failed") {
    const ids = [...new Set(eventIds.map((value) => text(value, 96)).filter(Boolean))];
    if (!ids.length) return 0;
    const statement = this.db.prepare(`
      UPDATE telemetry_events
      SET attempts = attempts + 1,
          next_attempt_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE event_id = ? AND state = 'pending'
    `);
    const nowMs = Number(this.now()) || Date.now();
    const next = nowMs + 30_000;
    const now = iso(nowMs);
    const tx = this.db.transaction(() => ids.reduce((count, id) => count + statement.run(next, text(error, 512), now, id).changes, 0));
    return tx();
  }

  publicEvent(row) {
    return {
      schema_version: Number(row.schema_version || 1),
      event_id: row.event_id,
      idempotency_key: row.idempotency_key,
      event_type: row.event_type,
      occurred_at: row.occurred_at,
      device_id: row.device_id,
      session_id: row.session_id,
      conversation_id: row.conversation_id,
      run_id: row.run_id,
      account_session_id: row.account_session_id || "",
      task_id: row.task_id,
      agent_id: row.agent_id,
      root_task_id: row.root_task_id || "",
      parent_task_id: row.parent_task_id || "",
      parent_agent_id: row.parent_agent_id || "",
      delegation_id: row.delegation_id || "",
      delegation_depth: Number(row.delegation_depth || 0),
      delegation_detected: Boolean(row.delegation_detected),
      agent_type: row.agent_type,
      event_seq: Number(row.event_seq || 0),
      attempt: Number(row.attempt || 0),
      task_role: row.task_role || "",
      task_kind: row.task_kind || "",
      model_tier: row.model_tier || "",
      provider: row.provider,
      model: row.model,
      provider_source: row.provider_source,
      provider_type: row.provider_type || "",
      bundle_origin: row.bundle_origin || "collaboration_run",
      content_availability: row.content_availability || "metadata_only",
      cloud_route: Boolean(row.cloud_route),
      control_origin: row.control_origin,
      gateway_response_ids: JSON.parse(row.gateway_response_ids_json || "[]"),
      payload: JSON.parse(row.payload_json || "{}"),
      attempts: Number(row.attempts || 0),
    };
  }

  close() {
    if (this.db?.open) this.db.close();
  }
}
