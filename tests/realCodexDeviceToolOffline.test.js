// Opt-in: actual installed Codex app-server with a local fake Responses API,
// a real MCP child process and daemon gateway. No provider is contacted.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import ssh2 from 'ssh2';
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
import { CodexAppServerClient } from '../src/adapters/codex/appServerClient.js';
import { codexAgentGatewayConfigArgs } from '../src/mcp/agentGatewayConfig.js';
import { RemoteEnvironmentService } from '../src/remoteEnvironment/remoteEnvironmentService.js';
import { sshHostFingerprint } from '../src/remoteEnvironment/sshConnectionManager.js';

async function until(fn){const end=Date.now()+15_000;while(Date.now()<end){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw new Error('runtime event timed out');}

test('real Codex calls scheduled and SSH MCP tools and waits for user approval', {skip:process.env.ORIGINROUTER_RUN_REAL_AGENT_OFFLINE_TESTS !== '1',timeout:35_000}, async (t) => {
  const list=spawnSync('codex',['mcp','list','--json'],{encoding:'utf8'});
  if(list.status!==0){t.skip('Codex MCP inventory unavailable');return;}
  let servers;try{servers=JSON.parse(list.stdout);}catch{t.skip('Codex MCP inventory cannot be verified');return;}
  if((Array.isArray(servers)?servers.length:Object.keys(servers||{}).length)>0){t.skip('unrelated global MCP servers are configured');return;}
  const dir=mkdtempSync(join(tmpdir(),'or-real-codex-tool-')),events=[], requests=[];
  const previous=process.env.ORIGINROUTER_HOME;process.env.ORIGINROUTER_HOME=dir;
  const token=ensureApiToken(dir), registry=new ExternalAgentRegistry();
  const store=new ScheduledTaskStore({stateDir:dir,now:()=>Date.parse('2026-01-01T00:00:00Z')});
  const scheduled=new ScheduledTaskScheduler({store,supervisor:{start:async()=>({accepted:true})}});
  const secrets=new Map();
  const remote=new RemoteEnvironmentService({stateDir:dir,vault:{put:async(k,v)=>secrets.set(k,v),get:async(k)=>secrets.get(k),remove:async(k)=>secrets.delete(k)}});
  const broker=new DeviceToolApprovalBroker({registry,accountProvider:()=>dir,timeoutMs:15_000});
  const service=new DeviceToolService({registry,broker,scheduled,remote,accountProvider:()=>dir});
  let api,bridge,approval,server,client,sshServer; const sshClients=new Set();
  try {
    const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    const fingerprint=sshHostFingerprint(ssh2.utils.parseKey(privateKey).getPublicSSH());
    sshServer=new ssh2.Server({hostKeys:[privateKey]},(connection)=>{
      sshClients.add(connection);connection.on('close',()=>sshClients.delete(connection));connection.on('error',()=>{});
      connection.on('authentication',(ctx)=>ctx.method==='password'&&ctx.password==='fixture-secret'?ctx.accept():ctx.reject());
      connection.on('ready',()=>connection.on('session',(accept)=>accept().on('exec',(acceptExec,_reject,info)=>{
        const stream=acceptExec();
        if(info.command === 'cd -- \'/srv\' && pwd -P') stream.write('/srv\n');
        else if(info.command.includes('printf ssh-ok')) stream.write('ssh-ok');
        else {stream.exit(1);stream.end();return;}
        stream.exit(0);stream.end();
      })));
    });
    await new Promise(r=>sshServer.listen(0,'127.0.0.1',r));
    await remote.handle('save',{target:{id:'ssh_a',name:'fixture',host:'127.0.0.1',port:sshServer.address().port,username:'test',hostFingerprint:fingerprint,defaultDirectory:'/srv'},
      confirmedFingerprint:fingerprint,credential:{kind:'password',password:'fixture-secret'}});
    const remoteSession=await remote.manager.open('s1','ssh_a');
    api=await startLocalApi({bindAddress:'127.0.0.1',externalAgentRegistry:registry,deviceToolService:service},{port:0});
    const base=`http://127.0.0.1:${api.port}`;
    writeFileSync(join(dir,'daemon.state.json'),JSON.stringify({localApiPort:api.port,localApiBindAddress:'127.0.0.1',localApiBaseUrl:base}));
    const interactions=new PendingInteractionRegistry({onRequested:async(event)=>bridge.sendEvent(event)});
    approval=createDeviceToolApprovalHandler({sessionId:'s1',provider:'codex',runtime:'codex-app-server',revision:()=>1,
      requestInteraction:(request,signal)=>interactions.request(request,signal),markApplied:(result)=>interactions.markResult(result.interactionId,'applied',{responseId:result.responseId}),
      sendResult:(event)=>bridge.sendDeviceToolApprovalResult(event)});
    bridge=new LocalAgentBridgeClient({stateDir:dir,sessionId:'s1',pollIntervalMs:10,endpointProvider:()=>({baseUrl:base,token}),onCommand:(command)=>{
      if(command.type==='agent.device_tool.approval')return approval.start(command);
      if(command.type==='agent.device_tool.cancel')return approval.cancel(command.requestId);
      if(command.type==='agent.interaction.resolve')return interactions.resolve(command);
      return false;
    }});
    await bridge.start({sessionId:'s1',agent:'codex',runtime:'codex-app-server',supportsDeviceTools:true});
    server=http.createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));const n=requests.length;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const send=(event)=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({type:'response.created',response:{id:`r${n}`}});
      if(n===1)send({type:'response.output_item.done',item:{type:'function_call',call_id:'call1',namespace:'mcp__originrouter_device',name:'scheduled_save',arguments:JSON.stringify({task:{name:'real-codex-task',schedule:{kind:'once',at:'2099-01-01T00:00:00Z'},launch:{agentType:'claude',workspaceId:'w1',initialMessage:'run test',permissionProfile:'manual'}}})}});
      else if(n===2)send({type:'response.output_item.done',item:{type:'function_call',call_id:'call2',namespace:'mcp__originrouter_device',name:'remote_env_exec',arguments:JSON.stringify({handle:remoteSession.handle,command:'printf ssh-ok'})}});
      else send({type:'response.output_item.done',item:{type:'message',role:'assistant',id:'m3',content:[{type:'output_text',text:'completed'}]}});
      send({type:'response.completed',response:{id:`r${n}`,usage:{input_tokens:0,input_tokens_details:null,output_tokens:0,output_tokens_details:null,total_tokens:0}}});res.end();
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    client=new CodexAppServerClient({rpcTimeoutMs:15_000});client.onEvent((event)=>events.push(event));
    await client.connect({cwd:dir,env:{...process.env,OPENAI_API_KEY:'offline-key',ORIGINROUTER_HOME:dir},configArgs:codexAgentGatewayConfigArgs('s1',{deviceTools:true,stateDir:dir}),
      modelProvider:{id:'originrouter_test',name:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,envKey:'OPENAI_API_KEY',wireApi:'responses'}});
    const thread=(await client.startThread({cwd:dir,model:'gpt-5.1-codex',ephemeral:true,approvalPolicy:'never'})).thread.id;
    await client.startTurn({threadId:thread,input:[{type:'text',text:'Schedule the test task.',text_elements:[]}]});
    let prompt;
    try { prompt=await until(()=>{if(events.some((event)=>event.type==='task_complete'))throw new Error('turn ended without approval');return interactions.snapshot()[0];}); }
    catch (error) {
      console.error(JSON.stringify({requests:requests.length, events:events.filter((event)=>event.method==='item/completed').map((event)=>event.params?.item), input:requests[1]?.input?.filter((item)=>item.type?.includes('function_call_output'))}));
      throw error;
    }
    assert.equal(prompt.payload.tool,'originrouter.scheduled.save');assert.equal(store.list().length,0);
    const reply=await fetch(`${base}/agent/local/sessions/s1/interaction`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({interactionId:prompt.interactionId,responseId:'r1',action:'allow'})});
    assert.equal(reply.status,200);
    const sshPrompt=await until(()=>interactions.snapshot().find((item)=>item.interactionId!==prompt.interactionId));
    assert.equal(sshPrompt.payload.tool,'originrouter.remote.exec');
    assert.equal(sshPrompt.payload.command,'printf ssh-ok');
    assert.equal(JSON.stringify(sshPrompt).includes('fixture-secret'),false);
    await fetch(`${base}/agent/local/sessions/s1/interaction`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({interactionId:sshPrompt.interactionId,responseId:'r2',action:'allow'})});
    await until(()=>events.find((event)=>event.type==='task_complete'));
    assert.equal(store.list()[0].name,'real-codex-task');assert.equal(requests.length,3);
    assert.ok(JSON.stringify(requests[2].input).includes('ssh-ok'));
  } finally {
    client?.disconnect();if(server)await new Promise(r=>server.close(r));approval?.close();await bridge?.close();service.close();broker.close();remote.close();
    for(const connection of sshClients)connection.end();if(sshServer)await new Promise(r=>sshServer.close(r));store.close();await api?.close();
    if(previous==null)delete process.env.ORIGINROUTER_HOME;else process.env.ORIGINROUTER_HOME=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
