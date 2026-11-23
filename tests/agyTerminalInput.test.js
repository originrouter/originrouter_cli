import test from 'node:test';
import assert from 'node:assert/strict';
import { AgyAdapter } from '../src/adapters/agyAdapter.js';

const editor = draft => `\x1b[2J\x1b[H────────────────────\r\n> ${draft}\r\n────────────────────\r\n? for shortcuts   auto · Gemini Flash · high`;
const idle = async a => { a.handleOutput(editor('Auto mode: edits & safe commands auto-approved (shift+tab to cycle)')); await a.screen.flush; };

test('terminal focus, cursor and device replies never become a local chat draft', async () => {
  const a = new AgyAdapter(), sent = [];
  a.executor = { async submitMessage(text) { sent.push(text); } };
  try {
    await idle(a);
    for (const input of ['\x1b[I', '\x1b[O', '\x1b[1;2R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\']) a.onTerminalInput(input);
    assert.equal(a.userTyping === true, false);
    assert.equal(await a.submitRemoteMessage(a.executor, 'App message', { messageId: 'focus-reply' }), true);
    assert.deepEqual(sent, ['App message']);
  } finally { a.cleanup(); }
});

test('fragmented control replies and Shift+Tab do not wedge a clean terminal', async () => {
  const a = new AgyAdapter();
  try {
    await idle(a);
    for (const input of ['\x1b', '[', 'I', '\x1b[', '?1;', '2c', '\x1b[Z']) a.onTerminalInput(input);
    assert.equal(a.userTyping === true, false);
  } finally { a.cleanup(); }
});

test('real local drafts stay protected through terminal reports, including multiline paste', async () => {
  const a = new AgyAdapter();
  try {
    await idle(a);
    a.onTerminalInput('\x1b[200~first line\nsecond line\x1b[201~');
    a.onTerminalInput('\x1b[O');
    assert.equal(a.userTyping, true);
    assert.equal(await a.submitRemoteMessage({}, 'remote'), false);
  } finally { a.cleanup(); }
});

test('deleting the final local draft releases App input after the native editor redraws', async () => {
  const a = new AgyAdapter();
  try {
    await idle(a); a.onTerminalInput('draft');
    a.handleOutput(editor('draft')); await a.screen.flush;
    assert.equal(await a.submitRemoteMessage({}, 'remote'), false);
    a.onTerminalInput('\x15');
    await idle(a);
    assert.equal(a.userTyping, false);
    assert.equal(a.ready, true);
  } finally { a.cleanup(); }
});

test('native history navigation protects the draft it loads into the editor', async () => {
  const a = new AgyAdapter();
  try {
    await idle(a); a.onTerminalInput('\x1b[A');
    a.handleOutput(editor('previous local message')); await a.screen.flush;
    assert.equal(a.userTyping, true);
    assert.equal(await a.submitRemoteMessage({}, 'remote'), false);
  } finally { a.cleanup(); }
});

test('official execution-mode placeholder hints never count as user drafts', async () => {
  const a = new AgyAdapter();
  try {
    for (const hint of [
      'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
      'Plan mode: research & plan only (shift+tab to cycle)',
      'Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
    ]) {
      a.handleOutput(editor(hint)); await a.screen.flush;
      assert.equal(a.ready, true); assert.equal(a.userTyping === true, false);
    }
  } finally { a.cleanup(); }
});

test('message rejection reports the actual cause instead of an opaque not-ready sentence', async () => {
  const a = new AgyAdapter();
  try {
    await idle(a); a.onTerminalInput('unsent draft');
    assert.equal(await a.submitRemoteMessage({}, 'remote', { messageId: 'draft' }), false);
    assert.equal(a.messageRefusalReason('draft'), 'native_local_draft');
    a.userTyping = false; a.state = 'needs_login';
    assert.equal(await a.submitRemoteMessage({}, 'remote', { messageId: 'login' }), false);
    assert.equal(a.messageRefusalReason('login'), 'native_needs_login');
    assert.equal(a.messageRefusalReason('draft'), 'native_local_draft');
  } finally { a.cleanup(); }
});
