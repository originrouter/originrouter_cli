import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

import Database from "better-sqlite3";

import { ensureStateDir } from "./state.js";
import { activeAccountStateDir } from "./accounts.js";
import {
  defaultConversationTitle,
  looksLikePlaceholderTitle,
} from "../agent/agentTitleSource.js";
import { isCollaborationSessionPayload } from "../runtime/agentSessionKind.js";
import {
  preflightUnattendedWorkspaceAuthorization,
  requireUnattendedWorkspace,
} from "../runtime/unattendedWorkspaceReadiness.js";
import {
  assertTrustableWorkspacePath,
  canonicalPath,
  collectArtifactPaths,
  eventText,
  iso,
  isWithinPath,
  normalizeStatus,
  publicConversation,
  repositoryRoot,
  safeText,
  stableId,
  workspaceTrustError,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SCHEMA_VERSION,
} from "./agentCatalogPrimitives.js";

export { workspaceDisplayPath } from "./agentCatalogPrimitives.js";

export class AgentCatalog {
  constructor({ stateDir = ensureStateDir(), dbPath = null, now = () => new Date() } = {}) {
    this.stateDir = activeAccountStateDir(stateDir);
    this.dbPath = dbPath || join(this.stateDir, "agent-catalog.sqlite3");
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

      CREATE TABLE IF NOT EXISTS agent_catalog_insert_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_catalog_preview_queue (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        field TEXT NOT NULL,
        previous_value TEXT NOT NULL,
        next_value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_workspaces (
        workspace_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        repo_root TEXT NOT NULL DEFAULT '',
        trusted INTEGER NOT NULL DEFAULT 0,
        unattended_authorized_at TEXT NOT NULL DEFAULT '',
        unattended_authorization_subject TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(device_id, canonical_path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_conversations (
        conversation_id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL,
        native_session_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        title_is_custom INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        first_prompt_preview TEXT NOT NULL DEFAULT '',
        last_message_preview TEXT NOT NULL DEFAULT '',
        workspace_id TEXT,
        transcript_locator TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        archived_at TEXT,
        restored_at TEXT,
        permission_state_json TEXT,
        FOREIGN KEY(workspace_id) REFERENCES agent_workspaces(workspace_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        originrouter_session_id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL DEFAULT '',
        device_name TEXT NOT NULL DEFAULT '',
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
      CREATE INDEX IF NOT EXISTS idx_agent_catalog_preview_conversation
        ON agent_catalog_preview_queue(conversation_id, sequence);

      CREATE TRIGGER IF NOT EXISTS agent_catalog_queue_new_conversation
      AFTER INSERT ON agent_conversations BEGIN
        INSERT INTO agent_catalog_insert_queue(conversation_id) VALUES (NEW.conversation_id);
      END;

      CREATE TRIGGER IF NOT EXISTS agent_catalog_queue_summary
      AFTER UPDATE OF summary ON agent_conversations
      WHEN OLD.summary IS NOT NEW.summary BEGIN
        INSERT INTO agent_catalog_preview_queue(conversation_id, field, previous_value, next_value)
        VALUES (NEW.conversation_id, 'summary', OLD.summary, NEW.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_catalog_queue_first_prompt
      AFTER UPDATE OF first_prompt_preview ON agent_conversations
      WHEN OLD.first_prompt_preview IS NOT NEW.first_prompt_preview BEGIN
        INSERT INTO agent_catalog_preview_queue(conversation_id, field, previous_value, next_value)
        VALUES (NEW.conversation_id, 'first_prompt_preview', OLD.first_prompt_preview, NEW.first_prompt_preview);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_catalog_queue_last_message
      AFTER UPDATE OF last_message_preview ON agent_conversations
      WHEN OLD.last_message_preview IS NOT NEW.last_message_preview BEGIN
        INSERT INTO agent_catalog_preview_queue(conversation_id, field, previous_value, next_value)
        VALUES (NEW.conversation_id, 'last_message_preview', OLD.last_message_preview, NEW.last_message_preview);
      END;
    `);
    const conversationColumns = new Set(
      this.db.prepare("PRAGMA table_info(agent_conversations)").all()
        .map((column) => column.name),
    );
    if (!conversationColumns.has("restored_at")) {
      this.db.exec("ALTER TABLE agent_conversations ADD COLUMN restored_at TEXT");
    }
    if (!conversationColumns.has("title_is_custom")) {
      this.db.exec("ALTER TABLE agent_conversations ADD COLUMN title_is_custom INTEGER NOT NULL DEFAULT 0");
    }
    if (!conversationColumns.has("permission_state_json")) {
      this.db.exec("ALTER TABLE agent_conversations ADD COLUMN permission_state_json TEXT");
    }
    const workspaceColumns = new Set(
      this.db.prepare("PRAGMA table_info(agent_workspaces)").all()
        .map((column) => column.name),
    );
    if (!workspaceColumns.has("unattended_authorized_at")) {
      this.db.exec("ALTER TABLE agent_workspaces ADD COLUMN unattended_authorized_at TEXT NOT NULL DEFAULT ''");
    }
    if (!workspaceColumns.has("unattended_authorization_subject")) {
      this.db.exec("ALTER TABLE agent_workspaces ADD COLUMN unattended_authorization_subject TEXT NOT NULL DEFAULT ''");
    }
    const runColumns = new Set(
      this.db.prepare("PRAGMA table_info(agent_runs)").all()
        .map((column) => column.name),
    );
    if (!runColumns.has('native_config')) this.db.exec('ALTER TABLE agent_runs ADD COLUMN native_config INTEGER NOT NULL DEFAULT 0');
    if (!runColumns.has("device_name")) {
      // Local history only stored `device_id`, so a directly connected App had
      // no device to show next to the workspace path even though the CLI knows
      // its own name and already reports it to the bridge.
      this.db.exec("ALTER TABLE agent_runs ADD COLUMN device_name TEXT NOT NULL DEFAULT ''");
    }
    this.db.prepare(`
      INSERT INTO catalog_meta(key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(SCHEMA_VERSION));
    this.repairDuplicateConversations();
    this.ensureProviderConversationIndex();
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

  listPendingCatalogInserts(limit = 50) {
    return this.db.prepare(`
      SELECT sequence, conversation_id FROM agent_catalog_insert_queue
      ORDER BY sequence LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  acknowledgeCatalogInsert(sequence) {
    this.db.prepare("DELETE FROM agent_catalog_insert_queue WHERE sequence = ?").run(sequence);
  }

  listPendingCatalogPreviews(limit = 50, after = 0) {
    return this.db.prepare(`
      SELECT q.sequence, q.conversation_id, q.field, q.previous_value, q.next_value
      FROM agent_catalog_preview_queue q
      WHERE q.sequence > ? AND NOT EXISTS (
        SELECT 1 FROM agent_catalog_preview_queue earlier
        WHERE earlier.conversation_id = q.conversation_id AND earlier.sequence < q.sequence
      )
      ORDER BY q.sequence LIMIT ?
    `).all(Math.max(0, Number(after) || 0), Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  acknowledgeCatalogPreview(sequence) {
    this.db.prepare("DELETE FROM agent_catalog_preview_queue WHERE sequence = ?").run(sequence);
  }

  readCatalogSnapshot(read) {
    return this.db.transaction(read).deferred();
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

  /// Fill in `device_name` for runs recorded before the column existed.
  ///
  /// Only rows belonging to `deviceId` are touched: this device is the one
  /// whose name we can actually resolve, and stamping it onto a run that
  /// happened on another machine would be worse than leaving it blank. Runs
  /// from other devices keep an empty name until that device reports again.
  backfillDeviceName({ deviceId, deviceName } = {}) {
    const id = safeText(deviceId, 191);
    const name = safeText(deviceName, 191);
    if (!id || !name) return { updated: 0, skipped: true };
    const result = this.db.prepare(`
      UPDATE agent_runs SET device_name = @name
      WHERE device_id = @id AND device_name = ''
    `).run({ id, name });
    return { updated: result.changes || 0, skipped: false };
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

  // The conversation a provider id names.
  //
  // The provider's own id for a conversation is the one fact that survives
  // every attempt at it. Our own conversation id is minted per launch, so a
  // resumed conversation used to get a row of its own for every attempt at
  // it — and the App's rail showed the same conversation once per attempt.
  //
  // The row that answers is the one that was last active: it is the
  // conversation the reader was last in. A tie goes to the smallest id, so
  // the answer never depends on the order the rows happen to come back in —
  // the index on `(agent_type, native_session_id)` has no order of its own.
  //
  // The server and the fold in `sql/054` pick the same row with the same
  // rule. If the three ever disagreed, the device would report the
  // conversation the fold had just removed, and the duplicate would be back.
  conversationIdForNativeSession(agentType, nativeSessionId) {
    const agent = safeText(agentType, 32);
    const native = safeText(nativeSessionId, 191);
    if (!agent || !native) return "";
    const row = this.db.prepare(`
      SELECT conversation_id FROM agent_conversations
      WHERE agent_type = ? AND native_session_id = ?
      ORDER BY last_activity_at DESC, conversation_id ASC
      LIMIT 1
    `).get(agent, native);
    return row?.conversation_id || "";
  }

  // Every row that names the same provider conversation is the same
  // conversation.
  //
  // The survivor is the row that was last active; the others are folded into
  // it. Their runs move across, their artifacts move with them, and their
  // fields are merged: a name somebody chose is never lost to an automatic
  // one, a placeholder never displaces a real name, and the conversation
  // keeps the oldest start and the latest activity.
  //
  // The tie-break is the smallest id, the same rule the server and the fold
  // in `sql/054` use. The three have to agree: the device reports the
  // survivor's conversation id to the server, and a different row would
  // undo the fold.
  //
  // Returns the survivor, or nothing when the conversation is not here.
  mergeConversationsForNativeSession(agentType, nativeSessionId) {
    const agent = safeText(agentType, 32);
    const native = safeText(nativeSessionId, 191);
    if (!agent || !native) return null;
    const rows = this.db.prepare(`
      SELECT * FROM agent_conversations
      WHERE agent_type = ? AND native_session_id = ?
      ORDER BY last_activity_at DESC, conversation_id ASC
    `).all(agent, native);
    if (!rows.length) return null;
    const survivor = rows[0];
    if (rows.length === 1) return survivor;
    const merge = this.db.transaction(() => {
      for (const loser of rows.slice(1)) {
        this._foldConversationInto(survivor, loser);
      }
    });
    merge();
    return this.db.prepare(
      "SELECT * FROM agent_conversations WHERE conversation_id = ?",
    ).get(survivor.conversation_id);
  }

  // Fold one conversation row into another.
  //
  // The survivor is read back from the table rather than taken from the
  // caller: the fold runs once per loser, and the row the caller holds is the
  // one from before the first fold. Judging every loser against that stale
  // copy lost a name — a real name that one loser contributed was wiped by
  // the next loser, whose placeholder was read against the stale copy as
  // "nothing better than what the survivor had".
  _foldConversationInto(survivor, loser) {
    const survivorId = survivor.conversation_id;
    const loserId = loser.conversation_id;
    const held = this.db.prepare(
      "SELECT * FROM agent_conversations WHERE conversation_id = ?",
    ).get(survivorId) || survivor;
    // The runs and the artifacts belong to the conversation, not to the row
    // that happened to write them down.
    this.db.prepare("UPDATE agent_runs SET conversation_id = ? WHERE conversation_id = ?")
      .run(survivorId, loserId);
    this.db.prepare("UPDATE agent_launch_receipts SET conversation_id = ? WHERE conversation_id = ?")
      .run(survivorId, loserId);
    this.db.prepare("UPDATE agent_catalog_insert_queue SET conversation_id = ? WHERE conversation_id = ?")
      .run(survivorId, loserId);
    this.db.prepare("UPDATE agent_catalog_preview_queue SET conversation_id = ? WHERE conversation_id = ?")
      .run(survivorId, loserId);
    // The artifacts move with the conversation, and they are moved rather
    // than copied: the artifact id is the primary key, so copying a row
    // while the original is still on the table is a constraint violation —
    // and the fold is the one place that cannot afford to fail, because it
    // is what keeps one conversation in one row.
    //
    // A survivor that already holds the same artifact — the same kind of
    // thing at the same place — keeps its own row and takes the earlier
    // sighting and the later sighting of the two.
    for (const artifact of this.db.prepare(
      "SELECT * FROM agent_artifacts WHERE conversation_id = ?",
    ).all(loserId)) {
      const twin = this.db.prepare(`
        SELECT artifact_id FROM agent_artifacts
        WHERE conversation_id = ? AND kind = ? AND locator = ?
      `).get(survivorId, artifact.kind, artifact.locator);
      if (twin) {
        this.db.prepare(`
          UPDATE agent_artifacts SET
            display_value = ?,
            first_seen_at = MIN(first_seen_at, ?),
            last_seen_at = MAX(last_seen_at, ?)
          WHERE artifact_id = ?
        `).run(
          artifact.display_value, artifact.first_seen_at, artifact.last_seen_at,
          twin.artifact_id,
        );
        this.db.prepare("DELETE FROM agent_artifacts WHERE artifact_id = ?")
          .run(artifact.artifact_id);
        continue;
      }
      this.db.prepare(
        "UPDATE agent_artifacts SET conversation_id = ? WHERE artifact_id = ?",
      ).run(survivorId, artifact.artifact_id);
    }
    // The name. A name somebody chose is never lost; a placeholder never
    // displaces a real name; between two real names the newer row wins,
    // because that is the conversation the reader was last in.
    const survivorCustom = Boolean(held.title_is_custom);
    const loserCustom = Boolean(loser.title_is_custom);
    const survivorIsPlaceholder = looksLikePlaceholderTitle(held.title, held.agent_type);
    const loserIsPlaceholder = looksLikePlaceholderTitle(loser.title, loser.agent_type);
    let title = held.title || loser.title;
    let titleIsCustom = survivorCustom;
    if (loserCustom && !survivorCustom) {
      title = loser.title;
      titleIsCustom = true;
    } else if (!survivorCustom && survivorIsPlaceholder && !loserIsPlaceholder) {
      title = loser.title;
    }
    this.db.prepare(`
      UPDATE agent_conversations SET
        title = ?, title_is_custom = ?,
        summary = CASE WHEN summary = '' THEN ? ELSE summary END,
        first_prompt_preview = CASE WHEN first_prompt_preview = '' THEN ? ELSE first_prompt_preview END,
        last_message_preview = CASE WHEN last_message_preview = '' THEN ? ELSE last_message_preview END,
        workspace_id = COALESCE(workspace_id, ?),
        transcript_locator = CASE WHEN transcript_locator = '' THEN ? ELSE transcript_locator END,
        permission_state_json = COALESCE(permission_state_json, ?),
        created_at = MIN(created_at, ?),
        last_activity_at = MAX(last_activity_at, ?),
        archived_at = COALESCE(archived_at, ?)
      WHERE conversation_id = ?
    `).run(
      title, titleIsCustom ? 1 : 0,
      loser.summary, loser.first_prompt_preview, loser.last_message_preview,
      loser.workspace_id, loser.transcript_locator, loser.permission_state_json,
      loser.created_at, loser.last_activity_at, loser.archived_at,
      survivorId,
    );
    this.db.prepare("DELETE FROM agent_conversations WHERE conversation_id = ?").run(loserId);
  }

  // The provider's id belongs to the row that holds it.
  //
  // Another row that already holds it means this conversation is that
  // conversation: the fold is what the catalog does everywhere else, and the
  // unique index over (agent, provider id) says the same thing in the
  // database. A write that broke it would throw where the conversation was
  // only being recorded.
  //
  // The fold keeps the row that was last active; a tie goes to the smallest
  // id. That is the rule the server and `sql/054` use, and the three have
  // to agree: the device reports the survivor's id, and a different row
  // would undo the fold.
  //
  // Returns the id of the row that holds the conversation afterwards, and
  // whether that row already holds the provider's id.
  foldIntoNativeSessionHolder(conversationId, nativeSessionId) {
    const id = safeText(conversationId, 96);
    const native = safeText(nativeSessionId, 191);
    if (!id || !native) return { conversationId: id, holdsNativeId: false };
    const mine = this.db.prepare(
      "SELECT * FROM agent_conversations WHERE conversation_id = ?",
    ).get(id);
    if (!mine) return { conversationId: id, holdsNativeId: false };
    const holder = this.db.prepare(`
      SELECT * FROM agent_conversations
      WHERE agent_type = ? AND native_session_id = ? AND conversation_id <> ?
      ORDER BY last_activity_at DESC, conversation_id ASC
      LIMIT 1
    `).get(mine.agent_type, native, id);
    if (!holder) return { conversationId: id, holdsNativeId: false };
    // The survivor is the row that was last active; a tie goes to the
    // smallest id. The order is the one the fold itself uses.
    const ordered = this.db.prepare(`
      SELECT * FROM agent_conversations
      WHERE conversation_id IN (?, ?)
      ORDER BY last_activity_at DESC, conversation_id ASC
    `).all(id, holder.conversation_id);
    const survivor = ordered[0];
    const loser = ordered[1];
    const fold = this.db.transaction(() => {
      this._foldConversationInto(survivor, loser);
    });
    fold();
    return {
      conversationId: survivor.conversation_id,
      holdsNativeId: survivor.conversation_id === holder.conversation_id,
    };
  }

  // A row that named one attempt at a conversation, and the attempt turned
  // out to belong to a conversation that already has a row of its own.
  // Nothing points at it any more, so it goes — a row nobody can reach is
  // a conversation that never existed.
  dropEmptyConversation(conversationId) {
    const id = safeText(conversationId, 96);
    if (!id) return false;
    const runs = this.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_runs WHERE conversation_id = ?",
    ).get(id)?.count || 0;
    if (runs > 0) return false;
    const artifacts = this.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_artifacts WHERE conversation_id = ?",
    ).get(id)?.count || 0;
    if (artifacts > 0) return false;
    this.db.prepare("DELETE FROM agent_catalog_insert_queue WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM agent_catalog_preview_queue WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM agent_launch_receipts WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM agent_conversations WHERE conversation_id = ?").run(id);
    return true;
  }

  // The rows written before the provider's id was used to identify a
  // conversation: one row per attempt at the same conversation. They are one
  // conversation, and the repair folds them into one row.
  //
  // It runs once. The marker in `catalog_meta` says it has been done, so the
  // catalog does not pay for it again.
  //
  // The marker must not lie. A fold that fails leaves the duplicates exactly
  // where they were, and a marker that says "done" would keep them there for
  // good — the one failure nobody is told about is the one that cannot be
  // repaired later. So a group that fails is reported, the marker is written
  // only when every group folded, and a catalog that could not finish tries
  // again the next time it opens.
  repairDuplicateConversations() {
    const markerKey = "conversation_native_merge_v2";
    const marker = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = ?",
    ).get(markerKey);
    if (marker) return { merged: 0, skipped: true };
    let merged = 0;
    const failures = [];
    const groups = this.db.prepare(`
      SELECT agent_type, native_session_id FROM agent_conversations
      WHERE native_session_id <> ''
      GROUP BY agent_type, native_session_id
      HAVING COUNT(*) > 1
    `).all();
    for (const group of groups) {
      try {
        const survivor = this.mergeConversationsForNativeSession(
          group.agent_type, group.native_session_id,
        );
        if (survivor) merged += 1;
      } catch (error) {
        failures.push(
          `${group.agent_type}:${group.native_session_id}: ${error?.message || error}`,
        );
      }
    }
    if (failures.length) {
      // No marker: the next open tries again.
      console.error(
        `[agent-catalog] the duplicate repair did not finish `
        + `(${failures.length} of ${groups.length}): ${failures.join("; ")}`,
      );
      return { merged, failed: failures.length, skipped: false };
    }
    this.setMeta(markerKey, JSON.stringify({ merged, at: iso(this.now()) }));
    // The first version of this marker was written even when the fold had
    // failed, so it said "done" over rows that were still there. It goes
    // now that the truth is on record.
    this.db.prepare(
      "DELETE FROM catalog_meta WHERE key = 'conversation_native_merge_v1'",
    ).run();
    return { merged, failed: 0, skipped: false };
  }

  // The database's own word for the rule the code keeps: one provider
  // conversation is one row.
  //
  // The index cannot be made while two rows hold the same provider
  // conversation, so the fold runs first — the same fold the repair does.
  // A fold that fails is reported and the index is left for the next open:
  // a rule the database cannot state yet is not a reason to stop working.
  //
  // The index is partial. A row with no provider id is not part of the
  // rule — a conversation the provider has not named yet is its own
  // conversation — and a partial index is what says so: SQLite compares no
  // two rows that are not in it.
  ensureProviderConversationIndex() {
    // The rule is already in the database. There is nothing left to do, and
    // nothing left that can break: the index is what says a second row for
    // one provider conversation cannot be written at all.
    const existing = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_agent_conversations_provider'
    `).get();
    if (existing) return true;
    const groups = this.db.prepare(`
      SELECT agent_type, native_session_id FROM agent_conversations
      WHERE native_session_id <> ''
      GROUP BY agent_type, native_session_id
      HAVING COUNT(*) > 1
    `).all();
    const failures = [];
    for (const group of groups) {
      try {
        this.mergeConversationsForNativeSession(
          group.agent_type, group.native_session_id,
        );
      } catch (error) {
        failures.push(
          `${group.agent_type}:${group.native_session_id}: ${error?.message || error}`,
        );
      }
    }
    if (failures.length) {
      console.error(
        `[agent-catalog] the provider index was not made `
        + `(${failures.length} of ${groups.length}): ${failures.join("; ")}`,
      );
      return false;
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_conversations_provider
        ON agent_conversations(agent_type, native_session_id)
        WHERE native_session_id <> ''
    `);
    return true;
  }

  upsertSession(payload = {}) {
    const sessionId = safeText(payload.sessionId || payload.originrouterSessionId, 64);
    if (!sessionId) throw new Error("sessionId is required");
    const existingRun = this.db.prepare(
      "SELECT run_id, conversation_id, started_by FROM agent_runs WHERE originrouter_session_id = ?",
    ).get(sessionId);
    const agent = safeText(payload.agent || payload.agentType, 32) || "unknown";
    // A conversation is identified by the provider's own id for it, and a
    // run is one attempt at that conversation. Resuming a conversation is
    // therefore a second run of the first one — not a second conversation.
    //
    // Without this lookup every resume minted a new conversation row, so the
    // same conversation appeared in the App's rail once per attempt. The
    // index on `(agent_type, native_session_id)` has been here all along;
    // nothing ever asked the question it was built for.
    const nativeSessionId = safeText(payload.nativeSessionId, 191);
    // The label this attempt was launched under. It is the label of the
    // attempt, not the identity of the conversation.
    const requestedConversationId = safeText(
      payload.conversationId || existingRun?.conversation_id || sessionId,
      96,
    );
    // The row the label names, when it is here.
    const labelled = this.db.prepare(
      "SELECT conversation_id, agent_type, native_session_id FROM agent_conversations WHERE conversation_id = ?",
    ).get(requestedConversationId);
    // The agent the conversation is under: what the report says, or what the
    // row already has when the report says nothing. The provider's id is
    // scoped to an agent, so the row that holds the conversation is the one
    // under this agent — and the unique index over (agent, provider id) is
    // what says that in the database.
    const effectiveAgent = agent !== "unknown"
      ? agent
      : (labelled?.agent_type || "unknown");
    // The provider's id the conversation will hold: the report's own, or the
    // one the row already holds when the report does not say. A report that
    // says nothing about the provider's id does not unbind the conversation
    // from it.
    const effectiveNative = nativeSessionId || labelled?.native_session_id || "";
    // The conversation that already holds this provider conversation, with
    // the rows that named it folded into one.
    const owner = effectiveNative
      ? this.mergeConversationsForNativeSession(effectiveAgent, effectiveNative)
      : null;
    const ownerId = owner?.conversation_id || "";
    // The provider's id decides which conversation this is — so the row that
    // already holds it is the row to write to.
    //
    // The label is the row to write to only when no row holds the provider's
    // id yet: then the label is the conversation's own row, and it takes the
    // id. A label whose row names a *different* provider conversation is not
    // that conversation either — the provider's id belongs to the row that
    // holds it under this agent, and the database refuses a second row for
    // one conversation.
    const conversationId = ownerId || requestedConversationId;
    const requestedRunId = safeText(payload.runId || existingRun?.run_id || sessionId, 96);
    // Runtime re-registration must not erase ownership recorded by the
    // collaboration supervisor. Persist it in the existing provenance field.
    const collaborationWorker = isCollaborationSessionPayload({
      ...payload, sessionId, runId: requestedRunId,
    }) || isCollaborationSessionPayload(existingRun || {});
    const startedBy = collaborationWorker
      ? (payload.startedBy === "collaboration-remote" || existingRun?.started_by === "collaboration-remote"
        ? "collaboration-remote" : "collaboration-runtime")
      : safeText(payload.startedBy, 64);
    const requestedRunOwner = this.db.prepare(
      "SELECT originrouter_session_id FROM agent_runs WHERE run_id = ?",
    ).get(requestedRunId);
    const runId = requestedRunOwner
      && requestedRunOwner.originrouter_session_id !== sessionId
      ? stableId("agent_run", requestedRunId, sessionId)
      : requestedRunId;
    const defaultTitle = defaultConversationTitle(agent);
    const requestedTitle = safeText(payload.title, 256);
    const title = requestedTitle || defaultTitle;
    // Whether this title is one of our own placeholders. A placeholder is a
    // title we wrote, not one anybody chose — and it must be marked as such,
    // or it latches as a custom title and can never be replaced by the title
    // the agent actually produced.
    //
    // "Claude Code" used to land here as a *custom* title: the agent's own
    // name in the title slot, which no rule recognised as a placeholder. Once
    // latched, the conversation could never show anything else.
    const titleIsCustom = payload.titleIsCustom === true
      || (payload.titleIsCustom !== false
        && requestedTitle !== ""
        && !looksLikePlaceholderTitle(requestedTitle, agent));
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
          conversation_id, agent_type, native_session_id, title, title_is_custom, summary,
          first_prompt_preview, last_message_preview, workspace_id,
          transcript_locator, created_at, last_activity_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          agent_type = CASE WHEN excluded.agent_type <> 'unknown' THEN excluded.agent_type ELSE agent_conversations.agent_type END,
          native_session_id = CASE WHEN excluded.native_session_id <> '' THEN excluded.native_session_id ELSE agent_conversations.native_session_id END,
          title = CASE
            WHEN excluded.title_is_custom = 1 THEN excluded.title
            WHEN agent_conversations.title_is_custom = 1 THEN agent_conversations.title
            -- A placeholder never displaces a real title. This is the rule
            -- that lets a conversation recover: the placeholder written at
            -- launch gives way to the title the agent produced.
            --
            -- Both sides are judged by the title itself rather than by a
            -- stored flag, so a row written before this rule existed is
            -- judged correctly the first time it is written again.
            WHEN LOWER(TRIM(excluded.title)) IN (
                'agent session',
                CONCAT(LOWER(excluded.agent_type), ' session'),
                CONCAT(LOWER(excluded.agent_type), ' code'),
                LOWER(excluded.agent_type)
              )
              AND LOWER(TRIM(agent_conversations.title)) NOT IN (
                'agent session',
                CONCAT(LOWER(agent_conversations.agent_type), ' session'),
                CONCAT(LOWER(agent_conversations.agent_type), ' code'),
                LOWER(agent_conversations.agent_type)
              )
              THEN agent_conversations.title
            WHEN excluded.title <> '' THEN excluded.title
            ELSE agent_conversations.title
          END,
          title_is_custom = MAX(agent_conversations.title_is_custom, excluded.title_is_custom),
          summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE agent_conversations.summary END,
          first_prompt_preview = CASE WHEN excluded.first_prompt_preview <> '' THEN excluded.first_prompt_preview ELSE agent_conversations.first_prompt_preview END,
          last_message_preview = CASE WHEN excluded.last_message_preview <> '' THEN excluded.last_message_preview ELSE agent_conversations.last_message_preview END,
          workspace_id = COALESCE(excluded.workspace_id, agent_conversations.workspace_id),
          transcript_locator = CASE WHEN excluded.transcript_locator <> '' THEN excluded.transcript_locator ELSE agent_conversations.transcript_locator END,
          last_activity_at = MAX(agent_conversations.last_activity_at, excluded.last_activity_at),
          archived_at = COALESCE(excluded.archived_at, agent_conversations.archived_at)
      `).run(
        conversationId,
        agent,
        safeText(payload.nativeSessionId, 191),
        title,
        titleIsCustom ? 1 : 0,
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
          run_id, conversation_id, originrouter_session_id, device_id, device_name,
          runtime, provider, model, permission_profile, started_by, pid, status,
          started_at, exited_at, exit_code, exit_signal, native_config
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(originrouter_session_id) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          device_id = CASE WHEN excluded.device_id <> '' THEN excluded.device_id ELSE agent_runs.device_id END,
          device_name = CASE WHEN excluded.device_name <> '' THEN excluded.device_name ELSE agent_runs.device_name END,
          runtime = CASE WHEN excluded.runtime <> '' THEN excluded.runtime ELSE agent_runs.runtime END,
          native_config = MAX(agent_runs.native_config, excluded.native_config),
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
        safeText(payload.deviceName, 191),
        safeText(payload.runtime, 64),
        safeText(payload.provider, 191),
        safeText(payload.model, 191),
        safeText(payload.permissionProfile || payload.autonomyProfile, 64),
        startedBy,
        Number.isFinite(Number(payload.pid)) ? Number(payload.pid) : null,
        status,
        startedAt,
        payload.exitedAt ? iso(payload.exitedAt) : null,
        Number.isFinite(Number(payload.exitCode)) ? Number(payload.exitCode) : null,
        safeText(payload.exitSignal, 32),
        payload.nativeConfig === true || agent === 'agy' ? 1 : 0,
      );
    });
    write();
    // The attempt was launched under a label of its own, and it turned out to
    // belong to a conversation that already had a row. Nothing points at the
    // label any more, so it goes.
    if (conversationId !== requestedConversationId) {
      try {
        this.dropEmptyConversation(requestedConversationId);
      } catch {}
    }
    return this.getConversation(conversationId);
  }

  updateSession(sessionId, payload = {}) {
    const current = this.db.prepare(`
      SELECT r.*, c.agent_type, c.title, c.title_is_custom, c.workspace_id,
             w.canonical_path AS cwd
      FROM agent_runs r
      JOIN agent_conversations c ON c.conversation_id = r.conversation_id
      LEFT JOIN agent_workspaces w ON w.workspace_id = c.workspace_id
      WHERE r.originrouter_session_id = ?
    `).get(safeText(sessionId, 64));
    return this.upsertSession({
      sessionId,
      conversationId: payload.conversationId || current?.conversation_id,
      runId: current?.run_id,
      agent: current?.agent_type,
      // The title a runtime reports is the one it just learned — the agent's
      // own title, once it has one. Without this the update would keep
      // re-asserting the stored title and the conversation would never move
      // off the placeholder it was launched with.
      title: payload.title !== undefined
        ? safeText(payload.title, 256)
        : current?.title,
      // A title is custom only when somebody chose it. The stored flag
      // carries that across updates; the caller can override it.
      titleIsCustom: payload.titleIsCustom !== undefined
        ? payload.titleIsCustom === true
        : payload.title !== undefined ? false : Boolean(current?.title_is_custom),
      cwd: payload.cwd || current?.cwd,
      deviceId: payload.deviceId || current?.device_id,
      deviceName: payload.deviceName || current?.device_name,
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
    // A conversation's activity stamp is a high-water mark: the catalog orders
    // its list by it. A late duplicate finish for an older run used to move it
    // backwards, which reordered the list and dragged the card's `status` onto
    // the finished run that the picker then selected.
    this.db.prepare(`
      UPDATE agent_conversations SET last_activity_at = MAX(last_activity_at, ?)
      WHERE conversation_id = (
        SELECT conversation_id FROM agent_runs WHERE originrouter_session_id = ?
      )
    `).run(endedAt, id);
  }

  ensureSessionForPermissionState(metadata) {
    const existing = this.db.prepare("SELECT conversation_id FROM agent_runs WHERE originrouter_session_id = ?")
      .get(safeText(metadata.sessionId, 64));
    if (!existing) this.upsertSession(metadata);
    else if (metadata.conversationId && existing.conversation_id !== metadata.conversationId) {
      this.updateSession(metadata.sessionId, { conversationId: metadata.conversationId });
    }
  }

  getConversationPermissionState(conversationId) {
    const row = this.db.prepare("SELECT permission_state_json FROM agent_conversations WHERE conversation_id = ?")
      .get(safeText(conversationId, 96));
    return row?.permission_state_json ? JSON.parse(row.permission_state_json) : null;
  }

  saveConversationPermissionState(sessionId, state) {
    if (!state?.profile || !Number.isSafeInteger(state.revision) || state.revision <= 0) return false;
    return this.db.transaction(() => {
      const run = this.db.prepare("SELECT conversation_id FROM agent_runs WHERE originrouter_session_id = ?")
        .get(safeText(sessionId, 64));
      if (!run) return false;
      const current = this.getConversationPermissionState(run.conversation_id);
      if (current && current.revision >= state.revision) return false;
      this.db.prepare("UPDATE agent_conversations SET permission_state_json = ? WHERE conversation_id = ?")
        .run(JSON.stringify(state), run.conversation_id);
      this.db.prepare("UPDATE agent_runs SET permission_profile = ? WHERE originrouter_session_id = ?")
        .run(state.profile, sessionId);
      return true;
    })();
  }

  recordEvent(sessionId, event = {}) {
    const run = this.db.prepare(
      "SELECT conversation_id FROM agent_runs WHERE originrouter_session_id = ?",
    ).get(safeText(sessionId, 64));
    if (!run) return false;
    let conversationId = run.conversation_id;
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
      const native = safeText(event.sessionId, 191);
      // The provider's id belongs to the row that holds it. Another row that
      // already holds it means this conversation is that conversation, and
      // the fold is what the catalog does everywhere else — the unique
      // index over (agent, provider id) says the same thing in the
      // database, and a write that broke it would throw where the
      // conversation was only being recorded.
      const held = this.foldIntoNativeSessionHolder(conversationId, native);
      if (held.conversationId && held.conversationId !== conversationId) {
        conversationId = held.conversationId;
      }
      if (!held.holdsNativeId) {
        updates.push("native_session_id = ?");
        values.push(native);
      }
    }
    if (type === "agent.session.start" && event.transcriptPath) {
      updates.push("transcript_locator = ?");
      values.push(canonicalPath(event.transcriptPath));
    }
    updates.push("last_activity_at = MAX(last_activity_at, ?)");
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

  listConversations({ search = "", conversationId = "", agent = "", deviceId = "", workspaceId = "", status = "", limit = DEFAULT_LIMIT, offset = 0, includeArchived = false, includeCollaboration = true } = {}) {
    const clauses = [];
    const params = {};
    if (!includeArchived) clauses.push("c.archived_at IS NULL");
    if (safeText(conversationId, 96)) {
      clauses.push("c.conversation_id = @conversationId");
      params.conversationId = safeText(conversationId, 96);
    }
    if (!includeCollaboration) {
      clauses.push("COALESCE(r.started_by, '') NOT IN ('collaboration-runtime', 'collaboration-remote')");
      clauses.push("substr(COALESCE(r.run_id, ''), 1, 4) <> 'acr_'");
      clauses.push("substr(COALESCE(r.originrouter_session_id, ''), 1, 7) <> 'collab-'");
    }
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
             r.device_id, r.device_name, r.runtime, r.provider, r.model, r.native_config,
             r.permission_profile, r.status, r.started_at, r.exited_at,
             -- The session this conversation's current run belongs to. The
             -- run knows the session id it was started under, and the
             -- conversation knows the run. Without this the link between a
             -- conversation and its session exists only for the runs this
             -- device started itself.
             r.originrouter_session_id AS session_id,
             (SELECT COUNT(*) FROM agent_artifacts a
              WHERE a.conversation_id = c.conversation_id) AS artifact_count
      FROM agent_conversations c
      LEFT JOIN agent_workspaces w ON w.workspace_id = c.workspace_id
      LEFT JOIN agent_runs r ON r.run_id = (
        SELECT r2.run_id FROM agent_runs r2
        WHERE r2.conversation_id = c.conversation_id
        -- Prefer the run that is still open. A conversation can be resumed many
        -- times, and picking purely by started_at made the card flip between
        -- the live run and the previous, finished one on the next sync.
        ORDER BY
          CASE WHEN r2.status IN ('running', 'starting', 'waiting_approval',
                                  'waiting_input', 'waiting_device')
               THEN 0 ELSE 1 END,
          r2.started_at DESC, r2.rowid DESC LIMIT 1
      )
      ${where}
      ORDER BY c.last_activity_at DESC, c.conversation_id DESC
      LIMIT @limit OFFSET @offset
    `).all(params);
    return rows.map(publicConversation);
  }

  // The registry rebuilds its detached half from these runs when the daemon
  // restarts. One row per run — not one per conversation — because the App
  // addresses history and presence by the run's session id, and a resumed
  // conversation is several runs folded onto one row.
  listRunsForRegistry({ limit = 200 } = {}) {
    const params = {
      limit: Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 200)),
    };
    return this.db.prepare(`
      SELECT r.originrouter_session_id, r.conversation_id, r.run_id,
             r.device_id, r.device_name, r.runtime, r.provider, r.model, r.native_config,
             r.started_by, r.pid, r.status, r.started_at, r.exited_at,
             c.agent_type, c.native_session_id, c.title, c.transcript_locator,
             w.canonical_path AS workspace_path
      FROM agent_runs r
      JOIN agent_conversations c ON c.conversation_id = r.conversation_id
      LEFT JOIN agent_workspaces w ON w.workspace_id = c.workspace_id
      ORDER BY r.started_at DESC, r.rowid DESC
      LIMIT @limit
    `).all(params);
  }

  listConversationPage({
    collection = "history",
    search = "",
    agent = "",
    deviceId = "",
    workspaceId = "",
    page = 1,
    pageSize = 20,
    autoArchiveDays = 30,
    includeCollaboration = true,
  } = {}) {
    const normalizedCollection = collection === "archived" ? "archived" : "history";
    const normalizedPage = Math.max(1, Number(page) || 1);
    const normalizedPageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
    const normalizedArchiveDays = Math.max(0, Math.min(3650, Number(autoArchiveDays) || 0));
    const offset = (normalizedPage - 1) * normalizedPageSize;
    const clauses = [
      "COALESCE(r.status, 'stopped') NOT IN ('running', 'waiting_approval', 'waiting_input', 'waiting_device', 'starting')",
    ];
    if (!includeCollaboration) {
      clauses.push("COALESCE(r.started_by, '') NOT IN ('collaboration-runtime', 'collaboration-remote')");
      clauses.push("substr(COALESCE(r.run_id, ''), 1, 4) <> 'acr_'");
      clauses.push("substr(COALESCE(r.originrouter_session_id, ''), 1, 7) <> 'collab-'");
    }
    const params = {
      pageSize: normalizedPageSize,
      offset,
      autoArchiveDays: normalizedArchiveDays,
      archiveCutoff: new Date(
        this.now().getTime() - normalizedArchiveDays * 86400000,
      ).toISOString(),
    };
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
    const restoredOverride = "(c.restored_at IS NOT NULL AND c.last_activity_at <= c.restored_at)";
    const archivedExpression = `(NOT ${restoredOverride} AND (c.archived_at IS NOT NULL OR (@autoArchiveDays > 0 AND c.last_activity_at <= @archiveCutoff)))`;
    clauses.push(
      normalizedCollection === "archived"
        ? archivedExpression
        : `NOT ${archivedExpression}`,
    );
    const where = `WHERE ${clauses.join(" AND ")}`;
    const joins = `
      FROM agent_conversations c
      LEFT JOIN agent_workspaces w ON w.workspace_id = c.workspace_id
      LEFT JOIN agent_runs r ON r.run_id = (
        SELECT r2.run_id FROM agent_runs r2
        WHERE r2.conversation_id = c.conversation_id
        ORDER BY
          CASE WHEN r2.status IN ('running', 'starting', 'waiting_approval',
                                  'waiting_input', 'waiting_device')
               THEN 0 ELSE 1 END,
          r2.started_at DESC, r2.rowid DESC LIMIT 1
      )
    `;
    const total = Number(
      this.db.prepare(`SELECT COUNT(*) AS count ${joins} ${where}`).get(params)?.count || 0,
    );
    const rows = this.db.prepare(`
      SELECT c.*, w.display_name AS workspace_name,
             w.canonical_path AS workspace_path, w.repo_root,
             r.device_id, r.device_name, r.runtime, r.provider, r.model, r.native_config,
             r.permission_profile, r.status, r.started_at, r.exited_at,
             -- The session this conversation's current run belongs to. The
             -- run knows the session id it was started under, and the
             -- conversation knows the run. Without this the link between a
             -- conversation and its session exists only for the runs this
             -- device started itself.
             r.originrouter_session_id AS session_id,
             (SELECT COUNT(*) FROM agent_artifacts a
              WHERE a.conversation_id = c.conversation_id) AS artifact_count
      ${joins}
      ${where}
      ORDER BY c.last_activity_at DESC, c.conversation_id DESC
      LIMIT @pageSize OFFSET @offset
    `).all(params);
    const totalPages = total > 0 ? Math.ceil(total / normalizedPageSize) : 0;
    return {
      conversations: rows.map(publicConversation),
      pagination: {
        page: normalizedPage,
        page_size: normalizedPageSize,
        total,
        total_pages: totalPages,
        has_more: normalizedPage < totalPages,
      },
    };
  }

  setConversationArchived(conversationId, archived) {
    const id = safeText(conversationId, 96);
    if (!id) return null;
    const now = iso(this.now());
    const result = this.db.prepare(`
      UPDATE agent_conversations
      SET archived_at = @archivedAt, restored_at = @restoredAt
      WHERE conversation_id = @conversationId
    `).run({
      conversationId: id,
      archivedAt: archived ? now : null,
      restoredAt: archived ? null : now,
    });
    return result.changes > 0 ? this.getConversation(id) : null;
  }

  renameConversation(conversationId, title) {
    const id = safeText(conversationId, 96);
    const nextTitle = safeText(title, 256);
    if (!id) throw new Error("conversationId is required");
    if (!nextTitle) throw new Error("title is required");
    const result = this.db.prepare(`
      UPDATE agent_conversations
      SET title = ?, title_is_custom = 1, last_activity_at = MAX(last_activity_at, ?)
      WHERE conversation_id = ?
    `).run(nextTitle, iso(this.now()), id);
    return result.changes > 0 ? this.getConversation(id) : null;
  }

  getConversation(conversationId) {
    const id = safeText(conversationId, 96);
    if (!id) return null;
    let conversation = this.listConversations({
      conversationId: id, limit: 1, includeArchived: true,
    })[0];
    if (!conversation) {
      // The App reopens a run by the session id it was given, and for a run
      // the App started itself that is not the conversation's id. The run
      // knows both, so the run is where the second id is found.
      const run = this.db.prepare(`
        SELECT conversation_id FROM agent_runs
        WHERE originrouter_session_id = ?
        ORDER BY started_at DESC, rowid DESC LIMIT 1
      `).get(id);
      if (run?.conversation_id) {
        conversation = this.listConversations({
          conversationId: run.conversation_id, limit: 1, includeArchived: true,
        })[0];
      }
    }
    if (!conversation) return null;
    const catalogConversationId = conversation.conversation_id;
    return {
      ...conversation,
      runs: this.db.prepare(`
        SELECT run_id, originrouter_session_id, device_id, device_name, runtime,
               provider, model, permission_profile, started_by, pid, status, native_config,
               started_at, exited_at, exit_code, exit_signal
        FROM agent_runs WHERE conversation_id = ?
        ORDER BY started_at DESC, rowid DESC
      `).all(catalogConversationId),
      artifacts: this.db.prepare(`
        SELECT artifact_id, kind, locator, display_value,
               first_seen_at, last_seen_at
        FROM agent_artifacts WHERE conversation_id = ?
        ORDER BY last_seen_at DESC
      `).all(catalogConversationId),
    };
  }

  /**
   * Collaboration workers share the catalog so their durable provenance can
   * survive a daemon restart, but they are not ordinary Agent conversations.
   * Keep this check on the catalog boundary so deep-linked local API routes
   * cannot accidentally expose or mutate a collaboration conversation.
   */
  isCollaborationConversation(conversationId) {
    const id = safeText(conversationId, 96);
    if (!id) return false;
    let run = this.db.prepare(`
      SELECT run_id, originrouter_session_id, started_by
      FROM agent_runs
      WHERE conversation_id = ?
      ORDER BY started_at DESC, rowid DESC
      LIMIT 1
    `).get(id);
    // Catalog lookup also accepts a session ID. Resolve that exact run so a
    // worker cannot escape the boundary through its alternate identifier.
    if (!run) {
      run = this.db.prepare(`
        SELECT run_id, originrouter_session_id, started_by
        FROM agent_runs WHERE originrouter_session_id = ? LIMIT 1
      `).get(id);
    }
    return isCollaborationSessionPayload(run || {});
  }

  getConversationTranscriptLocator(conversationId) {
    const id = safeText(conversationId, 96);
    if (!id) return "";
    const row = this.db.prepare(
      "SELECT transcript_locator FROM agent_conversations WHERE conversation_id = ? LIMIT 1",
    ).get(id);
    return canonicalPath(row?.transcript_locator);
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
             w.repo_root, w.trusted, w.unattended_authorized_at,
             w.unattended_authorization_subject, w.created_at, w.updated_at,
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
    const params = { reference: value };
    let deviceClause = "";
    if (safeText(deviceId, 191)) {
      deviceClause = " AND device_id = @deviceId";
      params.deviceId = safeText(deviceId, 191);
    }
    // Workspace ids are opaque database identifiers. Resolve those first so a
    // remote launch can run its preflight before it ever stats a protected
    // directory simply to retrieve workspace metadata.
    const byId = this.db.prepare(`
      SELECT workspace_id, device_id, display_name, canonical_path,
             repo_root, trusted, unattended_authorized_at,
             unattended_authorization_subject, created_at, updated_at
      FROM agent_workspaces
      WHERE workspace_id = @reference${deviceClause}
      LIMIT 1
    `).get(params);
    if (byId) return { ...byId, trusted: Boolean(byId.trusted) };
    const canonical = canonicalPath(value);
    const row = this.db.prepare(`
      SELECT workspace_id, device_id, display_name, canonical_path,
             repo_root, trusted, unattended_authorized_at,
             unattended_authorization_subject, created_at, updated_at
      FROM agent_workspaces
      WHERE canonical_path = @canonical${deviceClause}
      LIMIT 1
    `).get({ ...params, canonical });
    return row ? { ...row, trusted: Boolean(row.trusted) } : null;
  }

  getRegisteredWorkspaceWithoutFilesystem(path, { deviceId = "" } = {}) {
    const requested = safeText(path, 4096);
    if (!requested) return null;
    const canonical = resolve(requested);
    const normalizedDeviceId = safeText(deviceId, 191);
    const row = this.db.prepare(`
      SELECT workspace_id, device_id, display_name, canonical_path,
             repo_root, trusted, unattended_authorized_at,
             unattended_authorization_subject, created_at, updated_at
      FROM agent_workspaces
      WHERE canonical_path = @canonical
        AND (@deviceId = '' OR device_id = @deviceId)
      LIMIT 1
    `).get({ canonical, deviceId: normalizedDeviceId });
    return row ? { ...row, trusted: Boolean(row.trusted) } : null;
  }

  getTrustedWorkspaceForPath(path, { deviceId = "" } = {}) {
    let canonical;
    try {
      canonical = assertTrustableWorkspacePath(path);
    } catch {
      return null;
    }
    const normalizedDeviceId = safeText(deviceId, 191);
    const rows = this.db.prepare(`
      SELECT workspace_id, device_id, display_name, canonical_path,
             repo_root, trusted, unattended_authorized_at,
             unattended_authorization_subject, created_at, updated_at
      FROM agent_workspaces
      WHERE trusted = 1
        AND (@deviceId = '' OR device_id = @deviceId)
    `).all({ deviceId: normalizedDeviceId });
    const ancestor = rows
      .filter((row) => isWithinPath(canonical, row.canonical_path))
      .sort((left, right) => right.canonical_path.length - left.canonical_path.length)[0];
    if (!ancestor) return null;
    if (ancestor.canonical_path === canonical) {
      return { ...ancestor, trusted: true };
    }
    return {
      workspace_id: "",
      device_id: normalizedDeviceId || ancestor.device_id,
      display_name: basename(canonical) || canonical,
      canonical_path: canonical,
      repo_root: repositoryRoot(canonical),
      trusted: true,
      inherited_from_workspace_id: ancestor.workspace_id,
      unattended_authorized_at: ancestor.unattended_authorized_at,
      unattended_authorization_subject: ancestor.unattended_authorization_subject,
      created_at: ancestor.created_at,
      updated_at: ancestor.updated_at,
    };
  }

  trustWorkspace(path, { deviceId = "" } = {}) {
    const canonical = assertTrustableWorkspacePath(path);
    // Resolve the final path before persisting it. Symlink aliases therefore
    // converge on one trusted workspace and cannot be swapped after approval.
    try { lstatSync(canonical); } catch {
      throw workspaceTrustError("WORKSPACE_NOT_FOUND", "workspace directory does not exist");
    }
    const normalizedDeviceId = safeText(deviceId, 191);
    const workspaceId = stableId("workspace", normalizedDeviceId, canonical);
    const now = iso(this.now());
    this.db.prepare(`
      INSERT INTO agent_workspaces(
        workspace_id, device_id, display_name, canonical_path, repo_root,
        trusted, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(device_id, canonical_path) DO UPDATE SET
        display_name = excluded.display_name,
        repo_root = excluded.repo_root,
        trusted = 1,
        updated_at = excluded.updated_at
    `).run(
      workspaceId,
      normalizedDeviceId,
      basename(canonical) || canonical,
      canonical,
      repositoryRoot(canonical),
      now,
      now,
    );
    return this.getWorkspace(canonical, { deviceId: normalizedDeviceId });
  }

  authorizeWorkspaceForUnattended(path, { deviceId = "", subject = process.execPath } = {}) {
    const workspace = this.trustWorkspace(path, { deviceId });
    // Clear a previous grant before re-checking it. If the OS policy changed
    // or the user dismisses the prompt, a stale record must never make a
    // future remote launch appear eligible.
    this.db.prepare(`
      UPDATE agent_workspaces
      SET unattended_authorized_at = '', unattended_authorization_subject = ''
      WHERE workspace_id = ?
    `).run(workspace.workspace_id);
    // This method is intentionally invoked only by an explicit local command.
    // On macOS it may cause the one-time TCC prompt while a user is present.
    requireUnattendedWorkspace(workspace.canonical_path, { allowProtectedPaths: true });
    preflightUnattendedWorkspaceAuthorization(workspace.canonical_path);
    const authorizedAt = iso(this.now());
    this.db.prepare(`
      UPDATE agent_workspaces
      SET unattended_authorized_at = ?, unattended_authorization_subject = ?, updated_at = ?
      WHERE workspace_id = ?
    `).run(authorizedAt, safeText(subject, 4096), authorizedAt, workspace.workspace_id);
    return this.getWorkspace(workspace.workspace_id, { deviceId });
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
