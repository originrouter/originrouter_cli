// Explicit live validation: consumes the user's official agy login/quota.
// Creates a temporary workspace, never installs global Hooks, and starts the
// source `originrouter agy` entry inside the existing production PTY executor.
// A loopback-only, token-protected controller simulates App commands. This is
// a validation harness, not an implementation of the App/relay integration.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { PtyExecutor } from '../src/executors/ptyExecutor.js';
import { handleRemoteEvent } from '../src/local/agentSessionPrimitives.js';
import { inheritSystemProxyEnv } from '../src/utils/systemProxy.js';

if (!process.argv.includes('--live')) {
  console.error('Run with --live to start a real, isolated agy TUI. Official login is required.');
  process.exit(2);
}
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(path.join(tmpdir(), 'originrouter-agy-native-'));
const resumeIndex = process.argv.indexOf('--resume-probe');
let resumedSessionId = null;
let workspace = path.join(root, 'workspace');
if (resumeIndex !== -1) {
  const priorRoot = path.resolve(process.argv[resumeIndex + 1] || '');
  if (!path.basename(priorRoot).startsWith('originrouter-agy-native-')) throw new Error('Only a previous probe workspace may be resumed.');
  const prior = readFileSync(path.join(priorRoot, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  if (!prior.some(item => item.kind === 'exit')) throw new Error('Stop the previous probe before resuming.');
  resumedSessionId = prior.find(item => item.kind === 'hook' && item.payload?.conversationId)?.payload.conversationId;
  if (!resumedSessionId) throw new Error('The previous probe did not record a native conversation.');
  workspace = path.join(priorRoot, 'workspace');
}
mkdirSync(path.join(workspace, '.agents'), { recursive: true });
writeFileSync(path.join(workspace, 'hook-target.txt'), 'ORIGINROUTER_NATIVE_FILE_MARKER\n');
writeFileSync(path.join(root, 'mode'), 'observe');
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const command = `${quote(process.execPath)} ${quote(path.join(project, 'scripts/probes/agy-native-hook.cjs'))}`;
const handler = { type: 'command', command, timeout: 5 };
const hooks = Object.fromEntries(['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']
  .map(name => [name, [handler]]));
for (const name of ['PreToolUse', 'PostToolUse']) hooks[name] = [{ matcher: '*', hooks: [handler] }];
writeFileSync(path.join(workspace, '.agents/hooks.json'), JSON.stringify({ 'originrouter-native-probe': hooks }, null, 2));

const token = randomBytes(32).toString('hex');
const executor = new PtyExecutor({ forceKillMs: 1500 });
const sessionId = 'isolated-native-probe';
const pending = new Map();
let output = '', exit = null, nativeSessionId = null, url;
const events = [];
const journal = item => appendFileSync(path.join(root, 'journal.jsonl'), JSON.stringify({ at: Date.now(), ...item }) + '\n');
const reply = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) return reply(response, { error: 'unauthorized' }, 401);
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) return reply(response, { error: 'too large' }, 413);
  }
  let data;
  try { data = body ? JSON.parse(body) : {}; } catch { return reply(response, { error: 'invalid JSON' }, 400); }
  if (request.url === '/status') return reply(response, {
    root, workspace, resumedSessionId, pid: executor.terminal?.pid, nativeSessionId, exit,
    screen: stripVTControlCharacters(output).slice(-12000),
    pending: [...pending.keys()], events: events.slice(-25),
  });
  if (request.url === '/shutdown') {
    executor.stop();
    reply(response, { ok: true });
    server.close();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
    return;
  }
  if (request.url === '/mode') {
    const modes = ['observe', 'deny', 'force_ask', 'ask', 'auto_approve', 'remote', 'timeout', 'crash', 'malformed'];
    if (!modes.includes(data.mode)) return reply(response, { error: 'unknown mode' }, 400);
    writeFileSync(path.join(root, 'mode'), data.mode);
    journal({ kind: 'mode', mode: data.mode });
    return reply(response, { ok: true });
  }
  if (request.url === '/resolve') {
    const entry = pending.get(data.id);
    if (!entry) return reply(response, { error: 'not pending' }, 409);
    if (!['deny', 'auto_approve', 'allow'].includes(data.decision)) return reply(response, { error: 'invalid decision' }, 400);
    pending.delete(data.id);
    journal({ kind: 'resolved', id: data.id, decision: data.decision });
    reply(entry.response, { decision: data.decision, reason: 'OriginRouter isolated remote decision' });
    return reply(response, { ok: true });
  }
  if (request.url === '/command') {
    if (exit) return reply(response, { error: 'process exited' }, 409);
    if (!['agent.message', 'terminal.input', 'terminal.resize', 'terminal.interrupt', 'session.stop'].includes(data.type)) {
      return reply(response, { error: 'unsupported command' }, 400);
    }
    journal({ kind: 'command', command: data });
    try {
      const accepted = await handleRemoteEvent({ ...data, sessionId }, { sessionId, executor, adapter: {} });
      return reply(response, { accepted: accepted !== false });
    } catch (error) { return reply(response, { error: error.message }, 500); }
  }
  if (request.url === '/hook') {
    journal({ kind: 'hook', ...data });
    const event = data.payload?.hookEventName;
    nativeSessionId = data.payload?.conversationId || nativeSessionId;
    events.push({ event, mode: data.mode, conversationId: nativeSessionId, tool: data.payload?.toolCall });
    if (event !== 'PreToolUse') return reply(response, {});
    if (data.mode === 'timeout') return; // Native agy kills the Hook after five seconds.
    if (data.mode === 'remote') {
      const id = `${nativeSessionId}:${data.payload.toolCall?.id || data.payload.stepIdx}`;
      pending.set(id, { response });
      response.once('close', () => {
        if (pending.get(id)?.response === response) {
          pending.delete(id);
          journal({ kind: 'pending_closed', id });
        }
      });
      return;
    }
    return reply(response, { decision: data.mode === 'observe' ? 'allow' : data.mode, reason: 'OriginRouter isolated Hook probe' });
  }
  return reply(response, { error: 'unknown endpoint' }, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
url = `http://127.0.0.1:${server.address().port}`;
writeFileSync(path.join(root, 'controller.json'), JSON.stringify({ url, token }), { mode: 0o600 });
console.log(JSON.stringify({ root, controllerFile: path.join(root, 'controller.json') }));

const settings = { altScreenMode: 'never' };
if (process.argv.includes('--deny-read')) settings.permissions = { deny: [`read_file(${realpathSync(path.join(workspace, 'hook-target.txt'))})`] };
await executor.start({
  command: process.execPath,
  args: [path.join(project, 'bin/originrouter.js'), 'agy', '--model', 'gemini-3.8-flash-medium', '--log-file', path.join(root, 'agy.log'), '--settings', JSON.stringify(settings),
    ...(resumedSessionId ? [`--conversation=${resumedSessionId}`] : [])],
  cwd: workspace, cols: 120, rows: 40,
  env: { ...inheritSystemProxyEnv(process.env),
    ORIGINROUTER_DISABLE_UPDATE_CHECK: '1',
    ORIGINROUTER_AGY_PROBE_MODE: path.join(root, 'mode'),
    ORIGINROUTER_AGY_PROBE_URL: url,
    ORIGINROUTER_AGY_PROBE_TOKEN: token,
  },
  onOutput: text => {
    output = (output + text).slice(-500000);
    appendFileSync(path.join(root, 'terminal.raw'), text);
  },
  onExit: result => {
    exit = result;
    writeFileSync(path.join(root, 'terminal.txt'), stripVTControlCharacters(output));
    journal({ kind: 'exit', ...result });
    console.log(JSON.stringify({ exit: result, root }));
  },
  onError: error => console.error(error.message),
});
// Leave a short inspection window after exit. Cap abandoned probes to 15min.
const watchdog = setTimeout(() => { executor.stop(); server.close(); server.closeAllConnections(); }, 15 * 60_000);
watchdog.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  executor.stop(); server.close(); server.closeAllConnections();
});
