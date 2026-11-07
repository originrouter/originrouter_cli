import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { DeviceToolApprovalBroker } from '../src/mcp/deviceToolApprovalBroker.js';
import { createDeviceToolApprovalHandler } from '../src/runtime/deviceToolApproval.js';
import { PendingInteractionRegistry } from '../src/runtime/pendingInteractionRegistry.js';
import { resolveWithAutonomy } from '../src/runtime/agentAutonomyPolicy.js';

function fixture({profile='manual', timeoutMs=1000, aiReviewer=null} = {}) {
  const registry = new ExternalAgentRegistry();
  registry.register({sessionId:'s1',agent:'claude',runtime:'claude-sdk',supportsDeviceTools:true});
  registry.register({sessionId:'s2',agent:'codex',runtime:'codex-app-server',supportsDeviceTools:true});
  let account='a', revision=1;
  const requested=[];
  const interactions = new PendingInteractionRegistry({onRequested:async (item) => requested.push(item)});
  const handler = createDeviceToolApprovalHandler({sessionId:'s1', provider:'claude', runtime:'claude-sdk',
    revision:() => revision,
    requestInteraction:(request,signal) => resolveWithAutonomy({request,profile,aiReviewer,workspaceRoot:'/work',
      requestInteraction:(item) => interactions.request(item,signal)}),
    markApplied:(result) => interactions.markResult(result.interactionId,'applied',{responseId:result.responseId}),
    sendResult:async (event) => registry.notify('device_tool_approval_result','s1',event),
  });
  const broker = new DeviceToolApprovalBroker({registry,accountProvider:() => account,timeoutMs});
  const request = () => broker.authorize('s1',{tool:'originrouter.remote.exec',title:'Run SSH command',prompt:'review',input:{command:'pwd',cwd:'/srv'}});
  function pump() { for (const item of registry.commandsAfter('s1').commands) {
    if (item.type === 'agent.device_tool.approval') handler.start(item);
    if (item.type === 'agent.device_tool.cancel') handler.cancel(item.requestId);
  } }
  return {registry,broker,handler,interactions,requested,request,pump,setAccount:(x) => {account=x;},bumpRevision:() => {revision++;},close(){broker.close();handler.close();}};
}

test('manual approval reaches the existing interaction flow and is bound to the session', async () => {
  const f = fixture();
  try {
    let settled=false;
    const pending=f.request().finally(() => {settled=true;});
    f.pump(); await new Promise((resolve) => setTimeout(resolve,0));
    assert.equal(f.requested.length,1);
    assert.equal(f.requested[0].payload.command,'pwd');
    assert.equal(settled,false);
    const id=f.requested[0].interactionId;
    f.registry.notify('device_tool_approval_result','s2',{type:'agent.device_tool.approval_result',requestId:id,accepted:true});
    await new Promise((resolve) => setTimeout(resolve,0)); assert.equal(settled,false);
    f.interactions.resolve({interactionId:id,responseId:'r1',action:'allow'});
    assert.deepEqual(await pending,{account:'a'});
  } finally { f.close(); }
});

test('denial, expiry, session loss and account switch never authorize an action', async () => {
  for (const mode of ['deny','expiry','disconnect','account']) {
    const f = fixture({timeoutMs:mode === 'expiry' ? 30 : 1000});
    try {
      const pending=f.request();
      const rejected=assert.rejects(pending,{code:mode === 'deny' ? 'DEVICE_TOOL_DENIED' : mode === 'expiry' ? 'DEVICE_TOOL_APPROVAL_EXPIRED' : mode === 'disconnect' ? 'DEVICE_TOOL_SESSION_ENDED' : 'DEVICE_TOOL_ACCOUNT_CHANGED'});
      f.pump(); await new Promise((resolve) => setTimeout(resolve,0));
      const id=f.requested[0].interactionId;
      if (mode === 'deny') f.interactions.resolve({interactionId:id,responseId:'r1',action:'deny'});
      if (mode === 'disconnect') f.registry.unregister('s1');
      if (mode === 'account') { f.setAccount('b'); f.interactions.resolve({interactionId:id,responseId:'r1',action:'allow'}); }
      if (mode === 'expiry') await new Promise((resolve) => setTimeout(resolve,45));
      await rejected;
      if (mode !== 'disconnect') f.pump();
    } finally { f.close(); }
  }
});

test('unrestricted mode approves through the policy and changing permission revision rejects stale answers', async () => {
  const auto=fixture({profile:'unrestricted'});
  try { const p=auto.request(); auto.pump(); assert.deepEqual(await p,{account:'a'}); assert.equal(auto.requested.length,0); }
  finally {auto.close();}
  const f=fixture();
  try {
    const p=f.request(); const rejected=assert.rejects(p,{code:'DEVICE_TOOL_DENIED'});
    f.pump(); await new Promise((resolve) => setTimeout(resolve,0));
    f.bumpRevision();
    f.interactions.resolve({interactionId:f.requested[0].interactionId,responseId:'r',action:'allow'});
    await rejected;
  } finally {f.close();}
});

test('guarded and AI-review profiles require human approval for an unclassified device tool', async () => {
  for (const profile of ['guarded', 'ai_review']) {
    const f = fixture({profile, aiReviewer:{review:async () => ({decision:'allow',risk:'low',confidence:0.99})}});
    try {
      let settled=false;
      const pending=f.request().finally(() => {settled=true;});
      const rejected=assert.rejects(pending,{code:'DEVICE_TOOL_DENIED'});
      f.pump();
      await new Promise((resolve) => setTimeout(resolve,0));
      assert.equal(settled,false, `${profile} must not silently allow an unknown device operation`);
      assert.equal(f.requested.length,1);
      f.interactions.resolve({interactionId:f.requested[0].interactionId,responseId:'r',action:'deny'});
      await rejected;
    } finally {f.close();}
  }
});

test('cancellation removes the pending interaction and late results cannot be replayed', async () => {
  const f=fixture();
  try {
    const controller=new AbortController();
    const pending=f.broker.authorize('s1',{tool:'x',title:'x',input:{}},{signal:controller.signal});
    const rejected=assert.rejects(pending,{code:'DEVICE_TOOL_CANCELLED'});
    f.pump(); await new Promise((resolve) => setTimeout(resolve,0));
    const id=f.requested[0].interactionId;
    controller.abort(); await rejected; f.pump();
    await new Promise((resolve) => setTimeout(resolve,0));
    assert.equal(f.interactions.snapshot().length,0);
    f.registry.notify('device_tool_approval_result','s1',{type:'agent.device_tool.approval_result',requestId:id,accepted:true});
    assert.equal(f.broker.pending.size,0);
  } finally {f.close();}
});

test('old wrappers cannot be silently granted access', async () => {
  const f=fixture();
  try {
    f.registry.register({sessionId:'old',agent:'claude'});
    await assert.rejects(f.broker.authorize('old',{tool:'x'}),{code:'DEVICE_TOOL_UNAVAILABLE'});
    assert.equal(f.handler.start({requestId:`dta_${randomUUID()}`,expiresAt:0}),false);
  } finally {f.close();}
});

test('an already cancelled request cannot create a stale user prompt', async () => {
  const controller = new AbortController();
  controller.abort();
  const registry = new PendingInteractionRegistry();
  await assert.rejects(registry.request({interactionId:'expired'}, controller.signal), /interaction_aborted/);
  assert.deepEqual(registry.snapshot(), []);
});
