import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgyAdapter } from '../src/adapters/agyAdapter.js';
import { ClaudeAdapter } from '../src/adapters/claudeAdapter.js';
import { PtyExecutor } from '../src/executors/ptyExecutor.js';
import { CodexTurnState } from '../src/adapters/codex/turnState.js';
import { TerminalResponseFilter } from '../src/utils/terminalResponses.js';
import { AgyNativeScreen } from '../src/adapters/agy/nativeScreen.js';
import { questionPanel } from '../src/adapters/agy/nativeQuestions.js';
import { CodexAppServerClient } from '../src/adapters/codex/appServerClient.js';
import { handleRemoteEvent } from '../src/local/agentSessionPrimitives.js';
import { CodexAdapter } from '../src/adapters/codexAdapter.js';

test('shared Claude/Codex PTY submission cannot send Enter after interruption', async () => {
  const pty = new PtyExecutor(), writes = [];
  pty.terminal = { write: x => writes.push(x) };
  const result = pty.submitMessage('cancelled draft');
  pty.interrupt();
  assert.equal(await result, false);
  assert.deepEqual(writes, ['cancelled draft', '\x03']);
});

test('Claude effort status follows the newest native observation instead of an old confirmation', () => {
  const a = new ClaudeAdapter();
  try {
    a.handleOutput('Set effort level to low (this session only)');
    a.handleOutput('\r\n● high · /effort');
    assert.equal(a.currentEffort, 'high');
    a.handleOutput('\r\nunrelated repaint');
    assert.equal(a.currentEffort, 'high');
    a.handleOutput('\r\nSet effort level to medium (this session only)');
    assert.equal(a.currentEffort, 'medium');
  } finally { a.cleanup(); }
});

test('Claude disposal settles an effort waiter immediately', async () => {
  const a = new ClaudeAdapter();
  const result = a.waitForEffortText(() => null, 1000);
  a.cleanup();
  assert.equal(await Promise.race([result, delay(50).then(() => 'unsettled')]), null);
});

test('Claude mode and effort cannot drive the native terminal concurrently', async () => {
  const a = new ClaudeAdapter({ modeChangeTimeoutMs: 20 });
  a.sessionReady = true; a.handleOutput('● high · /effort');
  try {
    const effort = a.setEffort({ effort: 'low' }, { write() {} });
    const mode = await a.setMode({ mode: 'plan' }, { write() {} });
    assert.equal(mode, false);
    assert.equal(a.pendingEvents.at(-1).reason, 'mode_change_in_progress');
    a.cleanup(); await effort;
  } finally { a.cleanup(); }
});

test('Claude effort controller cannot type delayed keys after disposal', async () => {
  const a = new ClaudeAdapter(); a.sessionReady = true; a.handleOutput('● high · /effort');
  const writes = [];
  try {
    const result = a.setEffort({ effort: 'low' }, { write(key) {
      writes.push(key);
      if (key === '/effort\r') a.handleOutput('Effort low medium high xhigh max ←/→ to adjust · Enter to confirm · s for this session only');
      else if (key.includes('\x1b[D')) a.cleanup();
    } });
    assert.equal(await result, false);
    assert.equal(writes.includes('s'), false);
    assert.equal(writes.filter(key => key.includes('\x1b[C')).length, 0);
  } finally { a.cleanup(); }
});

test('an agy question tool error clears its blocking state immediately', () => {
  const a = new AgyAdapter(); a.nativeMenus = true; a.epoch = 1;
  const tool = { id: 'question-call', name: 'ask_question', args: { questions: [{ question: 'Choose?', options: ['A', 'B'] }] } };
  try {
    a.onHook({ hookEventName: 'PreToolUse', conversationId: 'native', stepIdx: 2, toolCall: tool });
    const id = [...a.questions.keys()][0];
    a.onHook({ hookEventName: 'PostToolUse', conversationId: 'native', stepIdx: 2, toolCall: tool, error: 'Cancelled in native UI' });
    assert.equal(a.questions.size, 0);
    assert.ok(a.pendingEvents.some(e => e.type === 'agent.permission.resolved' && e.callId === id));
  } finally { a.cleanup(); }
});

