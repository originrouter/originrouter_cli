import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import ssh2 from 'ssh2';
import { SshConnectionManager, sshHostFingerprint } from '../src/remoteEnvironment/sshConnectionManager.js';
import { probeSshHostKey } from '../src/remoteEnvironment/hostKeyProbe.js';
import { RemoteEnvironmentService } from '../src/remoteEnvironment/remoteEnvironmentService.js';
import { DeviceToolService } from '../src/mcp/deviceToolService.js';
import { DeviceToolApprovalBroker } from '../src/mcp/deviceToolApprovalBroker.js';
import { PendingInteractionRegistry } from '../src/runtime/pendingInteractionRegistry.js';
import { createDeviceToolApprovalHandler } from '../src/runtime/deviceToolApproval.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';

const { Server, utils } = ssh2;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const { privateKey: clientKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const parsedClientKey = utils.parseKey(clientKey);
const hostFingerprint = sshHostFingerprint(utils.parseKey(privateKey).getPublicSSH());

async function fixture({settings = undefined} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'or-ssh-test-')));
  mkdirSync(join(root, 'one'));
  mkdirSync(join(root, 'two'));
  let count = 0;
  let authenticationAttempts = 0;
  let credential = {kind:'password', password:'secret'};
  const connections = new Set();
  const children = new Set();
  const commands = [];
  const signals = [];
  const exitGroup = (child, name) => { try { process.kill(-child.pid, name); } catch {} };
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    count++;
    connections.add(client);
    client.on('close', () => connections.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      authenticationAttempts++;
      if (ctx.username !== 'test') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'secret') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.data.equals(parsedClientKey.getPublicSSH())
        && (!ctx.signature || parsedClientKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) return ctx.accept();
      return ctx.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      let running = null;
      // sshd turns a signal request into a killpg of the session's process
      // group: the exec child is a session leader (setsid), so one request
      // reaches the command and everything it started.
      session.on('signal', (acceptSignal, _reject, {name}) => {
        signals.push(name);
        if (running && running.exitCode == null && running.signalCode == null) exitGroup(running, `SIG${name}`);
        acceptSignal?.();
      });
      session.on('exec', (acceptExec, reject, info) => {
        commands.push(info.command);
        // A server can process an exec request and then fail or lose its
        // acknowledgement. Simulate a side effect before rejecting it.
        if (info.command.includes('test-uncertain-rejection')) {
          writeFileSync(join(root, 'remote-side-effect'), 'done');
          return reject();
        }
        const stream = acceptExec();
        const child = spawn('/bin/sh', ['-c', info.command], { cwd:root, detached:true, stdio:['ignore','pipe','pipe'] });
        running = child;
        children.add(child);
        child.stdout.pipe(stream, {end:false});
        child.stderr.pipe(stream.stderr, {end:false});
        child.on('close', (code, exitSignal) => { children.delete(child); if (running === child) running = null; try { stream.exit(code ?? 1, exitSignal || undefined); stream.end(); } catch {} });
        // Closing the channel is not a signal: like sshd, the remote process
        // keeps running until the host is told to end it.
        stream.on('error', () => {});
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = { id:'host-1', revision:1, host:'127.0.0.1', port:server.address().port, username:'test', hostFingerprint, defaultDirectory:root };
  let account = 'user-a';
  let behavior = settings === undefined ? null : settings;
  const manager = new SshConnectionManager({targetProvider:async (id) => id === target.id ? target : null,
    credentialProvider:async () => credential, accountProvider:async () => account, idleMs:100,
    ...(behavior === null ? {} : {settingsProvider:() => behavior})});
  return {root, target, manager, commands, signals, children,
    get count(){return count;}, get authenticationAttempts(){return authenticationAttempts;}, setAccount(value){account=value;},
    setBehavior(value) { behavior = value; },
    setCredential(value) { credential = value; },
    disconnect() { for (const conn of connections) conn.end(); },
    async stop() { manager.shutdown(); for (const child of children) { exitGroup(child, 'SIGKILL'); child.kill('SIGKILL'); } for (const conn of connections) conn.end();
      await new Promise((resolve) => server.close(resolve)); rmSync(root, {recursive:true,force:true}); }};
}

test('real SSH connection is reused while working directories stay session scoped', async () => {
  const f = await fixture();
  try {
    const a = await f.manager.open('agent-a', 'host-1');
    const b = await f.manager.open('agent-b', 'host-1');
    assert.equal(f.count, 1);
    assert.equal((await f.manager.chdir('agent-a', a.handle, join(f.root, 'one'))).cwd, join(f.root, 'one'));
    assert.equal((await f.manager.run('agent-a', a.handle, 'pwd')).stdout.trim(), join(f.root, 'one'));
    assert.equal((await f.manager.run('agent-b', b.handle, 'pwd')).stdout.trim(), f.root);
    await assert.rejects(f.manager.run('agent-b', a.handle, 'pwd'), {code:'REMOTE_ENV_SESSION_NOT_FOUND'});
    await f.manager.close('agent-a', a.handle);
    assert.equal((await f.manager.run('agent-b', b.handle, 'printf still-open')).stdout, 'still-open');
  } finally { await f.stop(); }
});

test('management cannot list or close a session across accounts', async () => {
  const f = await fixture();
  try {
    const session = await f.manager.open('agent-a', 'host-1');
    assert.equal(f.manager.managementSessions('user-a').length,1);
    assert.deepEqual(f.manager.managementSessions('user-b'),[]);
    f.setAccount('user-b');
    await assert.rejects(f.manager.closeManagedSession('host-1',session.handle,'user-a'),{code:'REMOTE_ENV_ACCOUNT_CHANGED'});
    assert.deepEqual(f.manager.managementSessions('user-b'),[]);
    assert.deepEqual(await f.manager.closeManagedSession('host-1',session.handle,'user-b'),{closed:false});
  } finally {await f.stop();}
});

test('management reports a disconnected transport without hiding its logical session', async () => {
  const f = await fixture();
  try {
    const session = await f.manager.open('agent-a','host-1');
    assert.equal(f.manager.managementSessions('user-a')[0].connected,true);
    f.disconnect();
    const deadline = Date.now() + 3000;
    while (f.manager.managementSessions('user-a')[0].connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve,10));
    }
    const [record] = f.manager.managementSessions('user-a');
    assert.equal(record.handle,session.handle);
    assert.equal(record.connected,false);
    assert.deepEqual(await f.manager.closeManagedSession('host-1',session.handle,'user-a'),{closed:true});
  } finally {await f.stop();}
});

