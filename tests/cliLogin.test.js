import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = resolve(repo, "bin", "originrouter.js");

function runCli(home, args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: repo,
      env: { ...process.env, ORIGINROUTER_HOME: home, NO_COLOR: "1" },
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
