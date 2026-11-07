import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { HeadlessCredentialVault } from '../src/remoteEnvironment/headlessCredentialVault.js';
import { createCredentialVault } from '../src/remoteEnvironment/credentialVault.js';
import { RemoteTargetStore } from '../src/remoteEnvironment/remoteTargetStore.js';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'or-headless-vault-'));
  const keyFile=join(root,'key');writeFileSync(keyFile,randomBytes(32),{mode:0o600});
  return {root,keyFile,vault:new HeadlessCredentialVault({stateDir:root,keyFile}),close(){rmSync(root,{recursive:true,force:true});}};
}
const target={id:'ssh_a',name:'host',host:'example.test',username:'u',hostFingerprint:`SHA256:${'A'.repeat(43)}`};

test('encrypted credentials survive reopening and are not present in files', async () => {
  const f=fixture();try {
    const credential={kind:'password',password:'not-plaintext-credential'};
    const store=new RemoteTargetStore({stateDir:f.root,vault:f.vault});
    await store.save(target,{credential});
    const info=store.get(target.id), account=store.dir();
    store.shutdown();
    const files=readdirSync(join(f.root,'remote-environment-secrets'));
    assert.equal(files.length,1);
    assert.equal(readFileSync(join(f.root,'remote-environment-secrets',files[0])).includes(Buffer.from(credential.password)),false);
    const reopened=new RemoteTargetStore({stateDir:f.root,vault:new HeadlessCredentialVault({stateDir:f.root,keyFile:f.keyFile})});
    assert.deepEqual(await reopened.getCredential(reopened.get(target.id),account),credential);
    assert.equal(reopened.get(target.id).credentialRef,info.credentialRef);
    reopened.shutdown();
  } finally {f.close();}
});

test('tampered ciphertext, wrong key, public key files, and symlinks fail closed', async () => {
  const f=fixture();try {
    await f.vault.put('ref',{password:'secret'});
    const file=join(f.root,'remote-environment-secrets',readdirSync(join(f.root,'remote-environment-secrets'))[0]);
    const content=JSON.parse(readFileSync(file,'utf8'));content.tag=Buffer.alloc(16).toString('base64');writeFileSync(file,JSON.stringify(content),{mode:0o600});
    await assert.rejects(f.vault.get('ref'),{code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE'});
    chmodSync(f.keyFile,0o644);
    await assert.rejects(f.vault.get('ref'),{code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE'});
    chmodSync(f.keyFile,0o600);
    const link=join(f.root,'key-link');symlinkSync(f.keyFile,link);
    const linked=new HeadlessCredentialVault({stateDir:f.root,keyFile:link});
    await assert.rejects(linked.get('ref'),{code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE'});
  } finally {f.close();}
});

test('vault backend and key changes cannot silently make mixed or inaccessible secrets', async () => {
  const f=fixture();try {
    const original=new RemoteTargetStore({stateDir:f.root,vault:f.vault});
    await original.save(target,{credential:{kind:'password',password:'secret'}});
    original.shutdown();
    writeFileSync(f.keyFile,randomBytes(32),{mode:0o600});
    const changed=new RemoteTargetStore({stateDir:f.root,vault:new HeadlessCredentialVault({stateDir:f.root,keyFile:f.keyFile})});
    await assert.rejects(changed.save({...target,name:'changed'},{baseRevision:1,credential:{kind:'password',password:'new'}}),{code:'REMOTE_ENV_VAULT_MISMATCH'});
    await assert.rejects(changed.getCredential(changed.get(target.id),changed.dir()),{code:'REMOTE_ENV_VAULT_MISMATCH'});
    assert.equal(changed.list()[0].name,'host');
    changed.shutdown();
  } finally {f.close();}
});

test('headless backend is selected only by explicit configuration', () => {
  const f=fixture();try {
    assert.ok(createCredentialVault({stateDir:f.root,env:{ORIGINROUTER_SSH_VAULT_KEY_FILE:f.keyFile}}) instanceof HeadlessCredentialVault);
    assert.throws(()=>createCredentialVault({stateDir:f.root,env:{ORIGINROUTER_SSH_VAULT_KEY_FILE:'relative-key'}}),{code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE'});
    assert.notEqual(createCredentialVault({stateDir:f.root,env:{}}).constructor.name,'HeadlessCredentialVault');
  } finally {f.close();}
});

test('backend can change only after the old vault has no remaining entries', async () => {
  const f=fixture();try {
    const original=new RemoteTargetStore({stateDir:f.root,vault:f.vault});
    await original.save(target,{credential:{kind:'password',password:'secret'}});
    await original.remove(target.id,1);
    original.shutdown();
    writeFileSync(f.keyFile,randomBytes(32),{mode:0o600});
    const replacement=new RemoteTargetStore({stateDir:f.root,vault:new HeadlessCredentialVault({stateDir:f.root,keyFile:f.keyFile})});
    await replacement.save({...target,id:'ssh_new'},{credential:{kind:'password',password:'new'}});
    assert.equal((await replacement.getCredential(replacement.get('ssh_new'),replacement.dir())).password,'new');
    replacement.shutdown();
  } finally {f.close();}
});
