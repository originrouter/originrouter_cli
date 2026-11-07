import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScheduledTaskStore } from '../src/runtime/scheduledTaskStore.js';
import { ScheduledTaskScheduler } from '../src/runtime/scheduledTaskScheduler.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { AgentCatalog } from '../src/persistence/agentCatalog.js';
import { ManagedAgentSupervisor } from '../src/daemon/managedAgentSupervisor.js';

function fixture(start) {
  let time = Date.parse('2026-11-03T00:00:00Z');
  const store = new ScheduledTaskStore({ stateDir:mkdtempSync(join(tmpdir(), 'or-scheduler-')), now:() => time });
  const registry = new ExternalAgentRegistry();
  const calls = [];
  const supervisor = { start: async (payload) => { calls.push(payload); return start ? start(payload, registry) : {accepted:true}; } };
  const scheduler = new ScheduledTaskScheduler({store, registry, supervisor, now:() => time, log:{error(){}}});
  store.save({id:'st_a', name:'nightly', schedule:{kind:'once', at:'2026-11-03T00:01:00Z'},
    launch:{agentType:'claude',workspaceId:'workspace-a',initialMessage:'Run tests',permissionProfile:'manual'}});
  return {store,registry,scheduler,calls, setTime:(s) => {time = Date.parse(s);}};
}

test('a scheduled launch uses the existing Agent launcher and records its lifecycle', async () => {
  const f = fixture();
  f.setTime('2026-11-03T00:01:00Z');
  f.scheduler.timer = setInterval(() => {}, 60_000);
  f.scheduler.timer.unref();
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].startedBy, 'scheduled-task');
  assert.equal(f.calls[0].initialMessage, 'Run tests');
  assert.equal(f.calls[0].permissionProfile, 'manual');
  assert.equal(f.store.executions()[0].status, 'running');
  const id = f.calls[0].sessionId;
  f.registry.register({sessionId:id, agent:'claude'});
  f.registry.appendEvent(id, {type:'agent.interaction.requested',interactionId:'p1',kind:'permission'});
  assert.equal(f.store.executions()[0].status, 'waiting_approval');
  f.registry.appendEvent(id, {type:'agent.interaction.applied',interactionId:'p1'});
  f.registry.appendEvent(id, {type:'agent.task.complete'});
  assert.equal(f.store.executions()[0].status, 'settling');
  f.setTime('2026-11-03T00:01:03Z');
  f.scheduler.settleFinishedTurns();
  assert.equal(f.store.executions()[0].status, 'succeeded');
  await f.scheduler.tick();
  assert.equal(f.calls.length, 1);
  f.scheduler.stop(); f.store.close();
});

test('actual interaction results update waiting status without hiding another request or reviving a finished turn', async () => {
  const f = fixture();
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  try {
    await f.scheduler.runNow('st_a');
    const session = f.calls[0].sessionId;
    f.registry.register({sessionId:session, agent:'claude'});
    f.registry.appendEvent(session, {type:'agent.interaction.requested', interactionId:'p1', kind:'permission'});
    f.registry.appendEvent(session, {type:'agent.interaction.requested', interactionId:'q1', kind:'question'});
    f.registry.appendEvent(session, {type:'agent.interaction.result', interactionId:'p1', status:'applying'});
    assert.equal(f.store.executions()[0].status, 'waiting_approval');
    f.registry.appendEvent(session, {type:'agent.interaction.result', interactionId:'p1', status:'applied'});
    assert.equal(f.store.executions()[0].status, 'waiting_input');
    f.registry.appendEvent(session, {type:'agent.interaction.result', interactionId:'q1', status:'applied'});
    assert.equal(f.store.executions()[0].status, 'running');
    f.registry.appendEvent(session, {type:'agent.task.complete'});
    f.registry.appendEvent(session, {type:'agent.interaction.requested', interactionId:'late', kind:'permission'});
    f.registry.appendEvent(session, {type:'agent.interaction.result', interactionId:'q1', status:'applied'});
    assert.equal(f.store.executions()[0].status, 'settling');
  } finally { f.scheduler.stop(); f.store.close(); }
});

