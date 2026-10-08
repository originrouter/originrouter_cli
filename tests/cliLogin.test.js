import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readCodingAuth, writeCodingAuth } from "../src/persistence/codingAuth.js";
import { ensureDeviceE2eeIdentity, readDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = resolve(repo, "bin", "originrouter.js");

function runCli(home, args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: repo,
      env: { ...process.env, ...env, ORIGINROUTER_HOME: home, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

test("auth status reports no local OAuth session", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-cli-empty-"));
  try {
    const result = await runCli(home, ["auth", "status"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Not logged in\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("logout device removal signs with the current account epoch and preserves the installation key", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-cli-device-removal-"));
  const deviceId = "device-logout-test";
  const requests = [];
  let removal = null;
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/cli/v1/device-e2ee/status") {
      res.end(JSON.stringify({ data: { policy: { epoch: 9 } } }));
    } else if (req.url === "/cli/v1/device-e2ee/self/remove") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      removal = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.end(JSON.stringify({ data: { identity: { trust_status: "revoked" } } }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "unexpected request" }));
    }
  });
  try {
    writeCodingAuth(home, makeOAuthCredential({ deviceId }));
    writeFileSync(join(home, "device.json"), JSON.stringify({ deviceId, displayName: "Test device" }));
    const identity = ensureDeviceE2eeIdentity(home, { deviceId });
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const result = await runCli(home, ["logout", "--remove-device"], {
      ORIGINROUTER_CONTROL_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Signed out and removed this device/);
    assert.deepEqual(requests, [
      "/cli/v1/device-e2ee/status",
      "/cli/v1/device-e2ee/self/remove",
    ]);
    assert.equal(removal.account_epoch, 9);
    assert.equal(removal.device_id, deviceId);
    assert.equal(readCodingAuth(home), null);
    assert.equal(readDeviceE2eeIdentity(home).public_identity.key_id, identity.public_identity.key_id);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(home, { recursive: true, force: true });
  }
});

test("auth status displays the OAuth session without printing raw tokens", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-cli-session-"));
  try {
    writeCodingAuth(home, makeOAuthCredential({
      deviceId: "device-stable-cli",
      sessionId: "or_ses_cli_status",
    }));
    const result = await runCli(home, ["auth", "status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Logged in \(OriginRouter OAuth\)/);
    assert.match(result.stdout, /device-stable-cli/);
    assert.match(result.stdout, /or_ses_cli_status/);
    assert.ok(!result.stdout.includes("or_rt_test_refresh"));
    assert.ok(!result.stdout.includes("or_at_control_test"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("login status is a read-only alias and never starts Agent route setup", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-cli-login-status-"));
  try {
    writeCodingAuth(home, makeOAuthCredential({
      deviceId: "device-login-status",
      sessionId: "or_ses_login_status",
    }));
    const result = await runCli(home, ["login", "status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Logged in \(OriginRouter OAuth\)/);
    assert.match(result.stdout, /device-login-status/);
    assert.doesNotMatch(result.stdout, /Configure OriginRouter Cloud/);
    assert.doesNotMatch(result.stdout, /Agent routes unchanged/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the first operational CLI command writes bundled Cloud defaults once", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-cli-default-routes-"));
  try {
    const first = await runCli(home, ["route", "list"]);
    assert.equal(first.code, 0, first.stderr);
    const seeded = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(seeded.routes.claude.main.model, "claude-sonnet-5");
    // The auxiliary families start out inheriting the primary model, so no
    // auxiliary slot is written at all.
    assert.equal(seeded.routes.claude.haiku, undefined);
    assert.equal(seeded.routes.codex.main.model, "gpt-5.6-sol");

    seeded.routes.codex.main.model = "user-selected-model";
    writeFileSync(join(home, "config.json"), JSON.stringify(seeded));
    const second = await runCli(home, ["status"]);
    assert.equal(second.code, 0, second.stderr);
    const preserved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(preserved.routes.codex.main.model, "user-selected-model");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("help exposes the current auth surface only", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-cli-help-"));
  try {
    const result = await runCli(home, ["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /originrouter login/);
    assert.match(result.stdout, /originrouter logout/);
    assert.match(result.stdout, /originrouter auth status/);
    assert.doesNotMatch(result.stdout, /auth rotate/);
    assert.doesNotMatch(result.stdout, /auth device list/);
    assert.doesNotMatch(result.stdout, /configure-agents/);
    assert.doesNotMatch(result.stdout, /keep-agent-routes/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
