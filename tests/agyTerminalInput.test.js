import test from 'node:test';
import assert from 'node:assert/strict';
import xterm from '@xterm/headless';
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

test('localNotice uses VT100 DECSC/DECRC and never shifts agy relative cursor on Apple Terminal', async () => {
  const a = new AgyAdapter();
  try {
    a.resetScreen(80, 8);
    const seq = a.localNotice('[OriginRouter approval] read_file — y: allow once, n: deny; also available in App.');
    assert.ok(seq.startsWith('\x1b7\x1b[8;1H\x1b[2K\x1b[0m'));
    assert.ok(seq.endsWith('\x1b8'));
    assert.equal(seq.includes('\x1b[s'), false);
    assert.equal(seq.includes('\x1b[u'), false);
    assert.equal(seq.includes('\x1b[?7'), false);

    // Wide CJK text must fit strictly below cols display columns so bottom row cannot wrap/scroll.
    a.resetScreen(12, 8);
    const wideSeq = a.localNotice('中文测试一行很长的提示文字');
    const widePayload = wideSeq.slice('\x1b7\x1b[8;1H\x1b[2K\x1b[0m'.length, -'\x1b8'.length);
    assert.equal(widePayload, '中文测试一');

    // Simulate Apple Terminal (which ignores CSI s/u but honors DECSC/DECRC)
    // while agy repaints a busy spinner via relative cursor moves.
    a.resetScreen(80, 8);
    const notice = a.localNotice('[OriginRouter approval] read_file — y: allow once, n: deny');
    const term = new xterm.Terminal({ cols: 80, rows: 8, scrollback: 50, allowProposedApi: true });
    const stream = [
      '\r\n\r\n\r\n\r\n\r\n\r\n\r\n',
      '\x1b[6A\r\x1b[J',
      '> 继续\r\n',
      '░ Reading file...\r\n',
      '└ Tip: Press esc to interrupt generation.\r\n',
      '────────────────────────────────────────\r\n',
      '>\r\n',
      '────────────────────────────────────────\r\n',
      'esc to cancel\r\x1b[2A\x1b[2C',
      // Strip any CSI s/u just as Apple Terminal does.
      notice.replace(/\x1b\[[su]/g, ''),
      '\x1b[?25l\r\x1b[4A\x1b[K> 继续\r\n\x1b[K░ Reading file... 10s\r\n\x1b[K└ Tip: Press esc to interrupt generation.\r\n\r\n\x1b[2C\x1b[?25h',
    ].join('');
    await new Promise(resolve => term.write(stream, resolve));
    const lines = [];
    for (let i = 0; i < term.buffer.active.length; i++) {
      const text = term.buffer.active.getLine(i)?.translateToString(true) || '';
      if (text.trim()) lines.push(text.trim());
    }
    term.dispose();
    assert.equal(lines.filter(l => l === '> 继续').length, 1);
    assert.equal(lines.filter(l => l.includes('Reading file')).length, 1);
    assert.ok(lines.includes('░ Reading file... 10s'));
  } finally { a.cleanup(); }
});