test('a stalled launch cannot delay another due task or stop future scheduler ticks', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(async (payload) => {
    if (payload.initialMessage === 'Run tests') await gate;
    return {accepted:true};
  });
  f.store.save({id:'st_b', name:'second', schedule:{kind:'once',at:'2026-11-03T00:01:00Z'},
    launch:{agentType:'claude', workspaceId:'workspace-a', initialMessage:'second', permissionProfile:'manual'}});
  f.store.save({id:'st_c', name:'later', schedule:{kind:'once',at:'2026-11-03T00:02:00Z'},
    launch:{agentType:'claude', workspaceId:'workspace-a', initialMessage:'later', permissionProfile:'manual'}});
  f.scheduler.timer = setInterval(() => {}, 60_000);
  f.scheduler.timer.unref();
  try {
    f.setTime('2026-11-03T00:01:00Z');
    await f.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls.map((call) => call.initialMessage), ['Run tests', 'second']);
    assert.equal(f.store.executions({taskId:'st_a'})[0].status, 'starting');
    assert.equal(f.store.executions({taskId:'st_b'})[0].status, 'running');
    f.setTime('2026-11-03T00:02:00Z');
    await f.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls[2].initialMessage, 'later');
    assert.equal(f.store.executions({taskId:'st_c'})[0].status, 'running');
    assert.equal(f.calls.filter((call) => call.initialMessage === 'Run tests').length, 1);
  } finally {
    f.scheduler.stop(); release(); await f.scheduler.drain(1000); f.store.close();
  }
});

test('a clean wrapper exit preserves the actual turn outcome and cannot invent success', async () => {
  for (const [event,expected] of [
    [{type:'agent.task.failed',error:'model failure'},'failed'],
    [{type:'agent.task.aborted',status:'interrupted'},'cancelled'],
    [{type:'agent.task.complete'},'succeeded'],
    [null,'uncertain'],
  ]) {
    const f=fixture();
    f.scheduler.unsubscribe=f.registry.subscribe((notification) => f.scheduler.onRegistryEvent(notification));
    try {
      await f.scheduler.runNow('st_a');
      const session=f.calls[0].sessionId;
      f.registry.register({sessionId:session,agent:'claude'});
      if(event) f.registry.appendEvent(session,event);
      f.registry.unregister(session,{status:'completed'});
      assert.equal(f.store.executions()[0].status,expected,JSON.stringify(event));
      if(expected==='uncertain') assert.equal(f.store.claim('st_a',{manual:true}).status,'skipped_busy');
    } finally {f.scheduler.stop();f.store.close();}
  }
});

test('a result from a later launch cannot overwrite a fast approval request', async () => {
  const f = fixture(async (payload, registry) => {
    registry.register({sessionId:payload.sessionId,agent:'claude'});
    registry.appendEvent(payload.sessionId, {type:'agent.interaction.requested',interactionId:'p1',kind:'permission'});
    return {accepted:true};
  });
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  await f.scheduler.runNow('st_a');
  assert.equal(f.store.executions()[0].status, 'waiting_approval');
  f.scheduler.stop(); f.store.close();
});

test('unknown launch failures remain uncertain, while workspace validation fails cleanly', async () => {
  for (const [code, expected] of [['WORKSPACE_NOT_TRUSTED','failed'],['AI_REVIEW_POLICY_INVALID','failed'],['AI_REVIEW_POLICY_NOT_APPLICABLE','failed'],['ECONNRESET','uncertain']]) {
    const f = fixture(() => { throw Object.assign(new Error('failed'), {code}); });
    await f.scheduler.runNow('st_a');
    assert.equal(f.store.executions()[0].status, expected);
    f.scheduler.stop(); f.store.close();
  }
});

test('a workspace removed after scheduling is a known failure and never starts an Agent', async () => {
  const root=mkdtempSync(join(tmpdir(),'or-scheduled-missing-workspace-'));
  const workspace=join(root,'workspace'); mkdirSync(workspace);
  const catalog=new AgentCatalog({stateDir:root});
  const trusted=catalog.trustWorkspace(workspace,{deviceId:'device-test'});
  const store=new ScheduledTaskStore({stateDir:root});
  let spawns=0;
  const launcher=new ManagedAgentSupervisor({catalog,deviceId:'device-test',spawnFn:() => {spawns++; throw new Error('unexpected spawn');}});
  const scheduler=new ScheduledTaskScheduler({store,catalog,registry:new ExternalAgentRegistry(),supervisor:launcher,log:{error(){}}});
  try {
    store.save({id:'st_workspace',name:'workspace',schedule:{kind:'once',at:'2099-01-01T00:00:00Z'},
      launch:{agentType:'claude',workspaceId:trusted.workspace_id,initialMessage:'test',permissionProfile:'manual'}});
    rmSync(workspace,{recursive:true});
    await scheduler.runNow('st_workspace');
    assert.equal(store.executions()[0].status,'failed');
    assert.match(store.executions()[0].detail,/workspace/i);
    assert.equal(spawns,0);
    await scheduler.runNow('st_workspace');
    assert.equal(store.executions()[0].status,'failed');
    assert.equal(store.executions().some((item) => item.status==='skipped_busy'),false);
    assert.equal(spawns,0);
  } finally {scheduler.stop();store.close();catalog.close();rmSync(root,{recursive:true,force:true});}
});

