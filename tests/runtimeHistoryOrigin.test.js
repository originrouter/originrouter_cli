import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ExternalAgentRegistry } from '../src/local/externalAgentRegistry.js';
import { RuntimeTaskStore } from '../src/runtime/runtimeTaskStore.js';

test('history identifies a confirmed supervisor message without changing ordinary messages', () => {
  const dir=mkdtempSync(join(tmpdir(),'or-origin-history-'));
  const store=new RuntimeTaskStore({stateDir:dir});
  const transcript=join(dir,'claude.jsonl');
  const digest=createHash('sha256').update('继续').digest('hex');
  try {
    writeFileSync(transcript,[
      {type:'user',uuid:'u1',timestamp:'2026-11-03T00:00:00Z',message:{content:'继续'}},
      {type:'user',uuid:'u2',timestamp:'2026-11-03T00:01:00Z',message:{content:'继续'}},
      {type:'user',uuid:'u3',timestamp:'2026-11-03T00:01:01Z',message:{content:'different'}},
    ].map((row)=>JSON.stringify(row)).join('\n'));
    store.appendLog({type:'agent.supervisor.receipt',sessionId:'s1',messageId:'supervisor_x',messageDigest:digest,createdAt:'2026-11-03T00:01:00Z'});
    const registry=new ExternalAgentRegistry({runtimeTaskStore:store});
    registry.register({sessionId:'s1',agent:'claude',transcriptPath:transcript});
    const history=registry.history('s1',{});
    assert.deepEqual(history.messages.map((item)=>item.origin || null),[null,'supervisor',null]);
    assert.deepEqual(store.log(),[],'internal receipt does not appear as a user-facing task log');
    const other=store.annotateHistory('another',history);
    assert.equal(other.messages.filter((item)=>item.origin==='supervisor').length,1,'already annotated data is preserved');
    assert.equal(store.annotateHistory('another',{messages:history.messages.map(({origin,...rest})=>rest)}).messages.some((item)=>item.origin),false);
    const ambiguous = store.annotateHistory('s1', {messages:[
      {role:'user',text:'继续',createdAt:'2026-11-03T00:01:00Z'},
      {role:'user',text:'继续',createdAt:'2026-11-03T00:01:01Z'},
    ]});
    assert.equal(ambiguous.messages.some((item)=>item.origin),false, 'an identical user message cannot be falsely attributed');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
