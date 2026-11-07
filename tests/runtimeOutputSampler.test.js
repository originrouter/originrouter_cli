import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeOutputSampler, claudeStreamPart, codexStreamDelta } from '../src/runtime/runtimeOutputSampler.js';

test('batches output without crossing turn boundaries', () => {
  const sampler = new RuntimeOutputSampler({ chunkSize: 8, maxBuffer: 32 });
  sampler.reset('turn-1');
  assert.deepEqual(sampler.add('turn-1', 'abcd'), []);
  assert.deepEqual(sampler.add('wrong', 'ignored!'), []);
  assert.deepEqual(sampler.add('turn-1', 'efghij'), ['abcdefgh']);
  assert.equal(sampler.flush('wrong'), null);
  assert.equal(sampler.flush('turn-1'), 'ij');
  sampler.add('turn-1', 'old');
  sampler.reset('turn-2');
  assert.equal(sampler.flush('turn-1'), null);
  assert.deepEqual(sampler.add('turn-2', 'new text'), ['new text']);
});


test('a partial batch is delivered while its turn is still running and never leaks to another turn', async () => {
  const chunks = [];
  const sampler = new RuntimeOutputSampler({chunkSize:512,flushIntervalMs:20,onChunk:(turn,text) => chunks.push([turn,text])});
  sampler.reset('one');
  sampler.add('one','Let me check this again. '.repeat(5));
  await new Promise((resolve) => setTimeout(resolve,40));
  assert.deepEqual(chunks,[['one','Let me check this again. '.repeat(5)]]);
  sampler.add('one','old partial');
  sampler.reset('two');
  sampler.add('two','new partial');
  await new Promise((resolve) => setTimeout(resolve,40));
  assert.deepEqual(chunks[1],['two','new partial']);
  assert.equal(chunks.length,2);
  sampler.reset();
});

test('discarding an oversized sample signals a discontinuity', () => {
  let gaps=0;
  const sampler=new RuntimeOutputSampler({chunkSize:8,maxBuffer:16,onGap:() => gaps++});
  sampler.reset('turn');
  sampler.add('turn','x'.repeat(20));
  assert.equal(gaps,1);
});

test('samples only visible top-level Claude SDK output', () => {
  assert.deepEqual(claudeStreamPart({type:'stream_event', parent_tool_use_id:null, event:{type:'message_start'}}), {kind:'start'});
  const event = {type:'content_block_delta', delta:{type:'text_delta', text:'hello'}};
  assert.deepEqual(claudeStreamPart({type:'stream_event', parent_tool_use_id:null, event}), {kind:'delta', text:'hello'});
  assert.equal(claudeStreamPart({type:'stream_event', parent_tool_use_id:'child', event}), null);
  assert.equal(claudeStreamPart({type:'stream_event', event:{type:'content_block_delta', delta:{type:'thinking_delta', thinking:'private'}}}), null);
});

test('accepts Codex output only for the active turn and thread', () => {
  const event = {type:'codex.notification', method:'item/agentMessage/delta', params:{turnId:'t1', threadId:'h1', delta:'hello'}};
  assert.equal(codexStreamDelta(event, 't1', 'h1'), 'hello');
  assert.equal(codexStreamDelta(event, 't2', 'h1'), null);
  assert.equal(codexStreamDelta(event, 't1', 'h2'), null);
  assert.equal(codexStreamDelta({...event, method:'item/reasoning/textDelta'}, 't1', 'h1'), null);
});
