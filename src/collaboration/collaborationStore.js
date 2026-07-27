import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { ensureStateDir } from "../persistence/state.js";

const MESSAGE_TYPES = new Set([
  "task.assign", "task.accepted", "task.progress", "task.question",
  "task.answer", "task.blocked", "task.completed", "task.failed",
  "task.cancelled", "plan.submitted", "review.approved",
  "review.revision_requested", "implementation.completed",
  "verification.passed", "verification.failed", "rework.requested",
  "artifact.created", "agent.message", "agent.shutdown_requested",
  "agent.shutdown_acknowledged",
]);
const RUN_STATES = new Set([
  "created", "researching", "decomposing", "planning",
  "awaiting_plan_review", "revision_requested", "plan_approved",
  "implementing", "awaiting_verification", "rework_requested", "completed",
  "waiting_approval", "waiting_input", "waiting_device", "budget_exhausted",
  "blocked", "failed", "cancelled", "expired",
]);
const FORBIDDEN_KEYS = /token|secret|password|authorization|cookie|api[_-]?key|service[_-]?key|environment|env_dump/i;
const SAFE_USAGE_KEYS = new Set([
  "token_limit", "token_budget", "sampled_tokens", "sampledTokens",
  "input_tokens", "inputTokens", "output_tokens", "outputTokens",
  "cached_input_tokens", "cachedInputTokens", "total_tokens", "totalTokens",
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
  };
}

