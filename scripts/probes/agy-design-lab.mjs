// Opt-in research harness. Not connected to production startup. Raw artifacts remain in a private temporary directory.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {stripVTControlCharacters} from 'node:util';
import {PtyExecutor} from '../../src/executors/ptyExecutor.js';
import {inheritSystemProxyEnv} from '../../src/utils/systemProxy.js';
if (!process.argv.includes('--live')) { console.error('Use --live to create an isolated official agy research session; prompts consume official account quota.'); process.exit(2); }
const root=fs.mkdtempSync(path.join(os.tmpdir(),'originrouter-agy-design-lab-'));
const workspace=path.join(root,'workspace');fs.mkdirSync(path.join(workspace,'.agents'),{recursive:true});
fs.writeFileSync(path.join(workspace,'hook-target.txt'),'DESIGN_LAB_READ_MARKER\n');
const token=randomBytes(24).toString('hex');let executor,output='',exit=null,events=[],mode='allow',hold=0,hookOutput={},epoch=0;
// Read configuration identity only; never open Google credential stores.
const globalSettings=path.join(os.homedir(),'.gemini/antigravity-cli/settings.json');
const hash=p=>fs.existsSync(p)?createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;
const before=hash(globalSettings);const journal=x=>fs.appendFileSync(path.join(root,'journal.jsonl'),JSON.stringify({at:Date.now(),epoch,...x})+'\n');
const reply=(res,x,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(x));};
const handlerFile=path.join(root,'hook.cjs');
fs.writeFileSync(handlerFile,`const http=require('node:http');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const q=http.request(process.env.AGY_LAB_URL+'/hook',{method:'POST',headers:{authorization:'Bearer '+process.env.AGY_LAB_TOKEN,'content-type':'application/json'}},r=>{r.pipe(process.stdout)});q.on('error',()=>process.exit(8));q.end(s);});`);
let base;
function hooks(timeout=300){const h={type:'command',command:[process.execPath,handlerFile].map(x=>process.platform==='win32'?'\"'+x.replaceAll('\"','')+'\"':"'"+x.replaceAll("'","'\\''")+"'").join(' '),timeout};const entries=Object.fromEntries(['SessionStart','PreInvocation','PostInvocation','Stop'].map(k=>[k,[h]]));for(const k of ['PreToolUse','PostToolUse'])entries[k]=[{matcher:'*',hooks:[h]}];return {'originrouter-design-lab':entries};}
async function stop(){if(executor&&!exit){executor.stop();for(let n=0;n<40&&!exit;n++)await new Promise(r=>setTimeout(r,100));}return exit;}
const server=http.createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer '+token)return reply(res,{error:'unauthorized'},401);let body='';for await(const x of req)body+=x;let d;try{d=JSON.parse(body||'{}');}catch{return reply(res,{error:'json'},400);}try{
if(req.url==='/hook'){events.push(d);journal({kind:'hook',payload:d});const result=d.hookEventName==='PreToolUse'?{decision:mode,reason:'Isolated design lab decision'}:hookOutput[d.hookEventName]||{};if(d.hookEventName==='PreToolUse'&&hold)await new Promise(r=>setTimeout(r,hold));journal({kind:'hook_response',event:d.hookEventName,result});return reply(res,result);}
if(req.url==='/status')return reply(res,{root,workspace,epoch,pid:executor?.terminal?.pid,exit,screen:stripVTControlCharacters(output).slice(-10000),events:events.slice(-18),settingsUnchanged:before===hash(globalSettings)});
if(req.url==='/mode'){mode=d.decision||'allow';hold=d.hold||0;hookOutput=d.outputs||{};return reply(res,{ok:true});}
if(req.url==='/input'){executor.write(d.data);journal({kind:'input',data:d.data});return reply(res,{ok:true});}
if(req.url==='/stop')return reply(res,{exit:await stop()});
if(req.url==='/start'){await stop();epoch++;output='';exit=null;events=[];const entries=hooks(d.timeout??300);if(d.settingsHooksOnly)fs.rmSync(path.join(workspace,'.agents/hooks.json'),{force:true});else fs.writeFileSync(path.join(workspace,'.agents/hooks.json'),JSON.stringify(entries));const settings={altScreenMode:'never',...(d.settingsHooksOnly?{hooks:entries}:{}),...(d.settings||{})};const settingsFile=path.join(root,'settings-'+epoch+'.json');fs.writeFileSync(settingsFile,JSON.stringify(settings));const args=['--settings',settingsFile,'--log-file',path.join(root,'agy-'+epoch+'.log'),...(d.args||[])];const env={...inheritSystemProxyEnv(process.env),AGY_LAB_URL:base,AGY_LAB_TOKEN:token};delete env.ORIGINROUTER_AGY_HOOK_URL;delete env.ORIGINROUTER_AGY_HOOK_TOKEN;executor=new PtyExecutor({forceKillMs:1500});let command='agy',launchArgs=args;if(d.guard){if(process.platform!=='darwin')throw new Error('The settings-write guard requires macOS sandbox-exec');const profile=path.join(root,'guard.sb');fs.writeFileSync(profile,'(version 1)(allow default)(deny file-write* (regex '+JSON.stringify('^'+globalSettings.replaceAll('.', '[.]')+'[^/]*$')+'))');command='/usr/bin/sandbox-exec';launchArgs=['-f',profile,path.join(os.homedir(),'.local/bin/agy'),...args];}const e=epoch;const p=await executor.start({command,args:launchArgs,cwd:workspace,env,cols:120,rows:40,onOutput:x=>{output=(output+x).slice(-500000);fs.appendFileSync(path.join(root,'terminal-'+e+'.raw'),x);},onExit:x=>{exit=x;journal({kind:'exit',...x});},onError:x=>journal({kind:'error',error:x.message})});journal({kind:'start',args,guard:!!d.guard,pid:p.pid});return reply(res,{...p,epoch,settingsFile});}
if(req.url==='/shutdown'){await stop();reply(res,{settingsUnchanged:before===hash(globalSettings)});server.close();server.closeAllConnections();return;}return reply(res,{error:'unknown'},404);
}catch(e){reply(res,{error:e.message},500);}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;fs.writeFileSync(path.join(root,'controller.json'),JSON.stringify({url:base,token}),{mode:0o600});console.log(root);setTimeout(async()=>{await stop();server.close();server.closeAllConnections();},20*60_000).unref();
