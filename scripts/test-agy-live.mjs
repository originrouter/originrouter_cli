// Explicit live integration test: real daemon and official agy account/quota.
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
if(!process.argv.includes('--live')) { console.error('Pass --live to run isolated tasks using the official agy login and quota.'); process.exit(2); }
const project=fileURLToPath(new URL('..',import.meta.url)),bin=join(project,'bin/originrouter.js');
const root=mkdtempSync(join(tmpdir(),'originrouter-live-agy-e2e-'));const state=join(root,'state');mkdirSync(state);mkdirSync(join(root,'workspace'));const workspace=realpathSync(join(root,'workspace'));
writeFileSync(join(root,'marker.txt'),'ORIGINROUTER_REAL_TOOL_MARKER\n');writeFileSync(join(state,'local-api.json'),JSON.stringify({relayMode:'off'}));
const env={...process.env,ORIGINROUTER_HOME:state,ORIGINROUTER_DISABLE_UPDATE_CHECK:'1'};
const daemon=spawn(process.execPath,[bin,'daemon','--local-port','0'],{cwd:project,env,stdio:['ignore','pipe','pipe']});
for(const stream of [daemon.stdout,daemon.stderr])stream.on('data',data=>writeFileSync(join(root,'daemon.log'),data,{flag:'a'}));
let base,token,current;const results=[];
const save=x=>{results.push(x);writeFileSync(join(root,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(x));};
const wait=async(label,fn,ms=40000)=>{const end=Date.now()+ms;let last;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){last=e.message;}await delay(200);}throw new Error(label+' timed out '+(last||''));};
const api=async(path,body)=>{const res=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});const data=await res.json();if(!res.ok)throw new Error(JSON.stringify({path,status:res.status,data}));return data.data||data;};
const snap=()=>api(`/agent/local/sessions/${current}/snapshot`);
const history=()=>api(`/agent/local/sessions/${current}/history`);
const command=(name,body={})=>api(`/agent/local/sessions/${current}/${name}`,body);
console.log(JSON.stringify({root}));
try {
 const ds=await wait('daemon',()=>{const p=join(state,'daemon.state.json');if(existsSync(p)){const s=JSON.parse(readFileSync(p));if(s.localApiPort)return s;}},15000);
 base=ds.localApiBaseUrl||`http://127.0.0.1:${ds.localApiPort}`;token=readFileSync(join(state,'local-api.token'),'utf8').trim();
 const {workspace:ws}=await api('/agent/catalog/workspaces/trust',{path:workspace});
 current='agy-live-first';
 await api('/agent/local/launch',{launchId:'agy-live-launch',sessionId:current,conversationId:'agy-live-conversation',runId:'agy-live-run',agentType:'agy',workspaceId:ws.workspace_id,initialMessage:'Reply exactly ORIGINROUTER_REAL_ACP_MESSAGE_OK. Do not use tools.',permissionProfile:'manual'});
 let s=await wait('native catalog',async()=>{const x=await snap();return x.modelSource==='native'&&x.availableModels?.length?x:null;});
 save({check:'app-launch-native-catalog',passed:true,model:s.model,models:s.availableModels.length});
 await wait('first real answer',async()=>{const h=await history();return h.messages?.some(x=>x.text==='ORIGINROUTER_REAL_ACP_MESSAGE_OK');},55000);
 save({check:'app-prompt-real-response',passed:true});
 s=await snap();const native=s.session.native_session_id;const beforeModel=s.model;
 const next=s.availableModels.find(x=>x.id!==beforeModel);assert.ok(next);
 await command('model',{model:next.id,requestId:'live-model'});
 await wait('native switch',async()=>{const x=await snap();return x.model===next.id;});
 let after=await snap();save({check:'native-model-set',passed:true,model:after.model,efforts:after.availableEfforts});
 await command('model',{model:beforeModel,requestId:'live-model-reset'});await wait('reset model',async()=>(await snap()).model===beforeModel);
 s=await wait('effort catalog',async()=>{const x=await snap();return x.availableEfforts?.length?x:null;},10000);if(s.availableEfforts?.length){const nextEffort=s.availableEfforts.find(x=>x!==s.effort)||s.availableEfforts[0];await command('effort',{effort:nextEffort,requestId:'live-effort'});await wait('effort changed',async()=>(await snap()).effort===nextEffort);save({check:'native-effort-set',passed:true,effort:nextEffort});}
 await command('message',{message:`Read ${join(root,'marker.txt')} exactly once with the file-reading tool. If denied say ORIGINROUTER_DENIED and do not retry or use other tools.`,messageId:'live-read'});
 const approval=await wait('approval or native policy allowed read',async()=>{const x=await snap();return x.interactions?.find(x=>x.kind==='permission')||((await history()).messages?.some(x=>x.text?.includes('ORIGINROUTER_REAL_TOOL_MARKER'))?{nativeAllowed:true}:null);},45000);
 if(!approval.nativeAllowed)await command('interaction',{interactionId:approval.interactionId,responseId:'live-approval',action:'allow'});
 await wait('real tool response',async()=>{const h=await history();return h.messages?.some(x=>x.text?.includes('ORIGINROUTER_REAL_TOOL_MARKER'));},50000);
 save({check:'app-real-tool',passed:true,nativePolicyAllowed:approval.nativeAllowed===true,interactionId:approval.interactionId});
 await wait('read turn ended',async()=>(await snap()).turn_state==='idle',15000);
 if(process.argv.includes('--parity')) {
  s=await snap();assert.ok(s.commands.some(c=>c.name==='compact'));assert.equal(s.promptCapabilities.image,true);assert.equal(s.promptCapabilities.embeddedContext,true);
  save({check:'native-command-and-content-capability-snapshot',passed:true,commands:s.commands.map(c=>c.name)});
  await command('message',{message:'Use the originrouter_device remote_env_list MCP tool once to list configured remote targets. Do not use any other tools. Afterwards reply exactly OR_DEVICE_TOOL_DONE.',messageId:'parity-device-tool'});
  let deviceApproval=false;const seen=new Set();
  await wait('device tool approved and completed',async()=>{const x=await snap();for(const item of x.interactions||[])if(!seen.has(item.interactionId)){seen.add(item.interactionId);if(item.payload?.tool==='originrouter.remote.list')deviceApproval=true;await command('interaction',{interactionId:item.interactionId,responseId:`parity-${seen.size}`,action:'allow'});}return deviceApproval&&x.turn_state==='idle';},90000);
  save({check:'real-originrouter-device-mcp-through-existing-approval',passed:true});
  await command('message',{message:'Use ask_question to ask me to choose a color from red and blue. Wait for my choice. Do not use other tools.',messageId:'parity-form'});
  const form=await wait('native question form',async()=>(await snap()).interactions.find(x=>x.kind==='form'),55000);
  const schema=form.payload.schema,values={};for(const [key,field]of Object.entries(schema.properties)){if(field.oneOf?.length)values[key]=field.oneOf[0].const;else if(field.enum?.length)values[key]=field.enum[0];else if(field.type==='array')values[key]=[field.items?.enum?.[0]||field.items?.oneOf?.[0]?.const||'1'];}
  await command('interaction',{interactionId:form.interactionId,responseId:'parity-form-answer',action:'submit',response:{values}});
  await wait('form turn ended',async()=>(await snap()).turn_state==='idle',40000);save({check:'real-form-answer-via-local-app-control',passed:true});
  await command('message',{message:'Reply only with the marker in the attached file. Do not use tools.',messageId:'parity-content',content:[{type:'resource',resource:{uri:'originrouter-attachment:marker.txt',mimeType:'text/plain',text:'OR_LOCAL_APP_ATTACHMENT_OK'}}]});
  await wait('attachment answer',async()=>(await history()).messages.some(x=>x.text==='OR_LOCAL_APP_ATTACHMENT_OK'),45000);
  await wait('attachment turn ended',async()=>(await snap()).turn_state==='idle',15000);save({check:'real-embedded-context-via-local-app-control',passed:true});
  s=await snap();assert.ok(s.usage?.contextWindowTokens>0);assert.equal(s.usage.amountMicros,null);save({check:'context-usage-without-fabricated-quota-or-price',passed:true});
 }
 await command('stop');await wait('first detached',async()=>{const x=await snap();return x.session?.attached===false;},15000);save({check:'app-stop',passed:true});
 current='agy-live-resumed';
 await api('/agent/local/launch',{launchId:'agy-live-resume-launch',sessionId:current,conversationId:'agy-live-conversation',runId:'agy-live-resume-run',agentType:'agy',workspaceId:ws.workspace_id,resumeConversationId:'agy-live-conversation',nativeSessionId:native,inheritPermission:true,initialMessage:'',permissionProfile:'manual'});
 s=await wait('resume',async()=>{const x=await snap();return x.modelSource==='native'&&x.availableModels?.length?x:null;});
 assert.equal(s.session.native_session_id,native);assert.ok((await history()).messages.some(x=>x.text==='ORIGINROUTER_REAL_ACP_MESSAGE_OK'));
 save({check:'app-resume-same-native-history',passed:true,nativeSessionId:native});
 await command('message',{message:'Reply exactly ORIGINROUTER_REAL_RESUME_OK. Do not use tools.',messageId:'live-resume-message'});
 await wait('resume response',async()=>(await history()).messages.some(x=>x.text==='ORIGINROUTER_REAL_RESUME_OK'),50000);save({check:'app-resume-real-response',passed:true});
 await command('stop');await wait('resumed detached',async()=>(await snap()).session?.attached===false,15000);
} catch(error){save({error:error.message,passed:false});process.exitCode=1;}
finally {if(current&&base){try{await command('stop');}catch{}}daemon.kill('SIGTERM');await Promise.race([new Promise(r=>daemon.once('exit',r)),delay(4000)]);if(daemon.exitCode===null)daemon.kill('SIGKILL');console.log(JSON.stringify({evidence:root}));}
