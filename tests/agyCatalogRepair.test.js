import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentCatalog } from '../src/persistence/agentCatalog.js';
import { syncAgentActivityCatalog } from '../src/agent/agentActivityCatalogSync.js';
import { repairAgyCatalog } from '../src/persistence/repairAgyCatalog.js';

test('legacy agy repair requires process evidence and preserves runs, artifacts and saved permissions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'or-agy-repair-'));
  const c = new AgentCatalog({ stateDir: home });
  try {
    const native = '10000000-0000-0000-0000-000000000001';
    const startedAt = new Date(2026, 10, 24, 10, 0, 0);
    const exitedAt = new Date(startedAt.getTime() + 30000);
    const dir = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(join(dir, 'log'), { recursive: true });
    mkdirSync(join(dir, 'cache'));
    writeFileSync(join(dir, 'cache', 'conversation_metadata.json'), JSON.stringify({
      conversations: { [native]: { summary: { Title: 'Provider title' } } },
    }));
    writeFileSync(join(dir, 'log', 'cli-20261124_100001.log'), [
      'I1124 10:00:01.000000 1 server.go:1] Starting language server process with pid 123',
      'I1124 10:00:01.123456 1 conversation_manager.go:1] Streaming conversation ' + native, '',
    ].join('\n'));
    for (const [sessionId, pid] of [['owner', 122], ['lost', 123], ['empty', 124]]) {
      c.upsertSession({ sessionId, agent: 'agy', startedAt, exitedAt, pid, status: 'stopped',
        nativeSessionId: sessionId === 'owner' ? native : '' });
    }
    c.saveConversationPermissionState('owner', { profile: 'unrestricted', revision: 200 });
    c.saveConversationPermissionState('lost', { profile: 'manual', revision: 300 });
    c.recordEvent('lost', { type: 'agent.tool_call.start', input: { file_path: '/example/file' } });
    c.db.prepare("DELETE FROM catalog_meta WHERE key = 'agy_conversation_identity_v2'").run();
    c.db.prepare('DELETE FROM agent_catalog_insert_queue').run();
    c.setMeta('agent_activity_cloud_sync_v5', JSON.stringify({ cursor: '2099-01-01T00:00:00Z' }));
    c.setMeta('agent_activity_missing_backfill_v1', JSON.stringify({ done: true }));
    repairAgyCatalog(c, { home });
    repairAgyCatalog(c, { home });
    const owner = c.getConversation('owner');
    assert.equal(owner.title, 'Provider title');
    assert.deepEqual(owner.runs.map(r => r.originrouter_session_id).sort(), ['lost', 'owner']);
    assert.equal(owner.artifacts.length, 1);
    assert.equal(owner.permission_state.revision, 200);
    assert.equal(c.getConversation('empty').runs.length, 1);
    assert.deepEqual(c.listConversationPage({collection: 'history', autoArchiveDays: 0}).conversations.map(r => r.conversation_id), ['owner']);
    c.upsertSession({ sessionId: 'other-agent', agent: 'claude' });
    const attempts = [];
    const report = async (payload, options) => {
      attempts.push({ payload, options });
      return { ok: true };
    };
    const result = await syncAgentActivityCatalog({ catalog: c, reportFn: report, reconcileFn: async () => ({ ok: true }) });
    assert.equal(result.scanned, 0);
    assert.ok(attempts.some(({ payload }) => payload.agentType === 'claude'));
    const repaired = attempts.filter(({ payload }) => payload.agentType === 'agy');
    assert.ok(repaired.length);
    for (const { payload, options } of repaired) {
      assert.equal(payload.nativeSessionId, native);
      assert.equal(payload.title, 'Provider title');
      assert.equal(options.insertOnly, true);
    }
    assert.deepEqual(c.listPendingCatalogInserts(), []);
    assert.deepEqual(c.db.pragma('foreign_key_check'), []);
  } finally { c.close(); rmSync(home, { recursive: true, force: true }); }
});

test('a provisional run stays live and becomes publishable once, even behind the activity cursor', async () => {
  const home = mkdtempSync(join(tmpdir(), 'or-agy-identity-'));
  const c = new AgentCatalog({ stateDir: home });
  try {
    const seen = [];
    const sync = () => syncAgentActivityCatalog({ catalog: c,
      reportFn: async payload => { seen.push(payload); return { ok: true }; },
      reconcileFn: async () => ({ ok: true }) });
    c.upsertSession({ sessionId: 'new-run', agent: 'agy', status: 'running' });
    c.updateSession('new-run', { firstPromptPreview: 'first turn' });
    assert.equal(c.getConversation('new-run').status, 'running');
    assert.deepEqual(c.listConversations(), []);
    await sync();
    assert.deepEqual(seen, []);
    c.setMeta('agent_activity_cloud_sync_v5', JSON.stringify({ cursor: '2099-01-01T00:00:00Z' }));
    c.updateSession('new-run', { nativeSessionId: 'one' });
    c.updateSession('new-run', { nativeSessionId: 'two' });
    await sync();
    assert.deepEqual(seen.map(row => row.nativeSessionId), ['one']);
    c.upsertSession({ agent: 'agy', sessionId: 'resume', nativeSessionId: 'one' });
    c.upsertSession({ agent: 'agy', sessionId: 'switch', nativeSessionId: 'two' });
    assert.equal(c.getConversation('new-run').runs.length, 2);
    assert.deepEqual(c.listConversations().map(row => row.native_session_id).sort(), ['one', 'two']);
  } finally { c.close(); rmSync(home, { recursive: true, force: true }); }
});
