import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgyAdapter } from '../src/adapters/agyAdapter.js';
import { AgyNativeQueueStore } from '../src/adapters/agy/nativeQueue.js';
import { AgyNativeExecutor } from '../src/adapters/agy/nativeExecutor.js';
import { agyTranscriptItems } from '../src/adapters/agy/history.js';
import { replaceAgyFlags } from '../src/adapters/agy/nativeLaunch.js';
import { startAgyHookServer } from '../src/adapters/agy/hookServer.js';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { configureAgyHooks } from '../src/adapters/agy/hookSettings.js';
import { configureAgyDeviceMcp } from '../src/adapters/agy/mcpSettings.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { agyQuestions } from '../src/adapters/agy/nativeQuestions.js';

test('interrupt persists uncertain delivery and refuses replay of that message ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-audit-'));
  const a = new AgyAdapter();
  try {
    a.queueStore = new AgyNativeQueueStore(root, 'conversation');
    a.inFlightMessage = { id: 'maybe-sent', text: 'execute once' };
    a.messageIds = new Set(['maybe-sent']);
    a.onInterrupt();
    assert.ok(a.queueStore.read().uncertain.includes('maybe-sent'));
    assert.equal(await a.submitRemoteMessage({}, 'execute once', { messageId: 'maybe-sent' }), false);
  } finally { a.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('failed PTY submission does not strand the queue behind a permanent in-flight entry', async () => {
  const a = new AgyAdapter();
  try {
    a.ready = true;
    a.executor = { async submitMessage() { throw new Error('PTY closed during write'); } };
    await a.submitRemoteMessage(a.executor, 'execute once', { messageId: 'write-failed' }).catch(() => {});
    assert.equal(a.inFlightMessage, null);
    assert.ok(a.unconfirmedIds.has('write-failed'));
    assert.ok(a.pendingEvents.some(e => e.type === 'agent.message.result' && e.accepted === false));
  } finally { a.cleanup(); }
});

test('duplicate delivery is acknowledged even after a modal opens or the queue fills', async () => {
  const a = new AgyAdapter();
  try {
    a.messageIds = new Set(['already-queued']); a.state = 'question';
    assert.equal(await a.submitRemoteMessage({}, 'same', { messageId: 'already-queued' }), true);
    assert.equal(a.messages.length, 0);
  } finally { a.cleanup(); }
});

test('message and attachment text limits cannot create a queue that fails on next startup', async () => {
  const a = new AgyAdapter();
  try {
    assert.equal(await a.submitRemoteMessage({}, 'x'.repeat(800001), { messageId: 'oversized' }), false);
    assert.equal(await a.submitRemoteMessage({}, '中'.repeat(300000), { messageId: 'oversized-utf8' }), false);
    a.nativeMenus = true;
    assert.equal(await a.submitRemoteMessage({}, 'a'.repeat(500000), { messageId: 'combined', content: [{
      type: 'resource', resource: { uri: 'originrouter-attachment:context', text: 'b'.repeat(400000) },
    }] }), false);
    assert.equal(a.messages.length, 0);
  } finally { a.cleanup(); }
});

test('stop during a configuration restart emits the session exit exactly once', async () => {
  let executor;
  const exits = [];
  class Child {
    async start(options) { this.options = options; return { pid: 123, executor: 'pty' }; }
    stop() {
      if (this.stopping) return;
      this.stopping = true;
      queueMicrotask(() => { executor.stop(); this.options.onExit({ code: 0 }); });
    }
  }
  executor = new AgyNativeExecutor({ resetScreen() {}, afterNativeStart() {} }, () => new Child());
  await executor.start({ onOutput() {}, onExit: e => exits.push(e) });
  await assert.rejects(executor.restart({}), /session_stopped/);
  assert.equal(exits.length, 1);
});

test('failure to spawn the replacement child ends the dead session and reports the error', async () => {
  const exits = [], errors = []; let starts = 0;
  class Child {
    async start(options) {
      this.options = options;
      if (++starts === 2) throw new Error('binary disappeared');
      return { pid: 123, executor: 'pty' };
    }
    stop() { queueMicrotask(() => this.options.onExit({ code: 0 })); }
  }
  const executor = new AgyNativeExecutor({ resetScreen() {}, afterNativeStart() {} }, () => new Child());
  await executor.start({ onOutput() {}, onExit: e => exits.push(e), onError: e => errors.push(e.message) });
  await assert.rejects(executor.restart({}), /binary disappeared/);
  assert.deepEqual(errors, ['binary disappeared']); assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 1);
});

