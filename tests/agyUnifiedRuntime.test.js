import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireThreadLock, setThreadLockChild, releaseThreadLock } from '../src/local/threadLock.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { agyManagedCommand, agySessionArguments, replaceAgyFlags } from '../src/adapters/agy/nativeLaunch.js';
import { AgyNativeScreen, agyScreenState } from '../src/adapters/agy/nativeScreen.js';
import { AgyNativeExecutor } from '../src/adapters/agy/nativeExecutor.js';
import { agyQuestions, questionSelection } from '../src/adapters/agy/nativeQuestions.js';
import { agyEffortVariants, parseAgyModels, agyFooterConfiguration } from '../src/adapters/agy/nativeCatalog.js';
import { AgyNativeQueueStore } from '../src/adapters/agy/nativeQueue.js';
import { prepareAgyAttachments } from '../src/adapters/agy/nativeAttachments.js';
import { configureAgyDeviceMcp } from '../src/adapters/agy/mcpSettings.js';
import { AgyAdapter } from '../src/adapters/agyAdapter.js';
import { agyTranscriptItems } from '../src/adapters/agy/history.js';

const fixture = () => mkdtempSync(join(tmpdir(), 'or-agy-unified-test-'));
test('terminal and App use native sessions; only recorded ACP conversations keep ACP', () => {
  assert.equal(agyManagedCommand(null), 'agy');
  assert.equal(agyManagedCommand({ runs: [{ runtime: 'agy-pty' }] }), 'agy');
  assert.equal(agyManagedCommand({ runs: [{ runtime: 'agy-acp' }] }), 'agy-acp');
  assert.deepEqual(agySessionArguments(['--prompt-interactive', 'task', '--resume', 'exact-id']),
    { args: ['--conversation', 'exact-id'], initialMessage: 'task' });
  assert.deepEqual(replaceAgyFlags(['--conversation=old', '--model', 'old', '--effort=high', '--settings', 'own.json'],
    { conversation: 'exact-id', model: 'next', effort: null }), ['--settings', 'own.json', '--conversation', 'exact-id', '--model', 'next']);
});

test('native readiness follows the rendered terminal after clearing an old modal', async () => {
  let current;
  const screen = new AgyNativeScreen(text => { current = agyScreenState(text); }, 100, 30);
  try {
    screen.write('Do you trust the contents of this project?'); await screen.flush;
    assert.equal(current, 'needs_native_trust');
    screen.write('\x1b[2J\x1b[H>\r\n────────────\r\n? for shortcuts'); await screen.flush;
    assert.equal(current, 'idle');
    screen.write('\x1b[2J\x1b[HQuestion 1/1: Color?\r\n> 1. Red'); await screen.flush;
    assert.equal(current, 'question');
  } finally { screen.dispose(); }
});

test('reconfiguration keeps the wrapper alive but a new child exit still ends the run', async () => {
  const children = [], exits = [], starts = [];
  class Child extends EventEmitter {
    constructor() { super(); this.terminal = { pid: children.length + 100 }; children.push(this); }
    async start(options) { this.options = options; starts.push(options); return { pid: this.terminal.pid, executor: 'pty' }; }
    stop() { queueMicrotask(() => this.options.onExit({ code: 0 })); }
    write() {} resize() {} interrupt() {}
  }
  const executor = new AgyNativeExecutor({ resetScreen() {}, afterNativeStart() {} }, () => new Child());
  await executor.start({ command: 'agy', args: [], env: { TOKEN: 'old' }, onOutput() {}, onExit: x => exits.push(x) });
  await executor.restart({ args: ['--conversation', 'same'], env: { TOKEN: 'new' } });
  assert.equal(children.length, 2); assert.equal(exits.length, 0);
  assert.equal(starts[1].env.TOKEN, 'new');
  children[0].options.onExit({ code: 7 }); assert.equal(exits.length, 0);
  children[1].options.onExit({ code: 1 }); assert.deepEqual(exits, [{ code: 1 }]);
});

test('a local draft rejects remote input; busy native messages queue only once', async () => {
  const a = new AgyAdapter(); const writes = [];
  a.executor = { submitMessage: async text => writes.push(text) };
  try {
    a.screen.write('>\r\n────────────\r\n? for shortcuts'); await a.screen.flush;
    a.onTerminalInput('local draft'); assert.equal(await a.submitRemoteMessage(a.executor, 'remote', { messageId: 'r' }), false);
    a.userTyping = false; a.busy = true;
    assert.equal(await a.submitRemoteMessage(a.executor, 'remote', { messageId: 'r' }), true);
    assert.equal(await a.submitRemoteMessage(a.executor, 'remote', { messageId: 'r' }), true);
    assert.equal(a.messages.length, 1); assert.deepEqual(writes, []);
    a.busy = false; a.ready = true; await a.pump(); assert.deepEqual(writes, ['remote']);
  } finally { a.cleanup(); }
});