test('completed native question with a different answer closes stale control instead of blocking forever', () => {
  const root = mkdtempSync(join(tmpdir(), 'or-state-audit-')), a = new AgyAdapter();
  try {
    a.transcriptPath = join(root, 'transcript.jsonl');
    writeFileSync(a.transcriptPath, JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'A1: Blueberry' }));
    let accepted;
    a.questions.set('q', { id: 'q', step: 2, toolId: 'tool', expected: ['Blue'], post: { error: '' }, done: result => { accepted = result; } });
    a.completeQuestions();
    assert.equal(a.questions.size, 0); assert.equal(accepted, false);
  } finally { a.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('native modal keyboard actions do not become a permanent agy editor draft', async () => {
  const a = new AgyAdapter();
  try {
    a.state = 'native_panel'; a.onTerminalInput('y');
    a.handleOutput('\x1b[2J\x1b[H>\r\n────────────\r\n? for shortcuts'); await a.screen.flush;
    assert.equal(a.ready, true); assert.equal(a.userTyping, false);
  } finally { a.cleanup(); }
});

test('Ctrl+C cancels agy interactions even with an unfinished terminal sequence', () => {
  const a = new AgyAdapter(); let canceled = 0;
  a.hookServer = { cancelAll() { canceled++; }, close() {} };
  try {
    a.onTerminalInput('\x1b['); a.onTerminalInput('\x03');
    assert.equal(canceled, 1);
  } finally { a.cleanup(); }
});

test('Codex late completion does not clear a newer turn, and late start replies cannot revive completed work', () => {
  const turns = new CodexTurnState();
  assert.equal(turns.observe({ type: 'task_started', turn_id: 'old' }, null).currentTurnId, 'old');
  assert.equal(turns.observe({ type: 'task_complete', turn_id: 'old' }, 'old').currentTurnId, null);
  assert.equal(turns.acknowledgeStart('old', null), null);
  assert.equal(turns.observe({ type: 'task_complete', turn_id: 'old' }, 'new').accepted, false);
  assert.equal(turns.observe({ type: 'turn_aborted', turn_id: 'other' }, 'new').currentTurnId, 'new');
  assert.equal(turns.observe({ type: 'task_started', turn_id: 'foreign', thread_id: 'other-thread' }, 'new', 'main-thread').accepted, false);
  assert.equal(turns.acknowledgeStart('old', 'new'), 'new');
});

test('remote keyboard ownership blocks local text but forwards terminal replies in agy and Claude', async () => {
  for (const a of [new AgyAdapter(), new ClaudeAdapter()]) {
    const writes = [], executor = { write: data => writes.push(data), interrupt() {} };
    if (a.kind === 'agy') a.inputTransaction = true;
    else a.nativeControlActive = true;
    try {
      for (const chunk of ['local draft', '\x1b[', '1;2R', '\x1b[O']) a.handleTerminalInput(chunk, executor);
      assert.deepEqual(writes, ['\x1b[1;2R', '\x1b[O']);
      if (a.kind === 'claude') assert.equal(await a.submitRemoteMessage(executor, 'remote chat'), false);
    } finally { a.cleanup(); }
  }
  const parser = new TerminalResponseFilter();
  assert.equal(parser.push('text\x1b[A\x1b]11;rgb:ffff/ffff/ffff\x1b\\more text'), '\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
});

test('disposing an agy screen cannot leave its pending output flush unresolved', async () => {
  const screen = new AgyNativeScreen(() => {});
  screen.write('pending redraw');
  const flushed = screen.flush.then(() => true);
  screen.dispose();
  assert.equal(await Promise.race([flushed, delay(60).then(() => false)]), true);
});

test('conversation text mentioning another agy version cannot revoke controls after startup', () => {
  const a = new AgyAdapter(); a.nativeVersion = '1.5.13'; a.nativeMenus = true;
  try {
    a.observeScreen('>\n────────────\n? for shortcuts');
    a.observeScreen('Discuss Antigravity CLI 9.9.9 compatibility\n>\n────────────\n? for shortcuts');
    assert.equal(a.nativeMenus, true);
  } finally { a.cleanup(); }
});

test('native question navigation ignores earlier question examples still visible above the active panel', () => {
  const panel = questionPanel('Question 1/1: Old example?\n> 1. Old\n\nQuestion 1/1: Active?\n> 1. New\n  2. Other');
  assert.equal(panel.question, 'Active?'); assert.deepEqual(panel.options.map(o => o.label), ['New', 'Other']);
});

test('the final idle repaint during remote question submission is not lost when keyboard ownership ends', async () => {
  const a = new AgyAdapter(); a.epoch = 1;
  const entry = { id: 'q', epoch: 1, questions: [{ id: 'q1', question: 'Choose?', multiple: false, options: [{ label: 'A' }] }] };
  a.questions.set(entry.id, entry); a.screenText = 'Question 1/1: Choose?\n> 1. A';
  a.executor = { write(key) { if (key === '\r') {
    a.observeScreen('>\n────────────\n? for shortcuts');
    a.questions.delete(entry.id); entry.done(true);
  } } };
  try {
    assert.equal(await a.answerQuestion(entry, { action: 'submit', response: { answers: { q1: 'A' } } }), true);
    assert.equal(a.inputTransaction, false); assert.equal(a.ready, true);
  } finally { a.cleanup(); }
});

test('real Codex JSON-RPC notification/response ordering keeps a completed fast turn idle', async () => {
  const client = new CodexAppServerClient({ rpcTimeoutMs: 1000 }), turns = new CodexTurnState();
  let current = null;
  client.onEvent(event => {
    if (['task_started', 'task_complete', 'turn_aborted'].includes(event.type)) {
      const result = turns.observe(event, current, 'main');
      if (result.accepted) current = result.currentTurnId;
    }
  });
  client.child = { stdin: { writable: true, write(line) {
    const request = JSON.parse(line);
    queueMicrotask(() => {
      client.handleLine(JSON.stringify({ method: 'turn/started', params: { threadId: 'main', turn: { id: 'fast' } } }));
      client.handleLine(JSON.stringify({ method: 'turn/completed', params: { threadId: 'main', turn: { id: 'fast', status: 'completed' } } }));
      client.handleLine(JSON.stringify({ id: request.id, result: { turn: { id: 'fast' } } }));
    });
  } } };
  const result = await client.startTurn({ threadId: 'main', input: [{ type: 'text', text: 'hello' }] });
  current = turns.acknowledgeStart(result.turn.id, current);
  assert.equal(current, null);
});

test('Claude/Codex chat control bytes cannot become native terminal actions', async () => {
  for (const adapter of [new ClaudeAdapter(), new CodexAdapter()]) {
    const writes = [], ctx = { sessionId: 's', adapter, executor: { write: data => writes.push(data),
      async submitMessage(data) { writes.push(data); return true; } } };
    try {
      assert.equal(await handleRemoteEvent({ type: 'agent.message', sessionId: 's', message: 'text\x03hidden action' }, ctx), false);
      assert.deepEqual(writes, []);
      assert.equal(await handleRemoteEvent({ type: 'agent.message', sessionId: 's', message: 'line one\r\nline two' }, ctx), true);
      assert.equal(writes[0], 'line one\nline two');
      assert.equal(handleRemoteEvent({ type: 'terminal.input', sessionId: 's', data: '\x1b[A' }, ctx), true);
      assert.equal(writes.at(-1), '\x1b[A');
    } finally { adapter.cleanup?.(); }
  }
});
