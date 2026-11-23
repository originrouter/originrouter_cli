import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { configureAgyHooks, AGY_HOOK_KEY } from '../src/adapters/agy/hookSettings.js';
import { startAgyHookServer } from '../src/adapters/agy/hookServer.js';
import { AgyAcpAdapter } from '../src/adapters/agyAcpAdapter.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { agyTranscriptItems } from '../src/adapters/agy/history.js';
import { agyPermissionPayload } from '../src/adapters/agy/permissionPayload.js';
import { assertAgyAccountConfig } from '../src/adapters/agy/accountConfig.js';
import { AgyAdapter } from '../src/adapters/agyAdapter.js';
import { AgentCatalog } from '../src/persistence/agentCatalog.js';
import { ManagedAgentSupervisor } from '../src/daemon/managedAgentSupervisor.js';
import { EventEmitter } from 'node:events';

test('Hook install/uninstall preserves unrelated configuration and refuses malformed files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-hooks-test-'));
  const file = join(home, '.gemini/config/hooks.json');
  try {
    mkdirSync(join(home, '.gemini/config'), { recursive: true });
    const other = { unrelated: { SessionStart: [{ type: 'command', command: 'user-owned-hook' }] } };
    writeFileSync(file, JSON.stringify(other));
    await configureAgyHooks({ home });
    const configured = JSON.parse(readFileSync(file));
    assert.deepEqual(configured.unrelated, other.unrelated);
    assert.equal(configured[AGY_HOOK_KEY].PreToolUse[0].matcher, '*');
    await configureAgyHooks({ home, remove: true });
    assert.deepEqual(JSON.parse(readFileSync(file)), other);
    writeFileSync(file, '{incomplete');
    await assert.rejects(configureAgyHooks({ home }));
    assert.equal(readFileSync(file, 'utf8'), '{incomplete');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('installed global forwarder delegates outside OriginRouter and never uses external endpoints', () => {
  const file = new URL('../scripts/agy-session-hook-forwarder.cjs', import.meta.url);
  const env = { ...process.env };
  delete env.ORIGINROUTER_AGY_HOOK_URL; delete env.ORIGINROUTER_AGY_HOOK_TOKEN;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [file.pathname], { env, input: '{"hookEventName":"PreToolUse"}' })), { decision: 'allow' });
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [file.pathname], { env, input: '{"hookEventName":"Stop"}' })), {});
  assert.equal(JSON.parse(execFileSync(process.execPath, [file.pathname], { env: { ...env, ORIGINROUTER_AGY_HOOK_URL: 'https://example.com', ORIGINROUTER_AGY_HOOK_TOKEN: 'test' }, input: '{}' })).decision, 'deny');
});
test('Hook broker binds native request identity and drops stale decisions after cancellation', async () => {
  const cancellations = [];
  const server = await startAgyHookServer({ timeoutMs: 1000, onEvent() {}, onPermission() {}, onCancel: (id, reason) => cancellations.push({ id, reason }) });
  const controller = new AbortController();
  try {
    const pending = fetch(server.env.ORIGINROUTER_AGY_HOOK_URL, { method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${server.env.ORIGINROUTER_AGY_HOOK_TOKEN}` },
      body: JSON.stringify({ hookEventName: 'PreToolUse', conversationId: 'native', stepIdx: 2, toolCall: { id: 'tool', name: 'read_file' } }) });
    for (let i = 0; i < 50 && !server.pending.size; i++) await delay(10);
    assert.equal(server.pending.size, 1);
    assert.equal(server.resolve('different:tool', 'allow'), false);
    server.cancelAll();
    assert.equal((await (await pending).json()).decision, 'deny');
    assert.equal(server.resolve('native:tool', 'allow'), false);
    assert.equal(cancellations.length, 1);
  } finally { controller.abort(); server.close(); }
});
test('native catalog is in live snapshots; gateway catalog remains device-owned', () => {
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: 'agy-test', agent: 'agy' });
  registry.appendEvent('agy-test', { type: 'agent.model.status', source: 'native', model: 'account-model', modelControl: 'supported', availableModels: [{ id: 'account-model' }] });
  assert.equal(registry.controlSnapshot('agy-test').availableModels[0].id, 'account-model');
  registry.appendEvent('agy-test', { type: 'agent.model.status', source: 'device', modelControl: 'supported', availableModels: [{ id: 'gateway-model' }] });
  assert.equal('availableModels' in registry.controlSnapshot('agy-test'), false);
});
test('agy transcript parser removes metadata and retains tool failures with stable step identity', () => {
  const items = agyTranscriptItems([
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nhello\nworld\n</USER_REQUEST><ADDITIONAL_METADATA>private</ADDITIONAL_METADATA>' },
    { step_index: 1, type: 'GENERIC', status: 'ERROR', error: 'denied', content: 'permission denied' },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: 'answer' },
  ].map(JSON.stringify).join('\n') + '\n{partial');
  assert.equal(items[0].text, 'hello\nworld');
  assert.equal(items[1].event.isError, true);
  assert.equal(items[2].id, 'agy-step-2');
});
test('real ACP stdio transport supports model config changes, approvals, and prompt completion', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-acp-test-'));
  const script = join(root, 'agy');
  writeFileSync(script, `#!${process.execPath}
const readline=require('node:readline');let model='gemini',session='test-native';let prompt;
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const config=()=>[{id:'model',category:'model',currentValue:model,options:[{value:'gemini',name:'Gemini'},{value:'claude',name:'Claude'}]},...(model==='gemini'?[{id:'thought_level',currentValue:'high',options:[{value:'low'},{value:'high'}]}]:[])];
readline.createInterface({input:process.stdin}).on('line',s=>{const r=JSON.parse(s);if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});else if(['session/new','session/resume'].includes(r.method))send({id:r.id,result:{sessionId:session,configOptions:config()}});else if(r.method==='session/set_config_option'){model=r.params.value;send({id:r.id,result:{configOptions:config()}});}else if(r.method==='session/prompt'){prompt=r;send({id:900,method:'session/request_permission',params:{sessionId:session,toolCall:{title:'Read file',rawInput:{Path:'/workspace/file'}},options:[{optionId:'yes',kind:'allow_once'},{optionId:'no',kind:'reject_once'}]}});}else if(r.id===900){send({method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:r.result.outcome.optionId==='yes'?'approved':'denied'}}}});send({id:prompt.id,result:{stopReason:'end_turn'}});}});
`);
  chmodSync(script, 0o755);
  const adapter = new AgyAcpAdapter({ args: [], cwd: root, accountConfigHome: root });
  await adapter.beforeStart({ sessionId: 'wrapper-id' });
  const executor = adapter.createExecutor();
  try {
    await executor.start({ cwd: root, env: { ...process.env, PATH: root, ORIGINROUTER_NO_PROXY: '1' }, onExit() {}, onError() {} });
    assert.equal(adapter.nativeSessionId, 'test-native');
    assert.deepEqual(adapter.effortStatusEvent().availableEfforts, ['low', 'high']);
    assert.equal(await adapter.setModel({ model: 'claude' }), true);
    assert.equal(adapter.modelStatusEvent().model, 'claude');
    assert.deepEqual(adapter.effortStatusEvent().availableEfforts, []);
    assert.equal(await adapter.submitRemoteMessage(null, 'read file'), true);
    for (let i = 0; i < 50 && !adapter.approvals.size; i++) await delay(10);
    const id = [...adapter.approvals.keys()][0];
    assert.ok(id.startsWith('test-native:'));
    assert.equal(adapter.resolvePermission({ interactionId: id, action: 'allow' }), true);
    assert.equal(adapter.resolvePermission({ interactionId: id, action: 'allow' }), false);
    for (let i = 0; i < 50 && adapter.busy; i++) await delay(10);
    assert.equal(adapter.busy, false);
    assert.ok(adapter.scanStructuredEvents().some(item => item.type === 'agent.text.delta' && item.text === 'approved'));
  } finally { adapter.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('native tool vocabulary is mapped into existing permission policy fields', () => {
  const read = agyPermissionPayload({ name: 'read_file', args: { Path: '/workspace/file' } }, '/workspace');
  assert.equal(read.tool, 'Read');
  assert.equal(read.tool_input.file_path, '/workspace/file');
  const command = agyPermissionPayload({ name: 'run_command', args: { CommandLine: 'git status' } }, '/workspace');
  assert.equal(command.tool, 'Bash'); assert.equal(command.command, 'git status');
  assert.equal(agyPermissionPayload({ name: 'unknown_tool' }, '/workspace').tool, 'unknown_tool');
});

test('App launch and resume retain runtime ownership without changing gateway defaults', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-launch-policy-test-'));
  const catalog = new AgentCatalog({ stateDir: root });
  const launches = [];
  const supervisor = new ManagedAgentSupervisor({ catalog, deviceId: 'test-device', relayUrl: '',
    spawnFn(command, args) {
      const child = new EventEmitter(); child.pid = 12345; child.unref = () => {};
      launches.push(args); queueMicrotask(() => child.emit('spawn')); return child;
    } });
  try {
    const workspace = catalog.trustWorkspace(root, { deviceId: 'test-device' });
    for (const [agent, native] of [['agy', false], ['claude', true], ['codex', false]]) {
      await supervisor.start({ launchId: `${agent}-launch`, sessionId: `${agent}-session`, conversationId: `${agent}-conversation`,
        agentType: agent, workspaceId: workspace.workspace_id, nativeConfig: native });
      assert.equal(launches.at(-1).includes('--native-config'), agent === 'agy' || native);
      assert.equal(launches.at(-1).includes('--provider'), false);
    }
    assert.equal(launches[0][1], 'agy');
    catalog.updateSession('agy-session', { nativeSessionId: 'native-agy', transcriptPath: join(root, 'transcript') });
    catalog.finishSession('agy-session', { status: 'completed' });
    await supervisor.start({ launchId: 'agy-resume-launch', sessionId: 'agy-resumed-session', agentType: 'agy',
      workspaceId: workspace.workspace_id, nativeSessionId: 'native-agy', resumeConversationId: 'agy-conversation', inheritPermission: true });
    assert.ok(launches.at(-1).includes('native-agy'));
    const run = catalog.getConversation('agy-conversation').runs.find(run => run.originrouter_session_id === 'agy-resumed-session');
    assert.equal(run.native_config, 1);
    catalog.upsertSession({ sessionId: 'recorded-acp', conversationId: 'recorded-acp-conversation', runId: 'recorded-acp-run',
      agent: 'agy', deviceId: 'test-device', cwd: root, workspaceId: workspace.workspace_id, runtime: 'agy-acp',
      nativeConfig: true, nativeSessionId: 'old-native-acp', status: 'running' });
    catalog.finishSession('recorded-acp', { status: 'completed' });
    await supervisor.start({ launchId: 'legacy-resume', sessionId: 'legacy-resumed', agentType: 'agy', workspaceId: workspace.workspace_id,
      resumeConversationId: 'recorded-acp-conversation', nativeSessionId: 'old-native-acp', initialMessage: 'Continue.' });
    assert.equal(launches.at(-1)[1], 'agy-acp');
    assert.ok(launches.at(-1).includes('--prompt'));
    await assert.rejects(supervisor.start({ launchId: 'bad-provider', sessionId: 'bad-provider', agentType: 'agy', provider: 'gateway', workspaceId: workspace.workspace_id }), { code: 'INVALID_PROVIDER' });
    await assert.rejects(supervisor.start({ launchId: 'collab-agy', sessionId: 'collab-agy', agentType: 'agy', workspaceId: workspace.workspace_id }), { code: 'UNSUPPORTED_AGENT' });
  } finally { catalog.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native TUI refuses chat input while a modal or local draft owns the terminal', async () => {
  const adapter = new AgyAdapter();
  let text;
  const executor = { submitMessage: async value => { text = value; } };
  adapter.executor = executor;
  adapter.handleOutput('Select login method:');
  assert.equal(await adapter.submitRemoteMessage(executor, 'hello'), false);
  adapter.handleOutput('\x1b[2J\x1b[H>\r\n────────────\r\n? for shortcuts');
  assert.equal(await adapter.submitRemoteMessage(executor, 'hello'), true);
  assert.equal(text, 'hello');
  clearTimeout(adapter.inFlightMessage?.timer); adapter.inFlightMessage = null;
  adapter.onTerminalInput('local draft');
  assert.equal(await adapter.submitRemoteMessage(executor, 'remote'), false);
  adapter.onTerminalInput('\r'); adapter.handleOutput('\x1b[2J\x1b[H>\r\n────────────\r\n? for shortcuts');
  adapter.handleOutput('\x1b[2J\x1b[HSwitch Model');
  assert.equal(await adapter.submitRemoteMessage(executor, 'remote'), false);
  adapter.cleanup();
});

test('account-only runtime refuses alternate provider selection without modifying user settings', () => {
  const home = mkdtempSync(join(tmpdir(), 'agy-account-test-'));
  try {
    const directory = join(home, '.gemini/antigravity-cli'); mkdirSync(directory, { recursive: true });
    const content = JSON.stringify({ modelProvider: 'gemini', model: 'custom' });
    writeFileSync(join(directory, 'settings.json'), content);
    assert.throws(() => assertAgyAccountConfig([], { home }), /account login only/);
    assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), content);
    assert.doesNotThrow(() => assertAgyAccountConfig(['--settings', '{"modelProvider":""}'], { home }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ACP startup authentication failures reach the existing local session event channel', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-auth-failure-test-'));
  const state = join(root, 'state'); mkdirSync(state);
  const events = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const data = body ? JSON.parse(body) : {};
    if (data.event) events.push(data.event);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, commands: [], cursor: 0, streamId: 'test' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(state, 'daemon.state.json'), JSON.stringify({ localApiBaseUrl: `http://127.0.0.1:${server.address().port}` }));
  writeFileSync(join(state, 'local-api.token'), 'a'.repeat(64));
  writeFileSync(join(state, 'local-api.json'), '{"relayMode":"off"}');
  const executable = join(root, 'agy');
  writeFileSync(executable, `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Authentication required'}})+'\\n');});\n`);
  chmodSync(executable, 0o755);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/originrouter.js', import.meta.url)), 'agy-acp', '--originrouter-session', 'auth-failure'], {
    cwd: root, env: { HOME: root, PATH: root, ORIGINROUTER_HOME: state, ORIGINROUTER_NO_PROXY: '1', ORIGINROUTER_DISABLE_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 1, stderr);
    assert.ok(events.some(event => event.type === 'agent.adapter.status' && event.state === 'authentication_required'));
    assert.ok(events.some(event => event.type === 'session.error' && /Authentication required/.test(event.message)));
  } finally { clearTimeout(timer); child.kill('SIGTERM'); server.close(); server.closeAllConnections(); rmSync(root, { recursive: true, force: true }); }
});