test('Ctrl+C remains available during remote question application', () => {
  const a = new AgyAdapter(); let interrupted = 0; a.inputTransaction = true;
  try { a.handleTerminalInput('\x03', { interrupt() { interrupted++; } }); assert.equal(interrupted, 1); }
  finally { a.cleanup(); }
});

test('question schemas parse string JSON, keep labels and reject ambiguous unsupported answers', () => {
  const q = agyQuestions({ questions: JSON.stringify([{ question: 'Color?', options: ['Red', 'Blue'], is_multi_select: true }]) });
  assert.equal(q[0].multiple, true); assert.equal(q[0].options[1].label, 'Blue');
  assert.deepEqual(questionSelection(q[0], ['Blue']), { indices: [1], other: null });
  assert.throws(() => questionSelection(q[0], ['custom']), /custom_answer_unavailable/);
  assert.equal(agyQuestions({ questions: 'not json' }), null);
});

test('an App question stays unconfirmed until the matching native tool and transcript result exist', async () => {
  const root = fixture(), a = new AgyAdapter();
  a.nativeMenus = true; a.nativeSessionId = 'native'; a.epoch = 1; a.sessionId = 'wrapper';
  const tool = { id: 'call', name: 'ask_question', args: { questions: [{ question: 'Color?', options: ['Red', 'Blue'] }] } };
  a.onHook({ conversationId: 'native', hookEventName: 'PreToolUse', stepIdx: 2, toolCall: tool });
  const entry = [...a.questions.values()][0]; a.transcriptPath = join(root, 'transcript.jsonl'); writeFileSync(a.transcriptPath, '');
  let cursor = 0, sent = false;
  const panel = () => `Question 1/1: Color?\n${cursor === 0 ? '>' : ' '} 1. Red\n${cursor === 1 ? '>' : ' '} 2. Blue\n  3. Write-in...`;
  a.screenText = panel();
  a.executor = { write(key) { if (key === '\x1b[B') cursor++; if (key === '\r') sent = true; a.screenText = panel(); } };
  let finished = false;
  const result = a.resolvePermission({ interactionId: entry.id, action: 'submit', response: { answers: { q1: 'Blue' } } }).then(x => { finished = true; return x; });
  try {
    await delay(150); assert.equal(sent, true); assert.equal(finished, false);
    a.onHook({ conversationId: 'native', hookEventName: 'PostToolUse', stepIdx: 99, toolCall: tool, error: '' });
    writeFileSync(a.transcriptPath, JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'A1: Blue' }));
    a.completeQuestions(); assert.equal(finished, false);
    a.onHook({ conversationId: 'native', hookEventName: 'PostToolUse', stepIdx: 2, toolCall: tool, error: '' });
    writeFileSync(a.transcriptPath, JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'A1: Blue' }));
    a.completeQuestions(); assert.equal(await result, true);
    assert.equal(a.questions.size, 0);
  } finally { a.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('running transcript rows are not final tool results and ends key on the step', () => {
  const row = { step_index: 4, type: 'GENERIC', status: 'RUNNING', content: '' };
  assert.equal(agyTranscriptItems(JSON.stringify(row)).length, 0);
  const items = agyTranscriptItems(JSON.stringify({ ...row, status: 'DONE', content: 'actual result' }), { includeToolStarts: false });
  assert.equal(items[0].event.callId, 'step-4'); assert.equal(items[0].event.content, 'actual result');
  // History renders still pair the end with the planner's generated start.
  const planner = { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: {} }] };
  const history = agyTranscriptItems([planner, { ...row, status: 'DONE', content: 'x' }].map(JSON.stringify).join('\n'));
  const start = history.find(i => i.event?.type === 'agent.tool_call.start');
  const end = history.find(i => i.event?.type === 'agent.tool_call.end');
  assert.equal(start.event.callId, 'agy-step-3:tool-0'); assert.equal(end.event.callId, 'agy-step-3:tool-0');
});

test('effort changes use only account-advertised model variants', () => {
  const models = parseAgyModels('flash-low\tGemini Flash (Low)\nflash-high\tGemini Flash (High)\nother\tOther Model\nPlease login');
  assert.deepEqual(agyEffortVariants(models, 'flash-low'), [{ effort: 'low', model: 'flash-low' }, { effort: 'high', model: 'flash-high' }]);
  assert.deepEqual(agyEffortVariants(models, 'other'), []);
});

