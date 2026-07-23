import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import Database from "better-sqlite3";

import { ensureStateDir } from "./state.js";

const SCHEMA_VERSION = 2;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function safeText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function iso(value = null) {
  const parsed = value == null ? new Date() : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function canonicalPath(value) {
  const path = safeText(value, 4096);
  if (!path) return "";
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function repositoryRoot(cwd) {
  let current = canonicalPath(cwd);
  if (!current) return "";
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function stableId(prefix, ...parts) {
  const hash = createHash("sha256")
    .update(parts.map((part) => safeText(part, 4096)).join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${hash}`;
}

function normalizeStatus(value, fallback = "running") {
  const status = safeText(value, 32).toLowerCase();
  return status || fallback;
}

function eventText(event) {
  return safeText(
    event?.text || event?.detail || event?.summary || event?.result || event?.reason,
    4096,
  );
}

function collectArtifactPaths(value, key = "", result = []) {
  if (result.length >= 64 || value == null) return result;
  if (Array.isArray(value)) {
    for (const child of value) collectArtifactPaths(child, key, result);
    return result;
  }
  if (typeof value !== "object") {
    if (/^(?:file_?path|path|target|destination)$/i.test(key)) {
      const path = safeText(value, 4096);
      if (path) result.push(path);
    }
    return result;
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectArtifactPaths(child, childKey, result);
  }
  return result;
}

function publicConversation(row) {
  if (!row) return null;
  return {
    conversation_id: row.conversation_id,
    agent_type: row.agent_type,
    native_session_id: row.native_session_id || "",
    title: row.title,
    summary: row.summary || "",
    first_prompt_preview: row.first_prompt_preview || "",
    last_message_preview: row.last_message_preview || "",
    transcript_available: Boolean(row.transcript_locator),
    workspace_id: row.workspace_id || "",
    workspace_name: row.workspace_name || "",
    workspace_path: row.workspace_path || "",
    repo_root: row.repo_root || "",
    device_id: row.device_id || "",
    runtime: row.runtime || "",
    provider: row.provider || "",
    model: row.model || "",
    permission_profile: row.permission_profile || "",
    status: row.status || "stopped",
    started_at: row.started_at || null,
    exited_at: row.exited_at || null,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
    archived_at: row.archived_at || null,
    artifact_count: Number(row.artifact_count || 0),
  };
}

export class AgentCatalog {
  constructor({ stateDir = ensureStateDir(), dbPath = null, now = () => new Date() } = {}) {
    this.stateDir = stateDir;
    this.dbPath = dbPath || join(stateDir, "agent-catalog.sqlite3");
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
      CREATE TABLE IF NOT EXISTS catalog_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_workspaces (
        workspace_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        repo_root TEXT NOT NULL DEFAULT '',
        trusted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(device_id, canonical_path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_conversations (
        conversation_id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        native_session_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        first_prompt_preview TEXT NOT NULL DEFAULT '',
        last_message_preview TEXT NOT NULL DEFAULT '',
        workspace_id TEXT,
        transcript_locator TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        archived_at TEXT,
        FOREIGN KEY(workspace_id) REFERENCES agent_workspaces(workspace_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        originrouter_session_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL DEFAULT '',
        runtime TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        permission_profile TEXT NOT NULL DEFAULT '',
        started_by TEXT NOT NULL DEFAULT '',
        pid INTEGER,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        exited_at TEXT,
        exit_code INTEGER,
        exit_signal TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(conversation_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_artifacts (
        artifact_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        locator TEXT NOT NULL,
        display_value TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(conversation_id),
        UNIQUE(conversation_id, kind, locator)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_launch_receipts (
        launch_id TEXT PRIMARY KEY,
        originrouter_session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        pid INTEGER,
        accepted INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_agent_conversations_activity
        ON agent_conversations(last_activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_conversations_native
        ON agent_conversations(agent_type, native_session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation
        ON agent_runs(conversation_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_device
        ON agent_runs(device_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_artifacts_conversation
        ON agent_artifacts(conversation_id, last_seen_at DESC);
    `);
    this.db.prepare(`
      INSERT INTO catalog_meta(key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
  }

  close() {
    if (this.db?.open) this.db.close();
  }

  getMeta(key) {
    const row = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = ?",
    ).get(safeText(key, 191));
    return row?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO catalog_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(safeText(key, 191), String(value ?? ""));
  }

  getLaunchReceipt(launchId) {
    const row = this.db.prepare(`
      SELECT launch_id, originrouter_session_id, conversation_id, run_id,
             agent_type, workspace_id, workspace_path, pid, accepted, created_at
      FROM agent_launch_receipts
      WHERE launch_id = ?
    `).get(safeText(launchId, 96));
    if (!row) return null;
    return {
      launchId: row.launch_id,
      sessionId: row.originrouter_session_id,
      conversationId: row.conversation_id,
      runId: row.run_id,
      agentType: row.agent_type,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      pid: row.pid == null ? null : Number(row.pid),
      accepted: Boolean(row.accepted),
      createdAt: row.created_at,
    };
  }

  recordLaunchReceipt(payload = {}) {
    const launchId = safeText(payload.launchId, 96);
    if (!launchId) throw new Error("launchId is required");
    this.db.prepare(`
      INSERT INTO agent_launch_receipts(
        launch_id, originrouter_session_id, conversation_id, run_id,
        agent_type, workspace_id, workspace_path, pid, accepted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(launch_id) DO NOTHING
    `).run(
      launchId,
      safeText(payload.sessionId, 64),
      safeText(payload.conversationId, 96),
      safeText(payload.runId, 96),
      safeText(payload.agentType, 32),
      safeText(payload.workspaceId, 96),
      canonicalPath(payload.workspacePath),
      Number.isFinite(Number(payload.pid)) ? Number(payload.pid) : null,
      payload.accepted === false ? 0 : 1,
      iso(payload.createdAt || this.now()),
    );
    return this.getLaunchReceipt(launchId);
  }

  migrateLegacySessions(records = []) {
    const marker = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = 'legacy_sessions_v1'",
    ).get();
    if (marker) return { migrated: 0, skipped: true };
    let migrated = 0;
    const migrate = this.db.transaction(() => {
      for (const record of Array.isArray(records) ? records : []) {
        const sessionId = safeText(record?.sessionId, 64);
        if (!sessionId) continue;
        this.upsertSession({
          sessionId,
          conversationId: sessionId,
          runId: sessionId,
          agent: record.agent || record.command || "unknown",
          title: record.title || `${record.agent || record.command || "Agent"} session`,
          deviceId: record.deviceId,
          cwd: record.cwd,
          pid: record.pid,
          runtime: record.runtime,
          startedBy: record.startedBy || "legacy-session-log",
          startedAt: record.startedAt,
          workspaceTrusted: true,
          status: record.status || (record.exitedAt ? "exited" : "stopped"),
          exitedAt: record.exitedAt,
          exitCode: record.code,
          exitSignal: record.signal,
        });
        migrated += 1;
      }
      this.db.prepare(
        "INSERT INTO catalog_meta(key, value) VALUES ('legacy_sessions_v1', ?)",
      ).run(JSON.stringify({ migrated, at: iso(this.now()) }));
    });
    migrate();
    return { migrated, skipped: false };
  }

  upsertSession(payload = {}) {
    const sessionId = safeText(payload.sessionId || payload.originrouterSessionId, 64);
    if (!sessionId) throw new Error("sessionId is required");
    const existingRun = this.db.prepare(
      "SELECT run_id, conversation_id FROM agent_runs WHERE originrouter_session_id = ?",
    ).get(sessionId);
    const conversationId = safeText(
      payload.conversationId || existingRun?.conversation_id || sessionId,
      96,
    );
    const requestedRunId = safeText(payload.runId || existingRun?.run_id || sessionId, 96);
    const requestedRunOwner = this.db.prepare(
      "SELECT originrouter_session_id FROM agent_runs WHERE run_id = ?",
    ).get(requestedRunId);
    const runId = requestedRunOwner
      && requestedRunOwner.originrouter_session_id !== sessionId
      ? stableId("agent_run", requestedRunId, sessionId)
      : requestedRunId;
    const agent = safeText(payload.agent || payload.agentType, 32) || "unknown";
    const title = safeText(payload.title, 256) || `${agent} session`;
    const deviceId = safeText(payload.deviceId, 191);
    const cwd = canonicalPath(payload.cwd);
    const workspaceId = cwd
      ? safeText(payload.workspaceId, 96) || stableId("workspace", deviceId, cwd)
      : null;
    const startedAt = iso(payload.startedAt || this.now());
    const activityAt = iso(payload.lastActivityAt || payload.updatedAt || startedAt);
    const status = normalizeStatus(payload.status, "running");

    const write = this.db.transaction(() => {
      if (workspaceId) {
        const repoRoot = repositoryRoot(cwd);
        this.db.prepare(`
          INSERT INTO agent_workspaces(
            workspace_id, device_id, display_name, canonical_path, repo_root,
            trusted, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET
            device_id = excluded.device_id,
            display_name = excluded.display_name,
            canonical_path = excluded.canonical_path,
            repo_root = excluded.repo_root,
            trusted = MAX(agent_workspaces.trusted, excluded.trusted),
            updated_at = excluded.updated_at
        `).run(
          workspaceId,
          deviceId,
          safeText(payload.workspaceName, 191) || basename(cwd) || cwd,
          cwd,
          repoRoot,
          payload.workspaceTrusted === true ? 1 : 0,
          startedAt,
          activityAt,
        );
      }

      this.db.prepare(`
        INSERT INTO agent_conversations(
          conversation_id, agent_type, native_session_id, title, summary,
          first_prompt_preview, last_message_preview, workspace_id,
          transcript_locator, created_at, last_activity_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          agent_type = CASE WHEN excluded.agent_type <> 'unknown' THEN excluded.agent_type ELSE agent_conversations.agent_type END,
          native_session_id = CASE WHEN excluded.native_session_id <> '' THEN excluded.native_session_id ELSE agent_conversations.native_session_id END,
          title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE agent_conversations.title END,
          summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE agent_conversations.summary END,
          first_prompt_preview = CASE WHEN excluded.first_prompt_preview <> '' THEN excluded.first_prompt_preview ELSE agent_conversations.first_prompt_preview END,
          last_message_preview = CASE WHEN excluded.last_message_preview <> '' THEN excluded.last_message_preview ELSE agent_conversations.last_message_preview END,
          workspace_id = COALESCE(excluded.workspace_id, agent_conversations.workspace_id),
          transcript_locator = CASE WHEN excluded.transcript_locator <> '' THEN excluded.transcript_locator ELSE agent_conversations.transcript_locator END,
          last_activity_at = excluded.last_activity_at,
          archived_at = COALESCE(excluded.archived_at, agent_conversations.archived_at)
      `).run(
        conversationId,
        agent,
        safeText(payload.nativeSessionId, 191),
        title,
        safeText(payload.summary, 4096),
        safeText(payload.firstPromptPreview, 1024),
        safeText(payload.lastMessagePreview, 1024),
        workspaceId,
        canonicalPath(payload.transcriptPath || payload.transcriptLocator),
        startedAt,
        activityAt,
        payload.archivedAt ? iso(payload.archivedAt) : null,
      );

      this.db.prepare(`
        INSERT INTO agent_runs(
          run_id, conversation_id, originrouter_session_id, device_id, runtime,
          provider, model, permission_profile, started_by, pid, status,
          started_at, exited_at, exit_code, exit_signal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(originrouter_session_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          device_id = CASE WHEN excluded.device_id <> '' THEN excluded.device_id ELSE agent_runs.device_id END,
          runtime = CASE WHEN excluded.runtime <> '' THEN excluded.runtime ELSE agent_runs.runtime END,
          provider = CASE WHEN excluded.provider <> '' THEN excluded.provider ELSE agent_runs.provider END,
          model = CASE WHEN excluded.model <> '' THEN excluded.model ELSE agent_runs.model END,
          permission_profile = CASE WHEN excluded.permission_profile <> '' THEN excluded.permission_profile ELSE agent_runs.permission_profile END,
          started_by = CASE WHEN excluded.started_by <> '' THEN excluded.started_by ELSE agent_runs.started_by END,
          pid = COALESCE(excluded.pid, agent_runs.pid),
          status = excluded.status,
          exited_at = COALESCE(excluded.exited_at, agent_runs.exited_at),
          exit_code = COALESCE(excluded.exit_code, agent_runs.exit_code),
          exit_signal = CASE WHEN excluded.exit_signal <> '' THEN excluded.exit_signal ELSE agent_runs.exit_signal END
      `).run(
        runId,
        conversationId,
        sessionId,
        deviceId,
        safeText(payload.runtime, 64),
        safeText(payload.provider, 191),
        safeText(payload.model, 191),
        safeText(payload.permissionProfile || payload.autonomyProfile, 64),
        safeText(payload.startedBy, 64),
        Number.isFinite(Number(payload.pid)) ? Number(payload.pid) : null,
        status,
        startedAt,
        payload.exitedAt ? iso(payload.exitedAt) : null,
        Number.isFinite(Number(payload.exitCode)) ? Number(payload.exitCode) : null,
        safeText(payload.exitSignal, 32),
      );
    });
    write();
    return this.getConversation(conversationId);
  }

  updateSession(sessionId, payload = {}) {
    const current = this.db.prepare(`
      SELECT r.*, c.agent_type, c.title, c.workspace_id,
             w.canonical_path AS cwd
      FROM agent_runs r
      JOIN agent_conversations c ON c.conversation_id = r.conversation_id
      LEFT JOIN agent_workspaces w ON w.workspace_id = c.workspace_id
      WHERE r.originrouter_session_id = ?
    `).get(safeText(sessionId, 64));
    return this.upsertSession({
      sessionId,
      conversationId: current?.conversation_id,
      runId: current?.run_id,
      agent: current?.agent_type,
      title: current?.title,
      cwd: payload.cwd || current?.cwd,
      deviceId: payload.deviceId || current?.device_id,
      runtime: payload.runtime || current?.runtime,
      provider: payload.provider || current?.provider,
      model: payload.model || current?.model,
      permissionProfile: payload.permissionProfile || current?.permission_profile,
      startedBy: payload.startedBy || current?.started_by,
      startedAt: current?.started_at,
      pid: payload.pid ?? current?.pid,
      status: payload.status || current?.status,
      nativeSessionId: payload.nativeSessionId,
      transcriptPath: payload.transcriptPath,
      summary: payload.summary,
      firstPromptPreview: payload.firstPromptPreview,
      lastMessagePreview: payload.lastMessagePreview,
      lastActivityAt: payload.lastActivityAt || this.now(),
      exitedAt: payload.exitedAt,
      exitCode: payload.exitCode,
      exitSignal: payload.exitSignal,
    });
  }

  finishSession(sessionId, payload = {}) {
    const id = safeText(sessionId, 64);
    const endedAt = iso(payload.exitedAt || this.now());
    this.db.prepare(`
      UPDATE agent_runs SET
        status = ?, exited_at = ?, exit_code = COALESCE(?, exit_code),
        exit_signal = CASE WHEN ? <> '' THEN ? ELSE exit_signal END
      WHERE originrouter_session_id = ?
    `).run(
      normalizeStatus(payload.status, "stopped"),
      endedAt,
      Number.isFinite(Number(payload.exitCode)) ? Number(payload.exitCode) : null,
      safeText(payload.exitSignal, 32),
      safeText(payload.exitSignal, 32),
      id,
    );
    this.db.prepare(`
      UPDATE agent_conversations SET last_activity_at = ?
      WHERE conversation_id = (
        SELECT conversation_id FROM agent_runs WHERE originrouter_session_id = ?
      )
    `).run(endedAt, id);
  }

  recordEvent(sessionId, event = {}) {
    const run = this.db.prepare(
      "SELECT conversation_id FROM agent_runs WHERE originrouter_session_id = ?",
    ).get(safeText(sessionId, 64));
    if (!run) return false;
    const conversationId = run.conversation_id;
    const createdAt = iso(event.createdAt || this.now());
    const rawType = safeText(event.type || event.eventType, 96);
    const type = rawType === "agent.task.completed"
      ? "agent.task.complete"
      : rawType;
    let text = eventText(event);
    const updates = [];
    const values = [];
    if (type === "user.text" && text) {
      updates.push("first_prompt_preview = CASE WHEN first_prompt_preview = '' THEN ? ELSE first_prompt_preview END");
      values.push(text.slice(0, 1024));
      updates.push("last_message_preview = ?");
      values.push(text.slice(0, 1024));
    } else if (type === "agent.text" && text) {
      updates.push("last_message_preview = ?");
      values.push(text.slice(0, 1024));
    } else if (["agent.task.started", "agent.task.complete"].includes(type)) {
      if (
        type === "agent.task.complete"
        && (!text || /^(?:complete|completed|done|success)$/i.test(text))
      ) {
        const current = this.db.prepare(
          "SELECT last_message_preview FROM agent_conversations WHERE conversation_id = ?",
        ).get(conversationId);
        text = safeText(current?.last_message_preview, 4096);
      }
      if (text) {
        updates.push("summary = ?");
        values.push(text.slice(0, 4096));
      }
    }
    if (type === "agent.session_id" && event.sessionId) {
      updates.push("native_session_id = ?");
      values.push(safeText(event.sessionId, 191));
    }
    if (type === "agent.session.start" && event.transcriptPath) {
      updates.push("transcript_locator = ?");
      values.push(canonicalPath(event.transcriptPath));
    }
    updates.push("last_activity_at = ?");
    values.push(createdAt, conversationId);
    this.db.prepare(
      `UPDATE agent_conversations SET ${updates.join(", ")} WHERE conversation_id = ?`,
    ).run(...values);

    const workspace = this.db.prepare(`
      SELECT w.canonical_path FROM agent_conversations c
      LEFT JOIN agent_workspaces w ON w.workspace_id = c.workspace_id
      WHERE c.conversation_id = ?
    `).get(conversationId);
    const paths = collectArtifactPaths(event.input || event.payload || event.detail || {});
    const upsertArtifact = this.db.prepare(`
      INSERT INTO agent_artifacts(
        artifact_id, conversation_id, kind, locator, display_value,
        first_seen_at, last_seen_at
      ) VALUES (?, ?, 'file', ?, ?, ?, ?)
      ON CONFLICT(conversation_id, kind, locator) DO UPDATE SET
        display_value = excluded.display_value,
        last_seen_at = excluded.last_seen_at
    `);
    for (const candidate of new Set(paths)) {
      const locator = candidate.startsWith("/")
        ? canonicalPath(candidate)
        : canonicalPath(join(workspace?.canonical_path || process.cwd(), candidate));
      if (!locator) continue;
      upsertArtifact.run(
        `artifact_${randomUUID()}`,
        conversationId,
        locator,
        candidate,
        createdAt,
        createdAt,
      );
    }
    return true;
  }

  listConversations({ search = "", agent = "", deviceId = "", workspaceId = "", status = "", limit = DEFAULT_LIMIT, offset = 0, includeArchived = false } = {}) {
    const clauses = [];
    const params = {};
    if (!includeArchived) clauses.push("c.archived_at IS NULL");
    if (safeText(agent, 32)) {
      clauses.push("c.agent_type = @agent");
      params.agent = safeText(agent, 32);
    }
    if (safeText(deviceId, 191)) {
      clauses.push("r.device_id = @deviceId");
      params.deviceId = safeText(deviceId, 191);
    }
    if (safeText(workspaceId, 96)) {
      clauses.push("c.workspace_id = @workspaceId");
      params.workspaceId = safeText(workspaceId, 96);
    }
    if (safeText(status, 32)) {
      clauses.push("r.status = @status");
      params.status = safeText(status, 32);
    }
    const query = safeText(search, 256);
    if (query) {
      clauses.push(`(
        c.title LIKE @search ESCAPE '\\'
        OR c.summary LIKE @search ESCAPE '\\'
        OR c.first_prompt_preview LIKE @search ESCAPE '\\'
        OR c.last_message_preview LIKE @search ESCAPE '\\'
        OR w.display_name LIKE @search ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM agent_artifacts a
          WHERE a.conversation_id = c.conversation_id
            AND a.display_value LIKE @search ESCAPE '\\'
        )
      )`);
      params.search = `%${query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
    }
    params.limit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
    params.offset = Math.max(0, Number(offset) || 0);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT c.*, w.display_name AS workspace_name,
             w.canonical_path AS workspace_path, w.repo_root,
             r.device_id, r.runtime, r.provider, r.model,
             r.permission_profile, r.status, r.started_at, r.exited_at,
             (SELECT COUNT(*) FROM agent_artifacts a
              WHERE a.conversation_id = c.conversation_id) AS artifact_count
      FROM agent_conversations c
      LEFT JOIN agent_workspaces w ON w.workspace_id = c.workspace_id
      LEFT JOIN agent_runs r ON r.run_id = (
        SELECT r2.run_id FROM agent_runs r2
        WHERE r2.conversation_id = c.conversation_id
        ORDER BY r2.started_at DESC, r2.rowid DESC LIMIT 1
      )
      ${where}
      ORDER BY c.last_activity_at DESC
      LIMIT @limit OFFSET @offset
    `).all(params);
    return rows.map(publicConversation);
  }

  getConversation(conversationId) {
    const id = safeText(conversationId, 96);
    const conversation = this.listConversations({ limit: MAX_LIMIT, includeArchived: true })
      .find((item) => item.conversation_id === id);
    if (!conversation) return null;
    return {
      ...conversation,
      runs: this.db.prepare(`
        SELECT run_id, originrouter_session_id, device_id, runtime, provider,
               model, permission_profile, started_by, pid, status, started_at,
               exited_at, exit_code, exit_signal
        FROM agent_runs WHERE conversation_id = ?
        ORDER BY started_at DESC, rowid DESC
      `).all(id),
      artifacts: this.db.prepare(`
        SELECT artifact_id, kind, locator, display_value,
               first_seen_at, last_seen_at
        FROM agent_artifacts WHERE conversation_id = ?
        ORDER BY last_seen_at DESC
      `).all(id),
    };
  }

  listWorkspaces({ search = "", deviceId = "", limit = DEFAULT_LIMIT } = {}) {
    const clauses = [];
    const params = {
      limit: Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT)),
    };
    if (safeText(deviceId, 191)) {
      clauses.push("w.device_id = @deviceId");
      params.deviceId = safeText(deviceId, 191);
    }
    if (safeText(search, 256)) {
      clauses.push("(w.display_name LIKE @search OR w.canonical_path LIKE @search)");
      params.search = `%${safeText(search, 256)}%`;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT w.workspace_id, w.device_id, w.display_name, w.canonical_path,
             w.repo_root, w.trusted, w.created_at, w.updated_at,
             COUNT(c.conversation_id) AS conversation_count,
             MAX(c.last_activity_at) AS last_activity_at
      FROM agent_workspaces w
      LEFT JOIN agent_conversations c ON c.workspace_id = w.workspace_id
      ${where}
      GROUP BY w.workspace_id
      ORDER BY last_activity_at DESC, w.updated_at DESC
      LIMIT @limit
    `).all(params).map((row) => ({ ...row, trusted: Boolean(row.trusted) }));
  }

  getWorkspace(reference, { deviceId = "" } = {}) {
    const value = safeText(reference, 4096);
    if (!value) return null;
    const canonical = canonicalPath(value);
    const clauses = ["(workspace_id = @reference OR canonical_path = @canonical)"];
    const params = { reference: value, canonical };
    if (safeText(deviceId, 191)) {
      clauses.push("device_id = @deviceId");
      params.deviceId = safeText(deviceId, 191);
    }
    const row = this.db.prepare(`
      SELECT workspace_id, device_id, display_name, canonical_path,
             repo_root, trusted, created_at, updated_at
      FROM agent_workspaces
      WHERE ${clauses.join(" AND ")}
      LIMIT 1
    `).get(params);
    return row ? { ...row, trusted: Boolean(row.trusted) } : null;
  }

  status() {
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_conversations) AS conversations,
        (SELECT COUNT(*) FROM agent_runs) AS runs,
        (SELECT COUNT(*) FROM agent_workspaces) AS workspaces,
        (SELECT COUNT(*) FROM agent_artifacts) AS artifacts
    `).get();
    return {
      schema_version: SCHEMA_VERSION,
      db_path: this.dbPath,
      ...counts,
    };
  }
}
