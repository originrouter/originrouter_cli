import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
} from "../src/crypto/deviceE2eeIdentity.js";
import {
  currentCachedDeviceIdentity,
  deviceE2eeDirectoryCacheState,
  storeDeviceE2eeDirectoryCache,
} from "../src/security/deviceE2eeDirectoryCache.js";

const root = mkdtempSync(join(tmpdir(), "originrouter-e2ee-directory-"));
const identityDir = join(root, "identity");
const cacheDir = join(root, "cache");
const first = ensureDeviceE2eeIdentity(identityDir, { deviceId: "cli-device" });
const policy = { epoch: 1, new_device_approval_required: false };
const trusted = (identity) => ({ ...identity, trust_status: "trusted" });
const firstDirectory = {
  policy,
  identities: [trusted(first.public_identity)],
};

const cached = storeDeviceE2eeDirectoryCache(cacheDir, firstDirectory, {
  now: new Date("2026-07-27T12:00:00.000Z"),
});
assert.equal(currentCachedDeviceIdentity(cached, "cli-device").key_version, 1);
assert.equal(deviceE2eeDirectoryCacheState(cached, {
  now: Date.parse("2026-07-27T12:10:00.000Z"),
}).fresh, true);
assert.equal(deviceE2eeDirectoryCacheState(cached, {
  now: Date.parse("2026-07-27T12:16:00.000Z"),
}).fresh, false);

const prepared = prepareDeviceE2eeRotation(identityDir, {
  deviceId: "cli-device",
  now: new Date("2026-07-27T13:00:00.000Z"),
});
storeDeviceE2eeDirectoryCache(cacheDir, {
  policy,
  identities: [
    trusted(first.public_identity),
    trusted(prepared.next.public_identity),
  ],
});
assert.throws(
  () => storeDeviceE2eeDirectoryCache(cacheDir, firstDirectory),
  /removed or changed/,
);

const vector = JSON.parse(readFileSync(
  new URL("./fixtures/e2ee_v2_dart_vector.json", import.meta.url),
  "utf8",
));
const app = vector.app.public_identity;
const cli = vector.cli.public_identity;
const signedProof = (domain, value) => ({
  ...value,
  signature: sign(
    null,
    Buffer.from(`${domain}${canonicalJson(value)}`),
    createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: app.signing_public_key,
        d: vector.app.signing_private_key,
      },
      format: "jwk",
    }),
  ).toString("base64url"),
});
const policyValue = {
  action: "set_new_device_approval_required",
  account_epoch: 1,
  device_id: app.device_id,
  approver_key_id: app.key_id,
  new_device_approval_required: true,
  grandfathered_key_ids: [app.key_id],
  created_at: "2026-07-27T15:01:00.000Z",
};
const verifiedPolicy = {
  epoch: 1,
  new_device_approval_required: true,
  policy_proof: signedProof("originrouter/device-policy/v2\n", policyValue),
};
const approvalValue = {
  action: "approve_device",
  account_epoch: 1,
  approver_device_id: app.device_id,
  approver_key_id: app.key_id,
  candidate_device_id: cli.device_id,
  candidate_key_id: cli.key_id,
  request_id: "e2a_cli",
  created_at: "2026-07-27T15:02:00.000Z",
};
const admissionProof = signedProof(
  "originrouter/device-admission/v2\n",
  approvalValue,
);
const verifiedCacheDir = join(root, "verified-cache");
storeDeviceE2eeDirectoryCache(verifiedCacheDir, {
  policy: verifiedPolicy,
  identities: [
    { ...app, trust_status: "trusted" },
    { ...cli, trust_status: "pending", approval_request_id: "e2a_cli" },
  ],
});
storeDeviceE2eeDirectoryCache(verifiedCacheDir, {
  policy: verifiedPolicy,
  identities: [
    { ...app, trust_status: "trusted" },
    { ...cli, trust_status: "trusted", admission_proof: admissionProof },
  ],
});
assert.throws(
  () => storeDeviceE2eeDirectoryCache(verifiedCacheDir, {
    policy: { epoch: 1, new_device_approval_required: false },
    identities: [
      { ...app, trust_status: "trusted" },
      { ...cli, trust_status: "trusted", admission_proof: admissionProof },
    ],
  }),
  /unsigned verified-device policy change/,
);
const attacker = ensureDeviceE2eeIdentity(join(root, "attacker"), {
  deviceId: "server-invented-device",
});
assert.throws(
  () => storeDeviceE2eeDirectoryCache(verifiedCacheDir, {
    policy: verifiedPolicy,
    identities: [
      { ...app, trust_status: "trusted" },
      { ...cli, trust_status: "trusted", admission_proof: admissionProof },
      { ...attacker.public_identity, trust_status: "trusted" },
    ],
  }),
  /unverified trusted device/,
);

console.log("device E2EE directory cache tests ok");
