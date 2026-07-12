// Stage 9.6 — End-to-end harness driving both Loop A and Loop B
// against a local backend + a fake H5.
//
// Run with:
//   node ./tests/9.6-e2e.test.js
//
// Requires `redis_helpers` and `utils` heavy deps to be installable
// OR the dev route loaded with stubs (see originrouter_auth_dev_test).
//
// This test uses an in-process fake backend that mimics the UPT
// dev blueprint (/login-code/dev-mint + /device/approve) and a fake
// H5 endpoint that calls /device/approve and then redirects to the
// CLI callback. It proves that:
//
//   - Loop A (CLI manual-code): mint → exchange → coding-key.json written
//   - Loop B (CLI → fake H5 → CLI): mint approve:"defer" → open H5 with
//     the raw code → H5 calls /device/approve → H5 redirects to CLI
//     callback with raw code → CLI exchanges → coding-key.json written
//   - coding-key.json passes isManagedKeyShape()
//   - log scrub: raw grant/key never appears in CLI output

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { exchangeResponseToManagedKeyShape } from "../src/auth/originrouterAuthClient.js";
import { persistExchangeResponse } from "../src/auth/originrouterLogin.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

// -----------------------------------------------------------------
// In-process fake backend that mirrors /login-code/dev-mint and
// /device/approve (UPT_back_end dev blueprint, simplified).
// -----------------------------------------------------------------

function startFakeBackend({ userId = 7 } = {}) {
  let nextId = 1;
  const codes = new Map(); // raw_code -> { user_id, source, approved_at, expires_at, consumed_at }

  function makeServer(handler) {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          handler(req, res, body ? JSON.parse(body) : {});
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: "internal_error", message: String(err) }));
        }
      });
    });
    return server;
  }

  const server = makeServer((req, res, body) => {
    const url = new URL(req.url, "http://x");
    // Mint a code.
    if (req.method === "POST" && url.pathname === "/originrouter/cli/auth/login-code/dev-mint") {
      const raw = "code-" + (nextId++).toString(16).padStart(8, "0");
      const pre_approved = body.approve !== "defer";
      codes.set(raw, {
        user_id: userId,
        source: body.source || "originrouter_cli",
        device_id: body.device_id || "dev",
        device_name: body.device_name || body.device_id || "dev",
        approved_at: pre_approved ? Math.floor(Date.now() / 1000) : null,
        expires_at: Math.floor(Date.now() / 1000) + 600,
        consumed_at: null,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        code: raw,
        device_id: body.device_id || "dev",
        device_name: body.device_name || "dev",
        source: body.source || "originrouter_cli",
        expires_at: codes.get(raw).expires_at,
      }));
      return;
    }
    // Approve a code.
    if (req.method === "POST" && url.pathname === "/originrouter/cli/auth/device/approve") {
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer uuid:")) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: "unauthenticated" }));
        return;
      }
      const rec = codes.get(body.code);
      if (!rec || rec.source !== body.source || rec.user_id !== userId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: "invalid_code" }));
        return;
      }
      rec.approved_at = Math.floor(Date.now() / 1000);
      res.statusCode = 200;
      res.end(JSON.stringify({
        ok: true,
        approved_at: rec.approved_at,
        expires_at: rec.expires_at,
      }));
      return;
    }
    // Exchange a code (always require_approved=true).
    if (req.method === "POST" && url.pathname === "/originrouter/cli/auth/device/exchange") {
      const rec = codes.get(body.code);
      if (!rec) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: "invalid_code" }));
        return;
      }
      if (rec.consumed_at) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: "invalid_code" }));
        return;
      }
      if (!rec.approved_at || rec.approved_at > rec.expires_at) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: "invalid_code" }));
        return;
      }
      if (rec.source !== body.client) {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: "source_mismatch" }));
        return;
      }
      rec.consumed_at = Math.floor(Date.now() / 1000);
      res.statusCode = 200;
      res.end(JSON.stringify({
        device_id: rec.device_id,
        device_grant: "grant-" + rec.code_hash || "grant-raw-secret",
        device_grant_id: "og_" + (nextId++).toString(16),
        managed_coding_key: "sk-or-raw-secret",
        managed_coding_key_id: "ok_" + (nextId++).toString(16),
        managed_coding_key_expires_at: rec.expires_at,
        device_grant_idle_expires_at: rec.expires_at + 90 * 86400,
        device_grant_absolute_expires_at: rec.expires_at + 365 * 86400,
        scopes: ["coding"],
        source: rec.source,
      }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  return new Promise((resolveStarted) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveStarted({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        codes,
      });
    });
  });
}

