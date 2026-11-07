import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ensureApiToken, apiTokenPath } from '../src/persistence/authToken.js';
import { startLocalApi } from '../src/local/localApi.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { ScheduledTaskStore } from '../src/runtime/scheduledTaskStore.js';
import { ScheduledTaskScheduler } from '../src/runtime/scheduledTaskScheduler.js';
import { closeScheduledTaskApi } from '../src/daemon/scheduledTaskShutdown.js';

test('shutdown closes a real HTTP request even if launch never acknowledges in time', {timeout:5000}, async () => {
  const root=mkdtempSync(join(tmpdir(),'or-scheduled-http-stop-'));
  const previous=process.env.ORIGINROUTER_HOME;
  process.env.ORIGINROUTER_HOME=root;
  let release, started, api;
  const gate=new Promise((resolve)=>{release=resolve;});
  const launchStarted=new Promise((resolve)=>{started=resolve;});
  const store=new ScheduledTaskStore({stateDir:root});
  const registry=new ExternalAgentRegistry();
  const scheduler=new ScheduledTaskScheduler({store,registry,supervisor:{start:async()=>{started();await gate;return {accepted:true};}},log:{error(){}}});
  try {
    const token=ensureApiToken(root);
    store.save({id:'st_a',name:'test',schedule:{kind:'once',at:'2099-01-01T00:00:00Z'},
      launch:{agentType:'claude',workspaceId:'w',initialMessage:'test',permissionProfile:'manual'}});
    api=await startLocalApi({stateDir:root,apiTokenPath:apiTokenPath(root),bindAddress:'127.0.0.1',
      externalAgentRegistry:registry,scheduledTaskScheduler:scheduler},{port:0});
    const request=fetch(`http://127.0.0.1:${api.port}/scheduled-tasks`,{method:'POST',
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({action:'run',body:{id:'st_a',baseRevision:1}})}).then(()=>null,(error)=>error);
    await launchStarted;
    scheduler.stop();
    assert.equal(store.executions()[0].status,'uncertain');
    assert.equal(await closeScheduledTaskApi(api,scheduler,{timeoutMs:10}),false);
    api=null;
    assert.ok(await request,'the waiting client sees its connection close');
    store.close();
    release();
    assert.equal(await scheduler.drain(1000),true);
    assert.equal(store.db,null,'late launch receipt cannot reopen the store');
    const reopened=new ScheduledTaskStore({stateDir:root});
    assert.equal(reopened.executions()[0].status,'uncertain');
    reopened.close();
  } finally {
    release();
    scheduler.stop();
    if(api){api.server.closeAllConnections();await api.close();}
    store.close();
    if(previous==null)delete process.env.ORIGINROUTER_HOME;else process.env.ORIGINROUTER_HOME=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
