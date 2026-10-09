// Generates the shared trust-evaluation fixtures consumed by BOTH the Node
// cache verifier (`src/security/deviceE2eeDirectoryCache.js`) and the Dart one
// (`lib/features/security/device_e2ee_directory_cache.dart`).
//
// The two verify the same signed directory with two independent
// implementations, so they have to reach the same verdict on every input. The
// envelope and directory-head vectors in `tests/fixtures` only cover the
// crypto, which is why a divergence in the *trust* decision could sit in the
// tree: the App accepted a directory the CLI rejected, and the two halves then
// disagreed about which devices exist.
//
// Each case below is one directory plus the verdict both sides must return.
// Run with `node scripts/generate-device-e2ee-trust-fixtures.mjs`; the output
// belongs at `tests/fixtures/device_e2ee_trust_vectors.json` here and at
// `test/fixtures/device_e2ee_trust_vectors.json` in the App repository.
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
} from "../src/crypto/deviceE2eeIdentity.js";

const POLICY_DOMAIN = "originrouter/device-policy/v2\n";
const ADMISSION_DOMAIN = "originrouter/device-admission/v2\n";

const at = (iso) => Math.floor(Date.parse(iso) / 1000);

// Real identities, built by the repo's own key code so the self-signature and
// the rotation chain verify for real. Generated per run into a scratch
// directory and thrown away with the fixture — nothing here is secret.
const scratch = mkdtempSync(join(tmpdir(), "originrouter-trust-vectors-"));
let scratchCount = 0;

const scratchDir = (prefix) => join(scratch, `${prefix}${scratchCount += 1}`);

const identity = ({ deviceId, source }) => ensureDeviceE2eeIdentity(
  scratchDir("id"),
  { deviceId, source, now: new Date("2026-07-27T11:00:00.000Z") },
);

// A device that rotates its key, so the window cases have a successor to age
// the old key out at.
const rotated = ({ deviceId, source, rotatedAt }) => {
  const dir = scratchDir("rot");
  const first = ensureDeviceE2eeIdentity(dir, {
    deviceId,
    source,
    now: new Date("2026-07-27T11:00:00.000Z"),
  });
  return {
    first,
    next: prepareDeviceE2eeRotation(dir, {
      deviceId,
      now: new Date(rotatedAt),
    }).next,
  };
};

const signProof = (domain, value, handle) => ({
  ...value,
  signature: sign(
    null,
    Buffer.from(`${domain}${canonicalJson(value)}`),
    createPrivateKey({ key: handle.signing_private_jwk, format: "jwk" }),
  ).toString("base64url"),
});

const policyProof = (approver, grandfatheredKeyIds, createdAt) => signProof(
  POLICY_DOMAIN,
  {
    action: "set_new_device_approval_required",
    account_epoch: 1,
    device_id: approver.public_identity.device_id,
    approver_key_id: approver.public_identity.key_id,
    new_device_approval_required: true,
    grandfathered_key_ids: grandfatheredKeyIds,
    created_at: createdAt,
  },
  approver,
);

const admissionProof = (approver, candidate, createdAt) => signProof(
  ADMISSION_DOMAIN,
  {
    action: "approve_device",
    account_epoch: 1,
    approver_device_id: approver.public_identity.device_id,
    approver_key_id: approver.public_identity.key_id,
    candidate_device_id: candidate.public_identity.device_id,
    candidate_key_id: candidate.public_identity.key_id,
    request_id: `req_${candidate.public_identity.device_id}`,
    created_at: createdAt,
  },
  approver,
);

const row = (handle, trustStatus, extra = {}) => ({
  ...handle.public_identity,
  trust_status: trustStatus,
  registered_at: at("2026-07-27T12:00:00.000Z"),
  approved_at: at("2026-07-27T12:00:00.000Z"),
  ...extra,
});

