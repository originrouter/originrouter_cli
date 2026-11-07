import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activateAccount } from '../src/persistence/accounts.js';
import { RemoteTargetStore } from '../src/remoteEnvironment/remoteTargetStore.js';
import { SystemCredentialVault } from '../src/remoteEnvironment/credentialVault.js';

class Vault {
  constructor() { this.values = new Map(); this.failPut = false; this.failRemove = false; }
  async put(key, value) { if (this.failPut) throw new Error('locked'); this.values.set(key, structuredClone(value)); }
  async get(key) { if (!this.values.has(key)) throw new Error('missing'); return structuredClone(this.values.get(key)); }
  async remove(key) { if (this.failRemove) throw new Error('locked'); return this.values.delete(key); }
}
const target = {id:'ssh_a', name:'Server', host:'host.example', port:22, username:'alice', hostFingerprint:`SHA256:${'A'.repeat(43)}`, defaultDirectory:'/srv'};
const password = {kind:'password',password:'secret-not-in-sqlite'};
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(),'or-remote-store-'));
  const vault = new Vault(), changes = [];
  const store = new RemoteTargetStore({stateDir,vault,onChanged:(id,dir) => changes.push([id,dir])});
  return {stateDir,vault,store,changes};
}

test('credentials remain in the vault, targets persist and accounts are isolated', async () => {
  const f = fixture();
  activateAccount(f.stateDir,'alice');
  const a = await f.store.save(target,{credential:password});
  assert.equal(a.revision,1); assert.equal(a.authKind,'password');
  assert.equal(JSON.stringify(a).includes(password.password),false);
  const dir = f.store.dir();
  const resolved = f.store.get(target.id, dir);
  assert.deepEqual(await f.store.getCredential(resolved,dir),password);
  f.store.close();
  const dbFile = join(dir,'remote-environments.sqlite3');
  assert.equal(readFileSync(dbFile).includes(Buffer.from(password.password)),false);
  activateAccount(f.stateDir,'bob');
  assert.deepEqual(f.store.list(),[]);
  await f.store.save({...target,name:'Bob server'},{credential:{kind:'agent',agent:'/tmp/agent.sock'}});
  activateAccount(f.stateDir,'alice');
  assert.equal(f.store.list()[0].name,'Server');
  assert.equal(JSON.stringify(f.store.list()).includes('credentialRef'),false);
  assert.equal(f.changes.length,2);
  f.store.close();
});

test('edits use revisions, rotate credentials, and retain failed cleanup for retry', async () => {
  const f = fixture();
  const a = await f.store.save(target,{credential:password});
  const firstRef = f.store.get(target.id).credentialRef;
  await assert.rejects(f.store.save({...target,name:'stale'},{baseRevision:0}),{code:'REMOTE_ENV_CONFLICT'});
  f.vault.failRemove = true;
  const b = await f.store.save({...target,name:'New'},{baseRevision:a.revision,credential:{kind:'private_key',privateKey:'key',passphrase:'pass'}});
  assert.equal(b.revision,2); assert.equal(b.authKind,'private_key');
  assert.notEqual(f.store.get(target.id).credentialRef,firstRef);
  assert.equal(f.vault.values.size,2);
  f.vault.failRemove = false;
  await f.store.collectGarbage();
  assert.equal(f.vault.values.size,1);
  assert.equal(await f.store.remove(target.id,2),true);
  assert.equal(f.vault.values.size,0);
  assert.deepEqual(f.store.list(),[]);
  f.store.close();
});

test('deleted target IDs cannot be reused by a stale edit after restart', async () => {
  const f=fixture();
  try {
    const saved=await f.store.save(target,{credential:password});
    await f.store.remove(target.id,saved.revision);
    f.store.close();
    await assert.rejects(f.store.save({...target,host:'other.example'},{baseRevision:0,credential:password}),{code:'REMOTE_ENV_CONFLICT'});
    assert.equal(f.store.get(target.id),null);
    await f.store.save({...target,id:'ssh_new'},{baseRevision:0,credential:password});
    assert.equal(f.store.list().length,1);
  } finally {f.store.shutdown();}
});

test('credential read rejects a target replaced while the vault was answering', async () => {
  const f = fixture();
  await f.store.save(target,{credential:password});
  const current = f.store.get(target.id), dir = f.store.dir();
  let release;
  const originalGet = f.vault.get.bind(f.vault);
  f.vault.get = async (key) => { await new Promise((resolve) => {release=resolve;}); return originalGet(key); };
  const pending = f.store.getCredential(current,dir);
  await new Promise((resolve) => setTimeout(resolve,0));
  await f.store.save({...target,name:'changed'},{baseRevision:1});
  release();
  await assert.rejects(pending,{code:'REMOTE_ENV_CONFLICT'});
  f.store.close();
});

test('failed vault writes cannot create a target or leak a plaintext fallback', async () => {
  const f = fixture();
  f.vault.failPut = true;
  await assert.rejects(f.store.save(target,{credential:password}));
  assert.deepEqual(f.store.list(),[]);
  f.vault.failPut = false;
  await f.store.collectGarbage();
  assert.equal(f.vault.values.size,0);
  f.store.close();
});

test('shutdown during a credential write leaves recoverable cleanup and does not reopen the database', async () => {
  const f = fixture();
  let release;
  const originalPut = f.vault.put.bind(f.vault);
  f.vault.put = async (key, value) => { await new Promise((resolve) => {release=resolve;}); return originalPut(key, value); };
  const pending = f.store.save(target,{credential:password});
  while (!release) await new Promise((resolve) => setTimeout(resolve,0));
  f.store.shutdown();
  release();
  await assert.rejects(pending,{code:'REMOTE_ENV_CLOSED'});
  assert.throws(() => f.store.list(),{code:'REMOTE_ENV_CLOSED'});
  const restarted = new RemoteTargetStore({stateDir:f.stateDir,vault:f.vault});
  assert.equal(restarted.pendingCleanup(),1);
  await restarted.collectGarbage();
  assert.equal(f.vault.values.size,0);
  assert.deepEqual(restarted.list(),[]);
  restarted.shutdown();
});

test('system vault pins Linux to persistent Secret Service and sanitizes failures', async () => {
  const calls = [];
  class Entry {
    constructor(service, key, options) { calls.push([service,key,options]); }
    async setPassword() { throw new Error('sensitive backend failure'); }
    async getPassword() { return null; }
    async deleteCredential() { return false; }
  }
  const vault = new SystemCredentialVault({Entry});
  await assert.rejects(vault.put('ref',password),{code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE', message:'Persistent system credential storage is unavailable or locked'});
  assert.deepEqual(calls[0][2],{linux:{store:'secret-service'}});
  await assert.rejects(vault.get('ref'),{code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE'});
  assert.equal(await vault.remove('ref'),false);
});
