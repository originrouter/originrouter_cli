import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir } from '../persistence/state.js';
import { activeAccountStateDir } from '../persistence/accounts.js';
import { normalizeScheduledTask, nextScheduledTime } from './scheduledTaskRules.js';

const ACTIVE = ['starting', 'running', 'waiting_approval', 'waiting_input', 'settling', 'uncertain'];
const ALL_STATES = new Set([...ACTIVE, 'succeeded', 'failed', 'cancelled', 'missed', 'skipped_busy']);
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function instant(ms) { return ms == null ? null : new Date(ms).toISOString(); }
function executionDocument(row) {
  return { id:row.id, taskId:row.task_id, taskName:row.task_name || null, scheduledAt:instant(row.scheduled_ms), status:row.status,
    launchId:row.launch_id, sessionId:row.session_id, createdAt:instant(row.created_ms), updatedAt:instant(row.updated_ms), detail:row.detail };
}
function idFor(accountDir, jobId, occurrence) {
  return createHash('sha256').update(`${accountDir}\0${jobId}\0${occurrence}`).digest('hex').slice(0, 40);
}

// One database per account on this CLI device. A transaction records the
// occurrence and advances the schedule before a process can be started.
export class ScheduledTaskStore {
  constructor({ stateDir = ensureStateDir(), now = () => Date.now() } = {}) {
    this.stateDir = stateDir;
    this.now = now;
    this.openDir = null;
    this.db = null;
  }
  dir() { return activeAccountStateDir(this.stateDir); }
  database() {
    const dir = this.dir();
    if (this.db && this.openDir === dir) return this.db;
    this.close();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'scheduled-tasks.sqlite3');
    const db = new Database(path);
    chmodSync(path, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 3000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL,
        next_ms INTEGER, updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scheduled_ms INTEGER NOT NULL,
        status TEXT NOT NULL, launch_id TEXT NOT NULL, session_id TEXT NOT NULL,
        task_name TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS deleted_task_ids (id TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS executions_task ON executions(task_id, created_ms DESC);
      CREATE INDEX IF NOT EXISTS executions_session ON executions(session_id);
      CREATE TABLE IF NOT EXISTS execution_history_revision (
        id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO execution_history_revision(id, revision) VALUES(1, 0);
      CREATE TRIGGER IF NOT EXISTS executions_history_insert AFTER INSERT ON executions BEGIN
        UPDATE execution_history_revision SET revision=revision+1 WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS executions_history_delete AFTER DELETE ON executions BEGIN
        UPDATE execution_history_revision SET revision=revision+1 WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS executions_history_priority AFTER UPDATE OF status ON executions
      WHEN (CASE WHEN OLD.status='uncertain' THEN 0 WHEN OLD.status IN ('starting','running','waiting_approval','waiting_input','settling') THEN 1 ELSE 2 END)
        <> (CASE WHEN NEW.status='uncertain' THEN 0 WHEN NEW.status IN ('starting','running','waiting_approval','waiting_input','settling') THEN 1 ELSE 2 END)
      BEGIN
        UPDATE execution_history_revision SET revision=revision+1 WHERE id=1;
      END;
    `);
    // Existing databases predate the immutable execution-name snapshot.
    if (!db.prepare('PRAGMA table_info(executions)').all().some((column) => column.name === 'task_name')) {
      db.exec('ALTER TABLE executions ADD COLUMN task_name TEXT');
    }
    this.db = db;
    this.openDir = dir;
    return db;
  }
  close() { if (this.db) this.db.close(); this.db = null; this.openDir = null; }
  list() {
    return this.database().prepare(`SELECT tasks.*,
      EXISTS(SELECT 1 FROM executions WHERE task_id=tasks.id AND status='uncertain') AS has_uncertain
      FROM tasks ORDER BY updated_ms DESC, id`).all().map((row) => ({
        ...this.decodeTask(row), hasUncertainExecution:row.has_uncertain === 1,
      }));
  }
  decodeTask(row) { return { ...JSON.parse(row.document), revision: row.revision, nextRunAt: instant(row.next_ms), updatedAt: instant(row.updated_ms) }; }
  get(id) { const row = this.database().prepare('SELECT * FROM tasks WHERE id = ?').get(id); return row ? this.decodeTask(row) : null; }
  save(input, { baseRevision = null } = {}) {
    const task = normalizeScheduledTask(input);
    const db = this.database();
    return db.transaction(() => {
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
      // A deleted task ID cannot represent a new task: old revision-1
      // clients and retained execution history would otherwise refer to it.
      // Existing history also protects IDs deleted by older CLI versions.
      if (!existing && (db.prepare('SELECT 1 FROM deleted_task_ids WHERE id=?').get(task.id)
        || db.prepare('SELECT 1 FROM executions WHERE task_id=? LIMIT 1').get(task.id))) {
        throw fail('SCHEDULED_TASK_CONFLICT', 'scheduled task id was already used; create a task with a new id');
      }
      if (!existing && db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count >= 256) {
        throw fail('SCHEDULED_TASK_LIMIT', 'at most 256 scheduled tasks are allowed on one device');
      }
      if (existing && baseRevision !== existing.revision) throw fail('SCHEDULED_TASK_CONFLICT', 'scheduled task changed since it was read');
      if (!existing && baseRevision != null && baseRevision !== 0) throw fail('SCHEDULED_TASK_CONFLICT', 'scheduled task no longer exists');
      const now = this.now();
      // Editing metadata or launch settings must not erase an already-due
      // occurrence before the scheduler records it as missed/busy/executed.
      // A changed schedule or an explicit pause/resume takes effect anew.
      const previous = existing ? this.decodeTask(existing) : null;
      const preserveNext = previous?.enabled && task.enabled
        && JSON.stringify(previous.schedule) === JSON.stringify(task.schedule)
        && existing.next_ms != null;
      const next = preserveNext ? existing.next_ms : task.enabled ? nextScheduledTime(task.schedule, now - 1) : null;
      if (task.enabled && next == null) throw fail('INVALID_SCHEDULED_TASK', 'the scheduled time has already passed');
      const revision = (existing?.revision || 0) + 1;
      db.prepare(`INSERT INTO tasks(id, document, revision, next_ms, updated_ms) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET document=excluded.document, revision=excluded.revision,
        next_ms=excluded.next_ms, updated_ms=excluded.updated_ms`).run(task.id, JSON.stringify(task), revision, next, now);
      return this.get(task.id);
    }).immediate();
  }
  remove(id, baseRevision) {
    const db = this.database();
    return db.transaction(() => {
      const row = db.prepare('SELECT revision FROM tasks WHERE id=?').get(id);
      if (!row) return false;
      if (row.revision !== baseRevision) throw fail('SCHEDULED_TASK_CONFLICT', 'scheduled task changed since it was read');
      db.prepare('INSERT OR IGNORE INTO deleted_task_ids(id) VALUES(?)').run(id);
      db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      return true;
    }).immediate();
  }
  due(now = this.now()) {
    return this.database().prepare('SELECT id FROM tasks WHERE next_ms IS NOT NULL AND next_ms <= ? ORDER BY next_ms, id').all(now).map((row) => row.id);
  }
  claim(id, { now = this.now(), manual = false, baseRevision = null, missedAfterMs = 60_000 } = {}) {
    const db = this.database();
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!row) throw fail('SCHEDULED_TASK_NOT_FOUND', 'scheduled task not found');
      if (baseRevision != null && row.revision !== baseRevision) throw fail('SCHEDULED_TASK_CONFLICT', 'scheduled task changed since it was read');
      const task = this.decodeTask(row);
      if (!manual && (row.next_ms == null || row.next_ms > now)) return null;
      const scheduled = manual ? now : row.next_ms;
      const occurrence = manual ? `manual:${randomUUID()}` : `scheduled:${scheduled}`;
      const hash = idFor(this.openDir, id, occurrence);
      const executionId = `se_${hash}`, launchId = `sl_${hash}`, sessionId = `sa_${hash}`;
      const busy = db.prepare(`SELECT 1 FROM executions WHERE task_id=? AND status IN (${ACTIVE.map(() => '?').join(',')}) LIMIT 1`).get(id, ...ACTIVE);
      const status = !manual && now - scheduled > missedAfterMs ? 'missed' : busy ? 'skipped_busy' : 'starting';
      db.prepare(`INSERT INTO executions(id,task_id,scheduled_ms,status,launch_id,session_id,task_name,created_ms,updated_ms)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(executionId,id,scheduled,status,launchId,sessionId,task.name,now,now);
      if (!manual) {
        const next = nextScheduledTime(task.schedule, now);
        if (next == null) task.enabled = false;
        const { revision, nextRunAt, updatedAt, ...document } = task;
        db.prepare('UPDATE tasks SET document=?, next_ms=?, revision=revision+1, updated_ms=? WHERE id=?')
          .run(JSON.stringify(document), next, now, id);
      }
      return { executionId, taskId:id, scheduledAt:instant(scheduled), status, launchId, sessionId, launch:task.launch, accountDir:this.openDir };
    }).immediate();
  }
  updateExecution(id, status, detail = null, { accountDir = this.dir(), from = ACTIVE } = {}) {
    if (!ALL_STATES.has(status)) throw fail('INVALID_SCHEDULED_TASK', 'invalid execution state');
    if (accountDir !== this.dir()) throw fail('SCHEDULED_ACCOUNT_CHANGED', 'account changed during execution');
    const db = this.database();
    const allowed = from.filter((item) => ACTIVE.includes(item));
    if (!allowed.length) return false;
    return db.prepare(`UPDATE executions SET status=?, detail=?, updated_ms=? WHERE id=? AND status IN (${allowed.map(() => '?').join(',')})`)
      .run(status, detail == null ? null : String(detail).slice(0, 1000), this.now(), id, ...allowed).changes === 1;
  }
  updateSession(sessionId, status, detail = null, { from = ACTIVE } = {}) {
    if (!ALL_STATES.has(status)) throw fail('INVALID_SCHEDULED_TASK', 'invalid execution state');
    const db = this.database();
    const allowed = from.filter((item) => ACTIVE.includes(item));
    if (!allowed.length) return false;
    const row = db.prepare(`SELECT id FROM executions WHERE session_id=? AND status IN (${allowed.map(() => '?').join(',')}) ORDER BY created_ms DESC LIMIT 1`).get(sessionId, ...allowed);
    return row ? this.updateExecution(row.id, status, detail, {from:allowed}) : false;
  }
  activeExecutionForSession(sessionId) {
    return this.database().prepare(`SELECT id, status, detail FROM executions
      WHERE session_id=? AND status IN (${ACTIVE.map(() => '?').join(',')})
      ORDER BY created_ms DESC, rowid DESC LIMIT 1`).get(sessionId, ...ACTIVE) || null;
  }
  settlingExecutions() {
    return this.database().prepare("SELECT id, session_id AS sessionId, detail, updated_ms AS updatedMs FROM executions WHERE status='settling'").all();
  }
  markInterruptedExecutionsUncertain() {
    return this.database().prepare("UPDATE executions SET status='uncertain', detail='daemon restarted before the execution outcome was confirmed', updated_ms=? WHERE status IN ('running','waiting_approval','waiting_input','settling')").run(this.now()).changes;
  }
  startingExecutions() {
    return this.database().prepare("SELECT id, launch_id AS launchId, session_id AS sessionId FROM executions WHERE status='starting'").all();
  }
  markUncertainStarting() {
    return this.database().prepare("UPDATE executions SET status='uncertain', detail='daemon restarted while launch outcome was unknown', updated_ms=? WHERE status='starting'").run(this.now()).changes;
  }
  executions({ taskId = null, limit = 50, prioritizeOpen = false } = {}) {
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    const db = this.database();
    // Bounded UI history must keep old unresolved outcomes reachable even
    // when newer completed records have accumulated.
    const order = prioritizeOpen
      ? "CASE WHEN status='uncertain' THEN 0 WHEN status IN ('starting','running','waiting_approval','waiting_input','settling') THEN 1 ELSE 2 END, created_ms DESC, rowid DESC"
      : 'created_ms DESC, rowid DESC';
    const rows = taskId ? db.prepare(`SELECT * FROM executions WHERE task_id=? ORDER BY ${order} LIMIT ?`).all(taskId, bounded)
      : db.prepare(`SELECT * FROM executions ORDER BY ${order} LIMIT ?`).all(bounded);
    return rows.map(executionDocument);
  }
  executionPage({taskId = null, limit = 50, cursor = null} = {}) {
    const requested = Number(limit);
    const bounded = Number.isFinite(requested) && requested > 0
      ? Math.max(1, Math.min(Math.floor(requested), 200)) : 50;
    let after = null;
    if (cursor != null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 512) throw new Error();
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (after.v !== 2 || after.taskId !== taskId || ![0,1,2].includes(after.priority)
          || !Number.isSafeInteger(after.revision) || after.revision < 0
          || !Number.isSafeInteger(after.created) || !Number.isSafeInteger(after.rowid) || after.rowid < 1) throw new Error();
      } catch { throw fail('INVALID_SCHEDULED_TASK', 'invalid execution history cursor'); }
    }
    const priority = "CASE WHEN status='uncertain' THEN 0 WHEN status IN ('starting','running','waiting_approval','waiting_input','settling') THEN 1 ELSE 2 END";
    const params = {limit:bounded + 1};
    const conditions = [];
    if (taskId != null) { conditions.push('task_id=@taskId'); params.taskId = taskId; }
    if (after) {
      conditions.push(`(${priority}>@priority OR (${priority}=@priority AND (created_ms<@created OR (created_ms=@created AND rowid<@rowid))))`);
      Object.assign(params, {priority:after.priority, created:after.created, rowid:after.rowid});
    }
    const db = this.database();
    // The sort order depends on status. A read transaction binds the cursor
    // revision and its page to one SQLite snapshot, including other writers.
    return db.transaction(() => {
      const {revision} = db.prepare('SELECT revision FROM execution_history_revision WHERE id=1').get();
      if (after && after.revision !== revision) {
        throw fail('SCHEDULED_HISTORY_CHANGED', 'execution history changed; refresh before loading more');
      }
      const rows = db.prepare(`SELECT *, rowid AS page_rowid, ${priority} AS page_priority FROM executions
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY page_priority, created_ms DESC, rowid DESC LIMIT @limit`).all(params);
      const more = rows.length > bounded;
      const page = rows.slice(0, bounded);
      const last = page.at(-1);
      const nextCursor = more ? Buffer.from(JSON.stringify({v:2, taskId, revision, priority:last.page_priority,
        created:last.created_ms, rowid:last.page_rowid})).toString('base64url') : null;
      return {executions:page.map(executionDocument), nextCursor};
    })();
  }
}
