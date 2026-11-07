import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureApiToken } from '../src/persistence/authToken.js';
import { startLocalApi } from '../src/local/localApi.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { LocalAgentBridgeClient } from '../src/local/localAgentBridgeClient.js';
import { PendingInteractionRegistry } from '../src/runtime/pendingInteractionRegistry.js';
import { createDeviceToolApprovalHandler } from '../src/runtime/deviceToolApproval.js';
import { DeviceToolApprovalBroker } from '../src/mcp/deviceToolApprovalBroker.js';
import { DeviceToolService } from '../src/mcp/deviceToolService.js';
import { ScheduledTaskStore } from '../src/runtime/scheduledTaskStore.js';
import { ScheduledTaskScheduler } from '../src/runtime/scheduledTaskScheduler.js';

async function waitFor(fn) {
  const deadline=Date.now()+5000;
  while (Date.now()<deadline) {const value=fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve,10));}
  throw new Error('fixture timed out');
}

test('MCP stdio, daemon and wrapper honor real approval and denial over local HTTP', async () => {
  const stateDir=mkdtempSync(join(tmpdir(),'or-device-mcp-'));
  const previous=process.env.ORIGINROUTER_HOME;
  process.env.ORIGINROUTER_HOME=stateDir;
  const token=ensureApiToken(stateDir);
  const registry=new ExternalAgentRegistry();
  const store=new ScheduledTaskStore({stateDir,now:() => Date.parse('2026-01-01T00:00:00Z')});
  const scheduled=new ScheduledTaskScheduler({store,supervisor:{start:async () => ({accepted:true})}});
  const remoteCalls=[];
  const remote={store:{get:() => ({id:'ssh_a',revision:1,name:'host',host:'example',username:'u',credentialRef:'never-show'}),list:() => []},manager:{
    async sessionInfo() {return {targetId:'ssh_a',revision:1,cwd:'/srv',account:stateDir};},
    async run(owner,handle,command,options) {remoteCalls.push({owner,handle,command,options});return {exitCode:0,stdout:'ok'};},
    closeOwner() {},
  }};
  const broker=new DeviceToolApprovalBroker({registry,accountProvider:() => stateDir,timeoutMs:5000});
  const deviceToolService=new DeviceToolService({registry,broker,scheduled,remote,accountProvider:() => stateDir});
  let api,bridge,client,handler;
  try {
    api=await startLocalApi({bindAddress:'127.0.0.1',externalAgentRegistry:registry,deviceToolService},{port:0});
    const base=`http://127.0.0.1:${api.port}`;
    writeFileSync(join(stateDir,'daemon.state.json'),JSON.stringify({localApiPort:api.port,localApiBindAddress:'127.0.0.1',localApiBaseUrl:base}));
    const interactions=new PendingInteractionRegistry({onRequested:async (event) => bridge.sendEvent(event)});
    handler=createDeviceToolApprovalHandler({sessionId:'s1',provider:'claude',runtime:'claude-sdk',revision:() => 1,
      requestInteraction:(request,signal) => interactions.request(request,signal),
      markApplied:(result) => interactions.markResult(result.interactionId,'applied',{responseId:result.responseId}),
      sendResult:(event) => bridge.sendDeviceToolApprovalResult(event),
    });
    bridge=new LocalAgentBridgeClient({stateDir,sessionId:'s1',pollIntervalMs:10,
      endpointProvider:() => ({baseUrl:base,token}), onCommand:(command) => {
        if (command.type === 'agent.device_tool.approval') return handler.start(command);
        if (command.type === 'agent.device_tool.cancel') return handler.cancel(command.requestId);
        if (command.type === 'agent.interaction.resolve') return interactions.resolve(command);
        return false;
      }});
    await bridge.start({sessionId:'s1',agent:'claude',runtime:'claude-sdk',supportsDeviceTools:true});
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../bin/originrouter.js',import.meta.url)),'agent-mcp-server','--originrouter-session','s1','--device-tools'],env:{...process.env,ORIGINROUTER_HOME:stateDir},stderr:'pipe'});
    client=new Client({name:'device-tool-test',version:'1'});
    await client.connect(transport);
    const tools=await client.listTools();
    assert.ok(tools.tools.some((item) => item.name === 'scheduled_save'));
    const scheduleTool = tools.tools.find((item) => item.name === 'scheduled_save');
    const profiles = scheduleTool.inputSchema.properties.task.properties.launch.properties.permissionProfile.enum;
    assert.deepEqual(profiles, ['manual','guarded','unrestricted']);
    assert.match(scheduleTool.description, /user-selected template/);
    assert.ok(tools.tools.some((item) => item.name === 'remote_env_exec'));
    assert.equal(tools.tools.some((item) => item.name === 'delegate_task'),false);
    const save=client.callTool({name:'scheduled_save',arguments:{task:{name:'night',schedule:{kind:'once',at:'2099-01-01T00:00:00Z'},launch:{agentType:'claude',workspaceId:'w1',initialMessage:'check',permissionProfile:'manual'}}}});
    const first=await waitFor(() => interactions.snapshot()[0]);
    assert.equal(store.list().length,0);
    assert.equal(first.payload.tool,'originrouter.scheduled.save');
    assert.equal(first.payload.tool_input.task.name,'night');
    assert.equal(first.payload.tool_input.task.launch.initialMessage,'check');
    assert.equal(first.payload.tool_input.task.launch.permissionProfile,'manual');
    const approve=await fetch(`${base}/agent/local/sessions/s1/interaction`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({interactionId:first.interactionId,responseId:'r1',action:'allow'})});
    assert.equal(approve.status,200);
    const saved=await save;
    assert.equal(saved.isError,undefined);
    assert.equal(store.list()[0].name,'night');
    assert.equal(registry.eventsAfter(0).events.some((e) => e.type === 'agent.device_tool.approval_result'),false);
    // A second device edits the task while a model's update waits for review.
    // Approving the old request must not overwrite the newer version.
    const original=store.list()[0];
    const staleSave=client.callTool({name:'scheduled_save',arguments:{baseRevision:original.revision,task:{id:original.id,
      name:'model edit',enabled:original.enabled,schedule:original.schedule,launch:original.launch}}});
    const staleRequest=await waitFor(() => interactions.snapshot().find((e) => e.interactionId !== first.interactionId));
    assert.equal(staleRequest.payload.tool_input.task.name,'model edit');
    store.save({...original,name:'other device edit'},{baseRevision:original.revision});
    await fetch(`${base}/agent/local/sessions/s1/interaction`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({interactionId:staleRequest.interactionId,responseId:'stale',action:'allow'})});
    const staleResult=await staleSave;
    assert.equal(staleResult.isError,true);
    assert.match(JSON.stringify(staleResult),/SCHEDULED_TASK_CONFLICT/i);
    assert.equal(store.list()[0].name,'other device edit');
    const run=client.callTool({name:'remote_env_exec',arguments:{handle:'h1',command:'pwd'}});
    const second=await waitFor(() => interactions.snapshot().find((e) => e.interactionId !== first.interactionId));
    assert.equal(second.payload.tool_input.target.host,'example');
    assert.equal(second.payload.tool_input.command,'pwd');
    assert.equal(second.payload.tool_input.cwd,'/srv');
    await fetch(`${base}/agent/local/sessions/s1/interaction`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({interactionId:second.interactionId,responseId:'r2',action:'deny'})});
    const denied=await run;
    assert.equal(denied.isError,true);
    assert.equal(remoteCalls.length,0);
    assert.equal(JSON.stringify(second).includes('never-show'),false);
  } finally {
    handler?.close(); await client?.close(); await bridge?.close(); deviceToolService.close(); broker.close(); store.close(); await api?.close();
    if (previous == null) delete process.env.ORIGINROUTER_HOME; else process.env.ORIGINROUTER_HOME=previous;
    rmSync(stateDir,{recursive:true,force:true});
  }
});
