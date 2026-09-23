import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitDeviceE2eeIdentity,
  createDeviceE2eeIdentityCandidate,
  ensureDeviceE2eeIdentity,
  isUsableDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
  readDeviceE2eeIdentityCandidate,
  resetDeviceE2eeIdentityForEpoch,
  signCurrentDeviceRemoval,
  signDeviceE2eeLocalChallenge,
  verifyDeviceE2eeIdentity,
  verifyDeviceE2eeLocalChallenge,
} from "../src/crypto/deviceE2eeIdentity.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-device-e2ee-"));
try {
  const candidate = createDeviceE2eeIdentityCandidate(stateDir, {
    deviceId: "cli-pending",
  });
  assert.equal(candidate.verification_status, "invalid");
  assert.equal(
    JSON.parse(readFileSync(join(stateDir, "device-e2ee-v2.pending.json"), "utf8"))
      .verification_status,
    "invalid",
  );
  assert.equal(
    (() => {
      try {
        readFileSync(join(stateDir, "device-e2ee-v2.json"));
        return true;
      } catch {
        return false;
      }
    })(),
    false,
  );
  commitDeviceE2eeIdentity(stateDir, candidate);
  assert.equal(
    JSON.parse(readFileSync(join(stateDir, "device-e2ee-v2.json"), "utf8"))
      .verification_status,
    "verified",
  );
  rmSync(join(stateDir, "device-e2ee-v2.json"));

  const first = ensureDeviceE2eeIdentity(stateDir, { deviceId: "cli-test" });
  const reused = ensureDeviceE2eeIdentity(stateDir, { deviceId: "cli-test" });
  assert.equal(reused.public_identity.key_id, first.public_identity.key_id);
  assert.equal(first.public_identity.key_version, 1);
  assert.equal(verifyDeviceE2eeIdentity(first.public_identity), true);
  assert.equal(isUsableDeviceE2eeIdentity(first), true);
  assert.equal(
    isUsableDeviceE2eeIdentity({
      ...first,
      signing_private_jwk: { ...first.signing_private_jwk, d: "damaged" },
    }),
    false,
  );
  const localChallenge = {
    protocol: "e2ee-v2",
    challenge_id: "e2c_identity_test",
    nonce: "nonce-test",
    app_device_id: first.public_identity.device_id,
    app_key_id: first.public_identity.key_id,
    cli_device_id: "cli-peer",
    cli_key_id: "sha256:peer",
    expires_at: "2026-07-30T00:00:00.000Z",
  };
  const localProof = signDeviceE2eeLocalChallenge(first, localChallenge);
  assert.equal(
    verifyDeviceE2eeLocalChallenge(
      first.public_identity,
      localChallenge,
      localProof,
    ),
    true,
  );
  assert.equal(
    verifyDeviceE2eeLocalChallenge(
      first.public_identity,
      { ...localChallenge, nonce: "tampered" },
      localProof,
    ),
    false,
  );
  const removal = signCurrentDeviceRemoval(first, {
    now: new Date("2026-07-28T11:00:00.000Z"),
  });
  assert.equal(removal.action, "remove_current_device");
  assert.equal(removal.device_id, "cli-test");
  assert.equal(removal.key_id, first.public_identity.key_id);
  assert.ok(removal.signature);

  const prepared = prepareDeviceE2eeRotation(stateDir, {
    deviceId: "cli-test",
    now: new Date("2026-07-28T12:00:00.000Z"),
  });
  assert.equal(prepared.next.public_identity.key_version, 2);
  assert.equal(
    prepared.next.public_identity.previous_key_id,
    first.public_identity.key_id,
  );
  assert.ok(prepared.next.public_identity.previous_key_signature);
  assert.equal(verifyDeviceE2eeIdentity(prepared.next.public_identity), true);
  prepared.commit();

  const stored = JSON.parse(readFileSync(join(stateDir, "device-e2ee-v2.json"), "utf8"));
  assert.equal(stored.public_identity.key_version, 2);
  assert.equal(statSync(join(stateDir, "device-e2ee-v2.json")).mode & 0o777, 0o600);
  assert.ok(stored.signing_private_jwk.d);
  assert.equal("signing_private_jwk" in stored.public_identity, false);

  const reset = resetDeviceE2eeIdentityForEpoch(stateDir, {
    deviceId: "cli-test",
    epoch: 2,
    now: new Date("2026-07-29T12:00:00.000Z"),
  });
  assert.equal(reset.public_identity.epoch, 1);
  assert.equal(reset.public_identity.key_version, stored.public_identity.key_version);
  assert.equal(reset.public_identity.key_id, stored.public_identity.key_id);

  const accountA = ensureDeviceE2eeIdentity(stateDir, {
    deviceId: "cli-test",
    accountScope: "sha256:account-a",
  });
  const accountB = ensureDeviceE2eeIdentity(stateDir, {
    deviceId: "cli-test",
    accountScope: "sha256:account-b",
  });
  assert.equal(accountA.public_identity.key_id, accountB.public_identity.key_id);
  assert.equal(
    ensureDeviceE2eeIdentity(stateDir, {
      deviceId: "cli-test",
      accountScope: "sha256:account-a",
    }).public_identity.key_id,
    accountA.public_identity.key_id,
  );

  // A pre-v2.1 installation may only have an account-scoped file for a
  // different account. Migrating into the shared install path must not
  // generate a second key just because the first post-upgrade login is B.
  const legacyStateDir = mkdtempSync(join(tmpdir(), "originrouter-legacy-e2ee-"));
  try {
    const legacyPath = join(
      legacyStateDir,
      "accounts",
      "sha256:account-a",
      "device-e2ee-v2.json",
    );
    mkdirSync(join(legacyPath, ".."), { recursive: true });
    writeFileSync(legacyPath, `${JSON.stringify(accountA)}\n`, { mode: 0o600 });
    const migratedFromOtherAccount = ensureDeviceE2eeIdentity(legacyStateDir, {
      deviceId: "cli-test",
      accountScope: "sha256:account-b",
    });
    assert.equal(
      migratedFromOtherAccount.public_identity.key_id,
      accountA.public_identity.key_id,
    );
    assert.equal(
      readDeviceE2eeIdentityFromDisk(legacyStateDir).public_identity.key_id,
      accountA.public_identity.key_id,
    );
  } finally {
    rmSync(legacyStateDir, { recursive: true, force: true });
  }

  const recovery = createDeviceE2eeIdentityCandidate(stateDir, {
    deviceId: "cli-test",
    epoch: 2,
    keyVersion: 5,
    previousKeyId: "sha256:server-head",
    accountScope: "sha256:recovery-account",
  });
  assert.equal(recovery.public_identity.device_id, "cli-test");
  assert.equal(recovery.public_identity.epoch, 1);
  assert.equal(recovery.public_identity.key_version, 5);
  assert.equal(recovery.public_identity.previous_key_id, "sha256:server-head");
  assert.equal("previous_key_signature" in recovery.public_identity, false);
  assert.equal(verifyDeviceE2eeIdentity(recovery.public_identity), true);
  const resumedRecovery = createDeviceE2eeIdentityCandidate(stateDir, {
    deviceId: "cli-test",
    epoch: 2,
    keyVersion: 5,
    previousKeyId: "sha256:server-head",
    accountScope: "sha256:recovery-account",
  });
  assert.equal(resumedRecovery.public_identity.key_id, recovery.public_identity.key_id);
  assert.equal(
    readDeviceE2eeIdentityCandidate(stateDir, {
      accountScope: "sha256:recovery-account",
    }).public_identity.key_id,
    recovery.public_identity.key_id,
  );
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

function readDeviceE2eeIdentityFromDisk(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "device-e2ee-v2.json"), "utf8"));
}

console.log("device e2ee identity tests ok");