const signerApp = identity({ deviceId: "signer-app-device", source: "originrouter_app" });
const secondApp = identity({ deviceId: "second-app-device", source: "originrouter_app" });
const grandfatheredCli = identity({ deviceId: "grandfathered-cli-device", source: "originrouter_cli" });
const lateCli = identity({ deviceId: "late-cli-device", source: "originrouter_cli" });
const rotatingApp = rotated({
  deviceId: "rotating-app-device",
  source: "originrouter_app",
  rotatedAt: "2026-07-27T14:00:00.000Z",
});
const revokedRootApp = identity({ deviceId: "revoked-root-app-device", source: "originrouter_app" });
const admittedCli = identity({ deviceId: "admitted-cli-device", source: "originrouter_cli" });
const windowCli = identity({ deviceId: "window-cli-device", source: "originrouter_cli" });

const REVOKED_AT = at("2026-07-27T13:00:00.000Z");
const ROTATED_AT = at("2026-07-27T14:00:00.000Z");
// Signed after the approver was vouched for (12:00) and before the revocations
// below, so "revoked after signing" and "revoked before signing" are two
// genuinely different inputs rather than the same one under two names.
const POLICY_AT = "2026-07-27T12:30:00.000Z";
// The rotating App only becomes the policy signer once its successor key is
// current, so those two cases need a later acceptance time.
const ROTATING_POLICY_AT = at("2026-07-27T14:30:00.000Z");
// The two-hop chain cases. Both admissions land after the roots are trusted
// (12:00) and before anything is revoked (13:00), so what the chain cases
// exercise is depth -- not a signature that falls outside a trust window,
// which cases 2, 3 and 8 already cover.
const SECOND_APP_ADMITTED_AT = at("2026-07-27T12:45:00.000Z");
const LATE_CLI_ADMITTED_AT = at("2026-07-27T12:50:00.000Z");
// `admissionProof` signs an ISO `created_at` while `row` stamps an epoch
// `approved_at`; a case that quotes the same instant in both has to convert.
const iso = (epoch) => new Date(epoch * 1000).toISOString();

const verifiedPolicy = (approver, grandfathered, updatedAt = at(POLICY_AT)) => ({
  epoch: 1,
  new_device_approval_required: true,
  updated_at: updatedAt,
  created_at: at(POLICY_AT),
  policy_proof: policyProof(approver, grandfathered, POLICY_AT),
});

// Mirror `public_record` + `list_account_identity_chains` exactly.
//
// `public_record` reshapes the stored row into the protocol shape, and the two
// timestamps in it are not interchangeable:
//
//  - `created_at` is `key_created_at` — the ISO string the key generated and
//    signed. `key_created_at` is a VARCHAR column, so it round-trips verbatim
//    and stays inside the signed record. Overriding it invalidates the
//    self-signature and the whole device drops out of `verified` before trust
//    is evaluated, which looks like a trust bug and is not one.
//  - `registered_at` is the row's own `created_at`, an epoch int.
//
// `list_account_identity_chains` is what makes a superseded key awkward: it
// hard-clears `approved_at` and `approved_by_device_id` on every key except the
// bound one, and reports the key as `revoked`. So an old key never carries an
// approval timestamp, which is the case `wasTrustedAt` has to survive.
const rotatingRows = () => [
  {
    ...row(rotatingApp.first, "revoked"),
    registered_at: at("2026-07-27T11:00:00.000Z"),
    approved_by_device_id: null,
    approved_at: null,
    revoked_at: ROTATED_AT,
  },
  row(rotatingApp.next, "trusted"),
];