test('native attachments never read client paths, validate image signatures and keep files inside the private directory', () => {
  const root = fixture();
  try {
    const text = prepareAgyAttachments('task', [{ type: 'resource', resource: { uri: 'originrouter-attachment:notes.txt', text: 'USER_CONTEXT' } }], root);
    assert.ok(text.text.includes('USER_CONTEXT'));
    assert.throws(() => prepareAgyAttachments('', [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not png').toString('base64') }], root), /image_type/);
    assert.throws(() => prepareAgyAttachments('', [{ type: 'resource', resource: { uri: '/etc/passwd', text: 'ignored' } }], root), /invalid_attachment/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MCP registration preserves user configuration and bare agy exposes no device tools', async () => {
  const root = fixture();
  try {
    mkdirSync(join(root, '.gemini/config'), { recursive: true });
    writeFileSync(join(root, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { own: { command: 'user-server' } } }));
    await configureAgyDeviceMcp({ home: root });
    assert.equal(JSON.parse(readFileSync(join(root, '.gemini/config/mcp_config.json'))).mcpServers.own.command, 'user-server');
    const env = { ...process.env }; delete env.ORIGINROUTER_AGY_MCP_SESSION; delete env.ORIGINROUTER_AGY_MCP_BIN;
    const output = execFileSync(process.execPath, [join(root, '.gemini/config/originrouter/agy-device-mcp-forwarder.cjs')],
      { env, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output).result.tools, []);
    await configureAgyDeviceMcp({ home: root, remove: true });
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.gemini/config/mcp_config.json'))), { mcpServers: { own: { command: 'user-server' } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native queue recovery separates unsent intents from ambiguous submitted messages', () => {
  const root = fixture();
  try {
    const store = new AgyNativeQueueStore(root, '../../same-conversation');
    store.write([{ id: 'queued', text: 'not sent' }], { id: 'in-flight', text: 'possibly sent' }, ['confirmed']);
    const recovered = new AgyNativeQueueStore(root, '../../same-conversation').read();
    assert.equal(recovered.pending[0].id, 'queued');
    assert.equal(recovered.inFlight.id, 'in-flight');
    assert.deepEqual(recovered.confirmed, ['confirmed']);
    assert.ok(store.file.startsWith(join(root, 'agy-pending')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('catalog observations distinguish thinking models from effort variants in the current footer', () => {
  const models = parseAgyModels('flash-low\tGemini Flash (Low)\nflash-high\tGemini Flash (High)\nsonnet\tClaude Sonnet (Thinking)');
  assert.deepEqual(agyFooterConfiguration(models, '? for shortcuts   auto · Claude Sonnet · high'), { mode: 'auto', model: 'sonnet' });
  assert.deepEqual(agyFooterConfiguration(models, '? for shortcuts   plan · Gemini Flash · low'), { mode: 'plan', model: 'flash-low' });
  assert.equal(agyFooterConfiguration(models, Array.from({length: 10},(_,i)=>i===0?'auto · Gemini Flash · high':'plain').join('\n')), null);
});

test('a native receipt tolerates terminal trimming and persists the confirmed message ID', () => {
  const root = fixture(), a = new AgyAdapter();
  try {
    a.nativeSessionId = 'native'; a.transcriptPath = join(root, 'transcript.jsonl');
    a.queueStore = new AgyNativeQueueStore(root, 'conversation');
    a.inFlightMessage = { id: 'attachment-message', text: 'user attachment\n' };
    writeFileSync(a.transcriptPath, JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>user attachment</USER_REQUEST>' }));
    assert.ok(a.scanStructuredEvents().some(e=>e.type==='agent.message.result'&&e.accepted===true));
    assert.equal(a.inFlightMessage, null);
    assert.deepEqual(a.queueStore.read().confirmed, ['attachment-message']);
  } finally { a.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('a live native child keeps the conversation locked after its wrapper disappears', () => {
  const root = fixture();
  try {
    const lock = acquireThreadLock('same-native', { dir: root, pid: 111, startedAt: 1000, isAlive: () => false });
    assert.equal(setThreadLockChild(lock, 222, 2000, { pid: 111 }), true);
    const contender = acquireThreadLock('same-native', { dir: root, pid: 333, startedAt: 3000,
      isAlive: pid => pid === 222 });
    assert.equal(contender.ok, false); assert.equal(contender.holder.childPid, 222);
    assert.equal(releaseThreadLock(lock, { pid: 111, isAlive: pid => pid === 222 }), false);
    assert.equal(releaseThreadLock(lock, { pid: 111, isAlive: () => false }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native MCP uses its own namespace and preserves a user or ACP server name', async () => {
  const root = fixture();
  try {
    mkdirSync(join(root, '.gemini/config'), { recursive: true });
    const file = join(root, '.gemini/config/mcp_config.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { originrouter_device: { command: 'user-owned-acp-server' } } }));
    await configureAgyDeviceMcp({ home: root });
    const configured = JSON.parse(readFileSync(file));
    assert.equal(configured.mcpServers.originrouter_device.command, 'user-owned-acp-server');
    assert.ok(configured.mcpServers.originrouter_native_device);
    await configureAgyDeviceMcp({ home: root, remove: true });
    assert.deepEqual(JSON.parse(readFileSync(file)), { mcpServers: { originrouter_device: { command: 'user-owned-acp-server' } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