test('an old physical PTY error cannot report a new logical session failure', async () => {
  const children = [], errors = [];
  class Child {
    async start(options) { this.options = options; children.push(this); return { pid: children.length }; }
    stop() { queueMicrotask(() => this.options.onExit({ code: 0 })); }
  }
  const executor = new AgyNativeExecutor({ resetScreen() {}, afterNativeStart() {} }, () => new Child());
  await executor.start({ onOutput() {}, onExit() {}, onError: e => errors.push(e.message) });
  await executor.restart({});
  children[0].options.onError(new Error('stale error'));
  children[1].options.onError(new Error('current error'));
  assert.deepEqual(errors, ['current error']);
});

test('an interrupt between paste and Enter never submits the cancelled draft afterwards', async () => {
  const writes = [];
  const child = { async start() { return { pid: 123 }; }, write: x => writes.push(x), interrupt: () => writes.push('interrupt') };
  const executor = new AgyNativeExecutor({ resetScreen() {}, afterNativeStart() {} }, () => child);
  await executor.start({ onOutput() {} });
  const submission = executor.submitMessage('cancel this');
  executor.interrupt();
  assert.equal(await submission, false);
  assert.deepEqual(writes, ['cancel this', 'interrupt']);
});

test('native chat content cannot inject terminal control sequences through text attachments', async () => {
  const a = new AgyAdapter(); a.nativeMenus = true;
  try {
    assert.equal(await a.submitRemoteMessage({}, 'hello\x03/model'), false);
    assert.equal(await a.submitRemoteMessage({}, 'hello', { content: [{ type: 'resource', resource: {
      uri: 'originrouter-attachment:file', text: '\x1b[200~hidden\x1b[201~',
    } }] }), false);
    assert.equal(a.messages.length, 0);
  } finally { a.cleanup(); }
});

test('exact resume after a model switch removes the old latest-conversation selector', () => {
  assert.deepEqual(replaceAgyFlags(['--continue', '-c', '--model', 'old'], { conversation: 'exact', model: 'new' }),
    ['--conversation', 'exact', '--model', 'new']);
});

test('native live tool events and restored history redact credential fields', () => {
  const a = new AgyAdapter();
  const args = { Path: '/workspace/file', nested: { api_key: 'PRIVATE_MARKER' } };
  try {
    a.onHook({ conversationId: 'native', hookEventName: 'PreToolUse', stepIdx: 1,
      toolCall: { id: 'tool', name: 'read_file', args } });
    a.permission({ name: 'read_file', args }, 'permission', 1000);
    assert.equal(a.pendingEvents.find(e => e.type === 'agent.interaction.requested').containsSecret, true);
    const event = a.pendingEvents.find(e => e.type === 'agent.tool_call.start');
    assert.equal(JSON.stringify(event).includes('PRIVATE_MARKER'), false);
    const history = agyTranscriptItems(JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 1,
      tool_calls: [{ id: 'tool', name: 'read_file', args }] }));
    assert.equal(JSON.stringify(history).includes('PRIVATE_MARKER'), false);
    assert.equal(args.nested.api_key, 'PRIVATE_MARKER');
  } finally { a.cleanup(); }
});

test('a failed approval callback removes its pending request immediately', async () => {
  const canceled = [];
  const server = await startAgyHookServer({ onEvent() {}, onPermission() { throw new Error('failed'); },
    onCancel: (id, reason) => canceled.push([id, reason]) });
  try {
    const response = await fetch(server.env.ORIGINROUTER_AGY_HOOK_URL, { method: 'POST', headers: {
      authorization: `Bearer ${server.env.ORIGINROUTER_AGY_HOOK_TOKEN}`,
    }, body: JSON.stringify({ hookEventName: 'PreToolUse', conversationId: 'native', toolCall: { id: 'tool' } }) });
    assert.equal((await response.json()).decision, 'deny');
    assert.equal(server.pending.size, 0);
    assert.equal(canceled.length, 1);
  } finally { server.close(); }
});

