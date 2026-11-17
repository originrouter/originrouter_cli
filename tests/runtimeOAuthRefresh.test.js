import assert from "node:assert/strict";
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readCodingAuth, writeCodingAuth } from "../src/persistence/codingAuth.js";
import { ensureFreshAccessToken } from "../src/runtime/oauthTokenRefresher.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";
import { persistOAuthCredential } from "../src/auth/originrouterLogin.js";
import { accountStateDir } from '../src/persistence/accounts.js';

test('a refresh in another process cannot restore an older account', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'originrouter-refresh-process-'));
  let notify;
  let resume;
  const arrived = new Promise((resolve) => { notify = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const server = http.createServer(async (_req, res) => {
    notify();
    await gate;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({access_token:'or_at_old_refreshed', refresh_token:'or_rt_old_rotated',
      expires_in:600, refresh_expires_in:600}));
  });
  let worker;
  try {
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const old = expiredCodingCredential({accountScope:'account-a', sessionId:'or_ses_old',
      tokenEndpoint:`http://127.0.0.1:${server.address().port}/token`});
    const next = makeOAuthCredential({accountScope:'account-b', sessionId:'or_ses_new', refreshToken:'or_rt_new'});
    writeCodingAuth(stateDir, old);
    const moduleUrl = new URL('../src/runtime/oauthTokenRefresher.js', import.meta.url).href;
    const script = `import {ensureFreshAccessToken} from ${JSON.stringify(moduleUrl)};
      try { await ensureFreshAccessToken({stateDir:process.argv[1], resource:'originrouter.coding'});
        console.log('unexpected-success');
      } catch (error) { console.log(error.code); }`;
    worker = spawn(process.execPath, ['--input-type=module', '-e', script, stateDir],
      {stdio:['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    worker.stdout.on('data', (chunk) => { stdout += chunk; });
    worker.stderr.on('data', (chunk) => { stderr += chunk; });
    const finished = new Promise((resolve) => worker.on('exit', (code) => resolve(code)));
    let timer;
    try {
      await Promise.race([arrived, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('refresh did not arrive')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    await persistOAuthCredential({stateDir, credential:next});
    resume();
    assert.equal(await finished, 0, stderr);
    assert.match(stdout, /account_changed/);
    assert.equal(readCodingAuth(stateDir).sessionId, next.sessionId);
    assert.equal(readCodingAuth(stateDir).refreshToken, next.refreshToken);
  } finally {
    resume();
    worker?.kill();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(stateDir, {recursive:true, force:true});
  }
});

test('a scoped worker cannot refresh its old account after the active account changes', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'originrouter-refresh-scoped-'));
  try {
    const old = expiredCodingCredential({accountScope:'account-a', sessionId:'or_ses_old'});
    const next = makeOAuthCredential({accountScope:'account-b', sessionId:'or_ses_new', refreshToken:'or_rt_new'});
    writeCodingAuth(stateDir, old);
    let started;
    let resume;
    const arrived = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { resume = resolve; });
    const scoped = accountStateDir(stateDir, old.accountScope);
    const pending = ensureFreshAccessToken({stateDir:scoped, resource:'originrouter.coding', fetchFn:async()=>{
      started(); await gate;
      return {ok:true, status:200, json:async()=>({access_token:'or_at_old_fresh',refresh_token:'or_rt_old_rotated'})};
    }});
    await arrived;
    await persistOAuthCredential({stateDir, credential:next});
    resume();
    await assert.rejects(pending, {code:'account_changed'});
    assert.equal(readCodingAuth(stateDir).sessionId, next.sessionId);
    assert.equal(readCodingAuth(scoped).refreshToken, old.refreshToken);
  } finally { rmSync(stateDir, {recursive:true, force:true}); }
});

test('a scoped worker cannot reuse an unexpired token after an account switch', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'originrouter-refresh-scoped-'));
  try {
    const old = makeOAuthCredential({accountScope:'account-a', sessionId:'or_ses_old'});
    const next = makeOAuthCredential({accountScope:'account-b', sessionId:'or_ses_new'});
    writeCodingAuth(stateDir, old);
    const scoped = accountStateDir(stateDir, old.accountScope);
    await persistOAuthCredential({stateDir, credential:next});
    let calls = 0;
    await assert.rejects(ensureFreshAccessToken({stateDir:scoped, fetchFn:async()=>{ calls++; }}),
      {code:'account_changed'});
    assert.equal(calls, 0);
    assert.equal(readCodingAuth(stateDir).sessionId, next.sessionId);
  } finally { rmSync(stateDir, {recursive:true, force:true}); }
});

function expiredCodingCredential(overrides = {}) {
  return makeOAuthCredential({
    ...overrides,
    accessTokens: {
      coding: {
        token: "or_at_coding_expired",
        expiresAt: Date.now() - 1_000,
        scopes: ["coding.invoke"],
      },
      ...(overrides.accessTokens || {}),
    },
  });
}

for (const sameAccount of [false, true]) {
  test(`a delayed refresh cannot overwrite a newer ${sameAccount ? 'session' : 'account'} login`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'originrouter-refresh-switch-'));
    try {
      const old = expiredCodingCredential({accountScope:'account-a', sessionId:'or_ses_old'});
      const next = makeOAuthCredential({accountScope:sameAccount ? 'account-a' : 'account-b',
        sessionId:'or_ses_new', refreshToken:'or_rt_new'});
      writeCodingAuth(stateDir, old);
      let started;
      let release;
      const waiting = new Promise((resolve) => { started = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const pending = ensureFreshAccessToken({stateDir, resource:'originrouter.coding', fetchFn: async () => {
        started();
        await gate;
        return {ok:true, status:200, json:async()=>({access_token:'or_at_old_refreshed',
          refresh_token:'or_rt_old_rotated', expires_in:600})};
      }});
      await waiting;
      await persistOAuthCredential({stateDir, credential:next});
      release();
      await assert.rejects(pending, {code:'account_changed'});
      assert.equal(readCodingAuth(stateDir).sessionId, 'or_ses_new');
      assert.equal(readCodingAuth(stateDir).refreshToken, 'or_rt_new');
    } finally { rmSync(stateDir, {recursive:true, force:true}); }
  });
}

