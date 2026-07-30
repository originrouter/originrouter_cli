import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectStoredLogin,
  storedLoginIsInvalid,
} from "../src/commands/auth.js";
import {
  codingAuthPath,
  readCodingAuth,
  writeCodingAuth,
} from "../src/persistence/codingAuth.js";

function credential() {
  return {
    kind: "oauth",
    clientId: "originrouter_cli",
    source: "originrouter_cli",
    deviceId: "device-0123456789abcdef0123456789abcdef",
    deviceName: "Work Mac · CLI",
    sessionId: "or_ses_existing",
    refreshToken: "or_rt_existing",
    refreshExpiresAt: Date.now() + 600_000,
    tokenEndpoint: "https://surety.example.test/api/oauth/token",
    revocationEndpoint: "https://surety.example.test/api/oauth/revoke",
    accessTokens: Object.fromEntries(
      ["control", "ai", "coding", "relay"].map((key) => [key, {
        token: `or_at_${key}_existing`,
        expiresAt: Date.now() + 600_000,
        scopes: [],
      }]),
    ),
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function withState(run) {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-login-preflight-"));
  return Promise.resolve(run(stateDir)).finally(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });
}

test("valid stored login is authoritatively refreshed and reused", () => withState(async (stateDir) => {
  writeCodingAuth(stateDir, credential());
  const result = await inspectStoredLogin({
    stateDir,
    fetchFn: async () => response(200, {
      access_token: "or_at_control_refreshed",
      refresh_token: "or_rt_refreshed",
      expires_in: 600,
      refresh_expires_in: 2592000,
      scope: "control.read control.write",
    }),
  });
  assert.equal(result.state, "active");
  assert.equal(result.credential.refreshToken, "or_rt_refreshed");
  assert.equal(readCodingAuth(stateDir).refreshToken, "or_rt_refreshed");
}));

test("terminal Surety rejection clears the stored login", () => withState(async (stateDir) => {
  writeCodingAuth(stateDir, credential());
  const result = await inspectStoredLogin({
    stateDir,
    fetchFn: async () => response(400, {
      error: "invalid_grant",
      error_description: "Refresh token is invalid",
    }),
  });
  assert.equal(result.state, "invalid");
  assert.equal(existsSync(codingAuthPath(stateDir)), false);
}));

test("temporary Surety failure preserves the stored login", () => withState(async (stateDir) => {
  writeCodingAuth(stateDir, credential());
  await assert.rejects(
    () => inspectStoredLogin({
      stateDir,
      fetchFn: async () => response(503, {
        error: "temporarily_unavailable",
      }),
    }),
    (error) => error.code === "temporarily_unavailable",
  );
  assert.equal(readCodingAuth(stateDir).refreshToken, "or_rt_existing");
}));

test("login credential classification keeps network and server failures retryable", () => {
  assert.equal(storedLoginIsInvalid({ code: "invalid_grant", status: 400 }), true);
  assert.equal(storedLoginIsInvalid({ code: "oauth_unavailable", status: 0 }), false);
  assert.equal(storedLoginIsInvalid({ code: "temporarily_unavailable", status: 503 }), false);
  assert.equal(storedLoginIsInvalid({ code: "slow_down", status: 429 }), false);
});
