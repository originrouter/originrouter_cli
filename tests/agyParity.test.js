import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgyAcpClient } from '../src/adapters/agy/acpClient.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AgyAcpAdapter } from '../src/adapters/agyAcpAdapter.js';
import { agyPromptContent, agyToolContent } from '../src/adapters/agy/acpContent.js';
import { agyTranscriptItems } from '../src/adapters/agy/history.js';
import { handleRemoteEvent } from '../src/local/agentSessionPrimitives.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { evaluateAutonomyInteraction } from '../src/runtime/agentAutonomyPolicy.js';
import { agyPermissionPayload } from '../src/adapters/agy/permissionPayload.js';
import { validAgyFormValues } from '../src/adapters/agy/acpForms.js';

class Client extends EventEmitter {
  constructor() { super(); this.child = { pid: 123 }; this.calls = []; this.prompts = [];
    this.capabilities = { promptCapabilities: { image: true, embeddedContext: true } }; }
  async connect() {}
  request(method, params) {
    this.calls.push({ method, params });
    if (method === 'session/prompt') return new Promise((resolve, reject) => this.prompts.push({ resolve, reject }));
    return Promise.resolve({ sessionId: 'native', configOptions: [{ id: 'model', category: 'model', currentValue: 'native-model', options: [{ value: 'native-model' }] }] });
  }
  notify(method, params) { this.calls.push({ method, params }); }
  close() { this.closed = true; }
}
async function adapter() {
  const client = new Client(), result = new AgyAcpAdapter({ cwd: '/tmp', client });
  await result.beforeStart({ sessionId: 'wrapper', stateDir: '/tmp/originrouter-isolated' });
  await result.createExecutor().start({ cwd: '/tmp', env: {}, onError() {} });
  result.scanStructuredEvents();
  return result;
}
const update = (a, update) => a.notification({ method: 'session/update', params: { sessionId: 'native', update } });

test('a broken ACP stdin rejects pending requests without an unhandled stream error', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0, null);
  child.stdin.on('data', data => {
    const request = JSON.parse(data);
    if (request.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result: { protocolVersion: 1 } }) + '\n'));
  });
  const client = new AgyAcpClient({ spawn: () => child });
  await client.connect();
  const pending = client.request('session/prompt', {}, { timeoutMs: 0 });
  const rejected = assert.rejects(pending, /broken pipe/);
  child.stdin.emit('error', new Error('broken pipe'));
  await rejected; assert.equal(client.pending.size, 0); client.close();
});

test('ACP steering has one logical turn and waits for every prompt response', async () => {
  const a = await adapter();
  assert.equal(await a.submitRemoteMessage(null, 'first'), true);
  const turn = a.turnId;
  assert.equal(await a.submitRemoteMessage(null, 'steer'), true);
  assert.equal(a.turnId, turn);
  a.client.prompts[1].resolve({ stopReason: 'end_turn' }); await delay(0);
  assert.equal(a.busy, true);
  assert.equal(a.scanStructuredEvents().filter(e => e.type === 'agent.task.started').length, 1);
  a.client.prompts[0].resolve({ stopReason: 'end_turn' }); await delay(0);
  assert.equal(a.busy, false);
  assert.equal(a.scanStructuredEvents().filter(e => e.type === 'agent.task.complete').length, 1);
  a.cleanup();
});

test('recovery cancels only its current turn and acknowledges the native response', async () => {
  const a = await adapter(); await a.submitRemoteMessage(null, 'task');
  assert.equal(await a.interruptForRecovery('old-turn'), false);
  const cancellation = a.interruptForRecovery(a.turnId);
  assert.equal(a.busy, true);
  assert.equal(await a.submitRemoteMessage(null, 'must wait'), false);
  a.onInterrupt();
  assert.equal(a.client.calls.filter(c => c.method === 'session/cancel').length, 1);
  a.client.prompts[0].resolve({ stopReason: 'cancelled' });
  assert.equal(await cancellation, true);
  const events = a.scanStructuredEvents();
  assert.equal(events.filter(e => e.type === 'agent.task.aborted').length, 1);
  assert.equal(events.some(e => e.type === 'agent.task.complete'), false);
  a.cleanup();
});

