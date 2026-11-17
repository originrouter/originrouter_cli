import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

import { ensureDeviceE2eeIdentity } from '../src/crypto/deviceE2eeIdentity.js';
import { dpopThumbprint } from '../src/crypto/dpopIdentity.js';
import { readDpopStore } from '../src/security/dpopStore.js';
import { withProcessLock } from '../src/persistence/processLock.js';

const registrationModule = new URL('../src/security/dpopRegistration.js', import.meta.url).href;
const lockModule = new URL('../src/persistence/processLock.js', import.meta.url).href;

function child(script, args) {
  return spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function output(processHandle) {
  let stdout = '';
  let stderr = '';
  processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
  processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(processHandle, 'exit');
  assert.equal(code, 0, `worker exited ${code || signal}: ${stderr}`);
  return stdout;
}

test('independent CLI processes register one shared key', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dpop-process-'));
  ensureDeviceE2eeIdentity(stateDir, { deviceId: 'process-test-device' });
  const state = { status: 'none', jkt: null, registrations: 0 };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url.endsWith('/key')) {
      // Delay makes competing first registrations overlap deterministically.
      await new Promise((resolve) => setTimeout(resolve, 150));
      state.jkt = dpopThumbprint(JSON.parse(Buffer.concat(chunks)).jwk);
      state.status = 'pending';
      state.registrations++;
    } else if (request.url.endsWith('/proof')) {
      state.status = 'active';
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: { ...state, available: true } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = `import {ensureDpopRegistered} from ${JSON.stringify(registrationModule)};
    const result = await ensureDpopRegistered({stateDir:process.argv[1], controlBaseUrl:process.argv[2],
      accessToken:'or_at_test',deviceId:'process-test-device'});
    console.log(JSON.stringify(result));`;
  try {
    const workers = Array.from({ length: 4 }, () => child(script, [stateDir, base]));
    const results = await Promise.all(workers.map(output));
    for (const result of results) assert.equal(JSON.parse(result).status, 'active');
    assert.equal(state.registrations, 1);
    assert.equal(dpopThumbprint(readDpopStore(stateDir).key.public_jwk), state.jkt);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a killed registration releases its lock without stale-lock takeover', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dpop-process-'));
  const storePath = join(stateDir, 'dpop-key.json');
  const script = `import {withProcessLock} from ${JSON.stringify(lockModule)};
    await withProcessLock(process.argv[1], async () => {
      console.log('locked'); await new Promise(() => setInterval(() => {}, 1000));
    });`;
  const worker = child(script, [storePath]);
  try {
    const [chunk] = await once(worker.stdout, 'data');
    assert.match(String(chunk), /locked/);
    await assert.rejects(withProcessLock(storePath, async () => {}, { timeoutMs: 100 }),
      { code: 'process_lock_timeout' });
    worker.kill('SIGKILL');
    await once(worker, 'exit');
    assert.equal(await withProcessLock(storePath, async () => 'available', { timeoutMs: 2000 }), 'available');
  } finally {
    worker.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an in-process waiter cannot release the lock held against other processes', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dpop-process-'));
  const storePath = join(stateDir, 'dpop-key.json');
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const first = withProcessLock(storePath, async () => { entered(); await hold; });
  await ready;
  const second = withProcessLock(storePath, async () => 'second', { timeoutMs: 3000 });
  const script = `import {withProcessLock} from ${JSON.stringify(lockModule)};
    try { await withProcessLock(process.argv[1], async () => {}, {timeoutMs:150});
      console.log('incorrectly-acquired');
    } catch (error) { console.log(error.code); }`;
  try {
    assert.match(await output(child(script, [storePath])), /process_lock_timeout/);
  } finally {
    release();
    await first;
    assert.equal(await second, 'second');
    rmSync(stateDir, { recursive: true, force: true });
  }
});
