import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgyConversationLog } from '../adapters/agy/conversationLog.js';
import { agyTranscriptPath } from '../adapters/agy/history.js';
import { looksLikePlaceholderTitle, readAgyConversationName } from '../agent/agentTitleSource.js';

// Old wrappers could put a finished run back under its launch label. Recover
// only from the run's own PID, time interval and a single foreground identity.
export function repairAgyCatalog(catalog, { home = homedir() } = {}) {
  const marker = 'agy_conversation_identity_v2';
  if (catalog.getMeta(marker)) return;
  const db = catalog.db;
  db.transaction(() => {
    if (catalog.getMeta(marker)) return;
    // agy emitted Unix seconds. Older catalogs treated them as JS milliseconds.
    // Only repair values whose decoded Unix time falls in the agy era.
    for (const field of ['first_seen_at', 'last_seen_at']) {
      const seconds = `ROUND((julianday(${field}) - 2440587.5) * 86400000)`;
      db.exec(`UPDATE agent_artifacts SET ${field} = strftime('%Y-%m-%dT%H:%M:%fZ', ${seconds}, 'unixepoch')
        WHERE ${field} LIKE '1970-%' AND ${seconds} BETWEEN 1704067200 AND unixepoch('now') + 86400
          AND conversation_id IN (SELECT conversation_id FROM agent_conversations WHERE agent_type = 'agy')`);
    }
    const provisional = db.prepare(`
      SELECT c.conversation_id, r.originrouter_session_id, r.pid, r.started_at, r.exited_at
      FROM agent_conversations c JOIN agent_runs r USING (conversation_id)
      WHERE c.agent_type = 'agy' AND c.native_session_id = '' AND r.pid > 0
        AND r.exited_at IS NOT NULL AND (SELECT COUNT(*) FROM agent_runs sibling
          WHERE sibling.conversation_id = c.conversation_id) = 1
    `).all();
    for (const run of provisional) {
      const startedAt = Date.parse(run.started_at);
      const until = Date.parse(run.exited_at);
      if (!Number.isFinite(startedAt) || !Number.isFinite(until)) continue;
      const log = new AgyConversationLog({ pid: run.pid, startedAt, dir: join(home, '.gemini', 'antigravity-cli', 'log') });
      const ids = new Set(log.read({ until: Math.min(startedAt + 120000, until), all: true }));
      if (ids.size !== 1) continue;
      const [id] = ids;
      catalog.updateSession(run.originrouter_session_id, {
        nativeSessionId: id, transcriptPath: agyTranscriptPath(id, home),
        lastActivityAt: run.exited_at,
      });
    }
    // Some attempts already moved, leaving previews and artifacts on a row
    // named exactly after the run. Keep the canonical conversation and its policy.
    const vacated = db.prepare(`
      SELECT c.conversation_id AS source, r.conversation_id AS owner
      FROM agent_conversations c JOIN agent_runs r ON r.originrouter_session_id = c.conversation_id
      JOIN agent_conversations target ON target.conversation_id = r.conversation_id
      WHERE c.agent_type = 'agy' AND c.native_session_id = '' AND target.agent_type = 'agy'
        AND target.native_session_id <> '' AND r.conversation_id <> c.conversation_id
    `).all();
    for (const { source, owner } of vacated) catalog.foldVacatedConversation(source, owner);
    const rows = db.prepare("SELECT conversation_id, native_session_id, title FROM agent_conversations WHERE agent_type = 'agy' AND native_session_id <> '' AND title_is_custom = 0").all();
    if (rows.length) {
      const rename = db.prepare('UPDATE agent_conversations SET title = ? WHERE conversation_id = ?');
      for (const row of rows) {
        if (!looksLikePlaceholderTitle(row.title, 'agy')) continue;
        const { title } = readAgyConversationName(row.native_session_id, home);
        if (title) {
          rename.run(title, row.conversation_id);
          db.prepare("INSERT INTO agent_catalog_insert_queue(conversation_id) VALUES (?)").run(row.conversation_id);
        }
      }
    }
    catalog.setMeta(marker, '1');
  }).immediate();
}