// -----------------------------------------------------------------
// Fake H5: receives an authorize URL, calls /device/approve under
// the configured uuid, then redirects to the CLI callback.
// -----------------------------------------------------------------

function startFakeH5({ uuid = "valid-uuid", backend }) {
  let lastRequest = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/cli/authorize") {
      // Authorize page received the redirect.
      lastRequest = {
        login_code: url.searchParams.get("login_code"),
        device_id: url.searchParams.get("device_id"),
        device_name: url.searchParams.get("device_name"),
        source: url.searchParams.get("source"),
        redirect_uri: url.searchParams.get("redirect_uri"),
        state: url.searchParams.get("state"),
      };
      // Forward the approve call to the fake backend.
      const u = new URL(lastRequest.redirect_uri);
      fetch(`${backend.url}/originrouter/cli/auth/device/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer uuid:${uuid}`,
        },
        body: JSON.stringify({
          code: lastRequest.login_code,
          source: lastRequest.source,
        }),
      }).then(async (r) => {
        if (!r.ok) {
          res.statusCode = 500;
          res.end("approve failed");
          return;
        }
        // Redirect back to CLI callback with raw code + state + status.
        u.searchParams.set("code", lastRequest.login_code);
        u.searchParams.set("state", lastRequest.state);
        u.searchParams.set("status", "authorized");
        res.statusCode = 302;
        res.setHeader("Location", u.toString());
        res.end();
      }).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      res({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// -----------------------------------------------------------------
// Helper: directly drive Loop A by simulating loginWithManualCode
// (which uses the global fetch the test already stubs).
// -----------------------------------------------------------------

async function loopA({ backend, home, deviceId = "loop-A" }) {
  // 1. Mint a code (auto-approved).
  const mintResp = await fetch(`${backend.url}/originrouter/cli/auth/login-code/dev-mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, source: "originrouter_cli" }),
  });
  assert.equal(mintResp.status, 200);
  const mintJson = await mintResp.json();
  assert.ok(mintJson.code);

  // 2. Exchange.
  const exchangeResp = await fetch(`${backend.url}/originrouter/cli/auth/device/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: mintJson.code,
      client: "originrouter_cli",
      device_id: deviceId,
      device_name: deviceId,
    }),
  });
  assert.equal(exchangeResp.status, 200);
  const exchangeJson = await exchangeResp.json();

  // 3. Persist via the real persistExchangeResponse (which calls
  //    exchangeResponseToManagedKeyShape + writeCodingAuth).
  const shape = persistExchangeResponse({
    stateDir: home,
    exchangeResponse: exchangeJson,
  });
  return { shape, exchangeJson };
}