const cases = [
  {
    // The baseline both sides must still accept: a trusted signer, both roots
    // grandfathered, nothing revoked.
    name: "grandfathered_roots_accepted",
    expect: "accept",
    why: "A policy signed by a trusted App, with every root grandfathered, is the ordinary case.",
    directory: {
      policy: verifiedPolicy(signerApp, [signerApp.public_identity.key_id, grandfatheredCli.public_identity.key_id]),
      identities: [row(signerApp, "trusted"), row(grandfatheredCli, "trusted")],
    },
  },
  {
    // The divergence. `set_policy` freezes its proof and never re-signs it, so
    // revoking the signing device used to invalidate the whole directory on
    // the CLI while the App, which asks whether the signer was trusted *when it
    // signed*, kept serving it.
    name: "policy_signer_revoked_after_signing",
    expect: "accept",
    why: "A signature does not stop verifying because the signer was revoked later; only the signer's window at signing time matters.",
    directory: {
      policy: verifiedPolicy(signerApp, [signerApp.public_identity.key_id, grandfatheredCli.public_identity.key_id]),
      identities: [
        row(signerApp, "revoked", { revoked_at: REVOKED_AT }),
        row(grandfatheredCli, "trusted"),
      ],
    },
  },
  {
    // The guard that keeps the case above honest: revoking a signer does not
    // license a policy it signed while already revoked.
    name: "policy_signer_revoked_before_signing",
    expect: "reject",
    why: "A signer that was already revoked when it signed the policy carries no weight.",
    directory: {
      policy: verifiedPolicy(secondApp, [secondApp.public_identity.key_id], at("2026-07-27T15:00:00.000Z")),
      identities: [
        row(secondApp, "revoked", { revoked_at: REVOKED_AT }),
        row(grandfatheredCli, "trusted"),
      ],
    },
  },
  {
    name: "policy_signer_approved_after_signing",
    expect: "reject",
    why: "A signer that had not yet been vouched for when it signed cannot authorize a policy.",
    directory: {
      policy: verifiedPolicy(secondApp, [secondApp.public_identity.key_id], at("2026-07-27T12:30:00.000Z")),
      identities: [
        row(secondApp, "trusted", { approved_at: at("2026-07-27T14:00:00.000Z") }),
        row(grandfatheredCli, "trusted"),
      ],
    },
  },
  {
    name: "policy_signature_forged",
    expect: "reject",
    why: "The approver's signature is what makes the policy a policy; a tampered body must not verify.",
    directory: {
      policy: {
        ...verifiedPolicy(signerApp, [signerApp.public_identity.key_id, grandfatheredCli.public_identity.key_id]),
        policy_proof: {
          ...policyProof(signerApp, [signerApp.public_identity.key_id, grandfatheredCli.public_identity.key_id], POLICY_AT),
          grandfathered_key_ids: [signerApp.public_identity.key_id],
        },
      },
      identities: [row(signerApp, "trusted"), row(grandfatheredCli, "trusted")],
    },
  },
  {
    // The rotation window, with the approver still trusted throughout.
    name: "admission_signed_inside_rotation_window",
    expect: "accept",
    why: "A key that signed while it was still the device's current one keeps its approvals.",
    directory: {
      policy: verifiedPolicy(rotatingApp.next, [rotatingApp.next.public_identity.key_id], ROTATING_POLICY_AT),
      identities: [
        ...rotatingRows(),
        row(windowCli, "trusted", {
          approved_at: at("2026-07-27T13:00:00.000Z"),
          admission_proof: admissionProof(rotatingApp.first, windowCli, "2026-07-27T13:00:00.000Z"),
        }),
      ],
    },
  },
  {
    // The live path. `admission_proof` is hard-coded to `None` by the server, so
    // in production the only signature that gates a directory is the policy's —
    // which makes "the signing App rotated its key since it signed" a live way
    // to wedge, not a theoretical one. The App that signed the policy is the
    // one every device vouches for, so it is also the one most likely to rotate.
    name: "policy_signer_rotated_after_signing",
    expect: "accept",
    why: "Rotating a signing device's key leaves its old key as chain history with no approval timestamp; the signature it made while current still stands.",
    directory: {
      policy: verifiedPolicy(rotatingApp.first, [
        rotatingApp.next.public_identity.key_id,
        grandfatheredCli.public_identity.key_id,
      ]),
      identities: [
        ...rotatingRows(),
        row(grandfatheredCli, "trusted"),
      ],
    },
  },
  {
    name: "admission_signed_after_rotation",
    expect: "reject",
    why: "A superseded key keeps its signature forever, so without a window check it could keep admitting devices long after the device rotated past it.",
    directory: {
      policy: verifiedPolicy(rotatingApp.next, [rotatingApp.next.public_identity.key_id], ROTATING_POLICY_AT),
      identities: [
        ...rotatingRows(),
        row(windowCli, "trusted", {
          approved_at: at("2026-07-27T15:00:00.000Z"),
          admission_proof: admissionProof(rotatingApp.first, windowCli, "2026-07-27T15:00:00.000Z"),
        }),
      ],
    },
  },
  {
    name: "admitted_by_revoked_grandfathered_root",
    expect: "reject",
    why: "Skipping a revoked root keeps the rest of the directory usable, but the root must then anchor nothing — the device it admitted no longer resolves to a live root.",
    directory: {
      policy: verifiedPolicy(signerApp, [signerApp.public_identity.key_id, revokedRootApp.public_identity.key_id]),
      identities: [
        row(signerApp, "trusted"),
        row(revokedRootApp, "revoked", { revoked_at: REVOKED_AT }),
        row(admittedCli, "trusted", {
          admission_proof: admissionProof(revokedRootApp, admittedCli, "2026-07-27T15:00:00.000Z"),
        }),
      ],
    },
  },
  {
    name: "admitted_by_live_grandfathered_root",
    expect: "accept",
    why: "The counterpart: an admission from a root that is still trusted resolves, and its device joins the directory.",
    directory: {
      policy: verifiedPolicy(signerApp, [signerApp.public_identity.key_id]),
      identities: [
        row(signerApp, "trusted"),
        row(lateCli, "trusted", {
          admission_proof: admissionProof(signerApp, lateCli, "2026-07-27T15:00:00.000Z"),
        }),
      ],
    },
  },

  // ---- Lifecycle transitions -------------------------------------------------
  //
  // Everything above tests one decision at a time. These cover the transitions
  // a real account actually goes through, because the frozen root set makes
  // every one of them a distinct question about which row still anchors a
  // device.

  {
    // "A normal, old-key-authorized key rotation is not a new device"
    // (e2ee-device-transport.md:82). The snapshot was taken before the
    // rotation, so it can only ever name the *old* key -- production never
    // gets to list the successor, because `set_policy` re-signs only when the
    // user touches the switch. The root lookup therefore has to resolve a
    // grandfathered key to the device's *current head*, not require the
    // grandfathered key itself to still be trusted.
    name: "grandfathered_key_anchors_rotated_device",
    expect: "accept",
    why: "Rotation is not a new device: the snapshot names the pre-rotation key, and that key still anchors the device through its current head.",
    directory: {
      policy: verifiedPolicy(signerApp, [
        signerApp.public_identity.key_id,
        rotatingApp.first.public_identity.key_id,
        grandfatheredCli.public_identity.key_id,
      ]),
      identities: [
        row(signerApp, "trusted"),
        ...rotatingRows(),
        row(grandfatheredCli, "trusted"),
      ],
    },
  },
  {
    // What the user actually did: remove the MacBook from the App, re-login the
    // CLI, approve it by QR. `logout` does not regenerate the E2EE key, so the
    // same key_id comes back with an approval timestamp *later than the one
    // the snapshot froze*. A root must not be required to have been approved
    // before the policy.
    name: "reapproved_grandfathered_root",
    expect: "accept",
    why: "Removing and re-approving a device returns the same key, so it resolves through the snapshot it was always in.",
    directory: {
      policy: verifiedPolicy(signerApp, [
        signerApp.public_identity.key_id,
        lateCli.public_identity.key_id,
      ]),
      identities: [
        row(signerApp, "trusted"),
        row(lateCli, "trusted", {
          approved_at: at("2026-07-27T18:00:00.000Z"),
        }),
      ],
    },
  },
  {
    // One root revoked, the others untouched. The revoked key stays in the
    // frozen set forever, so the lookup has to skip it without the skip
    // reaching anything else.
    name: "one_revoked_root_among_live_ones",
    expect: "accept",
    why: "A revoked root contributes nothing but must not disturb the roots around it.",
    directory: {
      policy: verifiedPolicy(signerApp, [
        signerApp.public_identity.key_id,
        revokedRootApp.public_identity.key_id,
        grandfatheredCli.public_identity.key_id,
      ]),
      identities: [
        row(signerApp, "trusted"),
        row(revokedRootApp, "revoked", { revoked_at: REVOKED_AT }),
        row(grandfatheredCli, "trusted"),
      ],
    },
  },
  {
    // The snapshot names a key the server no longer serves at all. It must be
    // skipped rather than treated as a broken policy, or one pruned history
    // would wedge the account.
    name: "grandfathered_key_absent_from_directory",
    expect: "accept",
    why: "A root the directory no longer carries is skipped, not treated as a policy failure.",
    directory: {
      policy: verifiedPolicy(signerApp, [
        signerApp.public_identity.key_id,
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        grandfatheredCli.public_identity.key_id,
      ]),
      identities: [row(signerApp, "trusted"), row(grandfatheredCli, "trusted")],
    },
  },
  {
    // A device mid-enrollment sits in the directory as `pending`. Only
    // `trusted` heads are candidates for authorization, so a pending device
    // must not be able to fail the directory on its own.
    name: "pending_device_alongside_live_roots",
    expect: "accept",
    why: "A device awaiting approval is neither authorized nor unresolved.",
    directory: {
      policy: verifiedPolicy(signerApp, [signerApp.public_identity.key_id]),
      identities: [
        row(signerApp, "trusted"),
        row(windowCli, "pending", { approved_at: null }),
      ],
    },
  },
  {
    // The switch was never turned on, so there is no snapshot and no proof at
    // all -- the ordinary case for most accounts.
    name: "policy_disabled_needs_no_proof",
    expect: "accept",
    why: "With the gate off there is no admission graph to evaluate.",
    directory: {
      policy: { epoch: 1, new_device_approval_required: false },
      identities: [row(signerApp, "trusted"), row(lateCli, "trusted")],
    },
  },
  {
    // Same, after an explicit trust reset: the server writes
    // `policy_proof: None` together with `new_device_approval_required: False`
    // (device_e2ee_store.py:609). A stale proof left over from the previous
    // epoch must not be evaluated against the new one.
    name: "policy_reset_to_unsigned",
    expect: "accept",
    why: "An epoch reset clears the proof and the gate together; nothing is left to verify.",
    directory: {
      policy: { epoch: 2, new_device_approval_required: false },
      identities: [row(signerApp, "trusted"), row(lateCli, "trusted")],
    },
  },
  {
    // The App admits a device, then rotates its own key. The proof names the
    // App's pre-rotation key, which is now chain history with no approval
    // timestamp -- the case `wasTrustedAt` was wrong about.
    name: "admitted_by_app_that_then_rotated",
    expect: "accept",
    why: "An approval made while the App's key was current survives that App rotating afterwards.",
    directory: {
      policy: verifiedPolicy(signerApp, [
        signerApp.public_identity.key_id,
        rotatingApp.first.public_identity.key_id,
      ], ROTATING_POLICY_AT),
      identities: [
        row(signerApp, "trusted"),
        ...rotatingRows(),
        row(windowCli, "trusted", {
          approved_at: at("2026-07-27T13:00:00.000Z"),
          admission_proof: admissionProof(rotatingApp.first, windowCli, "2026-07-27T13:00:00.000Z"),
        }),
      ],
    },
  },
  {
    // Removing the approver retroactively de-authorizes what it admitted. The
    // admission check requires the approver to be in `authorizedDevices`, and a
    // revoked root is skipped when that set is built -- so the subtree goes
    // with it, transitively. This is deliberate ("keeps a revoked device from
    // re-authorizing anything through the admission chain below"), and it is
    // the reason removing an App can strand the devices it admitted.
    name: "admitted_then_approver_removed",
    expect: "reject",
    why: "An admission only counts while its approver is still an authorized root, so removing the App strands the device it admitted.",
    directory: {
      policy: verifiedPolicy(signerApp, [
        signerApp.public_identity.key_id,
        revokedRootApp.public_identity.key_id,
      ]),
      identities: [
        row(signerApp, "trusted"),
        row(revokedRootApp, "revoked", { revoked_at: REVOKED_AT }),
        row(lateCli, "trusted", {
          admission_proof: admissionProof(revokedRootApp, lateCli, "2026-07-27T13:00:00.000Z"),
        }),
      ],
    },
  },
  {
    // Depth two, which no other vector here reaches: `signerApp` is the only
    // grandfathered root, `secondApp` is admitted by it, and `lateCli` is
    // admitted by `secondApp`. Resolving `lateCli` takes two passes over the
    // edge set, so a verifier that walks the edges once and stops would pass
    // all eighteen vectors above this one and get this wrong. The fixpoint
    // loop is the only reason the two implementations agree here, and nothing
    // else in this file would notice it being replaced by a single pass.
    name: "chain_two_levels_accepted",
    expect: "accept",
    why: "Trust resolves transitively: a device approved by an App that was itself approved resolves too.",
    directory: {
      policy: verifiedPolicy(signerApp, [signerApp.public_identity.key_id]),
      identities: [
        row(signerApp, "trusted"),
        row(secondApp, "trusted", {
          approved_at: SECOND_APP_ADMITTED_AT,
          admission_proof: admissionProof(signerApp, secondApp, iso(SECOND_APP_ADMITTED_AT)),
        }),
        row(lateCli, "trusted", {
          approved_at: LATE_CLI_ADMITTED_AT,
          admission_proof: admissionProof(secondApp, lateCli, iso(LATE_CLI_ADMITTED_AT)),
        }),
      ],
    },
  },
  {
    // The same chain one hop deeper into the cascade, and the shape the App's
    // removal confirmation quotes: `secondApp` is gone, so `lateCli` loses
    // trust even though its own row never changed. Distinct from
    // `admitted_then_approver_removed` in that the removed device is not a
    // grandfathered root -- it was admitted like anything else, and removing it
    // costs exactly what removing a root costs.
    name: "chain_two_levels_middle_removed",
    expect: "reject",
    why: "Removing the middle of a chain costs the device below it its trust, two hops from the removal.",
    directory: {
      policy: verifiedPolicy(signerApp, [signerApp.public_identity.key_id]),
      identities: [
        row(signerApp, "trusted"),
        row(secondApp, "revoked", {
          approved_at: SECOND_APP_ADMITTED_AT,
          revoked_at: REVOKED_AT,
          admission_proof: admissionProof(signerApp, secondApp, iso(SECOND_APP_ADMITTED_AT)),
        }),
        row(lateCli, "trusted", {
          approved_at: LATE_CLI_ADMITTED_AT,
          admission_proof: admissionProof(secondApp, lateCli, iso(LATE_CLI_ADMITTED_AT)),
        }),
      ],
    },
  },
  {
    // The recovery, and the case that makes the two above tolerable to ship.
    // The stranded device is approved again by a root that is still authorized
    // and its row now carries that proof, which is what the server writes when
    // the approval lands. Nothing here resets the epoch or re-enrolls anyone:
    // a cascade costs trust, not the account, and one approval from a surviving
    // trusted device puts it back. Without this vector the suite only pins the
    // damage and never the repair.
    name: "cascade_recovers_by_reapproval",
    expect: "accept",
    why: "A stranded device is restored by one approval from a still-authorized root; no epoch reset is involved.",
    directory: {
      policy: verifiedPolicy(signerApp, [
        signerApp.public_identity.key_id,
        revokedRootApp.public_identity.key_id,
      ]),
      identities: [
        row(signerApp, "trusted"),
        row(revokedRootApp, "revoked", { revoked_at: REVOKED_AT }),
        row(lateCli, "trusted", {
          approved_at: at("2026-07-27T15:00:00.000Z"),
          admission_proof: admissionProof(signerApp, lateCli, "2026-07-27T15:00:00.000Z"),
        }),
      ],
    },
  },
];

const payload = {
  _comment: [
    "Shared trust-evaluation vectors. Both the Node and the Dart directory",
    "cache verifiers must return `expect` for each `directory`. Regenerate with",
    "scripts/generate-device-e2ee-trust-fixtures.mjs.",
  ],
  cases,
};

const target = process.argv[2]
  ?? fileURLToPath(new URL("../tests/fixtures/device_e2ee_trust_vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${cases.length} trust vectors to ${target}`);
