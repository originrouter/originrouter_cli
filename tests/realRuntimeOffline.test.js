// Opt-in compatibility test: real installed runtimes, local fake model HTTP
// servers, ephemeral workspace/session. It never sends a prompt to a provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CodexAppServerClient } from '../src/adapters/codex/appServerClient.js';
import { claudeStreamPart, codexStreamDelta } from '../src/runtime/runtimeOutputSampler.js';

const enabled = process.env.ORIGINROUTER_RUN_REAL_AGENT_OFFLINE_TESTS === '1';
async function until(fn) {
  const deadline=Date.now()+15_000;
  while (Date.now()<deadline) {const found=fn();if(found)return found;await new Promise((r)=>setTimeout(r,20));}
  throw new Error('runtime event timed out');
}
async function listen(handler) {
  const server=http.createServer(handler); await new Promise((r)=>server.listen(0,'127.0.0.1',r)); return server;
}

test('real Claude SDK streams, interrupts and accepts a continuation against a local fixture', {skip:!enabled,timeout:35_000}, async () => {
  const dir=mkdtempSync(join(tmpdir(),'or-real-claude-')), messages=[], streams=new Set(), queue=[], waiters=[];
  let done=false, requests=0;
  async function* input() {while(!done){if(!queue.length)await new Promise((r)=>waiters.push(r));while(queue.length)yield {type:'user',message:{role:'user',content:queue.shift()},parent_tool_use_id:null};}}
  function push(value){queue.push(value);waiters.splice(0).forEach((r)=>r());}
  const server=await listen((req,res)=>{
    req.resume(); if(req.method!=='POST'||!req.url.startsWith('/v1/messages')){res.writeHead(404);res.end();return;}
    const n=++requests; streams.add(res);res.on('close',()=>streams.delete(res));res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
    send('message_start',{message:{id:`m${n}`,type:'message',role:'assistant',content:[],model:'claude-sonnet-4-5-20250929',stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
    send('content_block_start',{index:0,content_block:{type:'text',text:''}});
    send('content_block_delta',{index:0,delta:{type:'text_delta',text:n===1?'repeated':'continued'}});
    if(n>1){send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}});send('message_stop',{});res.end();}
  });
  const controller=new AbortController();
  const session=query({prompt:input(),options:{cwd:dir,abortController:controller,persistSession:false,settingSources:[],model:'claude-sonnet-4-5-20250929',includePartialMessages:true,
    env:{PATH:process.env.PATH,CLAUDE_CONFIG_DIR:dir,ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'offline-test-key',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}});
  const consume=(async()=>{try{for await(const item of session)messages.push(item);}catch{}})();
  try {
    push('test'); await until(()=>messages.find((m)=>claudeStreamPart(m)?.text==='repeated'));
    await session.interrupt();
    const first=await until(()=>messages.find((m)=>m.type==='result'));
    assert.match(first.terminal_reason,/^aborted/);
    push('continue'); await until(()=>messages.find((m)=>claudeStreamPart(m)?.text==='continued'));
    await until(()=>messages.filter((m)=>m.type==='result').length>=2);
    assert.equal(requests,2);
  } finally {
    done=true;waiters.splice(0).forEach((r)=>r());controller.abort();try{await session.return();}catch{}
    for(const stream of streams)stream.destroy();await new Promise((r)=>server.close(r));await Promise.race([consume,new Promise((r)=>setTimeout(r,1000))]);rmSync(dir,{recursive:true,force:true});
  }
});

test('real Codex app-server streams, confirms interruption and accepts a continuation against a local fixture', {skip:!enabled,timeout:35_000}, async (t) => {
  const listing=spawnSync('codex',['mcp','list','--json'],{encoding:'utf8'});
  if(listing.status!==0){t.skip('installed Codex MCP inventory is unavailable');return;}
  let configured;try{configured=JSON.parse(listing.stdout);}catch{t.skip('installed Codex MCP inventory cannot be verified');return;}
  if((Array.isArray(configured) ? configured.length : Object.keys(configured || {}).length)>0){t.skip('global MCP servers are configured; avoid starting unrelated servers');return;}
  const dir=mkdtempSync(join(tmpdir(),'or-real-codex-')),events=[],streams=new Set();let requests=0;
  const server=await listen((req,res)=>{
    const n=++requests;req.resume();streams.add(res);res.on('close',()=>streams.delete(res));res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(event)=>res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);const text=n===1?'repeated':'continued';
    send({type:'response.created',response:{id:`r${n}`}});send({type:'response.output_item.added',item:{type:'message',role:'assistant',id:`m${n}`,content:[]}});
    send({type:'response.output_text.delta',delta:text});
    if(n>1){send({type:'response.output_item.done',item:{type:'message',role:'assistant',id:`m${n}`,content:[{type:'output_text',text}]}});send({type:'response.completed',response:{id:`r${n}`,usage:{input_tokens:0,input_tokens_details:null,output_tokens:0,output_tokens_details:null,total_tokens:0}}});res.end();}
  });
  const client=new CodexAppServerClient({rpcTimeoutMs:15_000});client.onEvent((event)=>events.push(event));
  try {
    await client.connect({cwd:dir,env:{...process.env,OPENAI_API_KEY:'offline-test-key'},modelProvider:{id:'originrouter_test',name:'Local fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,envKey:'OPENAI_API_KEY',wireApi:'responses'}});
    const thread=(await client.startThread({cwd:dir,model:'gpt-5.1-codex',ephemeral:true,approvalPolicy:'never'})).thread.id;
    const first=(await client.startTurn({threadId:thread,input:[{type:'text',text:'test',text_elements:[]}]})).turn.id;
    await until(()=>events.find((event)=>codexStreamDelta(event,first,thread)==='repeated'));
    await client.interruptTurn(thread,first);
    await until(()=>events.find((event)=>event.type==='turn_aborted'&&event.turn_id===first));
    const second=(await client.startTurn({threadId:thread,input:[{type:'text',text:'continue',text_elements:[]}]})).turn.id;
    await until(()=>events.find((event)=>event.type==='task_complete'&&event.turn_id===second));
    assert.equal(events.map((event)=>codexStreamDelta(event,second,thread)).filter(Boolean).join(''),'continued');
    assert.equal(requests,2);
  } finally {client.disconnect();for(const stream of streams)stream.destroy();await new Promise((r)=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
