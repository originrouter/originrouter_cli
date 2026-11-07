// Real managed Claude/Codex wrappers + real runtime supervisor and local HTTP;
// the model endpoint and AI judge are local deterministic fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureApiToken } from '../src/persistence/authToken.js';
import { startLocalApi } from '../src/local/localApi.js';
import { canonicalTurnEventType, ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { RuntimeTaskStore } from '../src/runtime/runtimeTaskStore.js';
import { RuntimeSupervisor } from '../src/runtime/runtimeSupervisor.js';

const enabled=process.env.ORIGINROUTER_RUN_REAL_AGENT_OFFLINE_TESTS==='1';
// Less than one 512-character batch: the live timer must deliver it before the model ends.
const repeat='Let me check this again. '.repeat(5);
async function until(fn,ms=20_000){const end=Date.now()+ms;while(Date.now()<end){const result=fn();if(result)return result;await new Promise(r=>setTimeout(r,30));}throw new Error('supervision event timed out');}

for (const agent of ['claude','codex']) test(`real ${agent} wrapper is interrupted and continued by the runtime supervisor`,{skip:!enabled,timeout:40_000},async(t)=>{
  if(agent==='codex'){
    const output=spawnSync('codex',['mcp','list','--json'],{encoding:'utf8'});let servers;
    try{servers=JSON.parse(output.stdout);}catch{t.skip('Codex MCP inventory unavailable');return;}
    if(output.status!==0||(Array.isArray(servers)?servers.length:Object.keys(servers||{}).length)){t.skip('unrelated Codex MCP servers are configured');return;}
  }
  const dir=mkdtempSync(join(tmpdir(),`or-supervisor-${agent}-`)),streams=new Set(),events=[];
  writeFileSync(join(dir,'config.json'),JSON.stringify({providers:{},routes:{}}));
  const previous=process.env.ORIGINROUTER_HOME;process.env.ORIGINROUTER_HOME=dir;
  const registry=new ExternalAgentRegistry(),store=new RuntimeTaskStore({stateDir:dir,aiJudgeAvailable:true});
  registry.runtimeTaskStore=store;
  store.setCards({cards:[{id:'rt_loop',name:'loop recovery',checkpoints:['loop'],judge:{kind:'ai',instruction:'Detect repetition'},action:{kind:'interrupt_and_continue',message:'Continue the task.'},limits:{maxFires:1,cooldownSeconds:0}}]});
  let judgments=0,requests=0,api,child,supervisor,server;let childOutput='';
  try{
    supervisor=new RuntimeSupervisor({registry,store,settleMs:20,judge:async()=>{judgments++;return {verdict:'act',confidence:0.99};}}).start();
    registry.subscribe((event)=>events.push(event));
    const token=ensureApiToken(dir);
    api=await startLocalApi({bindAddress:'127.0.0.1',externalAgentRegistry:registry,runtimeTaskStore:store,runtimeSupervisor:supervisor},{port:0});
    writeFileSync(join(dir,'daemon.state.json'),JSON.stringify({localApiPort:api.port,localApiBindAddress:'127.0.0.1',localApiBaseUrl:`http://127.0.0.1:${api.port}`}));
    server=http.createServer((req,res)=>{
      req.resume();if(req.method!=='POST'){res.writeHead(404);res.end();return;}
      const n=++requests;streams.add(res);res.on('close',()=>streams.delete(res));res.writeHead(200,{'Content-Type':'text/event-stream'});
      const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
      if(agent==='claude'){
        send('message_start',{message:{id:`m${n}`,type:'message',role:'assistant',content:[],model:'claude-sonnet-4-5-20250929',stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
        send('content_block_start',{index:0,content_block:{type:'text',text:''}});send('content_block_delta',{index:0,delta:{type:'text_delta',text:n===1?repeat:'Recovered.'}});
        if(n>1){send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}});send('message_stop',{});res.end();}
      }else{
        const text=n===1?repeat:'Recovered.';
        send('response.created',{response:{id:`r${n}`}});send('response.output_item.added',{item:{type:'message',role:'assistant',id:`m${n}`,content:[]}});send('response.output_text.delta',{delta:text});
        if(n>1){send('response.output_item.done',{item:{type:'message',role:'assistant',id:`m${n}`,content:[{type:'output_text',text}]}});send('response.completed',{response:{id:`r${n}`,usage:{input_tokens:0,input_tokens_details:null,output_tokens:0,output_tokens_details:null,total_tokens:0}}});res.end();}
      }
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${server.address().port}`;
    const env={...process.env,ORIGINROUTER_HOME:dir,ORIGINROUTER_SERVER_BASE_URL:'http://127.0.0.1:1',ORIGINROUTER_CONTROL_BASE_URL:'http://127.0.0.1:1',CLAUDE_CONFIG_DIR:dir,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ANTHROPIC_BASE_URL:url,ANTHROPIC_API_KEY:'offline-key',OPENAI_BASE_URL:`${url}/v1`,OPENAI_API_KEY:'offline-key'};
    child=spawn(process.execPath,[fileURLToPath(new URL('../bin/originrouter.js',import.meta.url)),agent==='claude'?'claude-sdk':'codex-app-server','--originrouter-session','real-supervisor-test','--originrouter-relay-mode','local','--model',agent==='claude'?'claude-sonnet-4-5-20250929':'gpt-5.1-codex','--prompt','Perform the test task.'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
    child.stderr.on('data',(data)=>{childOutput=(childOutput+data.toString()).slice(-4000);});child.stdout.on('data',(data)=>{childOutput=(childOutput+data.toString()).slice(-4000);});
    try { await until(()=>{
      if(child.exitCode!=null)throw new Error(`wrapper exited ${child.exitCode}: ${childOutput}`);
      return events.find((e)=>e.type==='event'&&e.payload?.type==='agent.supervisor.acted'&&e.payload.action==='interrupt_and_continue');
    }); } catch(error) {
      console.error(JSON.stringify({agent,requests,judgments,childOutput,events:events.slice(-35).map((e)=>({type:e.type,payload:{type:e.payload?.type,status:e.payload?.status,id:e.payload?.id,reason:e.payload?.reason,code:e.payload?.code,turnId:e.payload?.turnId,accepted:e.payload?.accepted}}))}));
      throw error;
    }
    await until(()=>requests>=2);
    const receipt=await until(()=>{
      try { return JSON.parse(readFileSync(join(dir,'runtime-task-log.json'),'utf8')).find((item)=>item.type==='agent.supervisor.receipt'); }
      catch { return null; }
    });
    assert.equal(judgments,1);assert.equal(requests,2);
    assert.equal(receipt.sessionId,'real-supervisor-test');
    assert.equal(store.annotateHistory('real-supervisor-test',{messages:[{role:'user',text:'Continue the task.',createdAt:receipt.createdAt}]}).messages[0].origin,'supervisor');
    assert.equal(store.recoveryFor('real-supervisor-test').pending,false);
    assert.ok(events.some((e)=>e.type==='command'&&e.payload?.type==='agent.message'&&e.payload.origin==='supervisor'));
    assert.equal(registry.eventsAfter(0).events.some((event)=>event.type==='_supervisor.output'),false);
    try {
      await until(()=>events.some((e)=>e.type==='event'&&canonicalTurnEventType(e.payload?.type)==='agent.task.complete'));
      registry.enqueueCommand('real-supervisor-test',{type:'terminal.interrupt',sessionId:'real-supervisor-test'});
      store.setCards({cards:[{id:'rt_continue',name:'confirmed continuation',checkpoints:['turn_ended'],
        judge:{kind:'builtin',rule:'always'},action:{kind:'send',message:'Continue automatically.'},
        limits:{maxFires:1,cooldownSeconds:0}}]});
      const resumed=registry.enqueueCommand('real-supervisor-test',{type:'agent.message',sessionId:'real-supervisor-test',message:'Continue after my stop.'});
      assert.equal(store.recoveryFor('real-supervisor-test').userStopped,true);
      await until(()=>events.find((e)=>e.type==='event'&&e.payload?.type==='agent.message.result'
        && e.payload.messageId===resumed.commandId && e.payload.accepted===true));
      assert.equal(store.recoveryFor('real-supervisor-test'),null);
      await until(()=>requests>=3);
      const continued=await until(()=>events.find((e)=>e.type==='event'&&e.payload?.type==='agent.supervisor.acted'&&e.payload.action==='send'));
      assert.ok(events.some((e)=>e.type==='event'&&e.payload?.type==='agent.message.result'
        && e.payload.messageId===continued.payload.messageId && e.payload.accepted===true));
      await until(()=>requests>=4);
      assert.equal(store.recoveryFor('real-supervisor-test').pending,false);
    } catch (error) {
      console.error(JSON.stringify({agent,requests,childOutput,tail:events.slice(-30).map(e=>({type:e.type,payload:e.payload}))}));
      throw error;
    }
    registry.enqueueCommand('real-supervisor-test',{type:'session.stop'});
  }finally{
    if(child&&child.exitCode==null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode==null)child.kill('SIGKILL');}
    supervisor?.stop();for(const stream of streams)stream.destroy();if(server)await new Promise(r=>server.close(r));await api?.close();
    if(previous==null)delete process.env.ORIGINROUTER_HOME;else process.env.ORIGINROUTER_HOME=previous;rmSync(dir,{recursive:true,force:true});
  }
});
