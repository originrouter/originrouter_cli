// Stage 9.0: coding-auth storage tests.
//
// Covers src/runtime/authContract.js (pure shapes + lifetimes) and
// src/persistence/codingAuth.js (IO helpers).
//
// Verifies:
//   - writeCodingAuth / readCodingAuth round-trips a well-formed key
//   - writeCodingAuth requires kind=managed (delegated to isManagedKeyShape)
//   - writeCodingAuth requires all of keyId, key, deviceGrantId, expiresAt, source, scopes
//   - clearCodingAuth removes the file
//   - isManagedKeyShape accepts a well-formed payload, rejects each missing field
//   - isDeviceGrantShape accepts a well-formed payload, rejects missing fields
//   - lifetime ordering is consistent
//   - login code TTL is between 5 and 10 minutes

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_GRANT_IDLE_MS,
  DEVICE_GRANT_ABS_MS,
  KEY_KIND,
  KEY_SCOPE,
  KEY_SOURCE,
  LOGIN_CODE_TTL_MS_MAX,
  LOGIN_CODE_TTL_MS_MIN,
  MANAGED_KEY_DEFAULT_MS,
  MANAGED_KEY_MAX_MS,
  isDeviceGrantShape,
  isManagedKeyShape,
} from "../src/runtime/authContract.js";
import {
  clearCodingAuth,
  codingAuthPath,
  readCodingAuth,
  writeCodingAuth,
} from "../src/persistence/codingAuth.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-coding-auth-test-"));

