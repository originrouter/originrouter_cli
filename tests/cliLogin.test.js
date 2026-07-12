// Stage 9.1A: end-to-end CLI login tests.
//
// Spins up a local mock backend on `node:http` (no extra deps),
// then spawns `node ./bin/originrouter.js` against it. The
// mock implements the 5 backend endpoints used by the CLI:
//
//   POST /auth/v1/login-code
//   POST /auth/v1/device/exchange
//   POST /auth/v1/device/rotate-coding-key
//   POST /auth/v1/device/revoke
//   GET  /auth/v1/devices
//
// This file does NOT module-stub the auth client — the spawned
// CLI talks to the mock backend over real HTTP. That gives us
// the closest possible end-to-end check without depending on a
// running backend or a browser.

import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_ROOT = resolve(__dirname, "..");
const BIN_PATH = resolve(CLI_ROOT, "bin/originrouter.js");

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

function startMockBackend() {
  // Server-side in-memory state.
  const state = {
    login_codes: {},
    grants: {},
    keys: [],
    // Stage 9.7: RFC 8628 device flow state. Each row is keyed by
    // the 8-char user_code; tests can pre-populate this map to
    // simulate "already approved" / "already denied" / "expired"
    // states without going through the full /device/approve roundtrip.
    device_codes: {},
    // Optional injection point for tests: forces the next /device/token
    // poll to return a specific error code (one of authorization_pending,
    // slow_down, expired_token, access_denied). Set via the test runner
    // BEFORE each poll.
    deviceTokenNextError: null,
    // Tests can push user_codes here to mark them pre-approved
    // (skip the authorization_pending loop). Used by the
    // --device-flow e2e test below.
    preApprovedDeviceCodes: new Set(),
  };
  let grantSeq = 1;
  let keySeq = 1;

  function readJson(req) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return resolveBody({});
        try { resolveBody(JSON.parse(text)); }
        catch { reject(new Error("bad json")); }
      });
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const method = req.method;

      // /login-code
      if (url.pathname === "/auth/v1/login-code" && method === "POST") {
        const auth = req.headers.authorization || "";
        if (!auth.startsWith("Bearer uuid:")) {
          res.statusCode = 401;
          res.end(JSON.stringify({ code: "unauthenticated", message: "no uuid" }));
          return;
        }
        if (auth !== "Bearer uuid:test-uuid") {
          res.statusCode = 401;
          res.end(JSON.stringify({ code: "unauthenticated", message: "bad uuid" }));
          return;
        }
        const body = await readJson(req);
        const code = "mock-code-" + Math.random().toString(36).slice(2, 10);
        state.login_codes[code] = {
          user_id: 42, device_id: body.device_id || "mock-device",
          source: body.source || "originrouter_cli",
          expires_at: Math.floor(Date.now() / 1000) + 600,
          consumed_at: null,
        };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          code, device_id: state.login_codes[code].device_id,
          source: state.login_codes[code].source,
          expires_at: state.login_codes[code].expires_at,
        }));
        return;
      }

      // Stage 9.7: /device/code (RFC 8628)
      // Mint an 8-char user_code (uppercase alphanumeric minus I/O/0/1),
      // store as pending, return device_code/user_code/verification_uri.
      if (url.pathname === "/auth/v1/device/code" && method === "POST") {
        const body = await readJson(req);
        const deviceId = body.device_id || "mock-device";
        const source = body.source || "originrouter_cli";
        // 8-char from alphabet without look-alikes; deterministic for
        // test stability (a counter suffix on the same alphabet).
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const n = Object.keys(state.device_codes).length + 1;
        let userCode = "";
        let tmp = n;
        for (let i = 0; i < 8; i++) {
          userCode = alphabet[tmp % alphabet.length] + userCode;
          tmp = Math.floor(tmp / alphabet.length);
        }
        // If counter encoding collided, append deterministic salt.
        while (state.device_codes[userCode]) {
          userCode = userCode.slice(1) + alphabet[(n * 7) % alphabet.length];
        }
        state.device_codes[userCode] = {
          device_id: deviceId, source, approved: false,
          consumed: false, expires_at: Math.floor(Date.now() / 1000) + 600,
        };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          device_code: userCode, user_code: userCode,
          device_id: deviceId, source,
          verification_uri: "http://h5.test/cli/authorize",
          verification_uri_complete: `http://h5.test/cli/authorize?user_code=${userCode}`,
          expires_in: 600, interval: 5,
        }));
        return;
      }

      // Stage 9.7: /device/token (RFC 8628)
      // If state.deviceTokenNextError is set, return that error and clear.
      // Otherwise:
      //   - user_code unknown / expired  → expired_token
      //   - user_code approved but not consumed → mint grant + key, return success
      //   - user_code consumed (no approval) → access_denied
      //   - user_code not approved        → authorization_pending
      if (url.pathname === "/auth/v1/device/token" && method === "POST") {
        const body = await readJson(req);
        const userCode = body.device_code || body.user_code;
        const deviceId = body.device_id;
        const source = body.source || "originrouter_cli";
        if (state.deviceTokenNextError) {
          const errCode = state.deviceTokenNextError;
          state.deviceTokenNextError = null;
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ code: 0, msg: errCode, data: { error: errCode } }));
          return;
        }
        const rec = state.device_codes[userCode];
        if (!rec || rec.expires_at < Math.floor(Date.now() / 1000)) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ code: 0, msg: "expired_token", data: { error: "expired_token" } }));
          return;
        }
        if (rec.consumed && !rec.approved) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ code: 0, msg: "access_denied", data: { error: "access_denied" } }));
          return;
        }
        if (!rec.approved && !state.preApprovedDeviceCodes.has(userCode)) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ code: 0, msg: "authorization_pending", data: { error: "authorization_pending", interval: 5 } }));
          return;
        }
        // Approved — mint grant + relay token response.
        rec.consumed = true;
        const gid = "og_" + (grantSeq++);
        const grantRaw = "grant-raw-" + Math.random().toString(36).slice(2, 10);
        state.grants[grantRaw] = {
          grant_id: gid, user_id: 42,
          device_id: deviceId || rec.device_id,
          device_name: deviceId || rec.device_id,
          source, scopes: ["coding"],
          idle_expires_at: Math.floor(Date.now() / 1000) + 90 * 86400,
          absolute_expires_at: Math.floor(Date.now() / 1000) + 365 * 86400,
          last_used_at: Math.floor(Date.now() / 1000),
          revoked_at: null,
        };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          access_token: "rt_devflow_access_token_xyz",
          refresh_token: "or_rt_devflow_refresh_token_xyz",
          device_id: deviceId || rec.device_id,
          device_grant: grantRaw,
          token_endpoint: "https://surety.test/api/relay/token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          scopes: ["coding"],
          token_type: "Bearer",
          source,
        }));
        return;
      }

      // /device/exchange
      if (url.pathname === "/auth/v1/device/exchange" && method === "POST") {
        const body = await readJson(req);
        const rec = state.login_codes[body.code];
        if (!rec || rec.consumed_at || rec.expires_at < Math.floor(Date.now() / 1000)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: "invalid_code", message: "bad" }));
          return;
        }
        rec.consumed_at = Math.floor(Date.now() / 1000);
        const grantRaw = "grant-raw-" + Math.random().toString(36).slice(2, 10);
        const gid = "og_" + (grantSeq++);
        const kid = "ok_" + (keySeq++);
        state.grants[grantRaw] = {
          grant_id: gid, user_id: rec.user_id,
          device_id: rec.device_id, device_name: rec.device_id,
          source: rec.source, scopes: ["coding"],
          idle_expires_at: Math.floor(Date.now() / 1000) + 90 * 86400,
          absolute_expires_at: Math.floor(Date.now() / 1000) + 365 * 86400,
          last_used_at: Math.floor(Date.now() / 1000),
          revoked_at: null,
        };
        const rawKey = "sk-or-" + Math.random().toString(36).slice(2, 18) + Math.random().toString(36).slice(2, 18);
        state.keys.push({
          key_id: kid, raw_key: rawKey,
          device_grant_id: gid, revoked_at: null,
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          device_id: rec.device_id,
          device_grant: grantRaw,
          device_grant_id: gid,
          device_grant_idle_expires_at: state.grants[grantRaw].idle_expires_at,
          device_grant_absolute_expires_at: state.grants[grantRaw].absolute_expires_at,
          managed_coding_key: rawKey,
          managed_coding_key_id: kid,
          managed_coding_key_expires_at: Math.floor(Date.now() / 1000) + 30 * 86400,
          scopes: ["coding"],
          source: rec.source,
        }));
        return;
      }

      // /device/rotate-coding-key
      if (url.pathname === "/auth/v1/device/rotate-coding-key" && method === "POST") {
        const grant = lookupGrant(req, state);
        if (!grant) { res.statusCode = 401; res.end(JSON.stringify({ code: "unauthenticated" })); return; }
        // Revoke prior keys on this grant.
        for (const k of state.keys) {
          if (k.device_grant_id === grant.grant_id && !k.revoked_at) {
            k.revoked_at = Math.floor(Date.now() / 1000);
          }
        }
        const kid = "ok_" + (keySeq++);
        const rawKey = "sk-or-rotated-" + Math.random().toString(36).slice(2, 14);
        state.keys.push({
          key_id: kid, raw_key: rawKey,
          device_grant_id: grant.grant_id, revoked_at: null,
        });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          managed_coding_key: rawKey,
          managed_coding_key_id: kid,
          managed_coding_key_expires_at: Math.floor(Date.now() / 1000) + 30 * 86400,
        }));
        return;
      }

      // /device/revoke
      if (url.pathname === "/auth/v1/device/revoke" && method === "POST") {
        const grant = lookupGrantForRevoke(req, state);
        if (!grant) { res.statusCode = 401; res.end(JSON.stringify({ code: "unauthenticated" })); return; }
        const already = grant.revoked_at !== null;
        if (!already) {
          grant.revoked_at = Math.floor(Date.now() / 1000);
          for (const k of state.keys) {
            if (k.device_grant_id === grant.grant_id && !k.revoked_at) {
              k.revoked_at = grant.revoked_at;
            }
          }
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, revoked_at: grant.revoked_at, already_revoked: already }));
        return;
      }

      // /devices
      if (url.pathname === "/auth/v1/devices" && method === "GET") {
        const grant = lookupGrant(req, state);
        if (!grant) { res.statusCode = 401; res.end(JSON.stringify({ code: "unauthenticated" })); return; }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          scope: "current_device_only",
          devices: [{
            device_id: grant.device_id,
            device_grant_id: grant.grant_id,
            device_name: grant.device_name,
            source: grant.source,
            scopes: grant.scopes,
            idle_expires_at: grant.idle_expires_at,
            absolute_expires_at: grant.absolute_expires_at,
            last_used_at: grant.last_used_at,
            revoked_at: grant.revoked_at,
          }],
        }));
        return;
      }

      res.statusCode = 404;
      res.end("not found");
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });

  return new Promise((resolveStarted) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveStarted({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
        state,
      });
    });
  });
}