test('manual run atomically rejects missing or stale task revisions', async () => {
  const f = fixture();
  try {
    const original = f.store.get('st_a');
    f.store.save({...original, launch:{...original.launch,permissionProfile:'unrestricted'}}, {baseRevision:original.revision});
    await assert.rejects(f.scheduler.handle('run', {id:'st_a'}), {code:'INVALID_SCHEDULED_TASK'});
    await assert.rejects(f.scheduler.handle('run', {id:'st_a',baseRevision:original.revision}), {code:'SCHEDULED_TASK_CONFLICT'});
    assert.equal(f.calls.length,0);
    assert.deepEqual(f.store.executions(),[]);
    const result = await f.scheduler.handle('run', {id:'st_a',baseRevision:original.revision + 1});
    assert.equal(result.execution.status,'running');
    assert.equal(f.calls[0].permissionProfile,'unrestricted');
  } finally { f.scheduler.stop(); f.store.close(); }
});

test('the daemon refuses to launch a different account through its old workspace catalog', async () => {
  const f = fixture();
  f.scheduler.catalog = {stateDir:'/another/account'};
  await assert.rejects(f.scheduler.runNow('st_a'), {code:'SCHEDULED_ACCOUNT_RESTART_REQUIRED'});
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.executions(), []);
  f.scheduler.stop(); f.store.close();
});

test('recovery reconciles durable launch receipts without issuing a new launch', () => {
  const f = fixture();
  const claimed = f.store.claim('st_a', {manual:true});
  f.scheduler.catalog = {stateDir:f.store.dir(), getLaunchReceipt:() => ({accepted:true,sessionId:claimed.sessionId})};
  f.scheduler.recover();
  assert.equal(f.store.executions()[0].status, 'uncertain');
  assert.equal(f.calls.length, 0);
  f.scheduler.stop(); f.store.close();
});

test('shutdown refuses new work and keeps an in-flight launch uncertain even after a late receipt', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(async () => { await gate; return {accepted:true}; });
  const pending = f.scheduler.runNow('st_a');
  assert.equal(f.store.executions()[0].status, 'starting');
  f.scheduler.stop();
  assert.equal(f.store.executions()[0].status, 'uncertain');
  await assert.rejects(f.scheduler.runNow('st_a'), {code:'SCHEDULED_TASKS_STOPPED'});
  await assert.rejects(f.scheduler.handle('save', {}), {code:'SCHEDULED_TASKS_STOPPED'});
  release();
  await pending;
  assert.equal(await f.scheduler.drain(100), true);
  assert.equal(f.store.executions()[0].status, 'uncertain');
  assert.equal(f.calls.length, 1);
  f.store.close();
});

test('shutdown drain is bounded and a late launch does not reopen the closed task database', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture(async () => { await gate; return {accepted:true}; });
  const pending = f.scheduler.handle('run', {id:'st_a', baseRevision:1});
  const rejected = assert.rejects(pending, {code:'SCHEDULED_TASKS_STOPPED'});
  f.scheduler.stop();
  assert.equal(await f.scheduler.drain(10), false);
  const stateDir = f.store.stateDir;
  f.store.close();
  f.scheduler.stop();
  assert.equal(f.store.db, null, 'a repeated stop does not reopen the task database');
  release();
  await rejected;
  assert.equal(f.store.db, null);
  const restarted = new ScheduledTaskStore({stateDir});
  assert.equal(restarted.executions()[0].status, 'uncertain');
  restarted.close();
});

test('a scheduled run stays active while the runtime supervisor plans a retry', async () => {
  const f = fixture();
  let pending = true;
  f.scheduler.runtimeSupervisor = {hasPendingWork:() => pending};
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  await f.scheduler.runNow('st_a');
  const session = f.calls[0].sessionId;
  f.registry.register({sessionId:session,agent:'claude'});
  f.registry.appendEvent(session, {type:'agent.task.failed',error:'overloaded'});
  f.setTime('2026-11-03T00:01:00Z');
  f.scheduler.settleFinishedTurns();
  assert.equal(f.store.executions()[0].status, 'settling');
  assert.equal(f.store.claim('st_a').status, 'skipped_busy');
  pending = false;
  f.scheduler.settleFinishedTurns();
  assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'failed');
  f.scheduler.stop(); f.store.close();
});

test('a restart cannot treat an interrupted supervisor decision as a completed run', async () => {
  const f = fixture();
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  await f.scheduler.runNow('st_a');
  const session = f.calls[0].sessionId;
  f.registry.register({sessionId:session,agent:'claude'});
  f.registry.appendEvent(session, {type:'agent.task.complete'});
  assert.equal(f.store.executions()[0].status, 'settling');
  f.scheduler.stop();
  const restarted = new ScheduledTaskScheduler({store:f.store, registry:new ExternalAgentRegistry(), supervisor:{}, now:() => Date.parse('2026-11-03T00:02:00Z')});
  restarted.recover();
  restarted.settleFinishedTurns();
  assert.equal(f.store.executions()[0].status, 'uncertain');
  assert.equal(f.store.claim('st_a', {manual:true}).status, 'skipped_busy');
  f.store.close();
});

