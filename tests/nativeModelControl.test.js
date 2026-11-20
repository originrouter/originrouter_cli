import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeModelControl } from '../src/runtime/nativeModelControl.js';

test('gateway sessions never enumerate or change official native models', async () => {
  const fail = () => { throw new Error('must not call the native API'); };
  const control = new NativeModelControl({ enabled: false, load: fail, apply: fail });
  assert.deepEqual(await control.refresh(), []);
  assert.equal((await control.set({ model: 'native-model' })).accepted, false);
});
test('native selection requires the official catalog and updates only after acknowledgement', async () => {
  let model = 'first', fail = false;
  const control = new NativeModelControl({ enabled: true, provider: 'codex', runtime: 'codex-app-server',
    current: () => model, load: async () => [{ id: 'first', efforts: ['low'] }, { id: 'second', efforts: ['high'] }],
    apply: async value => { if (fail) throw new Error('native API rejected'); model = value; } });
  await control.refresh();
  assert.equal(control.status().source, 'native');
  assert.equal((await control.set({ model: 'unknown' })).accepted, false);
  assert.equal((await control.set({ model: 'second', provider: 'gateway' })).accepted, false);
  assert.equal((await control.set({ model: 'second' })).accepted, true);
  assert.equal(control.status().model, 'second');
  assert.deepEqual(control.efforts(), ['high']);
  fail = true;
  assert.equal((await control.set({ model: 'first' })).accepted, false);
  assert.equal(control.status().model, 'second');
});
test('unavailable native catalog disables the control', async () => {
  const control = new NativeModelControl({ enabled: true, load: async () => { throw new Error('logged out'); } });
  await control.refresh();
  assert.equal(control.status().modelControl, 'unsupported');
});