test('native MCP configuration is scoped to the wrapper state and session', async () => {
  const a = await adapter();
  const params = a.client.calls.find(c => c.method === 'session/new').params;
  const server = params.mcpServers[0];
  assert.equal(server.name, 'originrouter_device');
  assert.ok(server.args.includes('--device-tools'));
  assert.equal(server.args[server.args.indexOf('--originrouter-session') + 1], 'wrapper');
  assert.deepEqual(server.env, [{ name: 'ORIGINROUTER_HOME', value: '/tmp/originrouter-isolated' }]);
  assert.equal(JSON.stringify(params).includes('modelProvider'), false);
  a.cleanup();
});

test('ACP forms preserve native values and cancel on wrong session, stale response, or interrupt', async () => {
  const a = await adapter();
  const schema = { type: 'object', properties: { q1: { type: 'string', oneOf: [{ const: '1', title: 'Red' }, { const: '2', title: 'Blue' }] } } };
  const params = { sessionId: 'native', requestedSchema: schema, message: 'Choose' };
  assert.deepEqual(await a.client.onRequest('elicitation/create', { ...params, sessionId: 'wrong' }, 1), { action: 'cancel' });
  const result = a.client.onRequest('elicitation/create', params, 2);
  const request = a.scanStructuredEvents().find(e => e.type === 'agent.interaction.requested');
  assert.equal(request.kind, 'form'); assert.deepEqual(request.payload.schema, schema);
  assert.equal(a.resolvePermission({ interactionId: request.interactionId, action: 'submit', response: { values: { q1: '2' } } }), true);
  assert.deepEqual(await result, { action: 'accept', content: { q1: '2' } });
  assert.equal(a.resolvePermission({ interactionId: request.interactionId, action: 'allow' }), false);
  const pending = a.client.onRequest('elicitation/create', params, 3);
  a.onInterrupt(); assert.deepEqual(await pending, { action: 'cancel' });
  assert.throws(() => a.client.onRequest('elicitation/create', { ...params, mode: 'url' }, 4), /Unsupported/);
  assert.equal(validAgyFormValues(schema, { q1: 'Blue' }), false);
  a.cleanup();
});

test('App commands follow native advertisements, reject side forks and busy commands', async () => {
  const a = await adapter();
  update(a, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }, { name: '../bad' }] });
  assert.deepEqual(a.commands.map(c => c.name), ['compact', 'rename', 'export', 'quit']);
  const ctx = { sessionId: 'wrapper', adapter: a, executor: {}, sessionCommands: [] };
  const command = c => handleRemoteEvent({ type: 'agent.command', sessionId: 'wrapper', command: c }, ctx);
  assert.equal(await command({ name: 'unknown' }), false);
  assert.equal(await command({ kind: 'side_message', text: 'side' }), false);
  assert.equal(await command({ name: 'compact' }), true);
  assert.equal(await command({ name: 'compact' }), false);
  assert.equal(a.client.prompts.length, 1);
  a.client.prompts[0].resolve({ stopReason: 'end_turn' }); await delay(0); a.cleanup();
});