test('host key discovery returns a fingerprint without attempting authentication', async () => {
  const f = await fixture();
  try {
    const result = await probeSshHostKey({host:f.target.host, port:f.target.port});
    assert.equal(result.fingerprint, hostFingerprint);
    assert.equal(result.algorithm, 'ssh-rsa');
    assert.equal(f.authenticationAttempts, 0);
  } finally { await f.stop(); }
});

test('management service saves a verified target and invalidates sessions when it changes', async () => {
  const f = await fixture();
  const stateDir = mkdtempSync(join(tmpdir(), 'or-remote-service-'));
  const secrets = new Map();
  const vault = {put:async (key,value) => secrets.set(key, value), get:async (key) => secrets.get(key), remove:async (key) => secrets.delete(key)};
  const service = new RemoteEnvironmentService({stateDir, vault});
  const target = {...f.target, id:'ssh_a', name:'test host'};
  try {
    const probe = await service.handle('probe', {host:target.host, port:target.port});
    assert.equal(probe.fingerprint, target.hostFingerprint);
    await assert.rejects(service.handle('save', {target, credential:{kind:'password',password:'secret'}}), {code:'REMOTE_ENV_CONFIRM_FINGERPRINT'});
    const saved = await service.handle('save', {target, confirmedFingerprint:probe.fingerprint, credential:{kind:'password',password:'secret'}});
    assert.equal(saved.target.revision,1);
    assert.equal(JSON.stringify(await service.handle('list')).includes('secret'),false);
    assert.equal((await service.handle('test', {id:target.id})).cwd, f.root);
    const session = await service.manager.open('agent', target.id);
    assert.equal((await service.handle('list')).targets[0].connection,'connected');
    await service.handle('save', {target:{...target,name:'updated'},baseRevision:1,confirmedFingerprint:probe.fingerprint});
    await assert.rejects(service.manager.run('agent', session.handle, 'pwd'), {code:'REMOTE_ENV_SESSION_NOT_FOUND'});
    assert.equal((await service.handle('list')).targets[0].connection,'disconnected');
  } finally { service.close(); rmSync(stateDir,{recursive:true,force:true}); await f.stop(); }
});