test('Chinese Hook input survives an HTTP chunk boundary inside a UTF-8 character', async () => {
  let observed;
  const server = await startAgyHookServer({ onEvent: payload => { observed = payload; }, onPermission() {}, onCancel() {} });
  const expected = { hookEventName: 'PreInvocation', question: '中文问题' };
  const body = Buffer.from(JSON.stringify(expected));
  const boundary = body.indexOf(Buffer.from('中')) + 1;
  try {
    const finished = new Promise((resolve, reject) => {
      const request = http.request(server.env.ORIGINROUTER_AGY_HOOK_URL, { method: 'POST', headers: {
        authorization: `Bearer ${server.env.ORIGINROUTER_AGY_HOOK_TOKEN}`,
      } }, response => { response.resume(); response.on('end', resolve); });
      request.on('error', reject); request.write(body.subarray(0, boundary));
      void delay(25).then(() => request.end(body.subarray(boundary)));
    });
    await finished;
    assert.deepEqual(observed, expected);
  } finally { server.close(); }
});

test('unknown native versions revoke menu/content controls instead of pretending success', () => {
  const a = new AgyAdapter();
  a.nativeVersion = '1.5.13'; a.nativeMenus = true;
  a.models = [{ id: 'model', displayName: 'Model' }];
  try {
    a.observeScreen('Antigravity CLI 9.9.9');
    assert.equal(a.nativeMenus, false);
    assert.equal(a.setModel({ model: 'model' }), false);
    assert.equal(a.modelStatusEvent().modelControl, 'unsupported');
    assert.deepEqual(a.pendingEvents.find(e => e.type === 'agent.capabilities').promptCapabilities, {});
  } finally { a.cleanup(); }
});

test('configuration waits through a busy turn, background work, and local drafts', async () => {
  const a = new AgyAdapter(), applied = [];
  a.executor = {}; a.nativeMenus = true; a.nativeSessionId = 'native';
  a.models = [{ id: 'old' }, { id: 'new' }]; a.model = 'old'; a.ready = true; a.busy = true;
  a.reconfigure = async change => applied.push(change.model);
  try {
    assert.equal(a.setModel({ model: 'new', requestId: 'change' }), true);
    await a.pump(); assert.deepEqual(applied, []);
    a.busy = false; a.fullyIdle = false;
    await a.pump(); assert.deepEqual(applied, []);
    a.fullyIdle = true; a.userTyping = true;
    await a.pump(); assert.deepEqual(applied, []);
    a.userTyping = false;
    await a.pump(); assert.deepEqual(applied, ['new']);
    assert.equal(a.pendingConfiguration, null);
  } finally { a.cleanup(); }
});

test('a crashed installer with no lock owner does not permanently block Hook or MCP setup', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-audit-lock-'));
  try {
    for (const [name, configure] of [['hooks.json', configureAgyHooks], ['mcp_config.json', configureAgyDeviceMcp]]) {
      const lock = join(home, '.gemini/config', `${name}.originrouter-lock`);
      mkdirSync(lock, { recursive: true });
      const stale = new Date(Date.now() - 120000); utimesSync(lock, stale, stale);
      await configure({ home });
      assert.doesNotThrow(() => JSON.parse(readFileSync(join(home, '.gemini/config', name))));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a late App snapshot retains the final native execution-mode acknowledgement', () => {
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: 'mode-audit', agent: 'agy' });
  registry.appendEvent('mode-audit', { type: 'agent.mode.status', mode: 'auto', requestId: 'switch', accepted: null });
  registry.appendEvent('mode-audit', { type: 'agent.mode.status', mode: 'plan', requestId: 'switch', accepted: true });
  const snapshot = registry.controlSnapshot('mode-audit');
  assert.equal(snapshot.mode, 'plan');
  assert.equal(snapshot.controlResults.find(r => r.requestId === 'switch').accepted, true);
});

test('interrupt during native Write-in cancels all remaining remote keystrokes', async () => {
  const a = new AgyAdapter(), writes = [];
  a.epoch = 1;
  const entry = { id: 'question', epoch: 1,
    questions: agyQuestions({ questions: [{ question: 'Color?', options: ['Red'] }] }) };
  a.questions.set(entry.id, entry);
  a.screenText = 'Question 1/1: Color?\n> 1. Red\n  2. Write-in...';
  a.executor = {
    write(key) {
      writes.push(key);
      if (key === '\x1b[B') a.screenText = 'Question 1/1: Color?\n  1. Red\n> 2. Write-in...';
      if (key === '\r') a.screenText += '\nYour answer: ';
      if (key === 'CUSTOM') a.onInterrupt();
    },
  };
  try {
    assert.equal(await a.answerQuestion(entry, { action: 'submit', response: { answers: { q1: 'CUSTOM' } } }), false);
    assert.equal(writes.at(-1), 'CUSTOM');
    assert.equal(writes.filter(key => key === '\r').length, 1);
  } finally { a.cleanup(); }
});
