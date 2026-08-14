import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { ensureStateDir } from "../persistence/state.js";
import { redactDisplayText, redactDisplayValue } from "../security/displayRedaction.js";
import { ADAPTIVE_TEMPLATE_ID, normalizeParticipants } from "./adaptivePlan.js";
import {
  buildFinalReport,
  derivedAttentionItems,
  eventPresentation,
  runViewState,
  taskViewState,
} from "./collaborationView.js";

const MESSAGE_TYPES = new Set([
  "task.assign", "task.accepted", "task.progress", "task.question",
  "task.answer", "task.blocked", "task.completed", "task.failed",
  "task.cancelled", "plan.submitted", "review.approved",
  "review.revision_requested", "implementation.completed",
  "verification.passed", "verification.failed", "rework.requested",
  "artifact.created", "agent.message", "agent.shutdown_requested",
  "agent.shutdown_acknowledged", "agent.mcp.delegated",
]);
const RUN_STATES = new Set([
  "created", "designing", "awaiting_plan_confirmation", "executing",
  "researching", "decomposing", "planning",
  "awaiting_plan_review", "revision_requested", "plan_approved",
  "implementing", "awaiting_verification", "rework_requested", "completed",
  "waiting_approval", "waiting_input", "waiting_device", "budget_exhausted",
  "paused", "blocked", "failed", "cancelled", "expired",
]);
const FORBIDDEN_KEYS = /token|secret|password|authorization|cookie|api[_-]?key|service[_-]?key|environment|env_dump/i;
const SAFE_USAGE_KEYS = new Set([
  "token_limit", "token_budget", "sampled_tokens", "sampledTokens",
  "input_tokens", "inputTokens", "output_tokens", "outputTokens",
  "cached_input_tokens", "cachedInputTokens", "total_tokens", "totalTokens",
  "fencing_token", "fencingToken",
  "contains_secret", "containsSecret",
]);

function safeText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function iso(value = null) {
  const date = value == null ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function assertNoSecretFields(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertNoSecretFields(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_USAGE_KEYS.has(key) && FORBIDDEN_KEYS.test(key)) {
      const error = new Error(`forbidden_collaboration_field:${key}`);
      error.code = "forbidden_collaboration_field";
      throw error;
    }
    assertNoSecretFields(child);
  }
}

function normalizeRole(role, name) {
  if (!role || typeof role !== "object") throw new Error(`${name} role is required`);
  const runtime = safeText(role.runtime, 32).toLowerCase();
  if (!["claude", "codex"].includes(runtime)) throw new Error(`${name} runtime must be claude or codex`);
  const deviceId = safeText(role.device_id ?? role.deviceId, 191);
  if (!deviceId) throw new Error(`${name} device_id is required`);
  const responsibilities = [...new Set((Array.isArray(role.responsibilities) ? role.responsibilities : [])
    .map((item) => safeText(item, 64)).filter(Boolean))];
  if (responsibilities.length === 0) throw new Error(`${name} responsibilities are required`);
  return {
    agent_id: safeText(role.agent_id ?? role.agentId, 195) || id("agent"),
    role: name,
    runtime,
    device_id: deviceId,
    workspace_id: safeText(role.workspace_id ?? role.workspaceId, 191),
    provider: safeText(role.provider, 191),
    model: safeText(role.model, 191),
    permission_profile: safeText(role.permission_profile ?? role.permissionProfile, 64),
    responsibilities,
    display_name: safeText(role.display_name ?? role.displayName, 80) || name,
    role_hint: safeText(role.role_hint ?? role.roleHint, 2000),
    planner: role.planner === true,
  };
}

function publicRun(row) {
  if (!row) return null;
  return {
    protocol_version: "1",
    schema_version: Number(row.schema_version || 1),
    revision: Number(row.revision || 0),
    template_id: row.template_id,
    template_version: row.template_version,
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    objective: row.objective,
    preferences: row.preferences || "",
    coordination_prompt: row.coordination_prompt || "",
    workflow_template_id: row.workflow_template_id || "plan_implement_verify",
    planner_role: row.planner_role || "lead",
    plan_status: row.plan_status || (row.template_id === ADAPTIVE_TEMPLATE_ID ? "draft" : "confirmed"),
    plan_revision: Number(row.plan_revision || 0),
    plan_revision_feedback: row.plan_revision_feedback || "",
    plan: parseJson(row.plan_json, null),
    state: row.state,
    phase: row.phase || null,
    pause_reason: row.pause_reason || null,
    blocked_reason: row.blocked_reason || null,
    retry_of_run_id: row.retry_of_run_id || null,
    coordinator_device_id: row.coordinator_device_id || null,
    gates: parseJson(row.gates_json, {}),
    budget: parseJson(row.budget_json, {}),
    usage: parseJson(row.usage_json, {}),
    counters: parseJson(row.counters_json, {}),
    account_budget_blocked: Boolean(row.account_budget_blocked),
    resume_state: row.resume_state || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    archived_at: row.archived_at || null,
    final_report: parseJson(row.final_report_json, null),
    last_event_sequence: Number(row.last_event_sequence || 0),
  };
}

export class CollaborationStore {
  constructor({ stateDir = ensureStateDir(), dbPath = null, now = () => new Date() } = {}) {
    this.dbPath = dbPath || join(stateDir, "collaboration.sqlite3");
    this.now = now;
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.installSchema();
    try { chmodSync(this.dbPath, 0o600); } catch {}
  }

  installSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_runs (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL UNIQUE,
        template_id TEXT NOT NULL,
        template_version TEXT NOT NULL,
        objective TEXT NOT NULL,
        preferences TEXT NOT NULL DEFAULT '',
        coordination_prompt TEXT NOT NULL DEFAULT '',
        workflow_template_id TEXT NOT NULL DEFAULT 'plan_implement_verify',
        planner_role TEXT NOT NULL DEFAULT 'lead',
        plan_status TEXT NOT NULL DEFAULT 'confirmed',
        plan_revision INTEGER NOT NULL DEFAULT 0,
        plan_revision_feedback TEXT NOT NULL DEFAULT '',
        plan_json TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        revision INTEGER NOT NULL DEFAULT 1,
        phase TEXT NOT NULL DEFAULT '',
        pause_reason TEXT NOT NULL DEFAULT '',
        blocked_reason TEXT NOT NULL DEFAULT '',
        retry_of_run_id TEXT NOT NULL DEFAULT '',
        coordinator_device_id TEXT NOT NULL DEFAULT '',
        gates_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        counters_json TEXT NOT NULL,
        account_budget_blocked INTEGER NOT NULL DEFAULT 0,
        resume_state TEXT NOT NULL DEFAULT '',
        final_report_json TEXT NOT NULL DEFAULT '',
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        archived_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_agents (
        agent_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL,
        device_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        permission_profile TEXT NOT NULL DEFAULT '',
        responsibilities_json TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role_hint TEXT NOT NULL DEFAULT '',
        planner INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        current_task_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        native_session_id TEXT NOT NULL DEFAULT '',
        originrouter_session_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT NOT NULL DEFAULT '',
        lease_dispatch_key TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT NOT NULL DEFAULT '',
        last_heartbeat_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        UNIQUE(run_id, role)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_plan_revisions (
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        feedback TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        confirmed_at TEXT,
        superseded_at TEXT,
        PRIMARY KEY(run_id, revision),
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_tasks (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_task_id TEXT,
        assignee_agent_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        task_key TEXT NOT NULL DEFAULT '',
        participant_id TEXT NOT NULL DEFAULT '',
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        instructions TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'read_only',
        deliverable TEXT NOT NULL DEFAULT '',
        result_summary TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        waiting_reason TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_messages (
        message_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        sender_json TEXT NOT NULL,
        recipient_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        parent_message_id TEXT,
        causation_id TEXT,
        artifact_refs_json TEXT NOT NULL DEFAULT '[]',
        evidence_refs_json TEXT NOT NULL DEFAULT '[]',
        requires_ack INTEGER NOT NULL DEFAULT 0,
        acknowledged_at TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE,
        UNIQUE(run_id, sequence),
        UNIQUE(run_id, idempotency_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        locator TEXT NOT NULL DEFAULT '',
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES collaboration_tasks(task_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_remote_assignments (
        assignment_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        phase TEXT NOT NULL,
        source_device_id TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        permission_profile TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        native_session_id TEXT NOT NULL DEFAULT '',
        originrouter_session_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        lease_id TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT NOT NULL DEFAULT '',
        last_heartbeat_at TEXT NOT NULL DEFAULT '',
        last_delivery_id TEXT NOT NULL DEFAULT '',
        fencing_mode TEXT NOT NULL DEFAULT 'legacy',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_remote_cancellations (
        assignment_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        role TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT 'cancelled',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_outbox (
        outbox_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT '',
        assignment_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL,
        target_device_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_usage_receipts (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        sampled_tokens INTEGER NOT NULL DEFAULT 0,
        amount_micros INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT '',
        cost_source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_execution_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        sequence INTEGER NOT NULL DEFAULT 0,
        task_id TEXT NOT NULL DEFAULT '',
        participant_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'agent',
        severity TEXT NOT NULL DEFAULT 'info',
        visibility TEXT NOT NULL DEFAULT 'detail',
        summary TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        correlation_id TEXT NOT NULL DEFAULT '',
        causation_id TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS collaboration_attention_items (
        attention_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '',
        participant_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'normal',
        actions_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        UNIQUE(run_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_collaboration_runs_updated ON collaboration_runs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_runs_updated_stable
        ON collaboration_runs(updated_at DESC, run_id DESC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_messages_run ON collaboration_messages(run_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_artifacts_run ON collaboration_artifacts(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_remote_session ON collaboration_remote_assignments(originrouter_session_id);
      CREATE INDEX IF NOT EXISTS idx_collaboration_usage_run ON collaboration_usage_receipts(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_outbox_pending ON collaboration_outbox(state, updated_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_execution_run
        ON collaboration_execution_events(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_execution_participant
        ON collaboration_execution_events(run_id, participant_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_attention_run
        ON collaboration_attention_items(run_id, status, created_at ASC);
    `);
    this.ensureColumn("collaboration_runs", "schema_version", "INTEGER NOT NULL DEFAULT 2");
    this.ensureColumn("collaboration_runs", "revision", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("collaboration_runs", "phase", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "pause_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "blocked_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "retry_of_run_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "coordinator_device_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "final_report_json", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "last_event_sequence", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_runs", "started_at", "TEXT");
    this.ensureColumn("collaboration_agents", "originrouter_session_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "conversation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "account_budget_blocked", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_runs", "resume_state", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "preferences", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "coordination_prompt", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "workflow_template_id", "TEXT NOT NULL DEFAULT 'plan_implement_verify'");
    this.ensureColumn("collaboration_runs", "planner_role", "TEXT NOT NULL DEFAULT 'lead'");
    this.ensureColumn("collaboration_runs", "plan_status", "TEXT NOT NULL DEFAULT 'confirmed'");
    this.ensureColumn("collaboration_runs", "plan_revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_runs", "plan_revision_feedback", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "plan_json", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "archived_at", "TEXT");
    this.ensureColumn("collaboration_usage_receipts", "amount_micros", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_usage_receipts", "currency", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_usage_receipts", "cost_source", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "attempt", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_agents", "fencing_token", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_agents", "lease_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "lease_dispatch_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "lease_expires_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "last_heartbeat_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "display_name", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "role_hint", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "planner", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_agents", "sort_order", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_agents", "current_task_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_tasks", "task_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_tasks", "participant_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_tasks", "depends_on_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("collaboration_tasks", "instructions", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_tasks", "kind", "TEXT NOT NULL DEFAULT 'read_only'");
    this.ensureColumn("collaboration_tasks", "deliverable", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_tasks", "result_summary", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_tasks", "attempt", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_tasks", "waiting_reason", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_tasks", "started_at", "TEXT");
    this.ensureColumn("collaboration_tasks", "finished_at", "TEXT");
    this.ensureColumn("collaboration_remote_assignments", "attempt", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_remote_assignments", "fencing_token", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_remote_assignments", "lease_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_remote_assignments", "lease_expires_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_remote_assignments", "last_heartbeat_at", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_remote_assignments", "last_delivery_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_remote_assignments", "fencing_mode", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("collaboration_execution_events", "schema_version", "INTEGER NOT NULL DEFAULT 2");
    this.ensureColumn("collaboration_execution_events", "sequence", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_execution_events", "attempt", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_execution_events", "category", "TEXT NOT NULL DEFAULT 'agent'");
    this.ensureColumn("collaboration_execution_events", "severity", "TEXT NOT NULL DEFAULT 'info'");
    this.ensureColumn("collaboration_execution_events", "visibility", "TEXT NOT NULL DEFAULT 'detail'");
    this.ensureColumn("collaboration_execution_events", "payload_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("collaboration_execution_events", "correlation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_execution_events", "causation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_execution_events", "idempotency_key", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_execution_events", "recorded_at", "TEXT NOT NULL DEFAULT ''");
    this.backfillExecutionSequences();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_execution_sequence
        ON collaboration_execution_events(run_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_execution_idempotency
        ON collaboration_execution_events(run_id, idempotency_key)
        WHERE idempotency_key <> '';
      CREATE INDEX IF NOT EXISTS idx_collaboration_execution_cursor
        ON collaboration_execution_events(run_id, sequence ASC);
    `);
  }

  ensureColumn(table, column, declaration) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  backfillExecutionSequences() {
    const runIds = this.db.prepare(`
      SELECT DISTINCT run_id FROM collaboration_execution_events
      WHERE sequence <= 0 ORDER BY run_id
    `).all().map((row) => row.run_id);
    const rowsForRun = this.db.prepare(`
      SELECT rowid FROM collaboration_execution_events
      WHERE run_id = ? ORDER BY created_at ASC, event_id ASC
    `);
    const update = this.db.prepare(
      "UPDATE collaboration_execution_events SET sequence = ?, recorded_at = CASE WHEN recorded_at = '' THEN created_at ELSE recorded_at END WHERE rowid = ?",
    );
    const updateRun = this.db.prepare(
      "UPDATE collaboration_runs SET last_event_sequence = MAX(last_event_sequence, ?) WHERE run_id = ?",
    );
    this.db.transaction(() => {
      for (const runId of runIds) {
        const rows = rowsForRun.all(runId);
        for (let index = 0; index < rows.length; index += 1) update.run(index + 1, rows[index].rowid);
        updateRun.run(rows.length, runId);
      }
    })();
  }

  touchRun(runId, updatedAt = iso(this.now())) {
    this.db.prepare(`
      UPDATE collaboration_runs
      SET updated_at = ?, revision = revision + 1
      WHERE run_id = ?
    `).run(updatedAt, safeText(runId, 195));
    return updatedAt;
  }

  createRun(input = {}) {
    const objective = safeText(input.objective, 16_000);
    if (!objective) throw new Error("objective is required");
    if (Array.isArray(input.participants)) return this.createAdaptiveRun(input, objective);
    const lead = normalizeRole(input.agents?.lead, "lead");
    const worker = normalizeRole(input.agents?.worker, "worker");
    const verifier = input.agents?.verifier ? normalizeRole(input.agents.verifier, "verifier") : null;
    const runId = id("acr");
    const conversationId = `collaboration:${randomUUID().replaceAll("-", "")}`;
    const taskId = id("act");
    const createdAt = iso(this.now());
    const gates = {
      plan_requires_approval: input.gates?.plan_requires_approval !== false,
      implementation_requires_verification: input.gates?.implementation_requires_verification !== false,
      max_plan_revisions: Math.max(0, Math.min(100, Number(input.gates?.max_plan_revisions ?? 3))),
      max_rework_rounds: Math.max(0, Math.min(100, Number(input.gates?.max_rework_rounds ?? 3))),
    };
    const budget = {
      token_limit: input.budget?.token_limit == null ? 500_000 : Math.max(1, Number(input.budget.token_limit)),
      amount_limit_micros: input.budget?.amount_limit_micros == null ? null : Math.max(1, Number(input.budget.amount_limit_micros)),
      currency: input.budget?.currency ? safeText(input.budget.currency, 3).toUpperCase() : null,
      max_concurrency: Math.max(1, Math.min(32, Number(input.budget?.max_concurrency ?? 2))),
    };
    assertNoSecretFields(input);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO collaboration_runs(
          run_id, conversation_id, template_id, template_version, objective,
          state, gates_json, budget_json, usage_json, counters_json,
          account_budget_blocked, resume_state, coordinator_device_id,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, 'plan_implement_verify', '1', ?, 'created', ?, ?, ?, ?, 0, '', ?, ?, ?, NULL)
      `).run(
        runId, conversationId, objective, JSON.stringify(gates), JSON.stringify(budget),
        JSON.stringify({ sampled_tokens: 0, amount_micros: 0, currency: null, unpriced_events: 0 }),
        JSON.stringify({ plan_revisions: 0, rework_rounds: 0 }),
        safeText(input.coordinator_device_id ?? input.coordinatorDeviceId, 191),
        createdAt, createdAt,
      );
      const insertAgent = this.db.prepare(`INSERT INTO collaboration_agents(agent_id, run_id, role, runtime, device_id, workspace_id, provider, model, permission_profile, responsibilities_json, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [index, role] of [lead, worker, verifier].filter(Boolean).entries()) {
        insertAgent.run(role.agent_id, runId, role.role, role.runtime, role.device_id, role.workspace_id, role.provider, role.model, role.permission_profile, JSON.stringify(role.responsibilities), index, createdAt, createdAt);
      }
      this.db.prepare(`INSERT INTO collaboration_tasks(task_id, run_id, title, summary, state, phase, created_at, updated_at) VALUES (?, ?, ?, '', 'pending', 'research', ?, ?)`)
        .run(taskId, runId, safeText(input.title, 256) || objective.slice(0, 256), createdAt, createdAt);
    })();
    this.recordExecutionEvent(runId, {
      type: "run.created",
      summary: "The collaboration was created.",
      idempotencyKey: "run-created",
      createdAt,
    });
    return this.getRun(runId);
  }

  createAdaptiveRun(input, objective) {
    const participants = normalizeParticipants(input.participants);
    const explicitPlanner = participants.find((item) => item.planner);
    const planner = explicitPlanner || participants[0];
    const runId = id("acr");
    const conversationId = `collaboration:${randomUUID().replaceAll("-", "")}`;
    const plannerTaskId = id("act");
    const createdAt = iso(this.now());
    const budget = {
      token_limit: input.budget?.token_limit == null ? null : Math.max(1, Number(input.budget.token_limit)),
      amount_limit_micros: input.budget?.amount_limit_micros == null ? null : Math.max(1, Number(input.budget.amount_limit_micros)),
      currency: input.budget?.currency ? safeText(input.budget.currency, 3).toUpperCase() : null,
      max_concurrency: Math.max(1, Math.min(16, Number(input.budget?.max_concurrency ?? Math.min(4, participants.length)))),
    };
    assertNoSecretFields(input);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO collaboration_runs(
          run_id, conversation_id, template_id, template_version, objective,
          preferences, coordination_prompt, workflow_template_id, planner_role,
          plan_status, plan_json, state, gates_json, budget_json, usage_json,
          counters_json, account_budget_blocked, resume_state, coordinator_device_id,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, '2', ?, ?, ?, ?, ?, 'draft', '', 'created', '{}', ?, ?, '{}', 0, '', ?, ?, ?, NULL)
      `).run(
        runId, conversationId, ADAPTIVE_TEMPLATE_ID, objective,
        safeText(input.preferences, 16_000), safeText(input.coordination_prompt ?? input.coordinationPrompt, 16_000),
        safeText(input.workflow_template_id ?? input.workflowTemplateId, 64) || "adaptive",
        planner.participant_id, JSON.stringify(budget),
        JSON.stringify({ sampled_tokens: 0, amount_micros: 0, currency: null, unpriced_events: 0 }),
        safeText(input.coordinator_device_id ?? input.coordinatorDeviceId, 191),
        createdAt, createdAt,
      );
      const insert = this.db.prepare(`
        INSERT INTO collaboration_agents(
          agent_id, run_id, role, runtime, device_id, workspace_id, provider, model,
          permission_profile, responsibilities_json, display_name, role_hint, planner,
          sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, participant] of participants.entries()) {
        insert.run(
          id("agent"), runId, participant.participant_id, participant.runtime,
          participant.device_id, participant.workspace_id, participant.provider,
          participant.model, participant.permission_profile,
          JSON.stringify(participant.role_hint ? [participant.role_hint] : []),
          participant.display_name, participant.role_hint,
          participant.participant_id === planner.participant_id ? 1 : 0,
          index,
          createdAt, createdAt,
        );
      }
      this.db.prepare(`
        INSERT INTO collaboration_tasks(
          task_id, run_id, title, summary, state, phase, task_key, participant_id,
          depends_on_json, instructions, kind, deliverable, created_at, updated_at
        ) VALUES (?, ?, ?, '', 'pending', 'plan_design', '__planner__', ?, '[]', '', 'read_only', ?, ?, ?)
      `).run(plannerTaskId, runId, "Design collaboration plan", planner.participant_id, "A structured plan for user review.", createdAt, createdAt);
    })();
    this.recordExecutionEvent(runId, {
      type: "run.created",
      summary: "The collaboration was created.",
      idempotencyKey: "run-created",
      createdAt,
    });
    return this.getRun(runId);
  }

  getRun(runId, { includeMessages = true } = {}) {
    const key = safeText(runId, 195);
    const run = publicRun(this.db.prepare("SELECT * FROM collaboration_runs WHERE run_id = ?").get(key));
    if (!run) return null;
    run.agents = Object.fromEntries(this.db.prepare("SELECT * FROM collaboration_agents WHERE run_id = ? ORDER BY sort_order, created_at, role").all(key).map((row) => [row.role, {
      agent_id: row.agent_id, runtime: row.runtime, device_id: row.device_id,
      workspace_id: row.workspace_id || null, provider: row.provider || null,
      model: row.model || null, permission_profile: row.permission_profile || null,
      responsibilities: parseJson(row.responsibilities_json, []), status: row.status,
      display_name: row.display_name || row.role,
      role_hint: row.role_hint || "",
      planner: Boolean(row.planner),
      current_task_id: row.current_task_id || null,
      native_session_id: row.native_session_id || null,
      originrouter_session_id: row.originrouter_session_id || null,
      conversation_id: row.conversation_id || null,
      attempt: Number(row.attempt || 0),
      fencing_token: Number(row.fencing_token || 0),
      lease_id: row.lease_id || null,
      lease_expires_at: row.lease_expires_at || null,
      last_heartbeat_at: row.last_heartbeat_at || null,
    }]));
    run.tasks = this.db.prepare("SELECT * FROM collaboration_tasks WHERE run_id = ? ORDER BY created_at").all(key).map((row) => ({
      task_id: row.task_id, parent_task_id: row.parent_task_id, assignee_agent_id: row.assignee_agent_id,
      title: row.title, summary: row.summary, state: row.state, phase: row.phase,
      task_key: row.task_key || null,
      participant_id: row.participant_id || null,
      depends_on: parseJson(row.depends_on_json, []),
      instructions: row.instructions || "",
      kind: row.kind || "read_only",
      deliverable: row.deliverable || "",
      result_summary: row.result_summary || "",
      attempt: Number(row.attempt || 0),
      waiting_reason: row.waiting_reason || null,
      started_at: row.started_at || null,
      finished_at: row.finished_at || null,
      created_at: row.created_at, updated_at: row.updated_at,
    }));
    run.task_ids = run.tasks.map((task) => task.task_id);
    run.artifacts = this.listArtifacts(key);
    if (includeMessages) run.messages = this.listMessages(key);
    return run;
  }

  listRuns({ limit = 50, includeArchived = false } = {}) {
    const archived = includeArchived ? "" : "WHERE archived_at IS NULL";
    return this.db.prepare(
      `SELECT * FROM collaboration_runs ${archived} ORDER BY updated_at DESC, run_id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(200, Number(limit) || 50))).map(publicRun);
  }

  listRunPage({
    category = "all",
    page = 1,
    pageSize = 5,
    includeArchived = false,
  } = {}) {
    const terminal = "('completed','failed','cancelled','expired')";
    const attentionStates = "('awaiting_plan_confirmation','budget_exhausted','revision_requested','rework_requested','waiting_approval','waiting_input','blocked')";
    const pendingAttention = `EXISTS (
      SELECT 1 FROM collaboration_attention_items attention
      WHERE attention.run_id = collaboration_runs.run_id
        AND attention.status = 'pending'
    )`;
    const needsAttention = `(state IN ${attentionStates} OR ${pendingAttention})`;
    const conditions = [];
    if (!includeArchived) conditions.push("archived_at IS NULL");
    if (category === "attention") conditions.push(needsAttention);
    if (category === "active") {
      conditions.push(`state NOT IN ${terminal}`);
      conditions.push(`NOT ${needsAttention}`);
    }
    if (category === "recent") {
      conditions.push(`state IN ${terminal}`);
      conditions.push(`NOT ${pendingAttention}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const safePageSize = Math.max(1, Math.min(50, Number(pageSize) || 5));
    const safePage = Math.max(1, Number(page) || 1);
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS count FROM collaboration_runs ${where}`).get()?.count || 0,
    );
    const rows = this.db.prepare(`
      SELECT * FROM collaboration_runs ${where}
      ORDER BY updated_at DESC, run_id DESC LIMIT ? OFFSET ?
    `).all(safePageSize, (safePage - 1) * safePageSize).map(publicRun);
    return {
      runs: rows.map((run) => this.getRun(run.run_id, { includeMessages: false })),
      page: safePage,
      page_size: safePageSize,
      total,
      total_pages: Math.max(1, Math.ceil(total / safePageSize)),
    };
  }

  archiveRun(runId, archived = true) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    if (!["completed", "failed", "cancelled", "expired"].includes(run.state)) {
      throw new Error("only finished collaboration runs can be archived");
    }
    const updatedAt = iso(this.now());
    const archivedAt = archived ? updatedAt : null;
    this.db.prepare(
      "UPDATE collaboration_runs SET archived_at = ?, updated_at = ?, revision = revision + 1 WHERE run_id = ?",
    ).run(archivedAt, updatedAt, run.run_id);
    return this.getRun(run.run_id);
  }

  deleteRun(runId) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) return false;
    if (!["completed", "failed", "cancelled", "expired"].includes(run.state)) {
      throw new Error("only finished collaboration runs can be deleted");
    }
    return this.db.prepare("DELETE FROM collaboration_runs WHERE run_id = ?")
      .run(run.run_id).changes > 0;
  }

  listActiveRuns({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM collaboration_runs
      WHERE state NOT IN ('completed', 'failed', 'cancelled', 'expired')
      ORDER BY updated_at ASC, run_id ASC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100))).map(publicRun);
  }

  updateAgent(runId, role, payload = {}) {
    const current = this.db.prepare(
      "SELECT * FROM collaboration_agents WHERE run_id = ? AND role = ?",
    ).get(safeText(runId, 195), safeText(role, 32));
    if (!current) throw new Error("collaboration agent not found");
    const updatedAt = iso(this.now());
    this.db.prepare(`
      UPDATE collaboration_agents SET
        status = ?,
        native_session_id = ?,
        originrouter_session_id = ?,
        conversation_id = ?,
        current_task_id = ?,
        updated_at = ?
      WHERE run_id = ? AND role = ?
    `).run(
      safeText(payload.status ?? current.status, 32) || "idle",
      safeText(payload.native_session_id ?? payload.nativeSessionId ?? current.native_session_id, 191),
      safeText(payload.originrouter_session_id ?? payload.originrouterSessionId ?? current.originrouter_session_id, 64),
      safeText(payload.conversation_id ?? payload.conversationId ?? current.conversation_id, 96),
      safeText(payload.current_task_id ?? payload.currentTaskId ?? current.current_task_id, 195),
      updatedAt,
      runId,
      role,
    );
    this.touchRun(runId, updatedAt);
    return this.getRun(runId, { includeMessages: false }).agents[role];
  }

  setAdaptivePlan(runId, plan) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID) throw new Error("adaptive collaboration run not found");
    if (run.state !== "designing") throw new Error("collaboration plan is not being designed");
    const updatedAt = iso(this.now());
    const planRevision = Math.max(1, Number(run.plan_revision || 0) + 1);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM collaboration_tasks WHERE run_id = ? AND task_key <> '__planner__'").run(runId);
      const insertTask = this.db.prepare(`
        INSERT INTO collaboration_tasks(
          task_id, run_id, assignee_agent_id, title, summary, state, phase,
          task_key, participant_id, depends_on_json, instructions, kind,
          deliverable, result_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '', 'pending', ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      `);
      for (const task of plan.tasks) {
        const agent = run.agents[task.participant_id];
        insertTask.run(
          id("act"), runId, agent.agent_id, task.title, task.mode,
          task.id, task.participant_id, JSON.stringify(task.depends_on),
          task.instructions, task.mode, task.deliverable, updatedAt, updatedAt,
        );
      }
      this.db.prepare(`
        UPDATE collaboration_tasks
        SET state = 'completed', summary = ?, result_summary = ?,
            finished_at = ?, updated_at = ?
        WHERE run_id = ? AND task_key = '__planner__'
      `).run(
        plan.summary || "Plan ready for review.",
        plan.summary || "Plan ready for review.",
        updatedAt,
        updatedAt,
        runId,
      );
      this.db.prepare(`
        UPDATE collaboration_runs
        SET plan_json = ?, plan_status = 'proposed', state = 'awaiting_plan_confirmation',
            phase = 'plan_review', plan_revision = ?, plan_revision_feedback = '',
            updated_at = ?, revision = revision + 1
        WHERE run_id = ?
      `).run(JSON.stringify(plan), planRevision, updatedAt, runId);
      this.db.prepare(`
        INSERT INTO collaboration_plan_revisions(
          run_id, revision, status, plan_json, feedback, created_at
        ) VALUES (?, ?, 'proposed', ?, '', ?)
      `).run(runId, planRevision, JSON.stringify(plan), updatedAt);
    })();
    this.recordExecutionEvent(runId, {
      type: "plan.generated",
      participantId: run.planner_role,
      summary: plan.title || "The collaboration plan is ready for review.",
      detail: plan.summary || "",
      payload: { plan_version: planRevision, task_count: plan.tasks.length },
      idempotencyKey: `plan-generated:${planRevision}:${updatedAt}`,
      createdAt: updatedAt,
    });
    this.recordExecutionEvent(runId, {
      type: "run.plan_ready",
      summary: "The collaboration plan is ready for review.",
      idempotencyKey: `run-plan-ready:${updatedAt}`,
      createdAt: updatedAt,
    });
    return this.getRun(runId);
  }

  confirmAdaptivePlan(runId) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID) throw new Error("adaptive collaboration run not found");
    if (run.state !== "awaiting_plan_confirmation" || run.plan_status !== "proposed") {
      throw new Error("collaboration plan is not waiting for confirmation");
    }
    const updatedAt = iso(this.now());
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_runs
        SET plan_status = 'confirmed', state = 'executing', phase = 'execution',
            updated_at = ?, revision = revision + 1,
            started_at = COALESCE(started_at, ?)
        WHERE run_id = ?
      `).run(updatedAt, updatedAt, runId);
      this.db.prepare(`
        UPDATE collaboration_plan_revisions
        SET status = 'confirmed', confirmed_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(updatedAt, runId, Number(run.plan_revision || 0));
    })();
    this.recordExecutionEvent(runId, {
      type: "plan.confirmed",
      summary: "The collaboration plan was confirmed.",
      idempotencyKey: `plan-confirmed:${updatedAt}`,
      createdAt: updatedAt,
    });
    this.recordExecutionEvent(runId, {
      type: "run.started",
      summary: "The collaboration started.",
      idempotencyKey: `run-started:${updatedAt}`,
      createdAt: updatedAt,
    });
    return this.getRun(runId);
  }

  requestAdaptivePlanRevision(runId, feedback) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID) {
      throw new Error("adaptive collaboration run not found");
    }
    if (run.state !== "awaiting_plan_confirmation" || run.plan_status !== "proposed") {
      throw new Error("collaboration plan is not waiting for revision feedback");
    }
    const normalizedFeedback = safeText(feedback, 16_000);
    if (!normalizedFeedback) throw new Error("plan revision feedback is required");
    const updatedAt = iso(this.now());
    const counters = {
      ...(run.counters || {}),
      plan_revisions: Number(run.counters?.plan_revisions || 0) + 1,
    };
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_plan_revisions
        SET status = 'superseded', feedback = ?, superseded_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(normalizedFeedback, updatedAt, runId, Number(run.plan_revision || 0));
      this.db.prepare(`
        UPDATE collaboration_runs
        SET plan_status = 'draft', state = 'designing', phase = 'plan_design',
            plan_revision_feedback = ?, counters_json = ?,
            updated_at = ?, revision = revision + 1
        WHERE run_id = ?
      `).run(normalizedFeedback, JSON.stringify(counters), updatedAt, runId);
      this.db.prepare(`
        DELETE FROM collaboration_tasks
        WHERE run_id = ? AND task_key <> '__planner__'
      `).run(runId);
      this.db.prepare(`
        UPDATE collaboration_tasks
        SET state = 'pending', summary = '', result_summary = '',
            started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE run_id = ? AND task_key = '__planner__'
      `).run(updatedAt, runId);
      this.db.prepare(`
        UPDATE collaboration_agents
        SET status = 'idle', current_task_id = '', updated_at = ?
        WHERE run_id = ?
      `).run(updatedAt, runId);
    })();
    this.recordExecutionEvent(runId, {
      type: "plan.revision_requested",
      participantId: run.planner_role,
      severity: "warning",
      summary: "The user requested changes to the collaboration plan.",
      detail: normalizedFeedback,
      payload: { previous_plan_revision: Number(run.plan_revision || 0) },
      idempotencyKey: `plan-revision-requested:${Number(run.plan_revision || 0)}:${updatedAt}`,
      createdAt: updatedAt,
    });
    return this.getRun(runId);
  }

  updateAdaptiveTask(runId, taskKey, { state, resultSummary = null } = {}) {
    const updatedAt = iso(this.now());
    const info = this.db.prepare(`
      UPDATE collaboration_tasks
      SET state = COALESCE(?, state),
          result_summary = COALESCE(?, result_summary),
          summary = CASE WHEN ? IS NULL THEN summary ELSE ? END,
          attempt = CASE WHEN ? = 'active' THEN attempt + 1 ELSE attempt END,
          waiting_reason = CASE WHEN ? = 'active' THEN '' ELSE waiting_reason END,
          started_at = CASE WHEN ? = 'active' THEN COALESCE(started_at, ?) ELSE started_at END,
          finished_at = CASE WHEN ? IN ('completed','failed','cancelled','skipped') THEN ? ELSE finished_at END,
          updated_at = ?
      WHERE run_id = ? AND task_key = ?
    `).run(
      state || null,
      resultSummary,
      resultSummary,
      resultSummary,
      state,
      state,
      state,
      updatedAt,
      state,
      updatedAt,
      updatedAt,
      runId,
      safeText(taskKey, 64),
    );
    if (info.changes === 0) throw new Error("collaboration task not found");
    this.touchRun(runId, updatedAt);
    const updated = this.getRun(runId);
    const task = updated.tasks.find((item) => item.task_key === taskKey);
    const eventType = state === "active" ? "task.started"
      : state === "completed" ? "task.completed"
        : state === "failed" ? "task.failed"
          : state === "cancelled" ? "task.cancelled"
            : null;
    if (eventType && task) {
      this.recordExecutionEvent(runId, {
        type: eventType,
        taskId: task.task_id,
        participantId: task.participant_id,
        attempt: task.attempt,
        summary: state === "active" ? `Started: ${task.title}`
          : state === "completed" ? `Completed: ${task.title}`
            : state === "failed" ? `Failed: ${task.title}`
              : `Cancelled: ${task.title}`,
        detail: resultSummary || "",
        idempotencyKey: `${eventType}:${task.task_id}:${task.attempt}:${updatedAt}`,
        createdAt: updatedAt,
      });
      if (state === "completed" && resultSummary) {
        const existingArtifact = this.db.prepare(`
          SELECT artifact_id FROM collaboration_artifacts
          WHERE run_id = ? AND task_id = ? AND kind = 'agent_result'
          LIMIT 1
        `).get(runId, task.task_id);
        if (!existingArtifact) {
          this.registerArtifact(runId, {
            artifact_id: safeText(`aca_${task.task_id}_result`, 195),
            task_id: task.task_id,
            participant_id: task.participant_id,
            owner_agent_id: task.assignee_agent_id,
            kind: "agent_result",
            display_name: `${task.title} result`,
            metadata: {
              participant_id: task.participant_id,
              attempt: task.attempt,
            },
            created_at: task.finished_at || updatedAt,
          });
        }
      }
    }
    return this.getRun(runId);
  }

  addAdaptiveTask(runId, input = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID) {
      throw new Error("adaptive collaboration run not found");
    }
    if (run.state !== "executing") {
      throw new Error("collaboration is not executing");
    }
    const taskKey = safeText(input.task_key ?? input.taskKey, 64);
    const participantId = safeText(input.participant_id ?? input.participantId, 32);
    const participant = run.agents?.[participantId];
    if (!taskKey) throw new Error("collaboration task key is required");
    if (!participant) throw new Error("collaboration task participant is unavailable");
    const existing = run.tasks.find((task) => task.task_key === taskKey);
    if (existing) return existing;
    const parentTaskId = safeText(input.parent_task_id ?? input.parentTaskId, 195) || null;
    if (parentTaskId && !run.tasks.some((task) => task.task_id === parentTaskId)) {
      throw new Error("collaboration parent task is unavailable");
    }
    const mode = safeText(input.kind ?? input.mode, 32) || "discussion";
    if (!["read_only", "workspace_write", "verify", "discussion"].includes(mode)) {
      throw new Error("unsupported collaboration task mode");
    }
    const taskId = id("act");
    const updatedAt = iso(this.now());
    this.db.prepare(`
      INSERT INTO collaboration_tasks(
        task_id, run_id, parent_task_id, assignee_agent_id, title, summary,
        state, phase, task_key, participant_id, depends_on_json,
        instructions, kind, deliverable, result_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', 'pending', ?, ?, ?, '[]', ?, ?, ?, '', ?, ?)
    `).run(
      taskId,
      runId,
      parentTaskId,
      participant.agent_id,
      safeText(input.title, 256) || `Request from ${safeText(input.sourceParticipantId, 32) || "Agent"}`,
      mode,
      taskKey,
      participantId,
      safeText(input.instructions, 16_000),
      mode,
      safeText(input.deliverable, 2_000) || "A concise response for the requesting Agent.",
      updatedAt,
      updatedAt,
    );
    this.touchRun(runId, updatedAt);
    return this.getRun(runId, { includeMessages: false })
      .tasks.find((task) => task.task_id === taskId);
  }

  runnableAdaptiveTasks(runId) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID || run.state !== "executing") return [];
    const complete = new Set(run.tasks.filter((task) => task.state === "completed").map((task) => task.task_key));
    const busyParticipants = new Set(run.tasks.filter((task) => task.state === "active").map((task) => task.participant_id));
    const activeCount = run.tasks.filter((task) => task.state === "active").length;
    const capacity = Math.max(0, Number(run.budget.max_concurrency || 1) - activeCount);
    return run.tasks.filter((task) => (
      task.task_key !== "__planner__"
      && task.state === "pending"
      && !busyParticipants.has(task.participant_id)
      && task.depends_on.every((dependency) => complete.has(dependency))
    )).slice(0, capacity);
  }

  resetAdaptiveActiveTasks(runId) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID) return run;
    const updatedAt = iso(this.now());
    this.db.transaction(() => {
      this.db.prepare("UPDATE collaboration_tasks SET state = 'pending', updated_at = ? WHERE run_id = ? AND state = 'active'")
        .run(updatedAt, runId);
      this.db.prepare("UPDATE collaboration_agents SET current_task_id = '', originrouter_session_id = '', status = 'idle', updated_at = ? WHERE run_id = ? AND current_task_id <> ''")
        .run(updatedAt, runId);
      this.touchRun(runId, updatedAt);
    })();
    return this.getRun(runId);
  }

  issueAgentLease(runId, role, { dispatchKey, ttlMs = 30 * 60_000 } = {}) {
    const key = safeText(dispatchKey, 191);
    if (!key) throw new Error("collaboration dispatch key is required");
    const current = this.db.prepare(
      "SELECT * FROM collaboration_agents WHERE run_id = ? AND role = ?",
    ).get(safeText(runId, 195), safeText(role, 32));
    if (!current) throw new Error("collaboration agent not found");
    if (current.lease_dispatch_key === key && Number(current.fencing_token || 0) > 0) {
      return this.getRun(runId, { includeMessages: false }).agents[role];
    }
    const now = this.now();
    const updatedAt = iso(now);
    const leaseExpiresAt = iso(new Date(now.getTime() + Math.max(60_000, Number(ttlMs) || 0)));
    const attempt = Number(current.attempt || 0) + 1;
    const fencingToken = Number(current.fencing_token || 0) + 1;
    const leaseId = id("acl");
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_agents SET
          attempt = ?, fencing_token = ?, lease_id = ?, lease_dispatch_key = ?,
          lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE run_id = ? AND role = ?
      `).run(
        attempt, fencingToken, leaseId, key, leaseExpiresAt, updatedAt,
        updatedAt, runId, role,
      );
      this.touchRun(runId, updatedAt);
    })();
    return this.getRun(runId, { includeMessages: false }).agents[role];
  }

  touchAgentLease(runId, role, { ttlMs = 30 * 60_000 } = {}) {
    const now = this.now();
    const heartbeatAt = iso(now);
    const leaseExpiresAt = iso(new Date(now.getTime() + Math.max(60_000, Number(ttlMs) || 0)));
    this.db.prepare(`
      UPDATE collaboration_agents
      SET last_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE run_id = ? AND role = ?
    `).run(heartbeatAt, leaseExpiresAt, heartbeatAt, runId, role);
  }

  findAgentBySession(sessionId) {
    const row = this.db.prepare(
      "SELECT run_id, role FROM collaboration_agents WHERE originrouter_session_id = ?",
    ).get(safeText(sessionId, 64));
    return row ? { run_id: row.run_id, role: row.role } : null;
  }

  upsertRemoteAssignment(input = {}) {
    assertNoSecretFields(input);
    const assignmentId = safeText(input.assignment_id ?? input.assignmentId, 195);
    const runId = safeText(input.run_id ?? input.runId, 195);
    const taskId = safeText(input.task_id ?? input.taskId, 195);
    const role = safeText(input.role, 32);
    const runtime = safeText(input.runtime, 32).toLowerCase();
    const sourceDeviceId = safeText(input.source_device_id ?? input.sourceDeviceId, 191);
    const targetDeviceId = safeText(input.target_device_id ?? input.targetDeviceId, 191);
    const workspaceId = safeText(input.workspace_id ?? input.workspaceId, 191);
    const deliveryId = safeText(input.delivery_id ?? input.deliveryId, 96);
    const current = this.getRemoteAssignment(assignmentId);
    const hasFencing = input.attempt != null
      && (input.fencing_token ?? input.fencingToken) != null;
    if (current?.last_delivery_id === deliveryId && deliveryId) {
      return { assignment: current, duplicate: true, stale: false, legacy: !hasFencing };
    }
    const attempt = hasFencing
      ? Math.max(1, Math.floor(Number(input.attempt) || 0))
      : Number(current?.attempt || 0) + 1;
    const fencingToken = hasFencing
      ? Math.max(1, Math.floor(Number(input.fencing_token ?? input.fencingToken) || 0))
      : Number(current?.fencing_token || 0) + 1;
    const nowDate = this.now();
    const leaseId = safeText(input.lease_id ?? input.leaseId, 195)
      || `legacy:${deliveryId}`;
    const leaseExpiresAt = safeText(input.lease_expires_at ?? input.leaseExpiresAt, 64)
      || iso(new Date(nowDate.getTime() + 30 * 60_000));
    if (!assignmentId || !runId || !taskId || !role || !sourceDeviceId || !targetDeviceId || !workspaceId
        || !deliveryId || !leaseId || !leaseExpiresAt || attempt < 1 || fencingToken < 1) {
      throw new Error("invalid remote collaboration assignment");
    }
    if (!["claude", "codex"].includes(runtime)) throw new Error("invalid remote collaboration runtime");
    const now = iso(nowDate);
    if (current && (
      current.run_id !== runId
      || current.task_id !== taskId
      || current.role !== role
      || current.source_device_id !== sourceDeviceId
      || current.target_device_id !== targetDeviceId
    )) {
      const error = new Error("remote collaboration assignment identity conflict");
      error.code = "COLLABORATION_ASSIGNMENT_CONFLICT";
      throw error;
    }
    const currentFencingMode = current?.fencing_mode || "legacy";
    if (!hasFencing && current && currentFencingMode === "strict") {
      return { assignment: current, duplicate: false, stale: true, legacy: true };
    }
    if (hasFencing && current && currentFencingMode === "strict"
        && fencingToken < Number(current.fencing_token || 0)) {
      return { assignment: current, duplicate: false, stale: true, legacy: false };
    }
    if (hasFencing && current && currentFencingMode === "strict"
        && fencingToken === Number(current.fencing_token || 0)) {
      const error = new Error("conflicting collaboration dispatch for active fencing token");
      error.code = "COLLABORATION_FENCING_CONFLICT";
      throw error;
    }
    this.db.prepare(`
      INSERT INTO collaboration_remote_assignments(
        assignment_id, run_id, task_id, role, phase, source_device_id,
        target_device_id, runtime, workspace_id, provider, model,
        permission_profile, status, native_session_id, originrouter_session_id,
        conversation_id, attempt, fencing_token, lease_id, lease_expires_at,
        last_heartbeat_at, last_delivery_id, fencing_mode, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        phase = excluded.phase,
        runtime = excluded.runtime,
        workspace_id = excluded.workspace_id,
        provider = excluded.provider,
        model = excluded.model,
        permission_profile = excluded.permission_profile,
        attempt = excluded.attempt,
        fencing_token = excluded.fencing_token,
        lease_id = excluded.lease_id,
        lease_expires_at = excluded.lease_expires_at,
        last_heartbeat_at = excluded.last_heartbeat_at,
        last_delivery_id = excluded.last_delivery_id,
        fencing_mode = excluded.fencing_mode,
        status = 'pending',
        updated_at = excluded.updated_at
    `).run(
      assignmentId, runId, taskId, role, safeText(input.phase, 64),
      sourceDeviceId, targetDeviceId, runtime, workspaceId,
      safeText(input.provider, 191), safeText(input.model, 191),
      safeText(input.permission_profile ?? input.permissionProfile, 64),
      attempt, fencingToken, leaseId, leaseExpiresAt, now, deliveryId,
      hasFencing ? "strict" : "legacy", now, now,
    );
    return {
      assignment: this.getRemoteAssignment(assignmentId),
      duplicate: false,
      stale: false,
      legacy: !hasFencing,
    };
  }

  updateRemoteAssignment(assignmentId, payload = {}) {
    const current = this.getRemoteAssignment(assignmentId);
    if (!current) throw new Error("remote collaboration assignment not found");
    this.db.prepare(`
      UPDATE collaboration_remote_assignments SET
        phase = ?, status = ?, native_session_id = ?,
        originrouter_session_id = ?, conversation_id = ?, updated_at = ?
      WHERE assignment_id = ?
    `).run(
      safeText(payload.phase ?? current.phase, 64),
      safeText(payload.status ?? current.status, 32),
      safeText(payload.native_session_id ?? payload.nativeSessionId ?? current.native_session_id, 191),
      safeText(payload.originrouter_session_id ?? payload.originrouterSessionId ?? current.originrouter_session_id, 64),
      safeText(payload.conversation_id ?? payload.conversationId ?? current.conversation_id, 96),
      iso(this.now()), assignmentId,
    );
    return this.getRemoteAssignment(assignmentId);
  }

  touchRemoteAssignmentLease(assignmentId, { ttlMs = 30 * 60_000 } = {}) {
    const now = this.now();
    const heartbeatAt = iso(now);
    const leaseExpiresAt = iso(new Date(now.getTime() + Math.max(60_000, Number(ttlMs) || 0)));
    this.db.prepare(`
      UPDATE collaboration_remote_assignments
      SET last_heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE assignment_id = ?
    `).run(heartbeatAt, leaseExpiresAt, heartbeatAt, safeText(assignmentId, 195));
    return this.getRemoteAssignment(assignmentId);
  }

  enqueueOutbox(input = {}) {
    const outboxId = safeText(input.outbox_id ?? input.outboxId, 191);
    const messageType = safeText(input.message_type ?? input.messageType, 96);
    const targetDeviceId = safeText(input.target_device_id ?? input.targetDeviceId, 191);
    const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
    if (!outboxId || !messageType || !targetDeviceId) {
      throw new Error("invalid collaboration outbox message");
    }
    assertNoSecretFields(payload);
    const now = iso(this.now());
    const existing = this.getOutbox(outboxId);
    if (existing) {
      const same = existing.message_type === messageType
        && existing.target_device_id === targetDeviceId
        && (existing.state === "delivered"
          || JSON.stringify(existing.payload) === JSON.stringify(payload));
      if (!same) {
        const error = new Error("collaboration outbox id conflicts with another message");
        error.code = "COLLABORATION_OUTBOX_CONFLICT";
        throw error;
      }
      return existing;
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO collaboration_outbox(
        outbox_id, run_id, assignment_id, message_type, target_device_id,
        payload_json, state, attempts, last_error, created_at, updated_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, '', ?, ?, NULL)
    `).run(
      outboxId,
      safeText(input.run_id ?? input.runId, 195),
      safeText(input.assignment_id ?? input.assignmentId, 195),
      messageType,
      targetDeviceId,
      JSON.stringify(payload),
      now,
      now,
    );
    return this.getOutbox(outboxId);
  }

  getOutbox(outboxId) {
    const row = this.db.prepare(
      "SELECT * FROM collaboration_outbox WHERE outbox_id = ?",
    ).get(safeText(outboxId, 191));
    return row ? { ...row, payload: parseJson(row.payload_json, {}) } : null;
  }

  listPendingOutbox({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM collaboration_outbox
      WHERE state = 'pending'
      ORDER BY created_at ASC LIMIT ?
    `).all(Math.max(1, Math.min(500, Number(limit) || 100)))
      .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) }));
  }

  markOutboxAttempt(outboxId, error = "") {
    const now = iso(this.now());
    this.db.prepare(`
      UPDATE collaboration_outbox
      SET attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE outbox_id = ? AND state = 'pending'
    `).run(safeText(error, 2048), now, safeText(outboxId, 191));
    return this.getOutbox(outboxId);
  }

  markOutboxFailure(outboxId, error) {
    const now = iso(this.now());
    this.db.prepare(`
      UPDATE collaboration_outbox
      SET last_error = ?, updated_at = ?
      WHERE outbox_id = ? AND state = 'pending'
    `).run(safeText(error, 2048), now, safeText(outboxId, 191));
    return this.getOutbox(outboxId);
  }

  markOutboxFailed(outboxId, error) {
    const now = iso(this.now());
    this.db.prepare(`
      UPDATE collaboration_outbox
      SET state = 'failed', payload_json = '{}', last_error = ?, updated_at = ?
      WHERE outbox_id = ? AND state = 'pending'
    `).run(safeText(error, 2048), now, safeText(outboxId, 191));
    return this.getOutbox(outboxId);
  }

  markOutboxDelivered(outboxId) {
    const now = iso(this.now());
    this.db.prepare(`
      UPDATE collaboration_outbox
      SET state = 'delivered', payload_json = '{}', last_error = '',
          updated_at = ?, delivered_at = ?
      WHERE outbox_id = ?
    `).run(now, now, safeText(outboxId, 191));
    return this.getOutbox(outboxId);
  }

  getRemoteAssignment(assignmentId) {
    return this.db.prepare(
      "SELECT * FROM collaboration_remote_assignments WHERE assignment_id = ?",
    ).get(safeText(assignmentId, 195)) || null;
  }

  recordRemoteCancellation(input = {}) {
    const assignmentId = safeText(input.assignmentId ?? input.assignment_id, 195);
    const runId = safeText(input.runId ?? input.run_id, 195);
    const taskId = safeText(input.taskId ?? input.task_id, 195);
    const role = safeText(input.role, 32);
    if (!assignmentId || !runId || !taskId || !role) {
      throw new Error("invalid remote collaboration cancellation");
    }
    const attempt = Math.max(0, Math.floor(Number(input.attempt) || 0));
    const fencingToken = Math.max(0, Math.floor(Number(
      input.fencingToken ?? input.fencing_token,
    ) || 0));
    const reason = safeText(input.reason, 96) || "cancelled";
    const existing = this.getRemoteCancellation(assignmentId);
    if (existing && (
      existing.run_id !== runId
      || existing.task_id !== taskId
      || existing.role !== role
    )) {
      const error = new Error("remote collaboration cancellation identity conflict");
      error.code = "COLLABORATION_CANCELLATION_CONFLICT";
      throw error;
    }
    const now = iso(this.now());
    this.db.prepare(`
      INSERT INTO collaboration_remote_cancellations(
        assignment_id, run_id, task_id, role, attempt, fencing_token,
        reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        attempt = CASE
          WHEN excluded.fencing_token >= collaboration_remote_cancellations.fencing_token
          THEN excluded.attempt ELSE collaboration_remote_cancellations.attempt END,
        fencing_token = MAX(
          collaboration_remote_cancellations.fencing_token,
          excluded.fencing_token
        ),
        reason = CASE
          WHEN excluded.fencing_token >= collaboration_remote_cancellations.fencing_token
          THEN excluded.reason ELSE collaboration_remote_cancellations.reason END,
        updated_at = excluded.updated_at
    `).run(
      assignmentId,
      runId,
      taskId,
      role,
      attempt,
      fencingToken,
      reason,
      now,
      now,
    );
    return this.getRemoteCancellation(assignmentId);
  }

  getRemoteCancellation(assignmentId) {
    return this.db.prepare(
      "SELECT * FROM collaboration_remote_cancellations WHERE assignment_id = ?",
    ).get(safeText(assignmentId, 195)) || null;
  }

  isRemoteAssignmentCancelled(input = {}) {
    const cancellation = this.getRemoteCancellation(
      input.assignmentId ?? input.assignment_id,
    );
    if (!cancellation) return false;
    if (cancellation.run_id !== safeText(input.runId ?? input.run_id, 195)) return false;
    if (cancellation.role !== safeText(input.role, 32)) return false;
    const fencingToken = Math.max(0, Math.floor(Number(
      input.fencingToken ?? input.fencing_token,
    ) || 0));
    const attempt = Math.max(0, Math.floor(Number(input.attempt) || 0));
    if (cancellation.fencing_token > fencingToken) return true;
    return cancellation.fencing_token === fencingToken
      && cancellation.attempt >= attempt;
  }

  findRemoteAssignmentBySession(sessionId) {
    return this.db.prepare(
      "SELECT * FROM collaboration_remote_assignments WHERE originrouter_session_id = ?",
    ).get(safeText(sessionId, 64)) || null;
  }

  registerArtifact(runId, input = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const taskId = safeText(input.task_id ?? input.taskId, 195) || run.task_ids[0];
    if (!run.task_ids.includes(taskId)) throw new Error("collaboration task not found");
    assertNoSecretFields(input.metadata || {});
    const artifactId = safeText(input.artifact_id ?? input.artifactId, 195) || id("aca");
    const createdAt = iso(input.created_at ?? input.createdAt ?? this.now());
    const inserted = this.db.prepare(`
      INSERT OR IGNORE INTO collaboration_artifacts(
        artifact_id, run_id, task_id, owner_agent_id, kind, display_name,
        content_hash, locator, sensitivity, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId, runId, taskId,
      safeText(input.owner_agent_id ?? input.ownerAgentId, 195),
      safeText(input.kind, 64) || "report",
      safeText(input.display_name ?? input.displayName, 256) || "Collaboration artifact",
      safeText(input.content_hash ?? input.contentHash, 191),
      safeText(input.locator, 4096),
      ["normal", "sensitive", "high"].includes(input.sensitivity) ? input.sensitivity : "normal",
      JSON.stringify(input.metadata || {}), createdAt,
    );
    const artifact = this.db.prepare("SELECT * FROM collaboration_artifacts WHERE artifact_id = ?").get(artifactId);
    if (inserted.changes > 0) {
      this.touchRun(runId, createdAt);
      this.recordExecutionEvent(runId, {
        type: "artifact.created",
        taskId,
        participantId: safeText(input.participant_id ?? input.participantId, 32),
        summary: `Created artifact: ${artifact.display_name}`,
        payload: {
          artifact_id: artifact.artifact_id,
          kind: artifact.kind,
          sensitivity: artifact.sensitivity,
        },
        idempotencyKey: `artifact-created:${artifact.artifact_id}`,
        createdAt,
      });
    }
    return artifact;
  }

  listArtifacts(runId) {
    return this.db.prepare(
      "SELECT * FROM collaboration_artifacts WHERE run_id = ? ORDER BY created_at ASC",
    ).all(safeText(runId, 195)).map((row) => ({
      artifact_id: row.artifact_id,
      task_id: row.task_id,
      owner_agent_id: row.owner_agent_id || null,
      kind: row.kind,
      display_name: row.display_name,
      content_hash: row.content_hash || null,
      locator: row.locator || null,
      sensitivity: row.sensitivity,
      metadata: parseJson(row.metadata_json, {}),
      created_at: row.created_at,
    }));
  }

  recordUsage(runId, input = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const eventId = safeText(input.event_id ?? input.eventId, 195);
    if (eventId.length < 8) throw new Error("usage event_id is required");
    const existing = this.db.prepare(
      "SELECT event_id FROM collaboration_usage_receipts WHERE event_id = ?",
    ).get(eventId);
    if (existing) return { run: this.getRun(runId), duplicate: true, warning: null, exhausted: false };
    const sampledTokens = Math.max(0, Math.floor(Number(input.sampled_tokens ?? input.sampledTokens) || 0));
    const rawAmount = input.amount_micros ?? input.amountMicros;
    const costSource = safeText(input.cost_source ?? input.costSource, 32);
    const priced = rawAmount != null
      && costSource === "configured"
      && /^[A-Z]{3}$/.test(String(input.currency || "").toUpperCase());
    const currency = priced ? String(input.currency).toUpperCase() : "";
    const currencyMatches = !run.budget.currency || run.budget.currency === currency;
    const amountMicros = priced && currencyMatches
      ? Math.max(0, Math.floor(Number(rawAmount) || 0))
      : 0;
    const usage = {
      sampled_tokens: Number(run.usage.sampled_tokens || 0) + sampledTokens,
      amount_micros: Number(run.usage.amount_micros || 0) + amountMicros,
      currency: run.budget.currency || currency || run.usage.currency || null,
      unpriced_events: Number(run.usage.unpriced_events || 0) + (priced && currencyMatches ? 0 : 1),
    };
    const ratios = [
      run.budget.token_limit ? usage.sampled_tokens / Number(run.budget.token_limit) : 0,
      run.budget.amount_limit_micros
        ? usage.amount_micros / Number(run.budget.amount_limit_micros)
        : 0,
    ];
    const maxRatio = Math.max(0, ...ratios.filter(Number.isFinite));
    const exhausted = maxRatio >= 1;
    const warning = exhausted ? "exhausted" : maxRatio >= 0.8 ? "warning" : null;
    const updatedAt = iso(this.now());
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO collaboration_usage_receipts(
          event_id, run_id, agent_id, sampled_tokens, amount_micros,
          currency, cost_source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId, runId, safeText(input.agent_id ?? input.agentId, 195),
        sampledTokens, amountMicros, currency, costSource, updatedAt,
      );
      this.db.prepare("UPDATE collaboration_runs SET usage_json = ?, updated_at = ?, revision = revision + 1 WHERE run_id = ?")
        .run(JSON.stringify(usage), updatedAt, runId);
      if (exhausted && !["completed", "failed", "cancelled", "expired"].includes(run.state)) {
        const resumeState = run.state === "budget_exhausted"
          ? safeText(run.resume_state, 64)
          : run.state;
        this.db.prepare(`
          UPDATE collaboration_runs
          SET state = 'budget_exhausted', phase = 'execution', pause_reason = 'budget_exhausted',
              resume_state = CASE WHEN resume_state = '' THEN ? ELSE resume_state END
          WHERE run_id = ?
        `).run(resumeState, runId);
        this.db.prepare("UPDATE collaboration_tasks SET state = 'paused', updated_at = ? WHERE run_id = ? AND state IN ('active', 'pending')")
          .run(updatedAt, runId);
      }
    })();
    if (exhausted && run.state !== "budget_exhausted") {
      this.recordExecutionEvent(runId, {
        type: "budget.exhausted",
        severity: "error",
        summary: "The collaboration budget was exhausted.",
        payload: { ratio: maxRatio },
        idempotencyKey: `budget-exhausted:${runId}`,
        createdAt: updatedAt,
      });
    } else if (warning) {
      this.recordExecutionEvent(runId, {
        type: "budget.warning",
        summary: "The collaboration has used at least 80% of its budget.",
        payload: { ratio: maxRatio },
        idempotencyKey: `budget-warning:${runId}`,
        createdAt: updatedAt,
      });
    }
    return { run: this.getRun(runId), duplicate: false, warning, exhausted, ratio: maxRatio };
  }

  updateBudget(runId, input = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const budget = {
      token_limit: input.token_limit == null ? run.budget.token_limit : Math.max(1, Math.floor(Number(input.token_limit))),
      amount_limit_micros: input.amount_limit_micros === null
        ? null
        : input.amount_limit_micros == null
          ? run.budget.amount_limit_micros
          : Math.max(1, Math.floor(Number(input.amount_limit_micros))),
      currency: input.currency === null
        ? null
        : input.currency == null
          ? run.budget.currency
          : safeText(input.currency, 3).toUpperCase(),
      max_concurrency: input.max_concurrency == null
        ? run.budget.max_concurrency
        : Math.max(1, Math.min(32, Math.floor(Number(input.max_concurrency)))),
    };
    const updatedAt = iso(this.now());
    const ratios = [
      budget.token_limit ? Number(run.usage.sampled_tokens || 0) / Number(budget.token_limit) : 0,
      budget.amount_limit_micros
        ? Number(run.usage.amount_micros || 0) / Number(budget.amount_limit_micros)
        : 0,
    ];
    const taskBudgetExhausted = Math.max(0, ...ratios.filter(Number.isFinite)) >= 1;
    let nextState = run.state;
    let nextResumeState = safeText(run.resume_state, 64);
    let restoredState = null;
    const terminal = ["completed", "failed", "cancelled", "expired"].includes(run.state);
    if (taskBudgetExhausted && !terminal) {
      if (run.state !== "budget_exhausted") nextResumeState = run.state;
      nextState = "budget_exhausted";
    } else if (run.state === "budget_exhausted" && !run.account_budget_blocked) {
      const phase = run.tasks[0]?.phase;
      restoredState = nextResumeState || {
        research: "researching", planning: "planning", plan_review: "awaiting_plan_review",
        implementation: "implementing", verification: "awaiting_verification",
      }[phase] || "waiting_input";
      nextState = restoredState;
      nextResumeState = "";
    }
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_runs
        SET budget_json = ?, state = ?, resume_state = ?, updated_at = ?,
            revision = revision + 1,
            pause_reason = CASE WHEN ? = 'budget_exhausted' THEN 'budget_exhausted' ELSE '' END
        WHERE run_id = ?
      `).run(JSON.stringify(budget), nextState, nextResumeState, updatedAt, nextState, runId);
      if (taskBudgetExhausted && !terminal) {
        this.db.prepare("UPDATE collaboration_tasks SET state = 'paused', updated_at = ? WHERE run_id = ? AND state IN ('active', 'pending')")
          .run(updatedAt, runId);
      }
      if (restoredState) {
        this.db.prepare("UPDATE collaboration_tasks SET state = ?, updated_at = ? WHERE run_id = ? AND state = 'paused'")
          .run(run.template_id === ADAPTIVE_TEMPLATE_ID ? "pending" : "active", updatedAt, runId);
        if (run.template_id === ADAPTIVE_TEMPLATE_ID) {
          this.db.prepare("UPDATE collaboration_agents SET current_task_id = '', status = 'idle', updated_at = ? WHERE run_id = ?")
            .run(updatedAt, runId);
        }
      }
    })();
    if (restoredState) {
      this.recordExecutionEvent(runId, {
        type: "run.resumed",
        summary: "The collaboration resumed after its budget was updated.",
        idempotencyKey: `budget-resumed:${updatedAt}`,
        createdAt: updatedAt,
      });
    }
    return this.getRun(runId);
  }

  setAccountBudgetBlocked(runId, blocked) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || ["completed", "failed", "cancelled", "expired"].includes(run.state)) {
      return { run: this.getRun(runId), changed: false, restored: false };
    }
    const nextBlocked = Boolean(blocked);
    if (run.account_budget_blocked === nextBlocked) {
      return { run: this.getRun(runId), changed: false, restored: false };
    }
    const updatedAt = iso(this.now());
    let restoredState = null;
    this.db.transaction(() => {
      if (nextBlocked) {
        const resumeState = run.state === "budget_exhausted"
          ? safeText(run.resume_state, 64)
          : run.state;
        this.db.prepare(`
          UPDATE collaboration_runs
          SET state = 'budget_exhausted', phase = 'execution',
              pause_reason = 'budget_exhausted', account_budget_blocked = 1,
              resume_state = CASE WHEN resume_state = '' THEN ? ELSE resume_state END,
              updated_at = ?, revision = revision + 1
          WHERE run_id = ?
        `).run(resumeState, updatedAt, runId);
        this.db.prepare("UPDATE collaboration_tasks SET state = 'paused', updated_at = ? WHERE run_id = ? AND state IN ('active', 'pending')")
          .run(updatedAt, runId);
        return;
      }
      const ratios = [
        run.budget.token_limit ? Number(run.usage.sampled_tokens || 0) / Number(run.budget.token_limit) : 0,
        run.budget.amount_limit_micros
          ? Number(run.usage.amount_micros || 0) / Number(run.budget.amount_limit_micros)
          : 0,
      ];
      const taskBudgetExhausted = Math.max(0, ...ratios.filter(Number.isFinite)) >= 1;
      if (!taskBudgetExhausted && run.state === "budget_exhausted") {
        const phase = run.tasks[0]?.phase;
        restoredState = safeText(run.resume_state, 64) || {
          research: "researching", planning: "planning", plan_review: "awaiting_plan_review",
          implementation: "implementing", verification: "awaiting_verification",
        }[phase] || "waiting_input";
      }
      this.db.prepare(`
        UPDATE collaboration_runs
        SET account_budget_blocked = 0,
            state = COALESCE(?, state),
            resume_state = CASE WHEN ? IS NULL THEN resume_state ELSE '' END,
            updated_at = ?, revision = revision + 1,
            pause_reason = CASE WHEN ? IS NULL THEN pause_reason ELSE '' END
        WHERE run_id = ?
      `).run(restoredState, restoredState, updatedAt, restoredState, runId);
      if (restoredState) {
        this.db.prepare("UPDATE collaboration_tasks SET state = ?, updated_at = ? WHERE run_id = ? AND state = 'paused'")
          .run(run.template_id === ADAPTIVE_TEMPLATE_ID ? "pending" : "active", updatedAt, runId);
        if (run.template_id === ADAPTIVE_TEMPLATE_ID) {
          this.db.prepare("UPDATE collaboration_agents SET current_task_id = '', status = 'idle', updated_at = ? WHERE run_id = ?")
            .run(updatedAt, runId);
        }
      }
    })();
    this.recordExecutionEvent(runId, {
      type: nextBlocked ? "budget.exhausted" : (restoredState ? "run.resumed" : "agent.activity"),
      visibility: nextBlocked || restoredState ? "summary" : "diagnostic",
      summary: nextBlocked
        ? "The device or Agent budget paused this collaboration."
        : "The device or Agent budget restriction was cleared.",
      idempotencyKey: `account-budget:${nextBlocked ? "blocked" : "cleared"}:${updatedAt}`,
      createdAt: updatedAt,
    });
    return {
      run: this.getRun(runId),
      changed: true,
      restored: Boolean(restoredState),
    };
  }

  pauseForAccountBudget(runId) {
    return this.setAccountBudgetBlocked(runId, true).run;
  }

  pauseRun(runId, { reason = "user_requested" } = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    if (["completed", "failed", "cancelled", "expired"].includes(run.state)) {
      throw new Error("finished collaboration runs cannot be paused");
    }
    if (run.state === "paused") return run;
    const updatedAt = iso(this.now());
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_runs
        SET state = 'paused', resume_state = ?, pause_reason = ?,
            updated_at = ?, revision = revision + 1
        WHERE run_id = ?
      `).run(run.state, safeText(reason, 64) || "user_requested", updatedAt, run.run_id);
      this.db.prepare(`
        UPDATE collaboration_tasks
        SET state = 'paused', waiting_reason = 'run_paused', updated_at = ?
        WHERE run_id = ? AND state IN ('active', 'pending')
      `).run(updatedAt, run.run_id);
      this.db.prepare(`
        UPDATE collaboration_agents SET status = 'paused', updated_at = ?
        WHERE run_id = ? AND current_task_id <> ''
      `).run(updatedAt, run.run_id);
    })();
    this.recordExecutionEvent(run.run_id, {
      type: "run.paused",
      summary: "The collaboration was paused by the user.",
      payload: { reason: safeText(reason, 64) || "user_requested" },
      idempotencyKey: `run-paused:${updatedAt}`,
      createdAt: updatedAt,
    });
    return this.getRun(run.run_id);
  }

  resumeRun(runId) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    if (run.state !== "paused") throw new Error("collaboration run is not paused");
    if (run.account_budget_blocked) throw new Error("account budget still prevents this collaboration from resuming");
    const nextState = safeText(run.resume_state, 64) || (run.template_id === ADAPTIVE_TEMPLATE_ID ? "executing" : "researching");
    if (!RUN_STATES.has(nextState) || ["paused", "completed", "failed", "cancelled", "expired"].includes(nextState)) {
      throw new Error("collaboration run has no resumable state");
    }
    const projected = runViewState(nextState);
    const updatedAt = iso(this.now());
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_runs
        SET state = ?, resume_state = '', pause_reason = '',
            phase = ?, blocked_reason = '', updated_at = ?, revision = revision + 1
        WHERE run_id = ?
      `).run(nextState, projected.phase || run.phase || "execution", updatedAt, run.run_id);
      this.db.prepare(`
        UPDATE collaboration_tasks
        SET state = ?, waiting_reason = '', finished_at = NULL, updated_at = ?
        WHERE run_id = ? AND state = 'paused'
      `).run(run.template_id === ADAPTIVE_TEMPLATE_ID ? "pending" : "active", updatedAt, run.run_id);
      this.db.prepare(`
        UPDATE collaboration_agents
        SET status = 'idle', current_task_id = '', updated_at = ?
        WHERE run_id = ? AND status = 'paused'
      `).run(updatedAt, run.run_id);
    })();
    this.recordExecutionEvent(run.run_id, {
      type: "run.resumed",
      summary: "The collaboration resumed.",
      idempotencyKey: `run-resumed:${updatedAt}`,
      createdAt: updatedAt,
    });
    return this.getRun(run.run_id);
  }

  retryAdaptiveTask(runId, taskReference) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID) {
      throw new Error("adaptive collaboration run not found");
    }
    if (["completed", "failed", "cancelled", "expired"].includes(run.state)) {
      throw new Error("retrying a task in a finished run requires a new collaboration run");
    }
    const reference = safeText(taskReference, 195);
    const task = run.tasks.find((item) => item.task_id === reference || item.task_key === reference);
    if (!task || task.task_key === "__planner__") throw new Error("collaboration task not found");
    if (!["failed", "cancelled", "blocked", "paused"].includes(task.state)) {
      throw new Error("only failed, cancelled, blocked, or paused tasks can be retried");
    }
    const updatedAt = iso(this.now());
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_tasks
        SET state = 'pending', result_summary = '', summary = '', waiting_reason = '',
            started_at = NULL, finished_at = NULL, updated_at = ?
        WHERE run_id = ? AND task_id = ?
      `).run(updatedAt, run.run_id, task.task_id);
      this.db.prepare(`
        UPDATE collaboration_agents
        SET status = 'idle', current_task_id = '', updated_at = ?
        WHERE run_id = ? AND role = ?
      `).run(updatedAt, run.run_id, task.participant_id);
      this.db.prepare(`
        UPDATE collaboration_runs
        SET state = 'executing', phase = 'execution', blocked_reason = '',
            pause_reason = '', updated_at = ?, revision = revision + 1
        WHERE run_id = ?
      `).run(updatedAt, run.run_id);
    })();
    this.recordExecutionEvent(run.run_id, {
      type: "task.retry_scheduled",
      taskId: task.task_id,
      participantId: task.participant_id,
      attempt: Number(task.attempt || 0) + 1,
      summary: `Retry scheduled: ${task.title}`,
      idempotencyKey: `task-retry:${task.task_id}:${Number(task.attempt || 0) + 1}`,
      createdAt: updatedAt,
    });
    return this.getRun(run.run_id);
  }

  retryRun(runId) {
    const source = this.getRun(runId, { includeMessages: false });
    if (!source) throw new Error("collaboration run not found");
    if (!["failed", "cancelled", "expired"].includes(source.state)) {
      throw new Error("only failed, cancelled, or expired runs can be retried as a new run");
    }
    let created;
    if (source.template_id === ADAPTIVE_TEMPLATE_ID) {
      created = this.createRun({
        objective: source.objective,
        preferences: source.preferences,
        coordination_prompt: source.coordination_prompt,
        workflow_template_id: source.workflow_template_id,
        coordinator_device_id: source.coordinator_device_id,
        participants: Object.entries(source.agents).map(([participantId, agent]) => ({
          participant_id: participantId,
          display_name: agent.display_name,
          runtime: agent.runtime,
          device_id: agent.device_id,
          workspace_id: agent.workspace_id,
          provider: agent.provider,
          model: agent.model,
          permission_profile: agent.permission_profile,
          role_hint: agent.role_hint,
          planner: participantId === source.planner_role,
        })),
        budget: source.budget,
      });
    } else {
      const role = (name) => {
        const agent = source.agents[name];
        return agent ? {
          runtime: agent.runtime,
          device_id: agent.device_id,
          workspace_id: agent.workspace_id,
          provider: agent.provider,
          model: agent.model,
          permission_profile: agent.permission_profile,
          responsibilities: agent.responsibilities,
        } : null;
      };
      created = this.createRun({
        objective: source.objective,
        coordinator_device_id: source.coordinator_device_id,
        title: source.tasks[0]?.title,
        agents: {
          lead: role("lead"),
          worker: role("worker"),
          ...(source.agents.verifier ? { verifier: role("verifier") } : {}),
        },
        gates: source.gates,
        budget: source.budget,
      });
    }
    const updatedAt = iso(this.now());
    this.db.prepare(`
      UPDATE collaboration_runs
      SET retry_of_run_id = ?, updated_at = ?, revision = revision + 1
      WHERE run_id = ?
    `).run(source.run_id, updatedAt, created.run_id);
    this.recordExecutionEvent(created.run_id, {
      type: "run.retry_created",
      summary: `Created as a retry of ${source.run_id}.`,
      payload: { retry_of_run_id: source.run_id },
      idempotencyKey: `run-retry-of:${source.run_id}`,
      createdAt: updatedAt,
    });
    return this.getRun(created.run_id);
  }

  appendMessage(runId, input = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const type = safeText(input.type, 64);
    if (!MESSAGE_TYPES.has(type)) throw new Error("unsupported collaboration message type");
    const taskId = safeText(input.task_id ?? input.taskId, 195) || run.task_ids[0];
    if (!run.task_ids.includes(taskId)) throw new Error("collaboration task not found");
    const idempotencyKey = safeText(input.idempotency_key ?? input.idempotencyKey, 191);
    if (idempotencyKey.length < 8) throw new Error("idempotency_key is required");
    const existing = this.db.prepare("SELECT * FROM collaboration_messages WHERE run_id = ? AND idempotency_key = ?").get(runId, idempotencyKey);
    if (existing) return { message: this.publicMessage(existing), duplicate: true };
    const sender = input.sender && typeof input.sender === "object" ? input.sender : {};
    const recipient = input.recipient && typeof input.recipient === "object" ? input.recipient : {};
    const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
    assertNoSecretFields({ sender, recipient, payload });
    const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM collaboration_messages WHERE run_id = ?").get(runId).value) + 1;
    const messageId = safeText(input.message_id ?? input.messageId, 195) || id("acm");
    const createdAt = iso(input.created_at ?? input.createdAt ?? this.now());
    this.db.prepare(`INSERT INTO collaboration_messages(message_id, run_id, task_id, correlation_id, type, sequence, created_at, idempotency_key, sender_json, recipient_json, payload_json, parent_message_id, causation_id, artifact_refs_json, evidence_refs_json, requires_ack, sensitivity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(messageId, runId, taskId, safeText(input.correlation_id ?? input.correlationId, 191) || taskId, type, sequence, createdAt, idempotencyKey, JSON.stringify(sender), JSON.stringify(recipient), JSON.stringify(payload), safeText(input.parent_message_id, 195) || null, safeText(input.causation_id, 195) || null, JSON.stringify(input.artifact_refs || []), JSON.stringify(input.evidence_refs || []), input.requires_ack ? 1 : 0, ["normal", "sensitive", "high"].includes(input.sensitivity) ? input.sensitivity : "normal");
    this.db.prepare("UPDATE collaboration_runs SET updated_at = ? WHERE run_id = ?").run(createdAt, runId);
    return { message: this.publicMessage(this.db.prepare("SELECT * FROM collaboration_messages WHERE message_id = ?").get(messageId)), duplicate: false };
  }

  publicMessage(row) {
    return {
      protocol_version: "1", message_id: row.message_id, run_id: row.run_id,
      task_id: row.task_id, correlation_id: row.correlation_id, type: row.type,
      sequence: Number(row.sequence), created_at: row.created_at,
      idempotency_key: row.idempotency_key, sender: parseJson(row.sender_json, {}),
      recipient: parseJson(row.recipient_json, {}), payload: parseJson(row.payload_json, {}),
      parent_message_id: row.parent_message_id, causation_id: row.causation_id,
      artifact_refs: parseJson(row.artifact_refs_json, []), evidence_refs: parseJson(row.evidence_refs_json, []),
      requires_ack: Boolean(row.requires_ack), acknowledged_at: row.acknowledged_at,
      sensitivity: row.sensitivity,
    };
  }

  listMessages(runId, { after = 0, limit = 200 } = {}) {
    return this.db.prepare("SELECT * FROM collaboration_messages WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?")
      .all(safeText(runId, 195), Math.max(0, Number(after) || 0), Math.max(1, Math.min(500, Number(limit) || 200))).map((row) => this.publicMessage(row));
  }

  recordExecutionEvent(runId, input = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const eventId = safeText(input.event_id ?? input.eventId, 195) || id("ace");
    const idempotencyKey = safeText(input.idempotency_key ?? input.idempotencyKey, 191);
    const existing = this.db.prepare(`
      SELECT * FROM collaboration_execution_events
      WHERE event_id = ? OR (run_id = ? AND idempotency_key <> '' AND idempotency_key = ?)
      LIMIT 1
    `).get(eventId, run.run_id, idempotencyKey);
    if (existing) {
      return { duplicate: true, event_id: existing.event_id, event: this.publicExecutionEvent(existing) };
    }
    const metadata = input.metadata && typeof input.metadata === "object"
      ? redactDisplayValue(input.metadata)
      : {};
    const payload = input.payload && typeof input.payload === "object"
      ? redactDisplayValue(input.payload)
      : {};
    assertNoSecretFields({ metadata, payload });
    const type = safeText(input.type, 96) || "agent.activity";
    const presentation = eventPresentation(type, input);
    const createdAt = iso(input.created_at ?? input.createdAt ?? this.now());
    const recordedAt = iso(this.now());
    let sequence = 0;
    this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT last_event_sequence FROM collaboration_runs WHERE run_id = ?",
      ).get(run.run_id);
      sequence = Number(row?.last_event_sequence || 0) + 1;
      this.db.prepare(`
        INSERT INTO collaboration_execution_events(
          event_id, run_id, schema_version, sequence, task_id, participant_id,
          session_id, attempt, type, category, severity, visibility, summary,
          detail, payload_json, metadata_json, correlation_id, causation_id,
          idempotency_key, created_at, recorded_at
        ) VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        run.run_id,
        sequence,
        safeText(input.task_id ?? input.taskId, 195),
        safeText(input.participant_id ?? input.participantId, 32),
        safeText(input.session_id ?? input.sessionId, 64),
        Math.max(0, Number(input.attempt) || 0),
        type,
        presentation.category,
        presentation.severity,
        presentation.visibility,
        redactDisplayText(input.summary, 1024),
        redactDisplayText(input.detail, 8192),
        JSON.stringify(payload),
        JSON.stringify(metadata),
        safeText(input.correlation_id ?? input.correlationId, 191),
        safeText(input.causation_id ?? input.causationId, 195),
        idempotencyKey,
        createdAt,
        recordedAt,
      );
      this.db.prepare(`
        UPDATE collaboration_runs SET last_event_sequence = ? WHERE run_id = ?
      `).run(sequence, run.run_id);
    })();
    const inserted = this.db.prepare(
      "SELECT * FROM collaboration_execution_events WHERE event_id = ?",
    ).get(eventId);
    return { duplicate: false, event_id: eventId, event: this.publicExecutionEvent(inserted) };
  }

  publicExecutionEvent(row) {
    return {
      schema_version: Number(row.schema_version || 1),
      event_id: row.event_id,
      sequence: Number(row.sequence || 0),
      run_id: row.run_id,
      task_id: row.task_id || null,
      participant_id: row.participant_id || null,
      session_id: row.session_id || null,
      attempt: Number(row.attempt || 0),
      type: row.type,
      category: row.category || eventPresentation(row.type).category,
      severity: row.severity || "info",
      visibility: row.visibility || "detail",
      summary: row.summary,
      detail: row.detail,
      payload: parseJson(row.payload_json, {}),
      metadata: parseJson(row.metadata_json, {}),
      correlation_id: row.correlation_id || null,
      causation_id: row.causation_id || null,
      idempotency_key: row.idempotency_key || null,
      created_at: row.created_at,
      recorded_at: row.recorded_at || row.created_at,
    };
  }

  listExecutionEvents(runId, {
    participantId = "",
    taskId = "",
    after = "",
    afterSequence = 0,
    visibility = "",
    limit = 100,
  } = {}) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const conditions = ["run_id = ?"];
    const values = [safeText(runId, 195)];
    if (participantId) {
      conditions.push("participant_id = ?");
      values.push(safeText(participantId, 32));
    }
    if (taskId) {
      conditions.push("task_id = ?");
      values.push(safeText(taskId, 195));
    }
    if (Number(afterSequence) > 0) {
      conditions.push("sequence > ?");
      values.push(Math.max(0, Number(afterSequence) || 0));
    } else if (after) {
      conditions.push("created_at > ?");
      values.push(iso(after));
    }
    if (visibility) {
      const allowed = String(visibility).split(",").map((item) => item.trim())
        .filter((item) => ["summary", "detail", "diagnostic", "audit_only"].includes(item));
      if (allowed.length) {
        conditions.push(`visibility IN (${allowed.map(() => "?").join(",")})`);
        values.push(...allowed);
      }
    }
    values.push(safeLimit);
    return this.db.prepare(`
      SELECT *
      FROM collaboration_execution_events
      WHERE ${conditions.join(" AND ")}
      ORDER BY sequence ASC LIMIT ?
    `).all(...values).map((row) => this.publicExecutionEvent(row));
  }

  listExecutionEventPage(runId, {
    afterSequence = 0,
    participantId = "",
    taskId = "",
    visibility = "",
    limit = 200,
  } = {}) {
    const key = safeText(runId, 195);
    const safeAfter = Math.max(0, Number(afterSequence) || 0);
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 200));
    const rows = this.db.prepare(`
      SELECT * FROM collaboration_execution_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?
    `).all(key, safeAfter, safeLimit);
    const participant = safeText(participantId, 32);
    const task = safeText(taskId, 195);
    const allowedVisibility = new Set(
      String(visibility || "").split(",").map((item) => item.trim())
        .filter((item) => ["summary", "detail", "diagnostic", "audit_only"].includes(item)),
    );
    const events = rows
      .filter((row) => !participant || row.participant_id === participant)
      .filter((row) => !task || row.task_id === task)
      .filter((row) => allowedVisibility.size === 0 || allowedVisibility.has(row.visibility))
      .map((row) => this.publicExecutionEvent(row));
    const run = this.db.prepare(
      "SELECT revision, last_event_sequence FROM collaboration_runs WHERE run_id = ?",
    ).get(key);
    if (!run) return null;
    const nextSequence = Number(rows.at(-1)?.sequence || safeAfter);
    const lastSequence = Number(run.last_event_sequence || 0);
    return {
      events,
      next_sequence: nextSequence,
      last_sequence: lastSequence,
      snapshot_revision: Number(run.revision || 0),
      has_more: nextSequence < lastSequence,
    };
  }

  createAttention(runId, input = {}) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const idempotencyKey = safeText(input.idempotency_key ?? input.idempotencyKey, 191);
    if (!idempotencyKey) throw new Error("attention idempotency_key is required");
    const existing = this.db.prepare(`
      SELECT * FROM collaboration_attention_items WHERE run_id = ? AND idempotency_key = ?
    `).get(run.run_id, idempotencyKey);
    if (existing) return this.publicAttention(existing);
    const attentionId = safeText(input.attention_id ?? input.attentionId, 195) || id("att");
    const createdAt = iso(input.created_at ?? input.createdAt ?? this.now());
    const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
    assertNoSecretFields(payload);
    this.db.prepare(`
      INSERT INTO collaboration_attention_items(
        attention_id, run_id, task_id, participant_id, kind, status, title,
        summary, risk, actions_json, payload_json, idempotency_key, revision,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      attentionId,
      run.run_id,
      safeText(input.task_id ?? input.taskId, 195),
      safeText(input.participant_id ?? input.participantId, 32),
      safeText(input.kind, 64) || "input",
      safeText(input.title, 256) || "Collaboration needs attention",
      safeText(input.summary, 2048),
      ["low", "normal", "high", "critical"].includes(input.risk) ? input.risk : "normal",
      JSON.stringify(Array.isArray(input.actions) ? input.actions.map((item) => safeText(item, 64)).filter(Boolean) : []),
      JSON.stringify(payload),
      idempotencyKey,
      createdAt,
      createdAt,
      input.expires_at || input.expiresAt ? iso(input.expires_at ?? input.expiresAt) : null,
    );
    this.touchRun(run.run_id, createdAt);
    return this.publicAttention(this.db.prepare(
      "SELECT * FROM collaboration_attention_items WHERE attention_id = ?",
    ).get(attentionId));
  }

  publicAttention(row) {
    return {
      attention_id: row.attention_id,
      kind: row.kind,
      status: row.status,
      run_id: row.run_id,
      task_id: row.task_id || null,
      participant_id: row.participant_id || null,
      title: row.title,
      summary: row.summary,
      risk: row.risk,
      actions: parseJson(row.actions_json, []),
      payload: parseJson(row.payload_json, {}),
      revision: Number(row.revision || 1),
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at || null,
      resolved_at: row.resolved_at || null,
      resolved_by: row.resolved_by || null,
      resolution: row.resolution || null,
      derived: false,
    };
  }

  listAttention(runId, { status = "pending" } = {}) {
    const values = [safeText(runId, 195)];
    const where = status ? "AND status = ?" : "";
    if (status) values.push(safeText(status, 32));
    return this.db.prepare(`
      SELECT * FROM collaboration_attention_items
      WHERE run_id = ? ${where}
      ORDER BY created_at ASC, attention_id ASC
    `).all(...values).map((row) => this.publicAttention(row));
  }

  findAttentionByIdempotency(runId, idempotencyKey) {
    const row = this.db.prepare(`
      SELECT * FROM collaboration_attention_items
      WHERE run_id = ? AND idempotency_key = ?
    `).get(safeText(runId, 195), safeText(idempotencyKey, 191));
    return row ? this.publicAttention(row) : null;
  }

  resolveAttention(runId, attentionId, input = {}) {
    const current = this.db.prepare(`
      SELECT * FROM collaboration_attention_items WHERE run_id = ? AND attention_id = ?
    `).get(safeText(runId, 195), safeText(attentionId, 195));
    if (!current) throw new Error("collaboration attention item not found");
    if (current.status !== "pending") return { item: this.publicAttention(current), duplicate: true };
    const expectedRevision = Number(input.expected_revision ?? input.expectedRevision ?? current.revision);
    if (expectedRevision !== Number(current.revision)) {
      const error = new Error("collaboration attention item changed; refresh and try again");
      error.code = "COLLABORATION_ATTENTION_REVISION_CONFLICT";
      throw error;
    }
    const resolvedAt = iso(this.now());
    const result = this.db.prepare(`
      UPDATE collaboration_attention_items
      SET status = 'resolved', revision = revision + 1, updated_at = ?,
          resolved_at = ?, resolved_by = ?, resolution = ?
      WHERE run_id = ? AND attention_id = ? AND status = 'pending' AND revision = ?
    `).run(
      resolvedAt,
      resolvedAt,
      safeText(input.resolved_by ?? input.resolvedBy, 191) || "local-user",
      safeText(input.resolution, 64) || "resolved",
      current.run_id,
      current.attention_id,
      expectedRevision,
    );
    const item = this.db.prepare(
      "SELECT * FROM collaboration_attention_items WHERE attention_id = ?",
    ).get(current.attention_id);
    if (result.changes === 0) return { item: this.publicAttention(item), duplicate: true };
    this.touchRun(current.run_id, resolvedAt);
    return { item: this.publicAttention(item), duplicate: false };
  }

  getSnapshot(runId) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) return null;
    const projected = runViewState(run.state);
    const completedKeys = new Set(run.tasks.filter((task) => task.state === "completed")
      .map((task) => task.task_key).filter(Boolean));
    const tasks = run.tasks.map((task) => ({
      ...task,
      legacy_state: task.state,
      state: taskViewState(task, completedKeys),
    }));
    const storedAttention = this.listAttention(run.run_id, { status: "pending" });
    const derived = derivedAttentionItems(run)
      .filter((item) => !storedAttention.some((stored) => stored.kind === item.kind));
    const attention = [...storedAttention, ...derived];
    const terminal = ["completed", "failed", "cancelled", "expired"].includes(projected.state);
    const retryableTask = tasks.some((task) =>
      ["failed", "cancelled", "blocked", "paused"].includes(task.state),
    );
    return {
      schema_version: 2,
      revision: Number(run.revision || 0),
      last_sequence: Number(run.last_event_sequence || 0),
      run: {
        ...run,
        legacy_state: run.state,
        state: projected.state,
        phase: run.phase || projected.phase,
        pause_reason: run.pause_reason || projected.pauseReason || null,
        blocked_reason: run.blocked_reason || projected.blockedReason || null,
        tasks: undefined,
        agents: undefined,
        artifacts: undefined,
      },
      plan: run.plan,
      tasks,
      participants: Object.entries(run.agents).map(([participantId, participant]) => ({
        participant_id: participantId,
        ...participant,
      })),
      attention,
      artifacts: run.artifacts,
      budget: run.budget,
      usage: run.usage,
      final_report: run.final_report,
      capabilities: {
        can_confirm_plan: projected.state === "awaiting_confirmation",
        can_resolve_approval: attention.some((item) =>
          item.status === "pending" && Array.isArray(item.actions) && item.actions.length > 0,
        ),
        can_pause: ["queued", "running", "blocked"].includes(projected.state),
        can_resume: projected.state === "paused",
        can_cancel: !terminal,
        can_retry_task: !terminal && retryableTask,
        can_retry_run: ["failed", "cancelled", "expired"].includes(projected.state),
        can_change_budget: !terminal,
        can_archive: terminal && !run.archived_at,
        can_delete: terminal,
        can_view_diagnostics: true,
      },
    };
  }

  getDiagnostics(runId) {
    const snapshot = this.getSnapshot(runId);
    if (!snapshot) return null;
    const key = safeText(runId, 195);
    const count = (table, extra = "") => Number(this.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ? ${extra}`,
    ).get(key)?.count || 0);
    const errorEvents = this.db.prepare(`
      SELECT sequence, type, category, severity, payload_json, created_at
      FROM collaboration_execution_events
      WHERE run_id = ? AND severity IN ('warning','error')
      ORDER BY sequence DESC LIMIT 20
    `).all(key).map((row) => {
      const payload = parseJson(row.payload_json, {});
      return {
        sequence: Number(row.sequence || 0),
        type: row.type,
        category: row.category,
        severity: row.severity,
        diagnostic_code: safeText(
          payload.diagnostic_code ?? payload.diagnosticCode ?? payload.code ?? payload.reason,
          96,
        ) || null,
        created_at: row.created_at,
      };
    });
    return {
      schema_version: 1,
      generated_at: iso(this.now()),
      run: {
        run_id: snapshot.run.run_id,
        schema_version: snapshot.schema_version,
        revision: snapshot.revision,
        state: snapshot.run.state,
        legacy_state: snapshot.run.legacy_state,
        phase: snapshot.run.phase,
        connection: snapshot.run.connection,
        coordinator_device_id: snapshot.run.coordinator_device_id,
        created_at: snapshot.run.created_at,
        updated_at: snapshot.run.updated_at,
        started_at: snapshot.run.started_at,
        finished_at: snapshot.run.finished_at,
      },
      counts: {
        participants: snapshot.participants.length,
        tasks: snapshot.tasks.length,
        pending_attention: snapshot.attention.filter((item) => item.status === "pending").length,
        events: count("collaboration_execution_events"),
        artifacts: count("collaboration_artifacts"),
        remote_assignments: count("collaboration_remote_assignments"),
        pending_outbox: count("collaboration_outbox", "AND state NOT IN ('delivered','cancelled')"),
      },
      participants: snapshot.participants.map((participant) => ({
        participant_id: participant.participant_id,
        runtime: participant.runtime,
        device_id: participant.device_id,
        status: participant.status,
        attempt: participant.attempt,
        has_session: Boolean(participant.originrouter_session_id),
        lease_expires_at: participant.lease_expires_at || null,
        last_heartbeat_at: participant.last_heartbeat_at || null,
      })),
      recent_warnings_and_errors: errorEvents,
      database_integrity: this.db.pragma("quick_check", { simple: true }),
    };
  }

  persistFinalReport(runId) {
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    if (!new Set(["completed", "failed", "cancelled", "expired"]).has(run.state)) return null;
    if (run.final_report) return run.final_report;
    const report = buildFinalReport(run);
    this.db.prepare(`
      UPDATE collaboration_runs
      SET final_report_json = ?, revision = revision + 1
      WHERE run_id = ? AND final_report_json = ''
    `).run(JSON.stringify(report), run.run_id);
    return report;
  }

  transition(runId, nextState, { counter = null, taskState = null, taskPhase = null } = {}) {
    if (!RUN_STATES.has(nextState)) throw new Error("invalid collaboration state");
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const counters = { ...run.counters };
    if (counter) counters[counter] = Number(counters[counter] || 0) + 1;
    const terminal = ["completed", "failed", "cancelled", "expired"].includes(nextState);
    const finishedAt = terminal ? iso(this.now()) : null;
    const updatedAt = iso(this.now());
    const projected = runViewState(nextState);
    const startedAt = nextState === "created" ? null : updatedAt;
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE collaboration_runs
        SET state = ?, phase = ?, pause_reason = ?, blocked_reason = ?,
            counters_json = ?, updated_at = ?, revision = revision + 1,
            started_at = COALESCE(started_at, ?), finished_at = ?
        WHERE run_id = ?
      `).run(
        nextState,
        projected.phase || "",
        projected.pauseReason || "",
        projected.blockedReason || "",
        JSON.stringify(counters),
        updatedAt,
        startedAt,
        finishedAt,
        runId,
      );
      if (taskState || taskPhase) {
        this.db.prepare(`
          UPDATE collaboration_tasks
          SET state = COALESCE(?, state), phase = COALESCE(?, phase),
              started_at = CASE WHEN ? = 'active' THEN COALESCE(started_at, ?) ELSE started_at END,
              finished_at = CASE WHEN ? IN ('completed','failed','cancelled','skipped') THEN ? ELSE finished_at END,
              updated_at = ?
          WHERE run_id = ?
        `).run(taskState, taskPhase, taskState, updatedAt, taskState, updatedAt, updatedAt, runId);
      }
    })();
    const eventType = {
      designing: "run.planning_started",
      researching: "run.planning_started",
      awaiting_plan_confirmation: "run.plan_ready",
      executing: "run.started",
      budget_exhausted: "run.paused",
      blocked: "run.blocked",
      completed: "run.completed",
      failed: "run.failed",
      cancelled: "run.cancelled",
      expired: "run.cancelled",
    }[nextState];
    if (eventType) {
      this.recordExecutionEvent(runId, {
        type: eventType,
        summary: {
          "run.planning_started": "The Planner started preparing a collaboration plan.",
          "run.plan_ready": "The collaboration plan is ready for review.",
          "run.started": "The collaboration started.",
          "run.paused": "The collaboration was paused.",
          "run.blocked": "The collaboration needs attention before it can continue.",
          "run.completed": "The collaboration completed.",
          "run.failed": "The collaboration failed.",
          "run.cancelled": nextState === "expired" ? "The collaboration expired." : "The collaboration was cancelled.",
        }[eventType],
        idempotencyKey: `run-transition:${nextState}:${updatedAt}`,
        createdAt: updatedAt,
      });
    }
    if (terminal) this.persistFinalReport(runId);
    return this.getRun(runId);
  }

  close() { if (this.db?.open) this.db.close(); }
}
