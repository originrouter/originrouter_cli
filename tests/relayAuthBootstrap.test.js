// Stage 9.5 — relayAuthBootstrap tests.
//
// Coverage:
//   1. auth=off  -> { authState:"off", deviceId: fallback, authToken: null }
//   2. auth=on happy path -> { authState:"on", deviceId: stored, authToken: <token> }
//   3. auth=on Surety non-zero code -> RelayAuthBootstrapError, err.message === err.code
//      and the message does NOT contain deviceGrant or token.
//   4. auth=on Surety 5xx / network -> code="surety_unavailable", message === code
//      and the message does NOT contain deviceGrant or token.
//   5. auth=on no coding-key.json -> code="no_device_grant", message === code
//   6. auth=on no SURETY_BASE_URL -> code="surety_unavailable", message === code
//
// Every test asserts err.message === err.code EXACTLY (no concatenation).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRelayClientOptions,
  isRelayAuthOn,
  RelayAuthBootstrapError,
} from "../src/relay/relayAuthBootstrap.js";

function withAuthEnv(value, fn) {
  const prev = process.env.ORIGINROUTER_RELAY_AUTH;
  const prevSurety = process.env.SURETY_BASE_URL;
  if (value === undefined) delete process.env.ORIGINROUTER_RELAY_AUTH;
  else process.env.ORIGINROUTER_RELAY_AUTH = value;
  delete process.env.SURETY_BASE_URL;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.ORIGINROUTER_RELAY_AUTH;
      else process.env.ORIGINROUTER_RELAY_AUTH = prev;
      if (prevSurety === undefined) delete process.env.SURETY_BASE_URL;
      else process.env.SURETY_BASE_URL = prevSurety;
    });
}

function withSuretyEnv(value, fn) {
  const prev = process.env.SURETY_BASE_URL;
  if (value === undefined) delete process.env.SURETY_BASE_URL;
  else process.env.SURETY_BASE_URL = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.SURETY_BASE_URL;
      else process.env.SURETY_BASE_URL = prev;
    });
}

