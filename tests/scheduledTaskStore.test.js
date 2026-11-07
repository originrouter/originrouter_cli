import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateAccount } from '../src/persistence/accounts.js';
import { ScheduledTaskStore } from '../src/runtime/scheduledTaskStore.js';
import Database from 'better-sqlite3';

function task(overrides = {}) {
  return { id:'st_a', name:'daily', enabled:true,
    schedule:{kind:'interval', seconds:60, anchor:'2026-11-03T00:01:00Z'},
    launch:{agentType:'claude', workspaceId:'workspace-a', initialMessage:'Run the tests', permissionProfile:'guarded'},
    ...overrides };
}
function setup() {
  let clock = Date.parse('2026-11-03T00:00:00Z');
  const stateDir = mkdtempSync(join(tmpdir(), 'or-schedule-'));
  const store = new ScheduledTaskStore({stateDir, now:() => clock});
  return {stateDir, store, setNow:(value) => { clock = Date.parse(value); }};
}
test('tasks persist, reject stale edits and remain isolated by account', () => {
  const f = setup();
  activateAccount(f.stateDir, 'alice');
  const saved = f.store.save(task(), {baseRevision:0});
  assert.equal(saved.revision, 1);
  assert.equal(saved.nextRunAt, '2026-11-03T00:01:00.000Z');
  assert.throws(() => f.store.save(task({name:'stale'}), {baseRevision:0}), {code:'SCHEDULED_TASK_CONFLICT'});
  activateAccount(f.stateDir, 'bob');
  assert.deepEqual(f.store.list(), []);
  f.store.save(task({name:'bob'}));
  activateAccount(f.stateDir, 'alice');
  assert.equal(f.store.list()[0].name, 'daily');
  f.store.close();
});
test('deleted task IDs cannot be reused after restart, including tasks with no executions', () => {
  const f=setup();
  try {
    const saved=f.store.save(task());
    assert.equal(f.store.remove(saved.id,saved.revision),true);
    f.store.close();
    assert.throws(() => f.store.save(task({name:'replacement'}),{baseRevision:0}),{code:'SCHEDULED_TASK_CONFLICT'});
    assert.throws(() => f.store.save(task({name:'stale edit'}),{baseRevision:1}),{code:'SCHEDULED_TASK_CONFLICT'});
    assert.equal(f.store.get('st_a'),null);
    assert.equal(f.store.save(task({id:'st_new'}),{baseRevision:0}).revision,1);
  } finally {f.store.close();}
});

test('legacy deleted task IDs with retained execution history cannot be reused', () => {
  const f=setup();
  try {
    f.store.save(task());
    f.store.claim('st_a',{manual:true});
    // Simulate a task removed by a CLI predating deleted_task_ids.
    f.store.database().prepare('DELETE FROM tasks WHERE id=?').run('st_a');
    assert.throws(() => f.store.save(task(),{baseRevision:0}),{code:'SCHEDULED_TASK_CONFLICT'});
  } finally {f.store.close();}
});

test('claim is atomic, prevents overlapping executions and records history', () => {
  const f = setup(); f.store.save(task());
  f.setNow('2026-11-03T00:01:00Z');
  const first = f.store.claim('st_a');
  assert.equal(first.status, 'starting');
  assert.equal(f.store.claim('st_a'), null);
  assert.equal(f.store.get('st_a').nextRunAt, '2026-11-03T00:02:00.000Z');
  assert.equal(f.store.updateExecution(first.executionId, 'running'), true);
  f.setNow('2026-11-03T00:02:00Z');
  assert.equal(f.store.claim('st_a').status, 'skipped_busy');
  assert.equal(f.store.updateSession(first.sessionId, 'succeeded'), true);
  f.setNow('2026-11-03T00:03:00Z');
  assert.equal(f.store.claim('st_a').status, 'starting');
  assert.deepEqual(f.store.executions().map((entry) => entry.status), ['starting', 'skipped_busy', 'succeeded']);
  f.store.close();
});
test('missed execution is recorded and never launched on restart', () => {
  const f = setup(); f.store.save(task());
  f.setNow('2026-11-03T00:04:00Z');
  assert.equal(f.store.claim('st_a').status, 'missed');
  assert.equal(f.store.get('st_a').nextRunAt, '2026-11-03T00:05:00.000Z');
  f.store.close();
});
test('editing an overdue task preserves its occurrence for the scheduler to record', () => {
  const f=setup();
  try {
    const original=f.store.save(task());
    f.setNow('2026-11-03T00:04:00Z');
    const edited=f.store.save({...original,name:'renamed'},{baseRevision:original.revision});
    assert.equal(edited.nextRunAt,'2026-11-03T00:01:00.000Z');
    assert.equal(f.store.claim('st_a').status,'missed');
    assert.equal(f.store.get('st_a').nextRunAt,'2026-11-03T00:05:00.000Z');
  } finally {f.store.close();}
});

test('an explicit pause or schedule change replaces the pending occurrence', () => {
  const f=setup();
  try {
    const original=f.store.save(task());
    f.setNow('2026-11-03T00:04:00Z');
    const paused=f.store.save({...original,enabled:false},{baseRevision:original.revision});
    assert.equal(paused.nextRunAt,null);
    const resumed=f.store.save({...paused,enabled:true},{baseRevision:paused.revision});
    assert.equal(resumed.nextRunAt,'2026-11-03T00:04:00.000Z');
    const changed=f.store.save({...resumed,schedule:{kind:'once',at:'2026-11-03T01:00:00Z'}},{baseRevision:resumed.revision});
    assert.equal(changed.nextRunAt,'2026-11-03T01:00:00.000Z');
  } finally {f.store.close();}
});