test('management lists and closes only the selected account and target session', async () => {
  const f = await fixture();
  const stateDir = mkdtempSync(join(tmpdir(), 'or-remote-management-'));
  const secrets = new Map();
  const service = new RemoteEnvironmentService({stateDir, vault:{
    put:async (key,value) => secrets.set(key,value),
    get:async (key) => secrets.get(key),
    remove:async (key) => secrets.delete(key),
  }});
  const target = {...f.target,id:'ssh_a',name:'host'};
  try {
    await service.handle('save',{target,confirmedFingerprint:hostFingerprint,credential:{kind:'password',password:'secret'}});
    const first = await service.manager.open('agent-a',target.id);
    const second = await service.manager.open('agent-b',target.id);
    const result = await service.handle('list');
    assert.deepEqual(result.sessions.map(({handle,agentSessionId,cwd,outcomeUnknown}) => ({handle,agentSessionId,cwd,outcomeUnknown})), [
      {handle:first.handle,agentSessionId:'agent-a',cwd:f.root,outcomeUnknown:false},
      {handle:second.handle,agentSessionId:'agent-b',cwd:f.root,outcomeUnknown:false},
    ]);
    assert.equal(JSON.stringify(result).includes('secret'),false);
    assert.deepEqual(await service.handle('close_session',{id:'other',handle:first.handle}),{closed:false});
    assert.deepEqual(await service.handle('close_session',{id:target.id,handle:first.handle}),{closed:true});
    await assert.rejects(service.manager.run('agent-a',first.handle,'pwd'),{code:'REMOTE_ENV_SESSION_NOT_FOUND'});
    assert.equal((await service.manager.run('agent-b',second.handle,'printf ok')).stdout,'ok');
    assert.equal((await service.handle('list')).sessions.length,1);
  } finally {service.close();rmSync(stateDir,{recursive:true,force:true});await f.stop();}
});

test('a reviewed model tool can reuse a real SSH connection without receiving its credential', async () => {
  const f = await fixture();
  const stateDir = mkdtempSync(join(tmpdir(), 'or-remote-tool-'));
  const secrets = new Map(), approvals = [];
  const vault = {put:async (k,v) => secrets.set(k,v),get:async (k) => secrets.get(k),remove:async (k) => secrets.delete(k)};
  const remote = new RemoteEnvironmentService({stateDir,vault});
  const registry = new ExternalAgentRegistry();
  registry.register({sessionId:'agent',agent:'claude',supportsDeviceTools:true});
  const broker = {authorize:async (owner,request) => {approvals.push(request); return {account:remote.store.dir()};}};
  const service = new DeviceToolService({registry,broker,remote,accountProvider:() => remote.store.dir()});
  const target = {...f.target,id:'ssh_a',name:'test'};
  try {
    await remote.handle('save',{target,confirmedFingerprint:hostFingerprint,credential:{kind:'password',password:'secret'}});
    const opened = await service.handle('agent','remote.open',{id:'ssh_a'});
    const one = await service.handle('agent','remote.exec',{handle:opened.handle,command:'printf one'});
    const two = await service.handle('agent','remote.exec',{handle:opened.handle,command:'printf two'});
    assert.equal(one.stdout,'one'); assert.equal(two.stdout,'two'); assert.equal(f.count,1);
    assert.equal(JSON.stringify(approvals).includes('secret'),false);
    assert.equal(JSON.stringify(approvals).includes('credentialRef'),false);
    await service.handle('agent','remote.close',{handle:opened.handle});
  } finally {service.close();remote.close();rmSync(stateDir,{recursive:true,force:true});await f.stop();}
});

test('an approved SSH command keeps its reviewed directory even when another operation changes the session directory', async () => {
  const f=await fixture();
  const stateDir=mkdtempSync(join(tmpdir(),'or-ssh-cwd-review-'));
  const secrets=new Map();
  const vault={put:async (k,v) => secrets.set(k,v),get:async (k) => secrets.get(k),remove:async (k) => secrets.delete(k)};
  const remote=new RemoteEnvironmentService({stateDir,vault});
  const registry=new ExternalAgentRegistry();
  registry.register({sessionId:'agent',agent:'claude',supportsDeviceTools:true});
  let release, requested;
  const gate=new Promise((resolve) => {release=resolve;});
  const approvalStarted=new Promise((resolve) => {requested=resolve;});
  const broker={authorize:async (_owner,request) => {
    if(request.tool==='originrouter.remote.exec') {requested(request);await gate;}
    return {account:remote.store.dir()};
  }};
  const service=new DeviceToolService({registry,broker,remote,accountProvider:() => remote.store.dir()});
  try {
    await remote.handle('save',{target:{...f.target,id:'ssh_a',name:'fixture'},confirmedFingerprint:hostFingerprint,
      credential:{kind:'password',password:'secret'}});
    const opened=await service.handle('agent','remote.open',{id:'ssh_a'});
    const pending=service.handle('agent','remote.exec',{handle:opened.handle,command:'pwd'});
    const request=await approvalStarted;
    assert.equal(request.input.cwd,f.root);
    await remote.manager.chdir('agent',opened.handle,join(f.root,'one'));
    release();
    assert.equal((await pending).stdout.trim(),f.root);
    assert.equal((await remote.manager.sessionInfo('agent',opened.handle)).cwd,join(f.root,'one'));
  } finally {release();service.close();remote.close();rmSync(stateDir,{recursive:true,force:true});await f.stop();}
});

