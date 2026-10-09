import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
  deviceE2eeDirectoryCachePath,
  deviceE2eeDirectoryCacheState,
  deviceE2eeDirectoryHead,
  deviceE2eeDirectoryNamespace,
  ensureDeviceE2eeDirectoryCacheMigrated,
  quarantinedDeviceIds,
  readDeviceE2eeDirectoryCache,
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
// The directory endpoint serves these as epoch seconds; admission proofs are
// only honoured when the approver was already trusted at the moment it signed,
// so every fixture identity needs them.
const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const app = {
  ...vector.app.public_identity,
  registered_at: at("2026-07-27T15:00:00.000Z"),
  approved_at: at("2026-07-27T15:00:00.000Z"),
};
const cli = {
  ...vector.cli.public_identity,
  registered_at: at("2026-07-27T15:02:00.000Z"),
  approved_at: at("2026-07-27T15:02:00.000Z"),
};
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
  // The approver's trust is evaluated at the moment the policy was accepted,
  // which the server carries on the policy itself. Without it there is no
  // time to evaluate against and a signed policy cannot be honoured.
  updated_at: at("2026-07-27T15:01:00.000Z"),
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
  const legacyPath = deviceE2eeDirectoryCachePath(legacyDir, {
    namespace: "or_ses_old",
  });
  assert.ok(existsSync(legacyPath), "the session-scoped file starts present");
  const adopted = adoptLegacyDeviceE2eeDirectoryCache(legacyDir, {
    namespace: "account:sha256:abc",
  });
  assert.ok(adopted, "the newest usable session cache must be adopted");
  assert.equal(
    currentCachedDeviceIdentity(adopted, "legacy-device").key_id,
    legacyIdentity.public_identity.key_id,
  );
  // The session-scoped file is removed once its content has been carried over.
  // Leaving it behind keeps contradictory views of one account on disk forever,
  // which is how the epoch-2/epoch-1 split arose in the first place.
  assert.equal(
    existsSync(legacyPath),
    false,
    "the superseded session-scoped cache must be cleaned up",
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

  // An account-scoped cache already present stays authoritative, and the
  // leftover session files are still cleaned up rather than being adopted over
  // the newer state.
  const keepDir = join(root, "legacy-keep");
  const keepIdentity = ensureDeviceE2eeIdentity(join(root, "keep-identity"), {
    deviceId: "current-device",
  });
  storeDeviceE2eeDirectoryCache(keepDir, legacyDirectory, {
    namespace: "or_ses_superseded",
  });
  storeDeviceE2eeDirectoryCache(keepDir, {
    policy,
    identities: [trusted(keepIdentity.public_identity)],
  }, { namespace: "account:sha256:keep" });
  assert.equal(
    adoptLegacyDeviceE2eeDirectoryCache(keepDir, {
      namespace: "account:sha256:keep",
    }),
    null,
  );
  assert.equal(
    existsSync(deviceE2eeDirectoryCachePath(keepDir, {
      namespace: "or_ses_superseded",
    })),
    false,
    "leftovers are cleaned up even when nothing is adopted",
  );
  assert.equal(
    currentCachedDeviceIdentity(
      readDeviceE2eeDirectoryCache(keepDir, { namespace: "account:sha256:keep" }),
      "current-device",
    ).key_id,
    keepIdentity.public_identity.key_id,
    "the existing account-scoped cache must survive untouched",
  );

  // Running migration repeatedly must be safe and must not refetch or rewrite.
  const migrateDir = join(root, "legacy-migrate");
  storeDeviceE2eeDirectoryCache(migrateDir, legacyDirectory, {
    namespace: "or_ses_migrate",
  });
  const credential = { accountScope: "sha256:mig", sessionId: "or_ses_migrate" };
  assert.equal(
    ensureDeviceE2eeDirectoryCacheMigrated(migrateDir, credential),
    "account:sha256:mig",
  );
  assert.equal(
    ensureDeviceE2eeDirectoryCacheMigrated(migrateDir, credential),
    "account:sha256:mig",
    "migration is idempotent",
  );
  assert.ok(
    readDeviceE2eeDirectoryCache(migrateDir, { namespace: "account:sha256:mig" }),
    "migration must leave an account-scoped cache in place",
  );
  // A credential without an account scope must be left entirely alone.
  const legacyOnlyDir = join(root, "legacy-only");
  storeDeviceE2eeDirectoryCache(legacyOnlyDir, legacyDirectory, {
    namespace: "or_ses_only",
  });
  assert.equal(
    ensureDeviceE2eeDirectoryCacheMigrated(legacyOnlyDir, {
      sessionId: "or_ses_only",
    }),
    "or_ses_only",
  );
  assert.ok(
    existsSync(deviceE2eeDirectoryCachePath(legacyOnlyDir, {
      namespace: "or_ses_only",
    })),
    "a session-only credential must keep using its own cache",
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

// ---------------------------------------------------------------------------
// Regression: a revoked grandfathered root is skipped, not fatal.
//
// `set_policy` freezes `grandfathered_key_ids` at signing time and never
// re-signs, while `trust_status` is derived live from the binding. Removing
// any device that was in that list therefore leaves behind a root the client
// can no longer honour. Rejecting the whole snapshot over it failed every
// inbound device-relay message, and because the failed cache write pinned the
// client to the last pre-removal snapshot, it never recovered on its own.
// Skipping the root keeps a revoked device from re-authorizing anything while
// leaving the rest of the directory usable.
// ---------------------------------------------------------------------------
{
  const approvedAt = at("2026-07-27T12:00:00.000Z");
  const removedAt = at("2026-07-27T13:00:00.000Z");
  const signProof = (domain, value, handle) => ({
    ...value,
    signature: sign(
      null,
      Buffer.from(`${domain}${canonicalJson(value)}`),
      createPrivateKey({
        key: handle.signing_private_jwk,
        format: "jwk",
      }),
    ).toString("base64url"),
  });
  const approved = (identity, extra = {}) => ({
    ...identity,
    trust_status: "trusted",
    registered_at: approvedAt,
    approved_at: approvedAt,
    ...extra,
  });

  const rootApp = ensureDeviceE2eeIdentity(join(root, "root-app"), {
    deviceId: "root-app-device",
    source: "originrouter_app",
  });
  const healthyCli = ensureDeviceE2eeIdentity(join(root, "root-cli"), {
    deviceId: "root-cli-device",
  });
  const removedApp = ensureDeviceE2eeIdentity(join(root, "removed-root-app"), {
    deviceId: "removed-root-app-device",
    source: "originrouter_app",
  });
  const policyProofFor = (keyIds) => signProof(
    "originrouter/device-policy/v2\n",
    {
      action: "set_new_device_approval_required",
      account_epoch: 1,
      device_id: rootApp.public_identity.device_id,
      approver_key_id: rootApp.public_identity.key_id,
      new_device_approval_required: true,
      grandfathered_key_ids: keyIds,
      created_at: "2026-07-27T12:00:00.000Z",
    },
    rootApp,
  );
  const revokedRoot = {
    policy: {
      epoch: 1,
      new_device_approval_required: true,
      updated_at: approvedAt,
      policy_proof: policyProofFor([
        rootApp.public_identity.key_id,
        healthyCli.public_identity.key_id,
        removedApp.public_identity.key_id,
      ]),
    },
    identities: [
      approved(rootApp.public_identity),
      approved(healthyCli.public_identity),
      {
        ...removedApp.public_identity,
        trust_status: "revoked",
        registered_at: approvedAt,
        approved_at: approvedAt,
        revoked_at: removedAt,
      },
    ],
  };

  const stored = storeDeviceE2eeDirectoryCache(join(root, "revoked-root"), revokedRoot);
  assert.equal(
    currentCachedDeviceIdentity(stored, "root-app-device").key_id,
    rootApp.public_identity.key_id,
    "a revoked root must not cost the directory its other devices",
  );
  assert.equal(
    currentCachedDeviceIdentity(stored, "root-cli-device").key_id,
    healthyCli.public_identity.key_id,
  );
  assert.equal(
    currentCachedDeviceIdentity(stored, "removed-root-app-device").trust_status,
    "revoked",
    "the removed device stays in the directory as revoked history",
  );

  // The counterpart: skipping a removed root must also stop it from anchoring
  // other devices. A revoked approver is not in the authorized set, so a
  // device it admitted no longer resolves to a live root.
  const admittedCli = ensureDeviceE2eeIdentity(join(root, "admitted-cli"), {
    deviceId: "admitted-cli-device",
  });
  assert.throws(
    () => storeDeviceE2eeDirectoryCache(join(root, "revoked-approver"), {
      policy: {
        epoch: 1,
        new_device_approval_required: true,
        updated_at: approvedAt,
        policy_proof: policyProofFor([
          rootApp.public_identity.key_id,
          removedApp.public_identity.key_id,
        ]),
      },
      identities: [
        approved(rootApp.public_identity),
        {
          ...removedApp.public_identity,
          trust_status: "revoked",
          registered_at: approvedAt,
          approved_at: approvedAt,
          revoked_at: removedAt,
        },
        approved(admittedCli.public_identity, {
          admission_proof: signProof("originrouter/device-admission/v2\n", {
            action: "approve_device",
            account_epoch: 1,
            approver_device_id: removedApp.public_identity.device_id,
            approver_key_id: removedApp.public_identity.key_id,
            candidate_device_id: admittedCli.public_identity.device_id,
            candidate_key_id: admittedCli.public_identity.key_id,
            request_id: "e2a_admitted",
            created_at: "2026-07-27T12:30:00.000Z",
          }, removedApp),
        }),
      ],
    }),
    /unverified trusted device in directory/,
    "a revoked approver must not anchor the devices it admitted",
  );
}

// ---------------------------------------------------------------------------
// Regression: an approval only counts if the approver was trusted when it
// signed. A superseded key keeps its signature forever, so without checking
// the approver's window at proof time an old key could keep admitting new
// devices long after the device had rotated past it.
// ---------------------------------------------------------------------------
{
  const rotatedAt = at("2026-07-27T14:00:00.000Z");
  const approverDir = join(root, "rotating-approver");
  const approverV1 = ensureDeviceE2eeIdentity(approverDir, {
    deviceId: "rotating-approver-device",
    source: "originrouter_app",
  });
  const approverV2 = prepareDeviceE2eeRotation(approverDir, {
    deviceId: "rotating-approver-device",
    now: new Date("2026-07-27T14:00:00.000Z"),
  }).next;
  const signProof = (domain, value, handle) => ({
    ...value,
    signature: sign(
      null,
      Buffer.from(`${domain}${canonicalJson(value)}`),
      createPrivateKey({
        key: handle.signing_private_jwk,
        format: "jwk",
      }),
    ).toString("base64url"),
  });
  const approvedAt = at("2026-07-27T12:00:00.000Z");
  const row = (identity, extra = {}) => ({
    ...identity,
    trust_status: "trusted",
    registered_at: approvedAt,
    approved_at: approvedAt,
    ...extra,
  });
  const directoryWith = (candidate, approvedAtSeconds) => ({
    policy: {
      epoch: 1,
      new_device_approval_required: true,
      updated_at: approvedAt,
      policy_proof: signProof("originrouter/device-policy/v2\n", {
        action: "set_new_device_approval_required",
        account_epoch: 1,
        device_id: approverV2.public_identity.device_id,
        approver_key_id: approverV2.public_identity.key_id,
        new_device_approval_required: true,
        grandfathered_key_ids: [approverV2.public_identity.key_id],
        created_at: "2026-07-27T12:00:00.000Z",
      }, approverV2),
    },
    identities: [
      // A superseded key is reported as `revoked`, has its approval fields
      // cleared, and carries `revoked_at` stamped at the moment of rotation —
      // that stamp is what closes its trust window. Leaving it off here made
      // the key's window unbounded and the out-of-window case unverifiable.
      row(approverV1.public_identity, {
        trust_status: "revoked",
        approved_by_device_id: null,
        approved_at: null,
        revoked_at: rotatedAt,
      }),
      row(approverV2.public_identity, { registered_at: rotatedAt }),
      row(candidate.public_identity, {
        approved_at: approvedAtSeconds,
        admission_proof: signProof("originrouter/device-admission/v2\n", {
          action: "approve_device",
          account_epoch: 1,
          approver_device_id: approverV1.public_identity.device_id,
          approver_key_id: approverV1.public_identity.key_id,
          candidate_device_id: candidate.public_identity.device_id,
          candidate_key_id: candidate.public_identity.key_id,
          request_id: "e2a_rotation_window",
          created_at: "2026-07-27T13:00:00.000Z",
        }, approverV1),
      }),
    ],
  });

  // Approved while the signing key was still the device's current one.
  const inWindow = ensureDeviceE2eeIdentity(join(root, "in-window-candidate"), {
    deviceId: "in-window-candidate-device",
  });
  const accepted = storeDeviceE2eeDirectoryCache(
    join(root, "rotation-in-window"),
    directoryWith(inWindow, at("2026-07-27T13:00:00.000Z")),
  );
  assert.equal(
    currentCachedDeviceIdentity(accepted, "in-window-candidate-device").key_id,
    inWindow.public_identity.key_id,
    "an approval signed while the approver's key was current must still count",
  );

  // Approved after the device rotated past that key.
  const outOfWindow = ensureDeviceE2eeIdentity(join(root, "out-window-candidate"), {
    deviceId: "out-window-candidate-device",
  });
  assert.throws(
    () => storeDeviceE2eeDirectoryCache(
      join(root, "rotation-out-of-window"),
      directoryWith(outOfWindow, at("2026-07-27T15:00:00.000Z")),
    ),
    /unverified trusted device in directory/,
    "a key that was already superseded when it signed must not admit devices",
  );
}

console.log("device E2EE directory cache tests ok");
