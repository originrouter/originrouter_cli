import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  createDeviceE2eeIdentityCandidate,
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
} from "../src/crypto/deviceE2eeIdentity.js";
import {
  adoptLegacyDeviceE2eeDirectoryCache,
  cachedDeviceStatus,
  currentCachedDeviceIdentity,
  deviceE2eeDirectoryCacheState,
  deviceE2eeDirectoryHead,
  deviceE2eeDirectoryNamespace,
  quarantinedDeviceIds,
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

// A lost-key recovery is intentionally self-signed: the server has already
// authenticated the recovery flow and revoked the old head, so the new key
// cannot carry a signature from the unavailable private key. The directory
// verifier must accept exactly this transition while continuing to reject the
// same shape from a trusted (non-revoked) predecessor.
const recoveryIdentityDir = join(root, "recovery-identity");
const recoveryCacheDir = join(root, "recovery-cache");
const recoveryFirst = ensureDeviceE2eeIdentity(recoveryIdentityDir, {
  deviceId: "recovery-device",
});
const recoveryCandidate = createDeviceE2eeIdentityCandidate(recoveryIdentityDir, {
  deviceId: "recovery-device",
  keyVersion: 2,
  previousKeyId: recoveryFirst.public_identity.key_id,
});
storeDeviceE2eeDirectoryCache(recoveryCacheDir, {
  policy,
  identities: [
    { ...recoveryFirst.public_identity, trust_status: "revoked" },
    { ...recoveryCandidate.public_identity, trust_status: "trusted" },
  ],
});
// An unsigned replacement key is only acceptable as account-key recovery,
// which requires the superseded key to be revoked. While it is still trusted
// the transition is unverifiable, so the device must not be addressable.
// A single bad chain is quarantined rather than rejecting the whole directory,
// so assert on the quarantine instead of on a throw: other devices in the same
// directory have to stay usable.
{
  const badRecovery = storeDeviceE2eeDirectoryCache(
    join(root, "bad-recovery-cache"),
    {
      policy,
      identities: [
        { ...recoveryFirst.public_identity, trust_status: "trusted" },
        { ...recoveryCandidate.public_identity, trust_status: "trusted" },
      ],
    },
  );
  assert.deepEqual(
    quarantinedDeviceIds(badRecovery),
    ["recovery-device"],
    "an unverifiable rotation must quarantine exactly that device",
  );
  assert.equal(
    currentCachedDeviceIdentity(badRecovery, "recovery-device"),
    null,
    "a quarantined device must never be offered as a peer",
  );
  assert.equal(
    cachedDeviceStatus(badRecovery, "recovery-device").reason,
    "invalid_key_rotation",
  );
}

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

// ---------------------------------------------------------------------------
// Regression: a directory that serves only each device's current key.
//
// The account binding holds one row per installation, so a server assembling
// the directory from it reports only the bound key. After a rotation that
// chain begins at key_version 2. This shape previously threw and rejected the
// entire directory, which left the client unable to cache any directory at all
// for as long as the server kept omitting the superseded key.
// ---------------------------------------------------------------------------
{
  const dir = join(root, "truncated-identity");
  const rotatedFirst = ensureDeviceE2eeIdentity(dir, { deviceId: "rotated-device" });
  const rotated = prepareDeviceE2eeRotation(dir, {
    deviceId: "rotated-device",
    now: new Date("2026-07-27T14:00:00.000Z"),
  });
  const peerIdentity = ensureDeviceE2eeIdentity(join(root, "truncated-peer"), {
    deviceId: "healthy-peer",
  });
  const truncated = {
    policy,
    identities: [
      trusted(rotated.next.public_identity),
      trusted(peerIdentity.public_identity),
    ],
  };

  // Cold client: no pinned history to complete the chain. The rotated device
  // is quarantined, but the healthy peer must stay addressable.
  const cold = storeDeviceE2eeDirectoryCache(join(root, "truncated-cold"), truncated);
  assert.deepEqual(quarantinedDeviceIds(cold), ["rotated-device"]);
  assert.equal(
    cachedDeviceStatus(cold, "rotated-device").reason,
    "incomplete_key_chain",
  );
  assert.equal(currentCachedDeviceIdentity(cold, "rotated-device"), null);
  assert.equal(
    currentCachedDeviceIdentity(cold, "healthy-peer").key_version,
    1,
    "one device's truncated chain must not take the rest of the directory down",
  );

  // Warm client: it already pinned key_version 1, so the chain can be
  // completed from local history and the device stays usable.
  const warmDir = join(root, "truncated-warm");
  storeDeviceE2eeDirectoryCache(warmDir, {
    policy,
    identities: [
      trusted(rotatedFirst.public_identity),
      trusted(peerIdentity.public_identity),
    ],
  });
  const warm = storeDeviceE2eeDirectoryCache(warmDir, truncated);
  assert.deepEqual(
    quarantinedDeviceIds(warm),
    [],
    "pinned history must complete a chain the server truncated",
  );
  assert.equal(
    currentCachedDeviceIdentity(warm, "rotated-device").key_version,
    2,
    "the current peer must be the rotated key, not the superseded one",
  );
  assert.ok(
    warm.known_identities.some(
      (item) => item.key_id === rotatedFirst.public_identity.key_id,
    ),
    "the spliced key must be retained for the next refresh",
  );

  // The head describes what the server served, so a client that spliced local
  // history still agrees with one that did not. Otherwise the two would report
  // different heads and every peer exchange would look like a directory fork.
  assert.equal(
    deviceE2eeDirectoryHead(warm),
    deviceE2eeDirectoryHead(cold),
    "directory heads must not depend on local splicing or quarantine",
  );

  // A complete chain must verify with no quarantine at all.
  const complete = storeDeviceE2eeDirectoryCache(join(root, "chain-complete"), {
    policy,
    identities: [
      { ...rotatedFirst.public_identity, trust_status: "revoked" },
      trusted(rotated.next.public_identity),
      trusted(peerIdentity.public_identity),
    ],
  });
  assert.deepEqual(quarantinedDeviceIds(complete), []);
  assert.equal(
    currentCachedDeviceIdentity(complete, "rotated-device").key_version,
    2,
  );

  // Tolerating a truncated chain must not tolerate forged key material. A
  // rotation whose predecessor signature does not verify stays unusable even
  // when the chain is otherwise complete.
  const forged = storeDeviceE2eeDirectoryCache(join(root, "chain-forged"), {
    policy,
    identities: [
      { ...rotatedFirst.public_identity, trust_status: "revoked" },
      {
        ...rotated.next.public_identity,
        trust_status: "trusted",
        previous_key_signature: "A".repeat(86),
      },
      trusted(peerIdentity.public_identity),
    ],
  });
  assert.deepEqual(quarantinedDeviceIds(forged), ["rotated-device"]);
  assert.equal(
    cachedDeviceStatus(forged, "rotated-device").reason,
    "invalid_key_rotation",
  );
  assert.equal(
    currentCachedDeviceIdentity(forged, "healthy-peer").key_version,
    1,
  );
}

// ---------------------------------------------------------------------------
// The cache namespace belongs to the account, not to one sign-in.
// ---------------------------------------------------------------------------
{
  assert.equal(
    deviceE2eeDirectoryNamespace({
      accountScope: "sha256:abc",
      sessionId: "or_ses_one",
    }),
    "account:sha256:abc",
  );
  assert.equal(
    deviceE2eeDirectoryNamespace({
      accountScope: "sha256:abc",
      sessionId: "or_ses_two",
    }),
    "account:sha256:abc",
    "a new sign-in on the same account must reuse the same cache",
  );
  assert.equal(
    deviceE2eeDirectoryNamespace({ sessionId: "or_ses_legacy" }),
    "or_ses_legacy",
    "credentials recorded before the account scope keep working",
  );
  assert.equal(deviceE2eeDirectoryNamespace({}), "");

  // Upgrading must carry existing session-scoped state into the account
  // namespace so the pinned history that completes a truncated chain is not
  // thrown away.
  const legacyDir = join(root, "legacy-adopt");
  const legacyIdentity = ensureDeviceE2eeIdentity(join(root, "legacy-identity"), {
    deviceId: "legacy-device",
  });
  const legacyDirectory = {
    policy,
    identities: [trusted(legacyIdentity.public_identity)],
  };
  storeDeviceE2eeDirectoryCache(legacyDir, legacyDirectory, {
    namespace: "or_ses_old",
    now: new Date(),
  });
  const adopted = adoptLegacyDeviceE2eeDirectoryCache(legacyDir, {
    namespace: "account:sha256:abc",
  });
  assert.ok(adopted, "the newest usable session cache must be adopted");
  assert.equal(
    currentCachedDeviceIdentity(adopted, "legacy-device").key_id,
    legacyIdentity.public_identity.key_id,
  );
  assert.equal(
    adoptLegacyDeviceE2eeDirectoryCache(legacyDir, {
      namespace: "account:sha256:abc",
    }),
    null,
    "adoption must not overwrite an existing account-scoped cache",
  );
  assert.equal(
    adoptLegacyDeviceE2eeDirectoryCache(legacyDir, { namespace: "or_ses_old" }),
    null,
    "adoption only targets an account-scoped namespace",
  );

  // A cache past the usable window must not be adopted: it would reintroduce
  // trust state the client is no longer allowed to rely on.
  const staleDir = join(root, "legacy-stale");
  storeDeviceE2eeDirectoryCache(staleDir, legacyDirectory, {
    namespace: "or_ses_stale",
    now: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });
  assert.equal(
    adoptLegacyDeviceE2eeDirectoryCache(staleDir, {
      namespace: "account:sha256:def",
    }),
    null,
    "a cache beyond max-stale must not be adopted",
  );
}

console.log("device E2EE directory cache tests ok");
