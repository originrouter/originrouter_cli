import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeviceToolService } from '../src/mcp/deviceToolService.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { ScheduledTaskStore } from '../src/runtime/scheduledTaskStore.js';
import { ScheduledTaskScheduler } from '../src/runtime/scheduledTaskScheduler.js';

function fixture() {
  const registry=new ExternalAgentRegistry();
  registry.register({sessionId:'s1',agent:'claude',supportsDeviceTools:true});
  let account='a', decision=async () => ({account});
  const approvals=[];
  const broker={authorize:async (id,request) => {approvals.push({id,request}); return decision();}};
  const store=new ScheduledTaskStore({stateDir:mkdtempSync(join(tmpdir(),'device-tool-')),now:() => Date.parse('2026-01-01T00:00Z')});
  const calls=[];
  const scheduled=new ScheduledTaskScheduler({store,supervisor:{start:async (x) => {calls.push(x);return {accepted:true};}}});
  let target={id:'ssh_a',name:'Host',revision:1,host:'example',port:22,username:'user',hostFingerprint:'SHA256:abc',credentialRef:'private-ref'};
  let info={account:'a',targetId:'ssh_a',revision:1,cwd:'/home/user'};
  const manager={
    async open(owner,id,options) {calls.push({kind:'open',owner,id,options});return {handle:'handle',cwd:info.cwd};},
    async sessionInfo(owner,handle) {if (owner !== 's1' || handle !== 'handle') throw Object.assign(new Error('missing'),{code:'REMOTE_ENV_SESSION_NOT_FOUND'});return {...info};},
    async run(owner,handle,command,options) {calls.push({kind:'exec',owner,handle,command,options});return {stdout:'ok',exitCode:0};},
    async chdir(owner,handle,path) {calls.push({kind:'chdir',path});return {cwd:path};},
    async close(owner,handle) {calls.push({kind:'close'});return {closed:true};},
    closeOwner(owner) {calls.push({kind:'closeOwner',owner});},
  };
  const remote={manager,store:{dir:() => account,get:() => ({...target}),list:() => [{id:'ssh_a',name:'Host'}]}};
  const service=new DeviceToolService({registry,broker,scheduled,remote,accountProvider:() => account});
  return {service,registry,store,calls,approvals, setDecision:(fn) => {decision=fn;}, setAccount:(a) => {account=a;},
    setTargetRevision:(n) => {target.revision=n;},setCwd:(p) => {info.cwd=p;},setOutcomeUnknown:(value) => {info.outcomeUnknown=value;},close(){service.close();store.close();}};
}
const task={name:'check', schedule:{kind:'once',at:'2099-01-01T00:00:00Z'}, launch:{agentType:'claude',workspaceId:'w1',initialMessage:'run tests',permissionProfile:'manual'}};

test('model cannot create an AI review task without a user-selected template', async () => {
  const f=fixture(); try {
    await assert.rejects(f.service.handle('s1','scheduled.save',{task:{...task,launch:{...task.launch,permissionProfile:'ai_review'}}}), {code:'DEVICE_TOOL_INVALID'});
    assert.equal(f.store.list().length,0);
  } finally {f.close();}
});

test('model task creation uses the approval and drops unreviewed policy fields', async () => {
  const f=fixture(); try {
    const result=await f.service.handle('s1','scheduled.save',{task:{...task,launch:{...task.launch,policyBundle:{allow:'everything'}}}});
    assert.match(result.task.id,/^st_/);
    assert.equal(result.task.launch.policyBundle,undefined);
    const {revision,nextRunAt,updatedAt,...persisted} = result.task;
    assert.deepEqual(f.approvals[0].request.input.task,persisted);
  } finally {f.close();}
});

test('denied actions do not mutate a schedule and a stale approval cannot run it', async () => {
  const f=fixture(); try {
    f.setDecision(async () => {throw Object.assign(new Error('denied'),{code:'DEVICE_TOOL_DENIED'});});
    await assert.rejects(f.service.handle('s1','scheduled.save',{task}),{code:'DEVICE_TOOL_DENIED'});
    assert.equal(f.store.list().length,0);
    f.setDecision(async () => ({account:'a'}));
    const saved=await f.service.handle('s1','scheduled.save',{task});
    f.setDecision(async () => { f.store.save({...saved.task,name:'changed'},{baseRevision:1}); return {account:'a'}; });
    await assert.rejects(f.service.handle('s1','scheduled.run',{id:saved.task.id}),{code:'SCHEDULED_TASK_CONFLICT'});
    assert.equal(f.calls.length,0);
  } finally {f.close();}
});

test('SSH execution approves exact command and directory without exposing credentials', async () => {
  const f=fixture(); try {
    f.setDecision(async () => {f.setCwd('/other');return {account:'a'};});
    const result=await f.service.handle('s1','remote.exec',{handle:'handle',command:'pwd'});
    assert.equal(result.stdout,'ok');
    assert.equal(f.calls[0].options.cwd,'/home/user');
    assert.equal(f.approvals[0].request.input.command,'pwd');
    assert.equal(JSON.stringify(f.approvals).includes('private-ref'),false);
  } finally {f.close();}
});

test('an uncertain SSH session rejects new work before approval but can be closed', async () => {
  const f=fixture(); try {
    f.setOutcomeUnknown(true);
    await assert.rejects(f.service.handle('s1','remote.exec',{handle:'handle',command:'pwd'}), {code:'REMOTE_ENV_SESSION_UNCERTAIN'});
    await assert.rejects(f.service.handle('s1','remote.chdir',{handle:'handle',path:'/tmp'}), {code:'REMOTE_ENV_SESSION_UNCERTAIN'});
    assert.equal(f.approvals.length,0);
    assert.deepEqual(await f.service.handle('s1','remote.close',{handle:'handle'}), {closed:true});
    assert.equal(f.approvals[0].request.input.outcomeUnknown,true);
  } finally {f.close();}
});

test('SSH target changes and account changes invalidate a prior approval', async () => {
  const f=fixture(); try {
    f.setDecision(async () => {f.setTargetRevision(2);return {account:'a'};});
    // The real SSH manager also checks expectedRevision at open time.
    const opened=await f.service.handle('s1','remote.open',{id:'ssh_a'});
    assert.equal(opened.handle,'handle'); assert.equal(f.calls[0].options.expectedRevision,1);
    f.setDecision(async () => {f.setAccount('b');return {account:'a'};});
    await assert.rejects(f.service.handle('s1','remote.list',{}),{code:'DEVICE_TOOL_ACCOUNT_CHANGED'});
  } finally {f.close();}
});

test('session detach closes owned SSH sessions and unknown sessions are refused', async () => {
  const f=fixture(); try {
    await assert.rejects(f.service.handle('missing','remote.list',{}),{code:'DEVICE_TOOL_UNAVAILABLE'});
    f.registry.unregister('s1');
    assert.deepEqual(f.calls,[{kind:'closeOwner',owner:'s1'}]);
  } finally {f.close();}
});
