import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

// Exercise the database across an actual abrupt process death, rather than
// only closing and reopening it in a single JS process.
test('a daemon killed during launch restarts with an uncertain run and blocks duplicate execution', {timeout:10000,skip:process.platform==='win32'}, async () => {
  const root=mkdtempSync(join(tmpdir(),'or-scheduler-crash-'));
  const storeUrl=new URL('../src/runtime/scheduledTaskStore.js',import.meta.url).href;
  const schedulerUrl=new URL('../src/runtime/scheduledTaskScheduler.js',import.meta.url).href;
  const firstCode=`
    import {ScheduledTaskStore} from ${JSON.stringify(storeUrl)};
    import {ScheduledTaskScheduler} from ${JSON.stringify(schedulerUrl)};
    const store=new ScheduledTaskStore({stateDir:${JSON.stringify(root)}});
    store.save({id:'st_crash',name:'crash',schedule:{kind:'once',at:'2099-01-01T00:00:00Z'},launch:{agentType:'claude',workspaceId:'w',initialMessage:'test',permissionProfile:'manual'}});
    const scheduler=new ScheduledTaskScheduler({store,supervisor:{start:() => new Promise(() => {})}});
    void scheduler.runNow('st_crash');
    process.stdout.write(JSON.stringify(store.executions()[0])+'\\n');
    setInterval(() => {},1000);
  `;
  const secondCode=`
    import {ScheduledTaskStore} from ${JSON.stringify(storeUrl)};
    import {ScheduledTaskScheduler} from ${JSON.stringify(schedulerUrl)};
    const store=new ScheduledTaskStore({stateDir:${JSON.stringify(root)}});
    const scheduler=new ScheduledTaskScheduler({store,supervisor:{}});
    scheduler.recover();
    const before=store.executions()[0];
    const again=store.claim('st_crash',{manual:true});
    process.stdout.write(JSON.stringify({before,again}));
    store.close();
  `;
  let processChild;
  function run(code) {
    const proc=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    proc.stdout.on('data',(data) => {stdout+=data;});
    proc.stderr.on('data',(data) => {stderr+=data;});
    return {proc,output:() => ({stdout,stderr}),exit:new Promise((resolve,reject) => {proc.on('error',reject);proc.on('close',(code,signal) => resolve({code,signal}));})};
  }
  try {
    const first=run(firstCode); processChild=first.proc;
    await new Promise((resolve,reject) => {
      if(first.output().stdout.includes('\n')) return resolve();
      first.proc.stdout.on('data',() => {if(first.output().stdout.includes('\n')) resolve();});
      first.exit.then(() => reject(new Error('first process exited before writing its launch state')));
    });
    assert.equal(JSON.parse(first.output().stdout).status,'starting');
    first.proc.kill('SIGKILL');
    assert.equal((await first.exit).signal,'SIGKILL'); processChild=null;
    const second=run(secondCode);
    const result=await second.exit;
    assert.equal(result.code,0,second.output().stderr);
    const state=JSON.parse(second.output().stdout);
    assert.equal(state.before.status,'uncertain');
    assert.equal(state.again.status,'skipped_busy');
  } finally {
    if(processChild && processChild.exitCode==null) processChild.kill('SIGKILL');
    rmSync(root,{recursive:true,force:true});
  }
});
