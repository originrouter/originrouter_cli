import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateAccount,
  accountNamespace,
  activeAccountStateDir,
  readActiveAccountScope,
} from "../src/persistence/accounts.js";
import {
  clearCodingAuth,
  readCodingAuth,
  writeCodingAuth,
} from "../src/persistence/codingAuth.js";
import { readConfig, writeConfig } from "../src/persistence/state.js";

function credential(accountScope, sessionId) {
  const token = (value) => ({
    token: `or_at_${value}`,
    expiresAt: Date.now() + 60_000,
    scopes: [],
  });
  return {
    kind: "oauth",
    clientId: "originrouter_cli",
    source: "originrouter_cli",
    deviceId: "device-stable",
    sessionId,
    accountScope,
    refreshToken: `or_rt_${sessionId}`,
    refreshExpiresAt: Date.now() + 3_600_000,
    tokenEndpoint: "https://example.test/token",
    revocationEndpoint: "https://example.test/revoke",
    accessTokens: {
      control: token(`${sessionId}-control`),
      ai: token(`${sessionId}-ai`),
      coding: token(`${sessionId}-coding`),
      relay: token(`${sessionId}-relay`),
      memory: token(`${sessionId}-memory`),
    },
  };
}

test("account-scoped config and credentials do not cross-contaminate", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-account-scope-"));
  const previousHome = process.env.ORIGINROUTER_HOME;
  process.env.ORIGINROUTER_HOME = stateDir;
  const accountA = "sha256:outer-account-a";
  const accountB = "sha256:outer-account-b";

  writeCodingAuth(stateDir, credential(accountA, "or_ses_a"));
  writeConfig({ providers: { alpha: { name: "alpha", type: "proxy" } } });
  assert.equal(readCodingAuth(stateDir).accountScope, accountA);
  assert.deepEqual(Object.keys(readConfig().providers), ["alpha"]);
  const scopedA = activeAccountStateDir(stateDir);
  writeCodingAuth(scopedA, credential(accountA, "or_ses_a_refreshed"));
  assert.equal(readCodingAuth(scopedA).sessionId, "or_ses_a_refreshed");
  assert.equal(existsSync(join(scopedA, "accounts")), false);

  writeCodingAuth(stateDir, credential(accountB, "or_ses_b"));
  assert.equal(readActiveAccountScope(stateDir), accountB);
  assert.deepEqual(readConfig(), {});
  writeConfig({ providers: { beta: { name: "beta", type: "proxy" } } });

  activateAccount(stateDir, accountA);
  assert.equal(readCodingAuth(stateDir).sessionId, "or_ses_a_refreshed");
  assert.deepEqual(Object.keys(readConfig().providers), ["alpha"]);
  assert.equal(existsSync(join(stateDir, "device.json")), false);

  activateAccount(stateDir, accountB);
  assert.deepEqual(Object.keys(readConfig().providers), ["beta"]);
  assert.equal(
    activeAccountStateDir(stateDir),
    join(stateDir, "accounts", accountNamespace(accountB)),
  );
  clearCodingAuth(stateDir);
  assert.equal(readCodingAuth(stateDir), null);
  assert.equal(readActiveAccountScope(stateDir), null);
  assert.deepEqual(readConfig(), {});
  if (previousHome == null) delete process.env.ORIGINROUTER_HOME;
  else process.env.ORIGINROUTER_HOME = previousHome;
});

test("proxy state honors the caller state directory instead of global HOME", async () => {
  const { writeProxyState, readProxyState, clearProxyState } = await import("../src/persistence/state.js");
  const stateA = mkdtempSync(join(tmpdir(), "originrouter-proxy-state-a-"));
  const stateB = mkdtempSync(join(tmpdir(), "originrouter-proxy-state-b-"));
  writeProxyState({ state: "running", pid: 123 }, "proxy", stateA);
  assert.equal(readProxyState("proxy", stateA)?.pid, 123);
  assert.equal(readProxyState("proxy", stateB), null);
  clearProxyState("proxy", stateA);
  assert.equal(readProxyState("proxy", stateA), null);
});

test("a verified legacy session migrates its own config exactly once", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-account-migrate-"));
  const previousHome = process.env.ORIGINROUTER_HOME;
  process.env.ORIGINROUTER_HOME = stateDir;
  const account = "sha256:outer-legacy-account";
  const legacy = credential(account, "or_ses_legacy");
  writeFileSync(join(stateDir, "coding-key.json"), JSON.stringify(legacy));
  writeFileSync(join(stateDir, "config.json"), JSON.stringify({
    providers: { legacy: { name: "legacy", type: "proxy" } },
  }));
  writeFileSync(join(stateDir, "sessions.jsonl"), "legacy-session\n");

  assert.equal(readCodingAuth(stateDir).sessionId, "or_ses_legacy");
  assert.equal(readActiveAccountScope(stateDir), account);
  assert.deepEqual(Object.keys(readConfig().providers), ["legacy"]);
  assert.equal(existsSync(join(stateDir, "coding-key.json")), false);
  assert.equal(existsSync(join(stateDir, "config.json")), false);
  assert.equal(existsSync(join(stateDir, "sessions.jsonl")), false);
  assert.equal(existsSync(join(activeAccountStateDir(stateDir), "sessions.jsonl")), true);

  if (previousHome == null) delete process.env.ORIGINROUTER_HOME;
  else process.env.ORIGINROUTER_HOME = previousHome;
});