test('restart keeps a formerly running task uncertain on reconnect until a live turn event', async () => {
  const f = fixture();
  await f.scheduler.runNow('st_a');
  const session = f.calls[0].sessionId;
  const registry = new ExternalAgentRegistry();
  const restarted = new ScheduledTaskScheduler({store:f.store, registry, supervisor:{}});
  restarted.unsubscribe = registry.subscribe((event) => restarted.onRegistryEvent(event));
  restarted.recover();
  assert.equal(f.store.executions()[0].status, 'uncertain');
  registry.register({sessionId:session,agent:'claude'});
  assert.equal(f.store.executions()[0].status, 'uncertain');
  registry.appendEvent(session,{type:'agent.task.started'});
  assert.equal(f.store.executions()[0].status, 'running');
  restarted.stop(); f.store.close();
});

test('a lost agent connection keeps the outcome uncertain and blocks another run', async () => {
  const f = fixture();
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  await f.scheduler.runNow('st_a');
  const session = f.calls[0].sessionId;
  f.registry.register({sessionId:session,agent:'claude'});
  f.registry.notify('updated', session, {attached:false, status:'stopped'});
  assert.equal(f.store.executions()[0].status, 'uncertain');
  assert.equal(f.store.claim('st_a', {manual:true}).status, 'skipped_busy');
  f.registry.register({sessionId:session,agent:'claude'});
  assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'uncertain');
  f.registry.appendEvent(session,{type:'agent.interaction.requested',interactionId:'new',kind:'permission'});
  assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'waiting_approval');
  f.scheduler.stop(); f.store.close();
});

test('late events from a stale detached Agent do not resolve its uncertain execution', async () => {
  const f = fixture();
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  try {
    await f.scheduler.runNow('st_a');
    const session = f.calls[0].sessionId;
    f.registry.register({sessionId:session,agent:'claude'});
    f.registry.sessions.get(session).lastSeenAtMs = 0;
    f.registry.expireStale();
    assert.equal(f.store.executions()[0].status, 'uncertain');
    for (const event of [
      {type:'agent.task.started'},
      {type:'agent.interaction.requested',interactionId:'late',kind:'permission'},
      {type:'agent.supervisor.escalated',reason:'needs_user'},
      {type:'agent.task.complete'},
      {type:'agent.task.failed'},
      {type:'agent.task.aborted'},
    ]) {
      f.registry.appendEvent(session,event);
      assert.equal(f.store.executions()[0].status, 'uncertain', event.type);
    }
    assert.equal(f.store.claim('st_a', {manual:true}).status, 'skipped_busy');
    f.registry.register({sessionId:session,agent:'claude'});
    assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'uncertain');
    f.registry.appendEvent(session,{type:'agent.task.started'});
    assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'running');
  } finally {f.scheduler.stop(); f.store.close();}
});

test('a queued stop or interrupt does not permit a second launch before confirmation', async () => {
  for (const command of ['terminal.interrupt', 'session.stop']) {
    const f = fixture();
    f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
    await f.scheduler.runNow('st_a');
    const session = f.calls[0].sessionId;
    f.registry.register({sessionId:session,agent:'claude'});
    f.registry.enqueueCommand(session, {type:command});
    assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'running');
    assert.equal(f.store.claim('st_a', {manual:true}).status, 'skipped_busy');
    f.registry.appendEvent(session, {type:'agent.task.aborted'});
    assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'settling');
    f.setTime('2026-11-03T00:00:03Z');
    f.scheduler.settleFinishedTurns();
    assert.equal(f.store.executions().find((item) => item.sessionId === session).status, 'cancelled');
    f.scheduler.stop(); f.store.close();
  }
});

test('re-registration does not erase a pending approval or a completed turn', async () => {
  const f = fixture();
  f.scheduler.unsubscribe = f.registry.subscribe((event) => f.scheduler.onRegistryEvent(event));
  await f.scheduler.runNow('st_a');
  const session = f.calls[0].sessionId;
  f.registry.register({sessionId:session,agent:'claude'});
  f.registry.appendEvent(session, {type:'agent.interaction.requested',interactionId:'p1',kind:'permission'});
  f.registry.register({sessionId:session,agent:'claude'});
  assert.equal(f.store.executions()[0].status, 'waiting_approval');
  f.registry.appendEvent(session, {type:'agent.task.complete'});
  f.registry.register({sessionId:session,agent:'claude'});
  assert.equal(f.store.executions()[0].status, 'settling');
  f.scheduler.stop(); f.store.close();
});
