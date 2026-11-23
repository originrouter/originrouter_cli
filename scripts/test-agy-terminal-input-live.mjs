// Opt-in: a real terminal-launched wrapper, automatic terminal replies, and App local API input.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PtyExecutor } from '../src/executors/ptyExecutor.js';
import { AgyNativeScreen } from '../src/adapters/agy/nativeScreen.js';
import { inheritSystemProxyEnv } from '../src/utils/systemProxy.js';

if (!process.argv.includes('--live')) { console.error('Pass --live to use the official agy account and quota in an isolated workspace.'); process.exit(2); }
const project = fileURLToPath(new URL('..', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'or-agy-terminal-input-'));
const cwd = fs.realpathSync(root), stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir);
const bin = path.join(project, 'bin/originrouter.js'), session = 'terminal-input-live';
fs.writeFileSync(path.join(stateDir, 'local-api.json'), JSON.stringify({ relayMode: 'off' }));
const env = { ...inheritSystemProxyEnv(process.env), ORIGINROUTER_HOME: stateDir,
  ORIGINROUTER_AGY_TRUSTED_CWD: cwd, ORIGINROUTER_DISABLE_UPDATE_CHECK: '1' };
const daemon = spawn(process.execPath, [bin, 'daemon', '--local-port', '0'], { env, cwd: project, stdio: 'ignore' });
const outer = new PtyExecutor(), terminal = new AgyNativeScreen(() => {}, 100, 30);
let base, token, exited, replyCount = 0;
terminal.terminal.onData(data => { replyCount++; outer.write(data); });
const wait = async (label, fn, ms = 45000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error(`${label} timed out`);
};
const api = async (route, body) => {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Local API ${response.status}`);
  const data = await response.json(); return data.data || data;
};
const snap = () => api(`/agent/local/sessions/${session}/snapshot`);
const history = () => api(`/agent/local/sessions/${session}/history`);
const send = body => api(`/agent/local/sessions/${session}/message`, body);
const checks = [], record = check => { checks.push(check); console.log(JSON.stringify({ check, passed: true })); };
try {
  const state = await wait('daemon', () => {
    const file = path.join(stateDir, 'daemon.state.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file)); return data.localApiPort ? data : null;
  }, 15000);
  base = state.localApiBaseUrl; token = fs.readFileSync(path.join(stateDir, 'local-api.token'), 'utf8').trim();
  await outer.start({ command: process.execPath, args: [bin, 'agy', '--originrouter-session', session,
    '--model', 'gemini-3.8-flash-low'], cwd, env, cols: 100, rows: 30,
    onOutput: data => terminal.write(data), onExit: result => { exited = result; }, onError: error => { throw error; } });
  await wait('native empty editor', () => terminal.text().includes('? for shortcuts'));
  await delay(1000);
  outer.write('\x1b[I'); outer.write('\x1b[O'); outer.write('\x1b[1;2R'); outer.write('\x1b[?1;2c');
  await send({ message: 'Reply exactly OR_AGY_TERMINAL_INPUT_OK. Do not use tools.', messageId: 'after-terminal-replies' });
  await wait('reply after terminal focus/device responses', async () => (await history()).messages.some(m => m.text === 'OR_AGY_TERMINAL_INPUT_OK'));
  record('terminal-source wrapper accepts App input after terminal protocol replies');
  await wait('first turn idle', async () => (await snap()).turn_state === 'idle');
  await delay(300); outer.write('UNSENT_LOCAL_DRAFT'); await delay(500);
  await send({ message: 'Do not submit while local draft exists.', messageId: 'draft-protected' });
  await wait('specific local-draft rejection', async () => (await snap()).events.some(e =>
    e.type === 'agent.message.result' && e.messageId === 'draft-protected' && e.accepted === false && e.reason === 'native_local_draft'));
  assert.equal((await history()).messages.some(m => m.text === 'Do not submit while local draft exists.'), false);
  record('real terminal draft blocks remote input without overwriting or submitting it');
  outer.write('\x15'); await delay(700);
  await send({ message: 'Reply exactly OR_AGY_CLEARED_DRAFT_OK. Do not use tools.', messageId: 'after-clear' });
  await wait('reply after clearing draft', async () => (await history()).messages.some(m => m.text === 'OR_AGY_CLEARED_DRAFT_OK'));
  record('clearing native draft restores App input without restart');
} catch (error) { console.log(JSON.stringify({ passed: false, error: error.message })); process.exitCode = 1; }
finally {
  outer.stop(); await wait('wrapper exit', () => exited, 8000).catch(() => {}); terminal.dispose();
  daemon.kill('SIGTERM'); await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), delay(3000)]);
  if (daemon.exitCode === null) daemon.kill('SIGKILL');
  // Remove only the official trust entry created by this isolated test.
  const file = path.join(os.homedir(), '.gemini/antigravity-cli/settings.json');
  const original = fs.readFileSync(file, 'utf8'), settings = JSON.parse(original);
  if (Array.isArray(settings.trustedWorkspaces) && settings.trustedWorkspaces.includes(cwd)) {
    settings.trustedWorkspaces = settings.trustedWorkspaces.filter(value => value !== cwd);
    const temporary = `${file}.input-test-${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      if (fs.readFileSync(file, 'utf8') !== original) throw new Error('Native settings changed during cleanup');
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  console.log(JSON.stringify({ checksPassed: checks.length, automaticTerminalReplies: replyCount }));
}