test("refresh rotates RT and replaces only the requested audience token", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential());
    let body;
    const updated = await ensureFreshAccessToken({
      stateDir,
      resource: "originrouter.coding",
      fetchFn: async (_url, init) => {
        body = new URLSearchParams(init.body);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "or_at_coding_fresh",
              refresh_token: "or_rt_rotated",
              expires_in: 600,
              refresh_expires_in: 2_592_000,
              scope: "coding.invoke",
            };
          },
        };
      },
    });
    assert.equal(body.get("refresh_token"), "or_rt_test_refresh");
    assert.equal(body.get("resource"), "originrouter.coding");
    assert.equal(updated.refreshToken, "or_rt_rotated");
    assert.equal(updated.accessTokens.coding.token, "or_at_coding_fresh");
    assert.equal(updated.accessTokens.control.token, "or_at_control_test");
    assert.equal(readCodingAuth(stateDir).refreshToken, "or_rt_rotated");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("refresh lock prevents concurrent RT reuse", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-race-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential());
    let refreshCalls = 0;
    const fetchFn = async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "or_at_coding_once",
            refresh_token: "or_rt_once",
            expires_in: 600,
            refresh_expires_in: 2_592_000,
            scope: "coding.invoke",
          };
        },
      };
    };
    const [first, second] = await Promise.all([
      ensureFreshAccessToken({ stateDir, resource: "originrouter.coding", fetchFn }),
      ensureFreshAccessToken({ stateDir, resource: "originrouter.coding", fetchFn }),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first.refreshToken, "or_rt_once");
    assert.equal(second.refreshToken, "or_rt_once");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("expired refresh session is rejected before network access", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-expired-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential({
      refreshExpiresAt: Date.now() - 1,
    }));
    let fetched = false;
    await assert.rejects(
      () => ensureFreshAccessToken({
        stateDir,
        resource: "originrouter.coding",
        fetchFn: async () => { fetched = true; },
      }),
      (error) => error.code === "OAUTH_REFRESH_EXPIRED",
    );
    assert.equal(fetched, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("custom headroom refreshes a token before a long-running request starts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-headroom-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential({
      accessTokens: {
        coding: {
          token: "or_at_coding_near_expiry",
          expiresAt: Date.now() + 90_000,
          scopes: ["coding.invoke"],
        },
      },
    }));
    let refreshCalls = 0;
    const updated = await ensureFreshAccessToken({
      stateDir,
      resource: "originrouter.coding",
      headroomMs: 120_000,
      fetchFn: async () => {
        refreshCalls += 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "or_at_coding_headroom_fresh",
              refresh_token: "or_rt_headroom_rotated",
              expires_in: 600,
              refresh_expires_in: 2_592_000,
              scope: "coding.invoke",
            };
          },
        };
      },
    });
    assert.equal(refreshCalls, 1);
    assert.equal(updated.accessTokens.coding.token, "or_at_coding_headroom_fresh");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("forced refresh reuses a token already rotated by another request", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-stale-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential({
      accessTokens: {
        coding: {
          token: "or_at_coding_already_rotated",
          expiresAt: Date.now() + 600_000,
          scopes: ["coding.invoke"],
        },
      },
    }));
    let refreshCalls = 0;
    const updated = await ensureFreshAccessToken({
      stateDir,
      resource: "originrouter.coding",
      forceRefresh: true,
      staleToken: "or_at_coding_previous",
      fetchFn: async () => {
        refreshCalls += 1;
        throw new Error("must not refresh twice");
      },
    });
    assert.equal(refreshCalls, 0);
    assert.equal(updated.accessTokens.coding.token, "or_at_coding_already_rotated");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a bundled refresh stores every audience the answer carried", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-refresh-bundle-"));
  try {
    writeCodingAuth(stateDir, expiredCodingCredential());
    const before = readCodingAuth(stateDir);
    const updated = await ensureFreshAccessToken({
      stateDir,
      resource: "originrouter.coding",
      fetchFn: async () => ({
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "or_at_coding_bundle",
            refresh_token: "or_rt_bundle",
            expires_in: 600,
            refresh_expires_in: 2_592_000,
            scope: "coding.invoke",
            access_tokens: {
              "originrouter.control": { access_token: "or_at_control_bundle", expires_in: 600 },
              "originrouter.coding": { access_token: "or_at_coding_bundle", expires_in: 600 },
              "originrouter.relay": { access_token: "or_at_relay_bundle", expires_in: 600 },
            },
          };
        },
      }),
    });
    // The token this call asked for is the one it asked for.
    assert.equal(updated.accessTokens.coding.token, "or_at_coding_bundle");
    // The rest of the bundle is kept, so nobody has to spend the new refresh
    // token asking for tokens the answer already handed over.
    assert.equal(updated.accessTokens.control.token, "or_at_control_bundle");
    assert.equal(updated.accessTokens.relay.token, "or_at_relay_bundle");
    // An audience the answer did not mention keeps what was already stored.
    assert.equal(updated.accessTokens.ai.token, before.accessTokens.ai.token);
    assert.equal(updated.refreshToken, "or_rt_bundle");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