function makeValidKey() {
  return {
    kind: KEY_KIND.MANAGED,
    keyId: "k1",
    key: "sk-test-1234567890",
    deviceGrantId: "g1",
    deviceGrant: "raw-grant-token",
    deviceId: "device-test",
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    source: KEY_SOURCE.ORIGINROUTER_CLI,
    scopes: [KEY_SCOPE.CODING],
    deviceGrantIdleExpiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
    deviceGrantAbsoluteExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

const cases = [];

// 1. writeCodingAuth / readCodingAuth round-trip.
cases.push({
  name: "writeCodingAuth round-trips a well-formed key",
  run: () => {
    const k = makeValidKey();
    writeCodingAuth(home, k);
    const out = readCodingAuth(home);
    assert.ok(out, "readCodingAuth must return the persisted record");
    assert.equal(out.kind, k.kind);
    assert.equal(out.keyId, k.keyId);
    assert.equal(out.key, k.key);
    assert.equal(out.deviceGrantId, k.deviceGrantId);
    assert.equal(out.deviceGrant, k.deviceGrant);
    assert.equal(out.deviceId, k.deviceId);
    assert.equal(out.source, k.source);
    assert.deepEqual(out.scopes, k.scopes);
    assert.equal(typeof out.writtenAt, "number");
  },
});

// 2. writeCodingAuth requires all of the canonical fields.
cases.push({
  name: "writeCodingAuth throws when source is missing",
  run: () => {
    const k = { ...makeValidKey() };
    delete k.source;
    assert.throws(() => writeCodingAuth(home, k), /not a well-formed managed key/);
  },
});

cases.push({
  name: "writeCodingAuth throws when scopes are missing",
  run: () => {
    const k = { ...makeValidKey() };
    delete k.scopes;
    assert.throws(() => writeCodingAuth(home, k), /not a well-formed managed key/);
  },
});

cases.push({
  name: "writeCodingAuth throws when scopes omit 'coding'",
  run: () => {
    // isManagedKeyShape rejects this before writeCodingAuth reaches
    // its scope-specific check. The shape check is the contract; the
    // inner check is a defense-in-depth that is unreachable in
    // practice. We assert the throw happens.
    const k = { ...makeValidKey(), scopes: ["other"] };
    assert.throws(() => writeCodingAuth(home, k));
  },
});

cases.push({
  name: "writeCodingAuth rejects source=originrouter_app (CLI-only storage)",
  run: () => {
    const k = { ...makeValidKey(), source: KEY_SOURCE.ORIGINROUTER_APP };
    assert.throws(
      () => writeCodingAuth(home, k),
      /CLI storage only accepts source='originrouter_cli'/,
    );
  },
});

// 3. clearCodingAuth removes the file.
cases.push({
  name: "clearCodingAuth removes the file",
  run: () => {
    writeCodingAuth(home, makeValidKey());
    assert.ok(existsSync(codingAuthPath(home)), "file must exist before clear");
    clearCodingAuth(home);
    assert.ok(!existsSync(codingAuthPath(home)), "file must be removed by clear");
    assert.equal(readCodingAuth(home), null);
  },
});

// 4. isManagedKeyShape accepts a well-formed payload and rejects missing fields.
cases.push({
  name: "isManagedKeyShape accepts a well-formed payload",
  run: () => {
    assert.equal(isManagedKeyShape(makeValidKey()), true);
  },
});

cases.push({
  name: "isManagedKeyShape rejects each missing field",
  run: () => {
    const base = makeValidKey();
    const fields = ["kind", "keyId", "key", "deviceGrantId", "deviceGrant", "deviceId", "expiresAt", "source", "scopes"];
    for (const f of fields) {
      const copy = { ...base };
      delete copy[f];
      assert.equal(isManagedKeyShape(copy), false, `must reject missing '${f}'`);
    }
  },
});

// 4b. Stage 9.1A: deviceGrant + deviceId are required for rotate / revoke.
cases.push({
  name: "isManagedKeyShape rejects payload missing deviceGrant",
  run: () => {
    const k = { ...makeValidKey() };
    delete k.deviceGrant;
    assert.equal(isManagedKeyShape(k), false);
  },
});

cases.push({
  name: "isManagedKeyShape rejects payload missing deviceId",
  run: () => {
    const k = { ...makeValidKey() };
    delete k.deviceId;
    assert.equal(isManagedKeyShape(k), false);
  },
});

// 4c. Optional fields: when present, must be numbers.
cases.push({
  name: "isManagedKeyShape rejects non-number deviceGrantIdleExpiresAt",
  run: () => {
    const k = { ...makeValidKey(), deviceGrantIdleExpiresAt: "soon" };
    assert.equal(isManagedKeyShape(k), false);
  },
});

cases.push({
  name: "isManagedKeyShape accepts absence of optional idle/absolute expiries",
  run: () => {
    const k = { ...makeValidKey() };
    delete k.deviceGrantIdleExpiresAt;
    delete k.deviceGrantAbsoluteExpiresAt;
    assert.equal(isManagedKeyShape(k), true);
  },
});

// 5. isDeviceGrantShape accepts a well-formed payload and rejects missing fields.
cases.push({
  name: "isDeviceGrantShape accepts a well-formed payload",
  run: () => {
    const valid = {
      deviceId: "d1",
      userId: "u1",
      issuedAt: Date.now(),
      lastUsedAt: Date.now(),
      idleExpiresAt: Date.now() + DEVICE_GRANT_IDLE_MS,
      absoluteExpiresAt: Date.now() + DEVICE_GRANT_ABS_MS,
    };
    assert.equal(isDeviceGrantShape(valid), true);
  },
});

cases.push({
  name: "isDeviceGrantShape rejects missing required fields",
  run: () => {
    const base = {
      deviceId: "d1",
      userId: "u1",
      issuedAt: Date.now(),
      idleExpiresAt: Date.now() + DEVICE_GRANT_IDLE_MS,
      absoluteExpiresAt: Date.now() + DEVICE_GRANT_ABS_MS,
    };
    assert.equal(isDeviceGrantShape({ ...base, deviceId: undefined }), false);
    assert.equal(isDeviceGrantShape({ ...base, userId: undefined }), false);
    assert.equal(isDeviceGrantShape({ ...base, issuedAt: undefined }), false);
    assert.equal(isDeviceGrantShape({ ...base, idleExpiresAt: undefined }), false);
    assert.equal(isDeviceGrantShape({ ...base, absoluteExpiresAt: undefined }), false);
  },
});

// 6. Lifetime ordering.
cases.push({
  name: "lifetime ordering is consistent",
  run: () => {
    assert.ok(LOGIN_CODE_TTL_MS_MIN <= LOGIN_CODE_TTL_MS_MAX,
      "login code TTL min <= max");
    assert.ok(MANAGED_KEY_DEFAULT_MS <= MANAGED_KEY_MAX_MS,
      "managed key default <= max");
    assert.ok(MANAGED_KEY_MAX_MS <= DEVICE_GRANT_IDLE_MS,
      "managed key max <= device grant idle");
    assert.ok(DEVICE_GRANT_IDLE_MS <= DEVICE_GRANT_ABS_MS,
      "device grant idle <= absolute");
  },
});

// 7. Login code TTL bounds.
cases.push({
  name: "login code TTL is between 5 and 10 minutes",
  run: () => {
    assert.ok(LOGIN_CODE_TTL_MS_MIN >= 5 * 60 * 1000, "login code min >= 5 min");
    assert.ok(LOGIN_CODE_TTL_MS_MAX <= 10 * 60 * 1000, "login code max <= 10 min");
  },
});

let failures = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`  ok: ${c.name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL: ${c.name}`);
    console.log(`    ${e.message}`);
  }
}

rmSync(home, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

console.log("coding auth storage tests ok");