test('history keeps an older uncertain run visible and preserves its deleted task name', () => {
  const f=setup();
  try {
    const original=f.store.save(task({name:'original task'}));
    const old=f.store.claim(original.id,{manual:true});
    f.store.updateExecution(old.executionId,'uncertain');
    f.store.remove(original.id,original.revision);
    f.store.save(task({id:'st_new',name:'new task'}));
    for(let i=0;i<105;i++) {
      const run=f.store.claim('st_new',{manual:true});
      f.store.updateExecution(run.executionId,'succeeded');
    }
    const history=f.store.executions({limit:10,prioritizeOpen:true});
    assert.equal(history.length,10);
    assert.equal(history[0].id,old.executionId);
    assert.equal(history[0].taskName,'original task');
    assert.equal(history[0].status,'uncertain');
  } finally {f.store.close();}
});

test('paged history reaches every uncertain execution and task state is independent of the page', () => {
  const f = setup();
  try {
    const ids = [];
    for (let i = 0; i < 105; i++) {
      const saved = f.store.save(task({id:`st_${i}`}));
      const run = f.store.claim(saved.id, {manual:true});
      assert.equal(f.store.updateExecution(run.executionId, 'uncertain'), true);
      ids.push(run.executionId);
    }
    const first = f.store.executionPage({limit:100});
    assert.equal(first.executions.length, 100);
    assert.ok(first.nextCursor);
    assert.equal(first.executions.some((entry) => entry.id === ids[0]), false);
    assert.equal(f.store.list().find((item) => item.id === 'st_0').hasUncertainExecution, true);
    const second = f.store.executionPage({limit:100, cursor:first.nextCursor});
    assert.equal(second.executions.length, 5);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.executions, ...second.executions].map((entry) => entry.id)).size, 105);
    assert.ok(second.executions.some((entry) => entry.id === ids[0]));
    assert.throws(() => f.store.executionPage({taskId:'st_0', cursor:first.nextCursor}), {code:'INVALID_SCHEDULED_TASK'});
    assert.throws(() => f.store.executionPage({cursor:'broken'}), {code:'INVALID_SCHEDULED_TASK'});
    assert.equal(f.store.updateExecution(ids[0], 'cancelled'), true);
    assert.equal(f.store.list().find((item) => item.id === 'st_0').hasUncertainExecution, false);
  } finally { f.store.close(); }
});

test('a history cursor is rejected if a record moves across its sort boundary', () => {
  const f = setup();
  try {
    f.store.save(task({id:'st_old'}));
    f.store.save(task({id:'st_new'}));
    const old = f.store.claim('st_old', {manual:true});
    f.store.claim('st_new', {manual:true});
    const first = f.store.executionPage({limit:1});
    assert.ok(first.nextCursor);
    assert.notEqual(first.executions[0].id, old.executionId);
    assert.equal(f.store.updateExecution(old.executionId, 'uncertain'), true);
    assert.throws(() => f.store.executionPage({limit:1, cursor:first.nextCursor}), {code:'SCHEDULED_HISTORY_CHANGED'});
    const refreshed = f.store.executionPage({limit:1});
    assert.equal(refreshed.executions[0].id, old.executionId);
  } finally { f.store.close(); }
});

test('a database from before task-name snapshots is migrated without losing history', () => {
  const f=setup();
  const db=new Database(join(f.stateDir,'scheduled-tasks.sqlite3'));
  db.exec(`CREATE TABLE executions (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,scheduled_ms INTEGER NOT NULL,
    status TEXT NOT NULL,launch_id TEXT NOT NULL,session_id TEXT NOT NULL,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL,detail TEXT);
    INSERT INTO executions VALUES ('old','st_old',1,'uncertain','launch','session',1,1,NULL);`);
  db.close();
  try {
    assert.equal(f.store.executions({prioritizeOpen:true})[0].taskName,null);
    assert.equal(f.store.executions()[0].id,'old');
    const saved=f.store.save(task());
    const run=f.store.claim(saved.id,{manual:true});
    assert.equal(f.store.executions().find((item) => item.id===run.executionId).taskName,'daily');
  } finally {f.store.close();}
});

test('an ambiguous in-flight launch becomes uncertain and blocks repeats', () => {
  const f = setup(); f.store.save(task());
  f.setNow('2026-11-03T00:01:00Z');
  const run = f.store.claim('st_a');
  f.store.close();
  const restarted = new ScheduledTaskStore({stateDir:f.stateDir, now:() => Date.parse('2026-11-03T00:02:00Z')});
  assert.equal(restarted.markUncertainStarting(), 1);
  assert.equal(restarted.claim('st_a').status, 'skipped_busy');
  assert.equal(restarted.updateExecution(run.executionId, 'cancelled'), true);
  restarted.close();
});
test('a result from an old account cannot alter the new account', () => {
  const f = setup(); activateAccount(f.stateDir, 'a'); f.store.save(task());
  f.setNow('2026-11-03T00:01:00Z'); const run = f.store.claim('st_a');
  activateAccount(f.stateDir, 'b');
  assert.throws(() => f.store.updateExecution(run.executionId, 'running', null, {accountDir:run.accountDir}), {code:'SCHEDULED_ACCOUNT_CHANGED'});
  f.store.close();
});