test('rich native events, tool patches and authoritative snapshots retain their meaning', async () => {
  const a = await adapter();
  update(a, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } });
  update(a, { sessionUpdate: 'plan', entries: [{ content: 'Step one', status: 'in_progress' }] });
  update(a, { sessionUpdate: 'usage_update', used: 42, size: 1000 });
  update(a, { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Read', rawInput: { Path: '/tmp/file' } });
  update(a, { sessionUpdate: 'tool_call_update', toolCallId: 't', content: [{ type: 'content', content: { type: 'text', text: 'file output' } }] });
  update(a, { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' });
  const events = a.scanStructuredEvents();
  assert.ok(events.some(e => e.type === 'agent.thinking' && e.text === 'Thinking'));
  assert.ok(events.some(e => e.type === 'plan.updated' && e.text.includes('Step one')));
  assert.equal(events.find(e => e.type === 'agent.tool_call.end').content, 'file output');
  const usage = events.find(e => e.type === 'agent.usage');
  assert.equal(usage.contextUsedTokens, 42); assert.equal('sampledTokens' in usage, false); assert.equal(usage.amountMicros, null);
  const registry = new ExternalAgentRegistry(); registry.register({ sessionId: 'wrapper', agent: 'agy' });
  registry.appendEvent('wrapper', { type: 'agent.commands', commands: [{ name: 'compact' }] });
  registry.appendEvent('wrapper', { type: 'agent.capabilities', promptCapabilities: { image: true } });
  registry.appendEvent('wrapper', usage);
  const snapshot = registry.controlSnapshot('wrapper');
  assert.equal(snapshot.commands[0].name, 'compact'); assert.equal(snapshot.promptCapabilities.image, true); assert.equal(snapshot.usage.contextUsedTokens, 42);
  registry.register({ sessionId: 'wrapper', agent: 'agy' });
  assert.equal(registry.controlSnapshot('wrapper').promptCapabilities.image, true);
  assert.equal(registry.controlSnapshot('wrapper').usage.contextUsedTokens, 42);
  a.cleanup();
});

test('prompt content never fetches a URL, reads a path or silently drops unsupported data', () => {
  const caps = { image: true, embeddedContext: true };
  const image = { type: 'image', mimeType: 'image/png', data: 'YWJj' };
  assert.equal(agyPromptContent('', [image], {}), null);
  assert.deepEqual(agyPromptContent('', [image], caps), [image]);
  assert.equal(agyPromptContent('', [{ type: 'resource_link', uri: 'file:///etc/hosts' }], caps), null);
  assert.equal(agyPromptContent('', [{ type: 'image', mimeType: 'image/png', uri: 'https://example.com/private' }], caps), null);
  assert.equal(agyPromptContent('', [{ type: 'resource', resource: { uri: 'originrouter-attachment:large', text: '中'.repeat(300000) } }], caps), null);
  assert.equal(agyToolContent([{ type: 'diff', path: 'file', oldText: 'old', newText: 'new' }]), 'file\n---\nold\n+++\nnew');
});

test('native transcript restores thoughts, tool pairs and actual token usage', () => {
  const rows = [
    { type: 'PLANNER_RESPONSE', step_index: 1, thinking: 'reason', input_tokens: 10, cache_read_tokens: 20, output_tokens: 5, tool_calls: [{ name: 'read_file', args: { Path: '/tmp/file' } }] },
    { type: 'GENERIC', step_index: 2, content: 'output', status: 'DONE' },
    { type: 'PLANNER_RESPONSE', step_index: 3, content: 'answer', input_tokens: 4, output_tokens: 3 },
  ];
  const items = agyTranscriptItems(rows.map(JSON.stringify).join('\n'));
  assert.equal(items.find(i => i.event?.type === 'agent.thinking').event.text, 'reason');
  assert.equal(items.find(i => i.event?.type === 'agent.tool_call.start').event.callId, items.find(i => i.event?.type === 'agent.tool_call.end').event.callId);
  assert.equal(items.filter(i => i.event?.type === 'agent.usage').at(-1).event.sampledTokens, 42);
  assert.equal(agyTranscriptItems(rows.map(JSON.stringify).join('\n'), { includeToolStarts: false }).some(i => i.event?.type === 'agent.tool_call.start'), false);
});

test('agy permission vocabulary keeps manual and guarded safety boundaries', () => {
  const request = (tool) => ({ kind: 'permission', payload: agyPermissionPayload(tool, '/workspace') });
  assert.equal(evaluateAutonomyInteraction(request({ name: 'read_file', args: { Path: '/workspace/file' } }), { profile: 'guarded', workspaceRoot: '/workspace' }).autoResolve, true);
  for (const tool of [{ name: 'run_command', args: { CommandLine: 'rm -rf /tmp/data' } }, { name: 'unknown_tool' }, { name: 'read_file', args: { Path: '/etc/hosts' } }]) {
    assert.equal(evaluateAutonomyInteraction(request(tool), { profile: 'guarded', workspaceRoot: '/workspace' }).autoResolve, false);
  }
  assert.equal(evaluateAutonomyInteraction(request({ name: 'read_file', args: { Path: '/workspace/file' } }), { profile: 'manual', workspaceRoot: '/workspace' }).autoResolve, false);
});