function publicRun(row) {
  if (!row) return null;
  return {
    protocol_version: "1",
    template_id: row.template_id,
    template_version: row.template_version,
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    objective: row.objective,
    state: row.state,
    gates: parseJson(row.gates_json, {}),
    budget: parseJson(row.budget_json, {}),
    usage: parseJson(row.usage_json, {}),
    counters: parseJson(row.counters_json, {}),
    account_budget_blocked: Boolean(row.account_budget_blocked),
    resume_state: row.resume_state || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at || null,
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
        state TEXT NOT NULL,
        gates_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        counters_json TEXT NOT NULL,
        account_budget_blocked INTEGER NOT NULL DEFAULT 0,
        resume_state TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
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
        status TEXT NOT NULL DEFAULT 'idle',
        native_session_id TEXT NOT NULL DEFAULT '',
        originrouter_session_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES collaboration_runs(run_id) ON DELETE CASCADE,
        UNIQUE(run_id, role)
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_collaboration_runs_updated ON collaboration_runs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_messages_run ON collaboration_messages(run_id, sequence ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_artifacts_run ON collaboration_artifacts(run_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_collaboration_remote_session ON collaboration_remote_assignments(originrouter_session_id);
      CREATE INDEX IF NOT EXISTS idx_collaboration_usage_run ON collaboration_usage_receipts(run_id, created_at ASC);
    `);
    this.ensureColumn("collaboration_agents", "originrouter_session_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_agents", "conversation_id", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_runs", "account_budget_blocked", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_runs", "resume_state", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_usage_receipts", "amount_micros", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("collaboration_usage_receipts", "currency", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("collaboration_usage_receipts", "cost_source", "TEXT NOT NULL DEFAULT ''");
  }

  ensureColumn(table, column, declaration) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    }
  }

  createRun(input = {}) {
    const objective = safeText(input.objective, 16_000);
    if (!objective) throw new Error("objective is required");
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
          account_budget_blocked, resume_state, created_at, updated_at, finished_at
        ) VALUES (?, ?, 'plan_implement_verify', '1', ?, 'created', ?, ?, ?, ?, 0, '', ?, ?, NULL)
      `).run(
        runId, conversationId, objective, JSON.stringify(gates), JSON.stringify(budget),
        JSON.stringify({ sampled_tokens: 0, amount_micros: 0, currency: null, unpriced_events: 0 }),
        JSON.stringify({ plan_revisions: 0, rework_rounds: 0 }), createdAt, createdAt,
      );
      const insertAgent = this.db.prepare(`INSERT INTO collaboration_agents(agent_id, run_id, role, runtime, device_id, workspace_id, provider, model, permission_profile, responsibilities_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const role of [lead, worker, verifier].filter(Boolean)) {
        insertAgent.run(role.agent_id, runId, role.role, role.runtime, role.device_id, role.workspace_id, role.provider, role.model, role.permission_profile, JSON.stringify(role.responsibilities), createdAt, createdAt);
      }
      this.db.prepare(`INSERT INTO collaboration_tasks(task_id, run_id, title, summary, state, phase, created_at, updated_at) VALUES (?, ?, ?, '', 'pending', 'research', ?, ?)`)
        .run(taskId, runId, safeText(input.title, 256) || objective.slice(0, 256), createdAt, createdAt);
    })();
    return this.getRun(runId);
  }

  getRun(runId, { includeMessages = true } = {}) {
    const key = safeText(runId, 195);
    const run = publicRun(this.db.prepare("SELECT * FROM collaboration_runs WHERE run_id = ?").get(key));
    if (!run) return null;
    run.agents = Object.fromEntries(this.db.prepare("SELECT * FROM collaboration_agents WHERE run_id = ? ORDER BY role").all(key).map((row) => [row.role, {
      agent_id: row.agent_id, runtime: row.runtime, device_id: row.device_id,
      workspace_id: row.workspace_id || null, provider: row.provider || null,
      model: row.model || null, permission_profile: row.permission_profile || null,
      responsibilities: parseJson(row.responsibilities_json, []), status: row.status,
      native_session_id: row.native_session_id || null,
      originrouter_session_id: row.originrouter_session_id || null,
      conversation_id: row.conversation_id || null,
    }]));
    run.tasks = this.db.prepare("SELECT * FROM collaboration_tasks WHERE run_id = ? ORDER BY created_at").all(key).map((row) => ({
      task_id: row.task_id, parent_task_id: row.parent_task_id, assignee_agent_id: row.assignee_agent_id,
      title: row.title, summary: row.summary, state: row.state, phase: row.phase,
      created_at: row.created_at, updated_at: row.updated_at,
    }));
    run.task_ids = run.tasks.map((task) => task.task_id);
    run.artifacts = this.listArtifacts(key);
    if (includeMessages) run.messages = this.listMessages(key);
    return run;
  }

  listRuns({ limit = 50 } = {}) {
    return this.db.prepare("SELECT * FROM collaboration_runs ORDER BY updated_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(200, Number(limit) || 50))).map(publicRun);
  }

  listActiveRuns({ limit = 100 } = {}) {
    return this.db.prepare(`
      SELECT * FROM collaboration_runs
      WHERE state NOT IN ('completed', 'failed', 'cancelled', 'expired')
      ORDER BY updated_at ASC LIMIT ?
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
        updated_at = ?
      WHERE run_id = ? AND role = ?
    `).run(
      safeText(payload.status ?? current.status, 32) || "idle",
      safeText(payload.native_session_id ?? payload.nativeSessionId ?? current.native_session_id, 191),
      safeText(payload.originrouter_session_id ?? payload.originrouterSessionId ?? current.originrouter_session_id, 64),
      safeText(payload.conversation_id ?? payload.conversationId ?? current.conversation_id, 96),
      updatedAt,
      runId,
      role,
    );
    this.db.prepare("UPDATE collaboration_runs SET updated_at = ? WHERE run_id = ?")
      .run(updatedAt, runId);
    return this.getRun(runId, { includeMessages: false }).agents[role];
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
    if (!assignmentId || !runId || !taskId || !role || !sourceDeviceId || !targetDeviceId || !workspaceId) {
      throw new Error("invalid remote collaboration assignment");
    }
    if (!["claude", "codex"].includes(runtime)) throw new Error("invalid remote collaboration runtime");
    const now = iso(this.now());
    this.db.prepare(`
      INSERT INTO collaboration_remote_assignments(
        assignment_id, run_id, task_id, role, phase, source_device_id,
        target_device_id, runtime, workspace_id, provider, model,
        permission_profile, status, native_session_id, originrouter_session_id,
        conversation_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        phase = excluded.phase,
        runtime = excluded.runtime,
        workspace_id = excluded.workspace_id,
        provider = excluded.provider,
        model = excluded.model,
        permission_profile = excluded.permission_profile,
        updated_at = excluded.updated_at
    `).run(
      assignmentId, runId, taskId, role, safeText(input.phase, 64),
      sourceDeviceId, targetDeviceId, runtime, workspaceId,
      safeText(input.provider, 191), safeText(input.model, 191),
      safeText(input.permission_profile ?? input.permissionProfile, 64), now, now,
    );
    return this.getRemoteAssignment(assignmentId);
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

  getRemoteAssignment(assignmentId) {
    return this.db.prepare(
      "SELECT * FROM collaboration_remote_assignments WHERE assignment_id = ?",
    ).get(safeText(assignmentId, 195)) || null;
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
    this.db.prepare(`
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
    return this.db.prepare("SELECT * FROM collaboration_artifacts WHERE artifact_id = ?").get(artifactId);
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
      this.db.prepare("UPDATE collaboration_runs SET usage_json = ?, updated_at = ? WHERE run_id = ?")
        .run(JSON.stringify(usage), updatedAt, runId);
      if (exhausted && !["completed", "failed", "cancelled", "expired"].includes(run.state)) {
        const resumeState = run.state === "budget_exhausted"
          ? safeText(run.resume_state, 64)
          : run.state;
        this.db.prepare(`
          UPDATE collaboration_runs
          SET state = 'budget_exhausted',
              resume_state = CASE WHEN resume_state = '' THEN ? ELSE resume_state END
          WHERE run_id = ?
        `).run(resumeState, runId);
        this.db.prepare("UPDATE collaboration_tasks SET state = 'paused', updated_at = ? WHERE run_id = ?")
          .run(updatedAt, runId);
      }
    })();
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
        SET budget_json = ?, state = ?, resume_state = ?, updated_at = ?
        WHERE run_id = ?
      `).run(JSON.stringify(budget), nextState, nextResumeState, updatedAt, runId);
      if (taskBudgetExhausted && !terminal) {
        this.db.prepare("UPDATE collaboration_tasks SET state = 'paused', updated_at = ? WHERE run_id = ?")
          .run(updatedAt, runId);
      }
      if (restoredState) {
        this.db.prepare("UPDATE collaboration_tasks SET state = 'active', updated_at = ? WHERE run_id = ?")
          .run(updatedAt, runId);
      }
    })();
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
          SET state = 'budget_exhausted', account_budget_blocked = 1,
              resume_state = CASE WHEN resume_state = '' THEN ? ELSE resume_state END,
              updated_at = ?
          WHERE run_id = ?
        `).run(resumeState, updatedAt, runId);
        this.db.prepare("UPDATE collaboration_tasks SET state = 'paused', updated_at = ? WHERE run_id = ?")
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
            updated_at = ?
        WHERE run_id = ?
      `).run(restoredState, restoredState, updatedAt, runId);
      if (restoredState) {
        this.db.prepare("UPDATE collaboration_tasks SET state = 'active', updated_at = ? WHERE run_id = ?")
          .run(updatedAt, runId);
      }
    })();
    return {
      run: this.getRun(runId),
      changed: true,
      restored: Boolean(restoredState),
    };
  }

  pauseForAccountBudget(runId) {
    return this.setAccountBudgetBlocked(runId, true).run;
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

  transition(runId, nextState, { counter = null, taskState = null, taskPhase = null } = {}) {
    if (!RUN_STATES.has(nextState)) throw new Error("invalid collaboration state");
    const run = this.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const counters = { ...run.counters };
    if (counter) counters[counter] = Number(counters[counter] || 0) + 1;
    const finishedAt = ["completed", "failed", "cancelled", "expired"].includes(nextState) ? iso(this.now()) : null;
    const updatedAt = iso(this.now());
    this.db.transaction(() => {
      this.db.prepare("UPDATE collaboration_runs SET state = ?, counters_json = ?, updated_at = ?, finished_at = ? WHERE run_id = ?")
        .run(nextState, JSON.stringify(counters), updatedAt, finishedAt, runId);
      if (taskState || taskPhase) {
        this.db.prepare("UPDATE collaboration_tasks SET state = COALESCE(?, state), phase = COALESCE(?, phase), updated_at = ? WHERE run_id = ?")
          .run(taskState, taskPhase, updatedAt, runId);
      }
    })();
    return this.getRun(runId);
  }

  close() { if (this.db?.open) this.db.close(); }
}
