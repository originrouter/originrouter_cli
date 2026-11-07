import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import ssh2 from 'ssh2';

// A second OS process reads the first process's encrypted credential with only
// the stable key file and state directory, mirroring an unattended restart.
test('headless credential vault survives a process restart', {skip:process.platform==='win32'}, () => {
  const root=mkdtempSync(join(tmpdir(),'or-vault-restart-'));
  const key=join(root,'key');writeFileSync(key,randomBytes(32),{mode:0o600});
  const storeUrl=new URL('../src/remoteEnvironment/remoteTargetStore.js',import.meta.url).href;
  const target={id:'ssh_a',name:'host',host:'example.test',username:'u',hostFingerprint:`SHA256:${'A'.repeat(43)}`};
  const env={...process.env,ORIGINROUTER_HOME:root,ORIGINROUTER_SSH_VAULT_KEY_FILE:key};
  try {
    const first=spawnSync(process.execPath,['--input-type=module','-e',`import {RemoteTargetStore} from ${JSON.stringify(storeUrl)}; const s=new RemoteTargetStore(); await s.save(${JSON.stringify(target)},{credential:{kind:'password',password:'restart-secret'}}); s.shutdown();`],{env,encoding:'utf8'});
    assert.equal(first.status,0,first.stderr);
    const second=spawnSync(process.execPath,['--input-type=module','-e',`import {RemoteTargetStore} from ${JSON.stringify(storeUrl)}; const s=new RemoteTargetStore(); const c=await s.getCredential(s.get('ssh_a'),s.dir()); process.stdout.write(c.password==='restart-secret'?'ok':'wrong'); s.shutdown();`],{env,encoding:'utf8'});
    assert.equal(second.status,0,second.stderr);assert.equal(second.stdout,'ok');
  } finally {rmSync(root,{recursive:true,force:true});}
});

// A target saved by one daemon process must still authenticate and execute via
// SSH in a new daemon process, with only its configured vault key and files.
test('a restarted headless service reconnects to a real SSH server using its encrypted vault', {skip:process.platform==='win32',timeout:10000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'or-headless-ssh-restart-'));
  const key=join(root,'key');writeFileSync(key,randomBytes(32),{mode:0o600});
  const hostKey=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
  const fingerprint=`SHA256:${createHash('sha256').update(ssh2.utils.parseKey(hostKey).getPublicSSH()).digest('base64').replace(/=+$/,'')}`;
  const connections=new Set(), commands=[];
  const server=new ssh2.Server({hostKeys:[hostKey]}, (client) => {
    connections.add(client); client.on('close',() => connections.delete(client)); client.on('error',() => {});
    client.on('authentication',(ctx) => ctx.username==='test' && ctx.method==='password' && ctx.password==='restart-fixture-password' ? ctx.accept() : ctx.reject());
    client.on('ready',() => client.on('session',(accept) => accept().on('exec',(acceptExec,_reject,info) => {
      commands.push(info.command); const stream=acceptExec();
      if(info.command==='pwd -P'){stream.write('/fixture\n');stream.exit(0);}
      else if(info.command.includes('printf restart-ok')){stream.write('restart-ok');stream.exit(0);}
      else {stream.exit(1);}
      stream.end();
    })));
  });
  await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
  const target={id:'ssh_restart',name:'restart host',host:'127.0.0.1',port:server.address().port,username:'test',hostFingerprint:fingerprint};
  const env={...process.env,ORIGINROUTER_HOME:root,ORIGINROUTER_SSH_VAULT_KEY_FILE:key};
  const serviceUrl=new URL('../src/remoteEnvironment/remoteEnvironmentService.js',import.meta.url).href;
  async function child(code) {
    return new Promise((resolve,reject) => {
      const processChild=spawn(process.execPath,['--input-type=module','-e',code],{env,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';
      processChild.stdout.on('data',(chunk) => {stdout+=chunk;});
      processChild.stderr.on('data',(chunk) => {stderr+=chunk;});
      processChild.on('error',reject);
      processChild.on('close',(status) => resolve({status,stdout,stderr}));
    });
  }
  try {
    const save=await child(`import {RemoteEnvironmentService} from ${JSON.stringify(serviceUrl)}; const s=new RemoteEnvironmentService(); await s.handle('save',{target:${JSON.stringify(target)},confirmedFingerprint:${JSON.stringify(fingerprint)},credential:{kind:'password',password:'restart-fixture-password'}}); s.close();`);
    assert.equal(save.status,0,save.stderr);
    const run=await child(`import {RemoteEnvironmentService} from ${JSON.stringify(serviceUrl)}; const s=new RemoteEnvironmentService(); const session=await s.manager.open('agent','ssh_restart'); const result=await s.manager.run('agent',session.handle,'printf restart-ok'); process.stdout.write(result.stdout); await s.manager.close('agent',session.handle); s.close();`);
    assert.equal(run.status,0,run.stderr); assert.equal(run.stdout,'restart-ok');
    assert.equal(commands.some((command) => command.includes('printf restart-ok')),true);
  } finally {
    for(const connection of connections) connection.end();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root,{recursive:true,force:true});
  }
});