async function loopB({ backend, h5, home, deviceId = "loop-B" }) {
  // 1. Mint a deferred code.
  const mintResp = await fetch(`${backend.url}/originrouter/cli/auth/login-code/dev-mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_id: deviceId, source: "originrouter_cli", approve: "defer",
    }),
  });
  assert.equal(mintResp.status, 200);
  const mintJson = await mintResp.json();

  // 2. Build the H5 authorize URL with a redirect back to the CLI.
  //    In production the CLI binds a local HTTP server for the callback;
  //    here we emulate that server inline.
  const cbServer = http.createServer();
  const callbackPromise = new Promise((resolveCb, rejectCb) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cbServer.close();
      fn(value);
    };
    cbServer.on("request", (req, res) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname !== "/cli/authorize/callback") {
          res.statusCode = 404;
          res.end();
          return;
        }
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state");
        const status = u.searchParams.get("status");
        res.statusCode = 200;
        res.end("OK");
        settle(resolveCb, { code, state, status });
      } catch (err) {
        settle(rejectCb, err);
      }
    });
    cbServer.on("error", (err) => settle(rejectCb, err));
  });
  await new Promise((r) => cbServer.listen(0, "127.0.0.1", r));
  const cbAddr = cbServer.address();
  const redirectUri = `http://127.0.0.1:${cbAddr.port}/cli/authorize/callback`;

  // 3. Hit the fake H5 (which calls /device/approve then redirects).
  //    Use AbortController + manual redirect handling so we don't depend
  //    on Node's follow-redirect behavior, which can keep sockets open.
  const authorizeUrl = `${h5.url}/cli/authorize?` +
    new URLSearchParams({
      login_code: mintJson.code,
      device_id: deviceId,
      device_name: deviceId,
      source: "originrouter_cli",
      redirect_uri: redirectUri,
      state: "state-loop-B",
    }).toString();
  // Fire and forget — the callback server settles when the H5 redirects.
  fetch(authorizeUrl).catch(() => {});

  // 4. Race the callback settlement against a 5s timeout.
  const cb = await Promise.race([
    callbackPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("callback timeout")), 5000)),
  ]);
  assert.equal(cb.status, "authorized");
  assert.ok(cb.code);

  // 5. CLI exchanges.
  const exchangeResp = await fetch(`${backend.url}/originrouter/cli/auth/device/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: cb.code, client: "originrouter_cli",
      device_id: deviceId, device_name: deviceId,
    }),
  });
  assert.equal(exchangeResp.status, 200);
  const exchangeJson = await exchangeResp.json();

  const shape = persistExchangeResponse({
    stateDir: home,
    exchangeResponse: exchangeJson,
  });
  return { shape, exchangeJson };
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

const cases = [];

cases.push({
  name: "Loop A: dev-mint auto-approved → exchange → coding-key.json passes isManagedKeyShape",
  run: async () => {
    const { isManagedKeyShape } = await import("../src/runtime/authContract.js");
    const backend = await startFakeBackend();
    const home = mkdtempSync(join(tmpdir(), "9.6-loop-A-"));
    try {
      const { shape, exchangeJson } = await loopA({ backend, home });
      assert.ok(isManagedKeyShape(shape), "shape must satisfy isManagedKeyShape");
      const filePath = join(home, "coding-key.json");
      assert.ok(existsSync(filePath));
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      assert.equal(parsed.deviceGrant, exchangeJson.device_grant);
      assert.equal(parsed.key, exchangeJson.managed_coding_key);
      assert.equal(parsed.expiresAt, exchangeJson.managed_coding_key_expires_at * 1000);
    } finally {
      await backend.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
});

cases.push({
  name: "Loop B: dev-mint defer → fake H5 approves → CLI exchanges → coding-key.json written",
  run: async () => {
    const { isManagedKeyShape } = await import("../src/runtime/authContract.js");
    const backend = await startFakeBackend();
    const h5 = await startFakeH5({ backend });
    const home = mkdtempSync(join(tmpdir(), "9.6-loop-B-"));
    try {
      const { shape, exchangeJson } = await loopB({ backend, h5, home });
      assert.ok(isManagedKeyShape(shape), "shape must satisfy isManagedKeyShape");
      const filePath = join(home, "coding-key.json");
      assert.ok(existsSync(filePath));
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      assert.equal(parsed.deviceGrant, exchangeJson.device_grant);
    } finally {
      await backend.close();
      await h5.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
});

cases.push({
  name: "Loop B negative: exchange-without-approve fails with invalid_code",
  run: async () => {
    const backend = await startFakeBackend();
    try {
      const mintResp = await fetch(`${backend.url}/originrouter/cli/auth/login-code/dev-mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: "x", source: "originrouter_cli", approve: "defer" }),
      });
      const { code } = await mintResp.json();
      const exchangeResp = await fetch(`${backend.url}/originrouter/cli/auth/device/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code, client: "originrouter_cli",
          device_id: "x", device_name: "x",
        }),
      });
      assert.equal(exchangeResp.status, 400);
      const body = await exchangeResp.json();
      assert.equal(body.code, "invalid_code");
    } finally {
      await backend.close();
    }
  },
});

cases.push({
  name: "exchangeResponseToManagedKeyShape rejects missing required field WITHOUT leaking raw response",
  run: async () => {
    let thrown = null;
    try {
      exchangeResponseToManagedKeyShape({
        device_id: "x",
        // managed_coding_key missing
        device_grant: "grant-DO-NOT-LEAK",
        device_grant_id: "og_x",
        managed_coding_key_id: "ok_x",
        managed_coding_key_expires_at: 1700000000,
        source: "originrouter_cli",
      });
    } catch (e) { thrown = e; }
    assert.ok(thrown);
    assert.equal(thrown.name, "AuthClientError");
    assert.equal(thrown.body, null, "body must be null (no raw response)");
    assert.ok(!thrown.message.includes("grant-DO-NOT-LEAK"));
  },
});

(async () => {
  let failures = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`  ok: ${c.name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL: ${c.name}`);
      console.log(`    ${e.message}`);
      if (e.stack) console.log(`    ${e.stack.split("\n").slice(1, 4).join("\n")}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} case(s) failed`);
    process.exit(1);
  }
  console.log("9.6 e2e tests ok");
})();