function lookupGrant(req, state) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const raw = auth.slice("Bearer ".length);
  const grant = state.grants[raw];
  if (!grant) return null;
  if (grant.revoked_at !== null) return null;
  if (grant.absolute_expires_at < Math.floor(Date.now() / 1000)) return null;
  return grant;
}

function lookupGrantForRevoke(req, state) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const raw = auth.slice("Bearer ".length);
  return state.grants[raw] || null;
}

// ---------------------------------------------------------------------------
// CLI driver
// ---------------------------------------------------------------------------

function runCli({ home, args, apiBaseUrl, env = {} }) {
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env: { ...process.env, ORIGINROUTER_HOME: home, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err += c.toString(); });
    child.on("close", (code) => resolveDone({ code, stdout: out, stderr: err }));
  });
}

const cases = [];
let backend;
let home;

async function setup() {
  backend = await startMockBackend();
  home = mkdtempSync(join(tmpdir(), "originrouter-cli-login-test-"));
}

async function teardown() {
  if (backend) await backend.close();
  if (home) rmSync(home, { recursive: true, force: true });
}

cases.push({
  name: "auth status with no file prints 'Not logged in.'",
  run: async () => {
    const r = await runCli({ home, args: ["auth", "status"], apiBaseUrl: backend.url });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Not logged in\./);
  },
});