const tmpStateDir = mkdtempSync(join(tmpdir(), "relay-auth-bootstrap-"));
try {
  // 1. auth=off — no Surety, no coding-key required, returns fallback deviceId.
  await withAuthEnv("off", async () => {
    const r = await buildRelayClientOptions({
      stateDir: tmpStateDir,
      relayUrl: "http://127.0.0.1:9999",
      fallbackDeviceId: "fallback-device",
    });
    assert.equal(r.authState, "off");
    assert.equal(r.deviceId, "fallback-device");
    assert.equal(r.authToken, null);
    assert.equal(r.relayUrl, "http://127.0.0.1:9999");
    assert.equal(isRelayAuthOn(), false);
  });

  // 6. auth=on but no SURETY_BASE_URL — throws surety_unavailable.
  await withAuthEnv("on", async () => {
    await withSuretyEnv(undefined, async () => {
      let threw = null;
      try {
        await buildRelayClientOptions({
          stateDir: tmpStateDir,
          relayUrl: "http://127.0.0.1:9999",
          fallbackDeviceId: "f",
        });
      } catch (err) { threw = err; }
      assert.ok(threw instanceof RelayAuthBootstrapError, `expected RelayAuthBootstrapError, got: ${threw}`);
      assert.equal(threw.code, "surety_unavailable");
      assert.equal(threw.message, "surety_unavailable", "err.message must equal err.code exactly");
    });
  });

  // 5. auth=on, SURETY_BASE_URL set, but no coding-key.json.
  const emptyDir = mkdtempSync(join(tmpdir(), "relay-auth-bootstrap-empty-"));
  try {
    await withAuthEnv("on", async () => {
      await withSuretyEnv("http://127.0.0.1:9001", async () => {
        let threw = null;
        try {
          await buildRelayClientOptions({
            stateDir: emptyDir,
            relayUrl: "http://127.0.0.1:9999",
            fallbackDeviceId: "f",
          });
        } catch (err) { threw = err; }
        assert.ok(threw instanceof RelayAuthBootstrapError);
        assert.equal(threw.code, "no_device_grant");
        assert.equal(threw.message, "no_device_grant", "err.message must equal err.code exactly");
      });
    });
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  // Set up a real coding-key.json for the auth-on happy path and failure cases.
  const REAL_GRANT = "real-grant-secret-9.5-do-not-leak";
  const REAL_DEVICE = "prod-worker-coding-key-9.5";
  writeFileSync(join(tmpStateDir, "coding-key.json"), JSON.stringify({
    kind: "managed",
    source: "originrouter_cli",
    keyId: "ck-9.5",
    key: "sk-9.5",
    deviceGrantId: "dgid-9.5",
    deviceGrant: REAL_GRANT,
    deviceId: REAL_DEVICE,
    expiresAt: Date.now() + 3600_000,
    scopes: ["coding"],
  }, null, 2));

  // 2. auth=on happy path — fake fetchFn returns a Surety 200/0.
  await withAuthEnv("on", async () => {
    await withSuretyEnv("http://127.0.0.1:9001", async () => {
      const fakeFetch = async (url, opts) => {
        if (String(url).includes("/api/relay/token")) {
          return new Response(JSON.stringify({
            code: 0,
            msg: "success",
            data: {
              "relay-access-token": "tk-9.5-fake",
              "expires-at": Math.floor(Date.now() / 1000) + 3600,
              "token-id": "tid-9.5",
              scopes: ["relay.remote_coding"],
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("not used", { status: 404 });
      };
      const r = await buildRelayClientOptions({
        stateDir: tmpStateDir,
        relayUrl: "http://127.0.0.1:9999",
        fallbackDeviceId: "f",
        fetchFn: fakeFetch,
      });
      assert.equal(r.authState, "on");
      assert.equal(r.deviceId, REAL_DEVICE);
      assert.equal(r.authToken, "tk-9.5-fake");
      assert.equal(typeof r.tokenExpiresAt, "number");
    });
  });

  // 3. auth=on Surety returns non-zero code.
  //    Expect: RelayAuthBootstrapError, err.code is the mapped string, err.message === err.code.
  //    Expect: err.message does NOT contain the real grant or token.
  await withAuthEnv("on", async () => {
    await withSuretyEnv("http://127.0.0.1:9001", async () => {
      const fakeFetch = async () => new Response(JSON.stringify({
        code: -1,
        msg: "invalid grant (Surety original message)",
        data: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
      let threw = null;
      try {
        await buildRelayClientOptions({
          stateDir: tmpStateDir,
          relayUrl: "http://127.0.0.1:9999",
          fallbackDeviceId: "f",
          fetchFn: fakeFetch,
        });
      } catch (err) { threw = err; }
      assert.ok(threw instanceof RelayAuthBootstrapError);
      assert.equal(threw.code, "invalid_grant");
      assert.equal(threw.message, "invalid_grant", "err.message must equal err.code exactly");
      assert.ok(!threw.message.includes(REAL_GRANT), "err.message must not contain deviceGrant");
      assert.ok(!threw.message.includes("tk-9.5-fake"), "err.message must not contain token");
    });
  });

  // 4. auth=on Surety 5xx / network failure.
  //    Expect: code="surety_unavailable", message === code, no grant/token leak.
  await withAuthEnv("on", async () => {
    await withSuretyEnv("http://127.0.0.1:9001", async () => {
      const fakeFetch = async () => { throw new Error("ECONNREFUSED 127.0.0.1:9001"); };
      let threw = null;
      try {
        await buildRelayClientOptions({
          stateDir: tmpStateDir,
          relayUrl: "http://127.0.0.1:9999",
          fallbackDeviceId: "f",
          fetchFn: fakeFetch,
        });
      } catch (err) { threw = err; }
      assert.ok(threw instanceof RelayAuthBootstrapError);
      assert.equal(threw.code, "surety_unavailable");
      assert.equal(threw.message, "surety_unavailable");
      assert.ok(!threw.message.includes(REAL_GRANT));
    });
  });

  // 4b. auth=on Surety returns HTTP 500 (treated as surety_unavailable by client).
  await withAuthEnv("on", async () => {
    await withSuretyEnv("http://127.0.0.1:9001", async () => {
      const fakeFetch = async () => new Response(JSON.stringify({ code: -9, msg: "server exploded" }), { status: 500, headers: { "content-type": "application/json" } });
      let threw = null;
      try {
        await buildRelayClientOptions({
          stateDir: tmpStateDir,
          relayUrl: "http://127.0.0.1:9999",
          fallbackDeviceId: "f",
          fetchFn: fakeFetch,
        });
      } catch (err) { threw = err; }
      assert.ok(threw instanceof RelayAuthBootstrapError);
      assert.equal(threw.code, "surety_unavailable");
      assert.equal(threw.message, "surety_unavailable");
    });
  });
} finally {
  rmSync(tmpStateDir, { recursive: true, force: true });
}

console.log("relayAuthBootstrap ok");
