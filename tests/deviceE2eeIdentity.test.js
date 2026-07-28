import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
  resetDeviceE2eeIdentityForEpoch,
  verifyDeviceE2eeIdentity,
} from "../src/crypto/deviceE2eeIdentity.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-device-e2ee-"));
try {
  const first = ensureDeviceE2eeIdentity(stateDir, { deviceId: "cli-test" });
  const reused = ensureDeviceE2eeIdentity(stateDir, { deviceId: "cli-test" });
  assert.equal(reused.public_identity.key_id, first.public_identity.key_id);
  assert.equal(first.public_identity.key_version, 1);
  assert.equal(verifyDeviceE2eeIdentity(first.public_identity), true);

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
  assert.equal(reset.public_identity.epoch, 2);
  assert.equal(reset.public_identity.key_version, 1);
  assert.equal(reset.public_identity.previous_key_id, null);
  assert.notEqual(reset.public_identity.key_id, stored.public_identity.key_id);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("device e2ee identity tests ok");