// Stage 9.6: the auth-rotate test was removed along with
// --manual-code. Rotating a managed coding key requires a real
// device grant in the backend; the test was tightly coupled to
// the manual-code login path. End-to-end rotation coverage lives
// in 9.6-e2e.test.js (Loop B) once device flow is added.
cases.push({
  name: "--help includes new login / logout / auth commands",
  run: async () => {
    const r = await runCli({ home, args: ["--help"], apiBaseUrl: backend.url });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /originrouter login/);
    assert.match(r.stdout, /originrouter logout/);
    assert.match(r.stdout, /originrouter auth status/);
    assert.match(r.stdout, /originrouter auth rotate/);
    assert.match(r.stdout, /originrouter auth device list/);
  },
});

cases.push({
  name: "auth rotate with no file exits non-zero",
  run: async () => {
    // Use a fresh empty home so no file exists.
    const emptyHome = mkdtempSync(join(tmpdir(), "originrouter-cli-empty-"));
    try {
      const r = await runCli({
        home: emptyHome, args: ["auth", "rotate"], apiBaseUrl: backend.url,
      });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /originrouter login/);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  },
});

// Stage 9.7: --device-flow end-to-end.
// Auto-approve any newly-minted device_code at 20ms intervals so
// the polling loop eventually succeeds. Verify the CLI writes the
// managed key to disk and prints the expected summary.
cases.push({
  name: "--device-flow completes login end-to-end via mock backend",
  run: async () => {
    // Auto-approve loop: every 20ms, mark any new device_code as
    // approved. The CLI polls every 5s by default; we need a faster
    // cadence for the test to complete in <5s. Override via the
    // server's `interval` field which the CLI honors — but the
    // mock returns interval:5, so the CLI sleeps 5s between polls.
    // We instead push device_codes into preApprovedDeviceCodes
    // BEFORE the first poll, so it succeeds immediately.
    const collector = setInterval(() => {
      for (const code of Object.keys(backend.state.device_codes)) {
        backend.state.preApprovedDeviceCodes.add(code);
      }
    }, 10);
    try {
      const home = mkdtempSync(join(tmpdir(), "originrouter-cli-device-flow-"));
      try {
        const r = await runCli({
          home,
          args: ["login", "--device-flow", "--no-browser"],
          apiBaseUrl: backend.url,
          env: { ORIGINROUTER_API_BASE_URL: backend.url, NO_COLOR: "1" },
        });
        assert.equal(r.code, 0,
          `cli exit non-zero. stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
        const keyFile = join(home, "coding-key.json");
        assert.ok(existsSync(keyFile), `expected ${keyFile} to exist`);
        const parsed = JSON.parse(readFileSync(keyFile, "utf8"));
        assert.equal(parsed.kind, "relay");
        assert.equal(parsed.accessToken, "rt_devflow_access_token_xyz");
        assert.equal(parsed.deviceGrant, Object.keys(backend.state.grants)[0]);
        assert.equal(parsed.tokenEndpoint, "https://surety.test/api/relay/token");
        assert.match(r.stdout, /Logged in to /);
        assert.match(r.stdout, /Device:/);
      } finally {
        rmSync(home, { recursive: true, force: true });
        clearInterval(collector);
      }
    } catch (e) {
      throw e;
    }
  },
});

(async () => {
  await setup();
  let failures = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`  ok: ${c.name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL: ${c.name}`);
      console.log(`    ${e.message}`);
      if (e.stack) console.log(`    ${e.stack.split("\n").slice(1, 6).join("\n")}`);
    }
  }
  await teardown();
  if (failures > 0) {
    console.error(`\n${failures} case(s) failed`);
    process.exit(1);
  }
  console.log("cli login e2e tests ok");
})();
