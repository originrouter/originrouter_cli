import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearCodingAuth,
  codingAuthPath,
  readCodingAuth,
  withCodingAuthLock,
  writeCodingAuth,
} from "../src/persistence/codingAuth.js";
import { isOAuthCredentialShape } from "../src/runtime/authContract.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

test("OAuth credential round-trips with mode 0600", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-oauth-store-"));
  try {
    const credential = makeOAuthCredential();
    writeCodingAuth(stateDir, credential);
    assert.equal(isOAuthCredentialShape(readCodingAuth(stateDir)), true);
    assert.equal(statSync(codingAuthPath(stateDir)).mode & 0o777, 0o600);
    assert.match(readFileSync(codingAuthPath(stateDir), "utf8"), /"writtenAt"/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("invalid legacy credential is rejected", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-oauth-invalid-"));
  try {
    assert.throws(
      () => writeCodingAuth(stateDir, { kind: "managed", deviceGrant: "secret" }),
      /valid OriginRouter OAuth credential/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("clearCodingAuth removes the session", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-oauth-clear-"));
  try {
    writeCodingAuth(stateDir, makeOAuthCredential());
    clearCodingAuth(stateDir);
    assert.equal(readCodingAuth(stateDir), null);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("refresh lock serializes concurrent refreshes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-oauth-lock-"));
  const order = [];
  try {
    const first = withCodingAuthLock(stateDir, async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 120));
      order.push("first-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = withCodingAuthLock(stateDir, async () => order.push("second"));
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