test('real approval decisions control real SSH commands and a changed host invalidates pending approval', {timeout:10000}, async () => {
  const f = await fixture();
  const stateDir = mkdtempSync(join(tmpdir(), 'or-ssh-approved-'));
  const secrets = new Map();
  const vault = {put:async (k,v) => secrets.set(k,v),get:async (k) => secrets.get(k),remove:async (k) => secrets.delete(k)};
  const remote = new RemoteEnvironmentService({stateDir,vault});
  const registry = new ExternalAgentRegistry();
  registry.register({sessionId:'agent',agent:'claude',supportsDeviceTools:true});
  const broker = new DeviceToolApprovalBroker({registry,accountProvider:() => remote.store.dir(),timeoutMs:5000});
  const service = new DeviceToolService({registry,broker,remote,accountProvider:() => remote.store.dir()});
  const interactions = new PendingInteractionRegistry({onRequested:async (event) => registry.appendEvent('agent',event)});
  const handler = createDeviceToolApprovalHandler({sessionId:'agent',provider:'claude',runtime:'claude-sdk',revision:() => 1,
    requestInteraction:(request,signal) => interactions.request(request,signal),
    markApplied:(result) => interactions.markResult(result.interactionId,'applied',{responseId:result.responseId}),
    sendResult:async (event) => registry.notify('device_tool_approval_result','agent',event),
  });
  const unsubscribe = registry.subscribe(({type,payload}) => {
    if (type === 'command' && payload.type === 'agent.device_tool.approval') handler.start(payload);
    if (type === 'command' && payload.type === 'agent.device_tool.cancel') handler.cancel(payload.requestId);
  });
  const target = {...f.target,id:'ssh_a',name:'approval host'};
  const pendingRequest = async () => {
    for (let i=0; i<1000; i++) {
      const request = interactions.snapshot()[0];
      if (request) return request;
      await new Promise((resolve) => setTimeout(resolve,5));
    }
    throw new Error('approval request timed out');
  };
  const decide = (request,action) => interactions.resolve({interactionId:request.interactionId,responseId:`r-${request.interactionId}`,action});
  try {
    await remote.handle('save',{target,confirmedFingerprint:hostFingerprint,credential:{kind:'password',password:'secret'}});
    const opening = service.handle('agent','remote.open',{id:'ssh_a'});
    let request = await pendingRequest();
    assert.equal(request.payload.tool_input.target.host,'127.0.0.1');
    assert.equal(JSON.stringify(request).includes('secret'),false);
    assert.equal(f.count,0, 'the SSH connection must wait for approval');
    decide(request,'allow');
    const opened = await opening;
    const denied = service.handle('agent','remote.exec',{handle:opened.handle,command:'printf denied-command'});
    const deniedResult = assert.rejects(denied,{code:'DEVICE_TOOL_DENIED'});
    request = await pendingRequest();
    assert.equal(request.payload.tool_input.command,'printf denied-command');
    assert.equal(request.payload.tool_input.cwd,f.root);
    decide(request,'deny');
    await deniedResult;
    assert.equal(f.commands.some((command) => command.includes('denied-command')),false);
    const allowed = service.handle('agent','remote.exec',{handle:opened.handle,command:'printf approved-command'});
    request = await pendingRequest();
    assert.equal(request.payload.tool_input.command,'printf approved-command');
    decide(request,'allow');
    assert.equal((await allowed).stdout,'approved-command');
    assert.equal(f.count,1, 'approved commands reuse the verified connection');
    const stale = service.handle('agent','remote.exec',{handle:opened.handle,command:'printf stale-command'});
    const staleResult = assert.rejects(stale,{code:'REMOTE_ENV_SESSION_NOT_FOUND'});
    request = await pendingRequest();
    await remote.handle('save',{target:{...target,name:'edited'},baseRevision:1,confirmedFingerprint:hostFingerprint});
    decide(request,'allow');
    await staleResult;
    assert.equal(f.commands.some((command) => command.includes('stale-command')),false);
  } finally {
    unsubscribe(); handler.close(); service.close(); broker.close(); remote.close();
    rmSync(stateDir,{recursive:true,force:true}); await f.stop();
  }
});

