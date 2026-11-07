// Opt-in integration: actual scheduler, persistent catalog, managed launcher,
// wrappers against local deterministic model API fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ensureApiToken } from '../src/persistence/authToken.js';
import { AgentCatalog } from '../src/persistence/agentCatalog.js';
import { startLocalApi } from '../src/local/localApi.js';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { ManagedAgentSupervisor } from '../src/daemon/managedAgentSupervisor.js';
import { ScheduledTaskStore } from '../src/runtime/scheduledTaskStore.js';
import { ScheduledTaskScheduler } from '../src/runtime/scheduledTaskScheduler.js';

async function until(fn){const end=Date.now()+20_000;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,30));}throw new Error('scheduled launch timed out');}

for (const agent of ['claude','codex']) test(`scheduled task starts real managed ${agent} and records completion with no App online`, {skip:process.env.ORIGINROUTER_RUN_REAL_AGENT_OFFLINE_TESTS!=='1',timeout:35_000},async(t)=>{
  if(agent==='codex') {
    const inventory=spawnSync('codex',['mcp','list','--json'],{encoding:'utf8'});let servers;
    try{servers=JSON.parse(inventory.stdout);}catch{t.skip('Codex MCP inventory unavailable');return;}
    if(inventory.status!==0||(Array.isArray(servers)?servers.length:Object.keys(servers||{}).length)){t.skip('unrelated MCP servers configured');return;}
  }
  const root=mkdtempSync(join(tmpdir(),'or-scheduled-real-')),workspace=join(root,'workspace');mkdirSync(workspace);
  const previous={...process.env},registry=new ExternalAgentRegistry();let catalog,store,scheduler,api,server,child,requests=0;const children=[];
  try{
    process.env.ORIGINROUTER_HOME=root;process.env.ORIGINROUTER_SERVER_BASE_URL='http://127.0.0.1:1';process.env.ORIGINROUTER_CONTROL_BASE_URL='http://127.0.0.1:1';process.env.OPENAI_API_KEY='offline-key';
    writeFileSync(join(root,'config.json'),JSON.stringify({providers:{},routes:{}}));
    server=http.createServer((req,res)=>{req.resume();
      const path=new URL(req.url,'http://127.0.0.1').pathname;
      if(req.method==='POST' && path.endsWith(agent==='claude' ? '/messages' : '/responses')) requests++;
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const events = agent === 'claude' ? [
        {type:'message_start',message:{id:'m1',type:'message',role:'assistant',content:[],model:'claude-sonnet-4-5-20250929',stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'done'}},
        {type:'content_block_stop',index:0}, {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}},
        {type:'message_stop'},
      ] : [
        {type:'response.created',response:{id:'r1'}},{type:'response.output_item.added',item:{type:'message',role:'assistant',id:'m1',content:[]}},
        {type:'response.output_text.delta',delta:'done'},{type:'response.output_item.done',item:{type:'message',role:'assistant',id:'m1',content:[{type:'output_text',text:'done'}]}},
        {type:'response.completed',response:{id:'r1',usage:{input_tokens:0,input_tokens_details:null,output_tokens:0,output_tokens_details:null,total_tokens:0}}},
      ];
      for(const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);res.end();});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const fixtureBase=`http://127.0.0.1:${server.address().port}`;
    process.env.OPENAI_BASE_URL=`${fixtureBase}/v1`;process.env.ANTHROPIC_BASE_URL=fixtureBase;
    process.env.ANTHROPIC_API_KEY='offline-key';process.env.CLAUDE_CONFIG_DIR=root;process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
    catalog=new AgentCatalog({stateDir:root});const trusted=catalog.trustWorkspace(workspace,{deviceId:'device-test'});
    store=new ScheduledTaskStore({stateDir:root});
    const launcher=new ManagedAgentSupervisor({catalog,deviceId:'device-test',relayUrl:'http://127.0.0.1:1',spawnFn:(command,args,options)=>{
      child=spawn(command,args,{...options,stdio:['ignore','pipe','pipe']});children.push(child);child.on('error',()=>{});let tail='';
      child.stderr.on('data',(x)=>{tail=(tail+x.toString()).slice(-3000);});child.stdout.on('data',(x)=>{tail=(tail+x.toString()).slice(-3000);});child.diagnostic=()=>tail;return child;
    }});
    scheduler=new ScheduledTaskScheduler({store,supervisor:launcher,registry,catalog,intervalMs:100});
    ensureApiToken(root);api=await startLocalApi({bindAddress:'127.0.0.1',externalAgentRegistry:registry,scheduledTaskScheduler:scheduler,agentCatalog:catalog},{port:0});
    writeFileSync(join(root,'daemon.state.json'),JSON.stringify({localApiPort:api.port,localApiBindAddress:'127.0.0.1',localApiBaseUrl:`http://127.0.0.1:${api.port}`}));
    scheduler.start();
    const template={protocol_version:'1',template_id:'ait_offline123',name:'Offline approval',instructions:'Review workspace operations',allowed_scopes:['read_tools'],applicability:{}};
    const canonical=(v)=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    const aiReviewPolicy={...template,version:1,content_hash:createHash('sha256').update(JSON.stringify(canonical(template))).digest('hex')};
    store.save({id:'st_real',name:'test run',schedule:{kind:'once',at:new Date(Date.now()+1000).toISOString()},launch:{agentType:agent,workspaceId:trusted.workspace_id,initialMessage:'Execute the offline fixture task.',permissionProfile:'ai_review',aiReviewPolicy}});
    const execution=await until(()=>{
      const item=store.executions({taskId:'st_real'})[0];
      if(item&&['failed','uncertain'].includes(item.status))throw new Error(`${item.status}: ${item.detail || child?.diagnostic?.()}`);
      return item?.status==='succeeded'?item:null;
    });
    assert.equal(requests,1);assert.ok(execution.sessionId.startsWith('sa_'));assert.equal(store.executions({taskId:'st_real'}).length,1);
    assert.equal(store.list()[0].enabled,false);
  }finally{
    scheduler?.stop();for(const processChild of children)if(processChild.exitCode==null)processChild.kill('SIGTERM');
    await Promise.all(children.filter((p)=>p.exitCode==null).map((p)=>Promise.race([new Promise(r=>p.once('exit',r)),new Promise(r=>setTimeout(r,2000))])));
    for(const p of children)if(p.exitCode==null)p.kill('SIGKILL');
    await api?.close();store?.close();catalog?.close();if(server)await new Promise(r=>server.close(r));
    for(const key of ['ORIGINROUTER_HOME','ORIGINROUTER_SERVER_BASE_URL','ORIGINROUTER_CONTROL_BASE_URL','OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','CLAUDE_CONFIG_DIR','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']){if(previous[key]==null)delete process.env[key];else process.env[key]=previous[key];}
    rmSync(root,{recursive:true,force:true});
  }
});
