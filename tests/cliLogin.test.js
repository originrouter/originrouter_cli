// Stage 9.1A: end-to-end CLI login tests.
//
// Spins up a local mock backend on `node:http` (no extra deps),
// then spawns `node ./bin/originrouter.js` against it. The
// mock implements the 5 backend endpoints used by the CLI:
//
//   POST /originrouter/auth/login-code
//   POST /originrouter/auth/device/exchange
//   POST /originrouter/auth/device/rotate-coding-key
//   POST /originrouter/auth/device/revoke
//   GET  /originrouter/auth/devices
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
      if (url.pathname === "/originrouter/auth/login-code" && method === "POST") {
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

      // /device/exchange
      if (url.pathname === "/originrouter/auth/device/exchange" && method === "POST") {
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
      if (url.pathname === "/originrouter/auth/device/rotate-coding-key" && method === "POST") {
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
      if (url.pathname === "/originrouter/auth/device/revoke" && method === "POST") {
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
      if (url.pathname === "/originrouter/auth/devices" && method === "GET") {
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

cases.push({
  name: "login --manual-code writes coding-key.json with new fields",
  run: async () => {
    // First, mint a code from the mock backend via curl-like fetch.
    const loginResp = await fetch(`${backend.url}/originrouter/auth/login-code`, {
      method: "POST",
      headers: { Authorization: "Bearer uuid:test-uuid", "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "smoke-device", source: "originrouter_cli" }),
    });
    assert.equal(loginResp.status, 200);
    const { code } = await loginResp.json();
    const r = await runCli({
      home,
      args: ["login", "--manual-code", code, "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    assert.equal(r.code, 0, `login exited ${r.code}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    // File should exist.
    const filePath = join(home, "coding-key.json");
    assert.ok(existsSync(filePath), "coding-key.json must exist after login");
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    assert.ok(parsed.deviceGrant, "deviceGrant present");
    assert.ok(parsed.deviceId, "deviceId present");
    assert.equal(parsed.source, "originrouter_cli");
    assert.ok(Array.isArray(parsed.scopes) && parsed.scopes.includes("coding"));
    // Masked output: full key never appears in stdout.
    assert.ok(!r.stdout.includes(parsed.key), "raw key MUST NOT appear in stdout");
    assert.match(r.stdout, /sk-or-\*\*\*\*/);
  },
});

cases.push({
  name: "auth status after login prints masked key (not full)",
  run: async () => {
    // Reuse prior state — login first.
    const loginResp = await fetch(`${backend.url}/originrouter/auth/login-code`, {
      method: "POST",
      headers: { Authorization: "Bearer uuid:test-uuid", "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "smoke-device-2", source: "originrouter_cli" }),
    });
    const { code } = await loginResp.json();
    await runCli({
      home: mkdtempSync(join(tmpdir(), "originrouter-cli-login-status-")),
      args: ["login", "--manual-code", code, "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    // Run status with the same home — but status was run on the prior
    // setup home. So we re-login into the setup home first:
    const setupLoginResp = await fetch(`${backend.url}/originrouter/auth/login-code`, {
      method: "POST",
      headers: { Authorization: "Bearer uuid:test-uuid", "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "smoke-device-3", source: "originrouter_cli" }),
    });
    const { code: code2 } = await setupLoginResp.json();
    const loginRun = await runCli({
      home, args: ["login", "--manual-code", code2, "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    assert.equal(loginRun.code, 0);
    const filePath = join(home, "coding-key.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const r = await runCli({ home, args: ["auth", "status"], apiBaseUrl: backend.url });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes(parsed.key), "raw key MUST NOT appear in status");
    assert.match(r.stdout, /sk-or-\*\*\*\*/);
    assert.match(r.stdout, /Logged in \(CLI\)/);
  },
});

cases.push({
  name: "auth rotate replaces key while preserving deviceGrant",
  run: async () => {
    // Login first.
    const loginResp = await fetch(`${backend.url}/originrouter/auth/login-code`, {
      method: "POST",
      headers: { Authorization: "Bearer uuid:test-uuid", "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "smoke-device-4", source: "originrouter_cli" }),
    });
    const { code } = await loginResp.json();
    await runCli({
      home, args: ["login", "--manual-code", code, "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    const filePath = join(home, "coding-key.json");
    const before = JSON.parse(readFileSync(filePath, "utf8"));
    const r = await runCli({
      home, args: ["auth", "rotate", "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    assert.equal(r.code, 0);
    const after = JSON.parse(readFileSync(filePath, "utf8"));
    assert.notEqual(after.keyId, before.keyId, "keyId must change after rotate");
    assert.notEqual(after.key, before.key, "key must change after rotate");
    assert.equal(after.deviceGrant, before.deviceGrant, "deviceGrant must be preserved");
    assert.equal(after.deviceId, before.deviceId, "deviceId must be preserved");
    assert.equal(after.deviceGrantId, before.deviceGrantId);
  },
});

cases.push({
  name: "auth device list prints calling device under scope: current_device_only",
  run: async () => {
    const loginResp = await fetch(`${backend.url}/originrouter/auth/login-code`, {
      method: "POST",
      headers: { Authorization: "Bearer uuid:test-uuid", "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "smoke-device-5", source: "originrouter_cli" }),
    });
    const { code } = await loginResp.json();
    await runCli({
      home, args: ["login", "--manual-code", code, "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    const r = await runCli({
      home, args: ["auth", "device", "list", "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /scope: current_device_only/);
  },
});

cases.push({
  name: "logout clears the local file",
  run: async () => {
    const loginResp = await fetch(`${backend.url}/originrouter/auth/login-code`, {
      method: "POST",
      headers: { Authorization: "Bearer uuid:test-uuid", "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "smoke-device-6", source: "originrouter_cli" }),
    });
    const { code } = await loginResp.json();
    await runCli({
      home, args: ["login", "--manual-code", code, "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    const filePath = join(home, "coding-key.json");
    assert.ok(existsSync(filePath));
    const r = await runCli({
      home, args: ["logout", "--api-base-url", backend.url],
      apiBaseUrl: backend.url,
    });
    assert.equal(r.code, 0);
    assert.ok(!existsSync(filePath), "file must be removed after logout");
  },
});

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
    assert.match(r.stdout, /--manual-code/);
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