test('private-key authentication works over a verified connection', async () => {
  const f = await fixture();
  try {
    f.setCredential({kind:'private_key', privateKey:clientKey});
    const session = await f.manager.open('agent', 'host-1');
    assert.equal((await f.manager.run('agent', session.handle, 'printf key-ok')).stdout, 'key-ok');
  } finally { await f.stop(); }
});

test('host fingerprints are mandatory and changed keys cannot authenticate', async () => {
  const f = await fixture();
  try {
    f.target.hostFingerprint = '';
    await assert.rejects(f.manager.open('agent', 'host-1'), {code:'REMOTE_ENV_HOST_KEY_REQUIRED'});
    f.target.hostFingerprint = `SHA256:${'A'.repeat(43)}`;
    await assert.rejects(f.manager.open('agent', 'host-1'), {code:'REMOTE_ENV_HOST_KEY_MISMATCH'});
    assert.equal(f.manager.connections.size, 0);
  } finally { await f.stop(); }
});

test('commands are serialized per session, output is bounded, and paths are quoted', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "dir'quote");
    mkdirSync(path);
    const a = await f.manager.open('agent', 'host-1');
    await f.manager.chdir('agent', a.handle, path);
    const [first, second] = await Promise.all([
      f.manager.run('agent', a.handle, 'sleep 0.1; printf first'),
      f.manager.run('agent', a.handle, 'printf second'),
    ]);
    assert.equal(first.stdout, 'first'); assert.equal(second.stdout, 'second');
    assert.ok(f.commands.findIndex((x) => x.includes('printf first')) < f.commands.findIndex((x) => x.includes('printf second')));
    const output = await f.manager.run('agent', a.handle, 'printf 123456789', {maxOutputBytes:4});
    assert.equal(output.stdout, '1234'); assert.equal(output.truncated, true);
    await assert.rejects(f.manager.chdir('agent', a.handle, '/not/a/real/path'), {code:'REMOTE_ENV_DIRECTORY_UNAVAILABLE'});
    assert.equal((await f.manager.run('agent', a.handle, 'pwd')).stdout.trim(), path);
    const marker = join(f.root, 'must-not-exist');
    const failed = await f.manager.run('agent', a.handle, `printf first; touch '${marker}'`, {cwd:'/not/a/real/path'});
    assert.notEqual(failed.exitCode, 0);
    assert.equal(existsSync(marker), false);
  } finally { await f.stop(); }
});

