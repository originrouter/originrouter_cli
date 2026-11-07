import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeLoopDetector, detectRepeatedOutput } from '../src/runtime/runtimeLoopDetector.js';

test('finds repeated phrases in incremental output', () => {
  const detector = new RuntimeLoopDetector();
  let candidate;
  for (let i = 0; i < 5; i += 1) candidate = detector.add('Let me check this again. ');
  assert.ok(candidate);
  assert.ok(candidate.repeats >= 4);
});

test('does not count duplicate snapshots or ordinary similar progress', () => {
  const detector = new RuntimeLoopDetector();
  for (let i = 0; i < 10; i += 1) assert.equal(detector.add('Checking the current file.', { cumulative: true }), null);
  for (let i = 0; i < 10; i += 1) assert.equal(detector.add(`Processing file ${i} of 10. `), null);
  assert.equal(detectRepeatedOutput('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), null);
});

test('handles growing snapshots and limits memory', () => {
  const detector = new RuntimeLoopDetector({ maxWindow: 1024 });
  let candidate;
  let snapshot = '';
  for (let i = 0; i < 5; i += 1) {
    snapshot += 'Let me check this again. ';
    candidate = detector.add(snapshot, { cumulative: true });
  }
  assert.ok(candidate);
  detector.add('x'.repeat(50_000));
  assert.ok(detector.buffer.length <= 1024);
  detector.reset();
  assert.equal(detector.buffer, '');
});
