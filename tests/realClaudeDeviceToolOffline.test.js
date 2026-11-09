// Opt-in: real Claude SDK with a local fake Messages API, real MCP child and
// daemon, simulated wrapper approval. No provider is contacted.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
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
import { agentGatewayMcpConfig } from '../src/mcp/agentGatewayConfig.js';

async function until(fn){const end=Date.now()+15_000;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw new Error('runtime event timed out');}

test('real Claude SDK calls the scheduled-task MCP tool and waits for approval', {skip:process.env.ORIGINROUTER_RUN_REAL_AGENT_OFFLINE_TESTS !== '1',timeout:35_000}, async () => {
  const dir=mkdtempSync(join(tmpdir(),'or-real-claude-tool-')),messages=[],requests=[];
  const previous=process.env.ORIGINROUTER_HOME;process.env.ORIGINROUTER_HOME=dir;
  const token=ensureApiToken(dir),registry=new ExternalAgentRegistry();
  const store=new ScheduledTaskStore({stateDir:dir,now:()=>Date.parse('2026-01-01T00:00:00Z')});
  const scheduled=new ScheduledTaskScheduler({store,supervisor:{start:async()=>({accepted:true})}});
  const remote={manager:{closeOwner(){}},store:{}};
  const broker=new DeviceToolApprovalBroker({registry,accountProvider:()=>dir,timeoutMs:15_000});
  const service=new DeviceToolService({registry,broker,scheduled,remote,accountProvider:()=>dir});
  let api,bridge,approval,server,session,consume;const controller=new AbortController();
  try {
    api=await startLocalApi({bindAddress:'127.0.0.1',externalAgentRegistry:registry,deviceToolService:service},{port:0});
    const base=`http://127.0.0.1:${api.port}`;
    writeFileSync(join(dir,'daemon.state.json'),JSON.stringify({localApiPort:api.port,localApiBindAddress:'127.0.0.1',localApiBaseUrl:base}));
    const interactions=new PendingInteractionRegistry({onRequested:async(event)=>bridge.sendEvent(event)});
    approval=createDeviceToolApprovalHandler({sessionId:'s1',provider:'claude',runtime:'claude-sdk',revision:()=>1,
      requestInteraction:(request,signal)=>interactions.request(request,signal),markApplied:(result)=>interactions.markResult(result.interactionId,'applied',{responseId:result.responseId}),
      sendResult:(event)=>bridge.sendDeviceToolApprovalResult(event)});
    bridge=new LocalAgentBridgeClient({stateDir:dir,sessionId:'s1',pollIntervalMs:10,endpointProvider:()=>({baseUrl:base,token}),onCommand:(command)=>{
      if(command.type==='agent.device_tool.approval')return approval.start(command);
      if(command.type==='agent.device_tool.cancel')return approval.cancel(command.requestId);
      if(command.type==='agent.interaction.resolve')return interactions.resolve(command);
      return false;
    }});
    await bridge.start({sessionId:'s1',agent:'claude',runtime:'claude-sdk',supportsDeviceTools:true});
    server=http.createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      if(req.method!=='POST'||!req.url.startsWith('/v1/messages')){res.writeHead(404);res.end();return;}
      requests.push(JSON.parse(body));const n=requests.length;res.writeHead(200,{'Content-Type':'text/event-stream'});
      const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
      send('message_start',{message:{id:`m${n}`,type:'message',role:'assistant',content:[],model:'claude-sonnet-4-5-20250929',stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
      if(n===1){
        send('content_block_start',{index:0,content_block:{type:'tool_use',id:'toolu_1',name:'mcp__originrouter_device__scheduled_save',input:{}}});
        send('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({task:{name:'real-claude-task',schedule:{kind:'once',at:'2099-01-01T00:00:00Z'},launch:{agentType:'claude',workspaceId:'w1',initialMessage:'run test',permissionProfile:'manual'}}})}});
      }else{
        send('content_block_start',{index:0,content_block:{type:'text',text:''}});
        send('content_block_delta',{index:0,delta:{type:'text_delta',text:'scheduled'}});
      }
      send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:n===1?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:2}});send('message_stop',{});res.end();
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    session=query({prompt:'Schedule the test task.',options:{cwd:dir,abortController:controller,persistSession:false,settingSources:[],model:'claude-sonnet-4-5-20250929',includePartialMessages:true,
      env:{PATH:process.env.PATH,CLAUDE_CONFIG_DIR:dir,ORIGINROUTER_HOME:dir,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'offline-key',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},
      mcpServers:{originrouter_device:agentGatewayMcpConfig('s1',{deviceTools:true,stateDir:dir})},
      canUseTool:async(_name,input)=>({behavior:'allow',updatedInput:input})}});
    consume=(async()=>{try{for await(const item of session)messages.push(item);}catch(error){messages.push({type:'consumer_error',error:error.message});}})();
    const prompt=await until(()=>{const item=interactions.snapshot()[0];if(messages.some((m)=>m.type==='result'))throw new Error('turn ended without approval');return item;});
    assert.equal(prompt.payload.tool,'originrouter.scheduled.save');assert.equal(store.list().length,0);
    const reply=await fetch(`${base}/agent/local/sessions/s1/interaction`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({interactionId:prompt.interactionId,responseId:'r1',action:'allow'})});
    assert.equal(reply.status,200);
    await until(()=>messages.find((item)=>item.type==='result'));
    assert.equal(store.list()[0].name,'real-claude-task');assert.equal(requests.length,2);
    const modelTools=JSON.stringify(requests[0].tools);
    assert.match(modelTools,/prefer the OriginRouter remote_env tools/);
    assert.match(modelTools,/id, not its display name/);
    assert.match(modelTools,/does not persist between calls/);
  } finally {
    controller.abort();try{await session?.return();}catch{};await Promise.race([consume || Promise.resolve(),new Promise(r=>setTimeout(r,1000))]);
    if(server)await new Promise(r=>server.close(r));approval?.close();await bridge?.close();service.close();broker.close();store.close();await api?.close();
    if(previous==null)delete process.env.ORIGINROUTER_HOME;else process.env.ORIGINROUTER_HOME=previous;rmSync(dir,{recursive:true,force:true});
  }
});
