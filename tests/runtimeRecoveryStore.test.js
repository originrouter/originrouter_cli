import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeTaskStore } from '../src/runtime/runtimeTaskStore.js';

test('recovery intent and retry count survive a daemon restart', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'or-recovery-'));
  const first = new RuntimeTaskStore({stateDir});
  assert.equal(first.recoveryFor('s1'), null);
  first.beginRecovery('s1', 'rt_loop', 2);
  const restarted = new RuntimeTaskStore({stateDir});
  assert.equal(restarted.recoveryFor('s1').pending, true);
  assert.throws(() => restarted.beginRecovery('s1', 'rt_loop', 2), { code: 'RECOVERY_PENDING' });
  restarted.finishRecovery('s1');
  restarted.beginRecovery('s1', 'rt_loop', 2);
  restarted.finishRecovery('s1');
  assert.throws(() => restarted.beginRecovery('s1', 'rt_loop', 2), { code: 'RECOVERY_LIMIT' });
  restarted.clearRecovery('s1');
  assert.equal(restarted.recoveryFor('s1'), null);
});

test('corrupt recovery state fails closed and arbitrary session ids are safe', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'or-recovery-'));
  const store = new RuntimeTaskStore({stateDir});
  store.beginRecovery('__proto__', 'rt_loop', 3);
  assert.equal(store.recoveryFor('__proto__').pending, true);
  assert.equal({}.pending, undefined);
  writeFileSync(join(store.dir(), 'runtime-task-recovery.json'), '{invalid');
  assert.throws(() => store.beginRecovery('s1', 'rt_loop', 3), { code: 'RECOVERY_STATE_UNAVAILABLE' });
});

test('a user stop survives restart without discarding an uncertain recovery', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'or-stop-state-'));
  const first = new RuntimeTaskStore({stateDir});
  first.beginRecovery('s1', 'rt_loop', 2);
  first.markUserStopped('s1');
  const restarted = new RuntimeTaskStore({stateDir});
  assert.equal(restarted.recoveryFor('s1').userStopped, true);
  assert.equal(restarted.recoveryFor('s1').pending, true);
  restarted.clearFinishedStop('s1');
  assert.equal(restarted.recoveryFor('s1').pending, true, 'uncertain recovery remains recorded');
  restarted.clearRecovery('s1');
  assert.equal(restarted.recoveryFor('s1'), null);
  restarted.markUserStopped('s2');
  restarted.clearFinishedStop('s2');
  assert.equal(restarted.recoveryFor('s2'), null);
});