test('a connection lost while a command is running is never replayed', async () => {
  const f = await fixture();
  try {
    const session = await f.manager.open('agent', 'host-1');
    const result = f.manager.run('agent', session.handle, 'sleep 1; printf completed');
    while (!f.commands.some((command) => command.includes('printf completed'))) await new Promise((resolve) => setTimeout(resolve, 5));
    f.disconnect();
    await assert.rejects(result, {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    assert.equal(f.commands.filter((command) => command.includes('printf completed')).length, 1);
    await assert.rejects(f.manager.run('agent', session.handle, 'pwd'), {code:'REMOTE_ENV_DISCONNECTED'});
  } finally { await f.stop(); }
});

test('closing one session cancels its channel without closing another session', async () => {
  const f = await fixture();
  try {
    const a = await f.manager.open('agent-a', 'host-1');
    const b = await f.manager.open('agent-b', 'host-1');
    const pending = f.manager.run('agent-a', a.handle, 'sleep 1; printf long-command');
    while (!f.commands.some((command) => command.includes('long-command'))) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.manager.close('agent-a', a.handle);
    await assert.rejects(pending, {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    assert.equal((await f.manager.run('agent-b', b.handle, 'printf ok')).stdout, 'ok');
    assert.equal(f.count, 1);
  } finally { await f.stop(); }
});

test('a cancelled queued command is never sent to the SSH host', async () => {
  const f=await fixture();
  try {
    const session=await f.manager.open('agent','host-1');
    const first=f.manager.run('agent',session.handle,'sleep 0.15; printf first');
    const controller=new AbortController();
    const second=f.manager.run('agent',session.handle,'printf must-not-run',{signal:controller.signal});
    const rejected=assert.rejects(second,{code:'REMOTE_ENV_CANCELLED'});
    controller.abort();
    await first; await rejected;
    assert.equal(f.commands.some((command) => command.includes('must-not-run')),false);
  } finally {await f.stop();}
});

test('switching accounts while a secret is being read prevents authentication', async () => {
  const f = await fixture();
  let account = 'user-a', release;
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = new SshConnectionManager({targetProvider:async () => f.target,
    credentialProvider:async () => { await gate; return {kind:'password', password:'secret'}; }, accountProvider:async () => account});
  try {
    const pending = manager.open('agent', 'host-1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    account = 'user-b';
    release();
    await assert.rejects(pending, {code:'REMOTE_ENV_ACCOUNT_CHANGED'});
    assert.equal(f.count, 0);
  } finally { manager.shutdown(); await f.stop(); }
});

test('an Agent ending during SSH connection cannot leave a session, while another owner may connect', {timeout:5000}, async () => {
  const f = await fixture();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const credentialStarted = new Promise((resolve) => { started = resolve; });
  const manager = new SshConnectionManager({targetProvider:async () => f.target,
    credentialProvider:async () => { started(); await gate; return {kind:'password', password:'secret'}; },
    accountProvider:async () => 'user-a', idleMs:100});
  try {
    const first = manager.open('agent-a', 'host-1');
    const firstRejected = assert.rejects(first, {code:'REMOTE_ENV_SESSION_ENDED'});
    await credentialStarted;
    const second = manager.open('agent-b', 'host-1');
    while ([...manager.connections.values()][0]?.references !== 2) await new Promise((resolve) => setTimeout(resolve, 1));
    manager.closeOwner('agent-a');
    release();
    await firstRejected;
    const opened = await second;
    assert.equal((await manager.run('agent-b', opened.handle, 'printf ok')).stdout, 'ok');
    assert.equal(manager.sessions.size, 1);
    assert.equal(f.count, 1);
  } finally { release(); manager.shutdown(); await f.stop(); }
});

test('an abandoned pending SSH connection never sends credentials to the host', {timeout:5000}, async () => {
  const f = await fixture();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const credentialStarted = new Promise((resolve) => { started = resolve; });
  const manager = new SshConnectionManager({targetProvider:async () => f.target,
    credentialProvider:async () => { started(); await gate; return {kind:'password', password:'secret'}; },
    accountProvider:async () => 'user-a'});
  try {
    const pending = manager.open('agent-a', 'host-1');
    const rejected = assert.rejects(pending, {code:'REMOTE_ENV_SESSION_ENDED'});
    await credentialStarted;
    manager.closeOwner('agent-a');
    release();
    await rejected;
    assert.equal(f.count, 0);
    assert.equal(manager.connections.size, 0);
    assert.equal(manager.sessions.size, 0);
  } finally { release(); manager.shutdown(); await f.stop(); }
});

test('timeouts report unknown outcome and account switching invalidates handles', async () => {
  const f = await fixture();
  try {
    const a = await f.manager.open('agent', 'host-1');
    await assert.rejects(f.manager.run('agent', a.handle, 'sleep 1', {timeoutMs:50}), {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    f.setAccount('user-b');
    await assert.rejects(f.manager.run('agent', a.handle, 'pwd'), {code:'REMOTE_ENV_SESSION_NOT_FOUND'});
    const b = await f.manager.open('agent', 'host-1');
    assert.equal((await f.manager.run('agent', b.handle, 'printf new-account')).stdout, 'new-account');
  } finally { await f.stop(); }
});

test('an unconfirmed SSH exec acknowledgement freezes the session even if the host performed a side effect', async () => {
  const f = await fixture();
  try {
    const opened = await f.manager.open('agent', 'host-1');
    await assert.rejects(f.manager.run('agent', opened.handle, 'test-uncertain-rejection'), {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    assert.equal(existsSync(join(f.root, 'remote-side-effect')), true);
    assert.equal((await f.manager.sessionInfo('agent', opened.handle)).outcomeUnknown, true);
    await assert.rejects(f.manager.run('agent', opened.handle, 'printf must-not-run'), {code:'REMOTE_ENV_SESSION_UNCERTAIN'});
    assert.equal(f.commands.some((command) => command.includes('must-not-run')), false);
    await f.manager.close('agent', opened.handle);
  } finally { await f.stop(); }
});

test('after a command times out, queued commands cannot start on that session', async () => {
  const f = await fixture();
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const first = f.manager.run('agent', opened.handle, 'sleep 1; printf unfinished', {timeoutMs:50});
    const second = f.manager.run('agent', opened.handle, 'printf must-not-run');
    const firstRejected = assert.rejects(first, {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    const secondRejected = assert.rejects(second, {code:'REMOTE_ENV_SESSION_UNCERTAIN'});
    await firstRejected; await secondRejected;
    assert.equal(f.commands.some((command) => command.includes('must-not-run')), false);
    assert.equal((await f.manager.sessionInfo('agent', opened.handle)).outcomeUnknown, true);
    await assert.rejects(f.manager.chdir('agent', opened.handle, f.root), {code:'REMOTE_ENV_SESSION_UNCERTAIN'});
    assert.deepEqual(await f.manager.close('agent', opened.handle), {closed:true});
  } finally { await f.stop(); }
});

test('closing a session ends the remote processes it started', async () => {
  const f = await fixture();
  const marker = join(f.root, 'killed-marker');
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const running = f.manager.run('agent', opened.handle, `sleep 30; printf alive > '${marker}'`);
    const rejected = assert.rejects(running, {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    while (!f.commands.some((command) => command.includes('killed-marker'))) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.manager.close('agent', opened.handle);
    await rejected;
    // The signal request reaches the session's process group, so the command
    // dies instead of finishing its work on the host.
    assert.ok(f.signals.length >= 1, 'the session is closed with a signal request');
    // A short sleep would make the kill a race against the command's own end;
    // a long one cannot end on its own, so the dead child is the proof.
    const deadline = Date.now() + 5000;
    while (f.children.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.children.size, 0, 'the remote process group was ended');
    assert.equal(existsSync(marker), false);
  } finally { await f.stop(); }
});

test('turning the behavior off leaves the remote process running after the session closes', async () => {
  const f = await fixture({settings:{killRemoteProcesses:false, backgroundTasks:true}});
  const marker = join(f.root, 'survived-marker');
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const rejected = f.manager.run('agent', opened.handle, `sleep 0.5; printf alive > '${marker}'`);
    while (!f.commands.some((command) => command.includes('survived-marker'))) await new Promise((resolve) => setTimeout(resolve, 5));
    // Only the channel ends; the host is never told to end the command.
    await f.manager.close('agent', opened.handle);
    await assert.rejects(rejected, {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(marker), true);
    assert.deepEqual(f.signals, []);
  } finally { await f.stop(); }
});

test('a command is never re-parsed by the shell that carries it', async () => {
  const f = await fixture();
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const command = "printf '%s' 'a)b('; printf '|%s' \"it's\"; printf '|%s' 'x\"y'; printf '|%s' '$HOME'";
    const result = await f.manager.run('agent', opened.handle, command);
    assert.equal(result.stdout, 'a)b(|it\'s|x"y|$HOME');
    assert.equal(result.exitCode, 0);
  } finally { await f.stop(); }
});

test('an Agent ending ends the remote processes it started', async () => {
  const f = await fixture();
  const marker = join(f.root, 'owner-detach-marker');
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const rejected = f.manager.run('agent', opened.handle, `sleep 30; printf alive > '${marker}'`);
    while (!f.commands.some((command) => command.includes('owner-detach-marker'))) await new Promise((resolve) => setTimeout(resolve, 5));
    f.manager.closeOwner('agent');
    await assert.rejects(rejected, {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    assert.ok(f.signals.length >= 1, 'detach sends a signal request, not only a channel close');
    const deadline = Date.now() + 5000;
    while (f.children.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.children.size, 0, 'the remote process group was ended');
    assert.equal(existsSync(marker), false);
  } finally { await f.stop(); }
});

test('an Agent ending leaves the remote process running when the behavior is off', async () => {
  const f = await fixture({settings:{killRemoteProcesses:false, backgroundTasks:true}});
  const marker = join(f.root, 'owner-detach-survived');
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const rejected = f.manager.run('agent', opened.handle, `sleep 0.5; printf alive > '${marker}'`);
    while (!f.commands.some((command) => command.includes('owner-detach-survived'))) await new Promise((resolve) => setTimeout(resolve, 5));
    f.manager.closeOwner('agent');
    // The channel ending does not tell the host anything about the command.
    await assert.rejects(Promise.race([rejected, new Promise((resolve) => setTimeout(resolve, 1500))]), {code:'REMOTE_ENV_OUTCOME_UNKNOWN'});
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(marker), true);
    assert.deepEqual(f.signals, []);
  } finally { await f.stop(); }
});

test('a background task ends with the session that started it', async () => {
  const f = await fixture();
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const job = await f.manager.start('agent', opened.handle, 'sleep 5; printf never');
    await f.manager.close('agent', opened.handle);
    await assert.rejects(f.manager.jobOutput('agent', opened.handle, job.jobId), {code:'REMOTE_ENV_SESSION_NOT_FOUND'});
    // The job's exec was still confirming when the session closed, so the
    // signal is sent as soon as its channel exists.
    const deadline = Date.now() + 3000;
    while (!f.signals.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(f.signals.length >= 1, 'closing the session signals the job');
  } finally { await f.stop(); }
});

test('a background task runs alongside the session, reports new output, and can be stopped', async () => {
  const f = await fixture();
  try {
    const opened = await f.manager.open('agent', 'host-1');
    // The job holds its own channel, so the session is still usable while it runs.
    const started = await f.manager.start('agent', opened.handle, 'printf one; sleep 0.2; printf two');
    assert.equal((await f.manager.run('agent', opened.handle, 'printf foreground')).stdout, 'foreground');
    const deadline = Date.now() + 3000;
    let read = await f.manager.jobOutput('agent', opened.handle, started.jobId);
    while (!read.done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      read = await f.manager.jobOutput('agent', opened.handle, started.jobId);
    }
    assert.equal(read.output, 'onetwo');
    assert.equal(read.done, true);
    assert.equal(read.exitCode, 0);

    const slow = await f.manager.start('agent', opened.handle, 'sleep 5; printf never');
    const killed = await f.manager.killJob('agent', opened.handle, slow.jobId);
    assert.deepEqual(killed, {killed:true, ended:true});
    const after = await f.manager.jobOutput('agent', opened.handle, slow.jobId);
    assert.equal(after.done, true);
    assert.equal(after.terminated, true);
    assert.deepEqual(await f.manager.killJob('agent', opened.handle, slow.jobId), {killed:false, ended:true});
    await assert.rejects(f.manager.jobOutput('agent', opened.handle, 'rj_missing'), {code:'REMOTE_ENV_JOB_NOT_FOUND'});
    await f.manager.close('agent', opened.handle);
  } finally { await f.stop(); }
});

test('background reads keep the offset the caller was given and report a moved window', async () => {
  const f = await fixture();
  try {
    const opened = await f.manager.open('agent', 'host-1');
    const job = await f.manager.start('agent', opened.handle, 'printf 1234567890', {maxOutputBytes:4});
    const deadline = Date.now() + 3000;
    let read = await f.manager.jobOutput('agent', opened.handle, job.jobId);
    while (!read.done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      read = await f.manager.jobOutput('agent', opened.handle, job.jobId);
    }
    assert.equal(read.nextOffset, 10);
    assert.equal(read.output, '7890');
    assert.equal((await f.manager.jobOutput('agent', opened.handle, job.jobId, {fromByte:2})).lost, true);
    assert.equal((await f.manager.jobOutput('agent', opened.handle, job.jobId, {fromByte:8})).output, '90');
    await f.manager.close('agent', opened.handle);
  } finally { await f.stop(); }
});

test('turning background tasks off refuses to start one', async () => {
  const f = await fixture({settings:{killRemoteProcesses:true, backgroundTasks:false}});
  try {
    const opened = await f.manager.open('agent', 'host-1');
    await assert.rejects(f.manager.start('agent', opened.handle, 'printf no'), {code:'REMOTE_ENV_BACKGROUND_DISABLED'});
    assert.equal((await f.manager.run('agent', opened.handle, 'printf ok')).stdout, 'ok');
    await f.manager.close('agent', opened.handle);
  } finally { await f.stop(); }
});

test('a behavior that was never written leaves the device promise intact', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'or-remote-behavior-'));
  const secrets = new Map();
  const service = new RemoteEnvironmentService({stateDir, vault:{
    put:async (key,value) => secrets.set(key,value), get:async (key) => secrets.get(key), remove:async (key) => secrets.delete(key)},
  });
  try {
    assert.deepEqual((await service.handle('list')).settings, {killRemoteProcesses:true, backgroundTasks:true});
    assert.deepEqual(await service.handle('set_behavior', {backgroundTasks:false}),
      {settings:{killRemoteProcesses:true, backgroundTasks:false}});
    assert.deepEqual((await service.handle('list')).settings, {killRemoteProcesses:true, backgroundTasks:false});
    await assert.rejects(service.handle('set_behavior', {killRemoteProcesses:'no'}), {code:'REMOTE_ENV_INVALID'});
    assert.deepEqual((await service.handle('list')).settings, {killRemoteProcesses:true, backgroundTasks:false});
    await service.handle('set_behavior', {killRemoteProcesses:false, backgroundTasks:true});
    assert.deepEqual(await service.manager.behavior(), {killRemoteProcesses:false, backgroundTasks:true});
  } finally { service.close(); rmSync(stateDir,{recursive:true,force:true}); }
});
