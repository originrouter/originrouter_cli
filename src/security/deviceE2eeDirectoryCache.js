import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  canonicalJson,
  verifyDeviceE2eeIdentity,
  verifyDeviceE2eeRotation,
} from "../crypto/deviceE2eeIdentity.js";
import { KEY_SOURCE } from "../runtime/authContract.js";

export const DEVICE_E2EE_DIRECTORY_REFRESH_MS = 15 * 60 * 1000;
export const DEVICE_E2EE_DIRECTORY_MAX_STALE_MS = 24 * 60 * 60 * 1000;
const FILE_MODE = 0o600;

function namespaceSuffix(namespace) {
  if (!namespace) return "";
  return `-${createHash("sha256").update(String(namespace)).digest("base64url").slice(0, 22)}`;
}

/**
 * The directory belongs to an account, not to one sign-in.
 *
 * Namespacing the cache by `sessionId` gave every `originrouter login` a cold
 * cache: the new session started with no pinned history, every device had to
 * be refetched before it could be addressed, and the abandoned files stayed on
 * disk holding contradictory views of the same account. Prefer the account
 * scope and keep `sessionId` only as a fallback for credentials recorded
 * before the scope was persisted.
 */
export function deviceE2eeDirectoryNamespace(credential) {
  const accountScope = credential?.accountScope;
  if (typeof accountScope === "string" && accountScope.trim()) {
    return `account:${accountScope.trim()}`;
  }
  const sessionId = credential?.sessionId;
  return typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim()
    : "";
}

export function deviceE2eeDirectoryCachePath(stateDir, { namespace } = {}) {
  return join(stateDir, `device-e2ee-directory-v2${namespaceSuffix(namespace)}.json`);
}

// The namespace migration only has to run once per process, but every entry
// point that reads the cache has to be behind it. Track it here so callers
// cannot disagree about whether it already happened.
const migratedStateDirs = new Set();

/**
 * Run the session-scoped to account-scoped migration once per state directory.
 *
 * Safe to call on every cache read: after the first call it is a set lookup.
 * Never throws — a failed migration only costs a directory refetch.
 */
export function ensureDeviceE2eeDirectoryCacheMigrated(stateDir, credential) {
  const namespace = deviceE2eeDirectoryNamespace(credential);
  if (!namespace.startsWith("account:")) return namespace;
  const key = `${stateDir}\u0000${namespace}`;
  if (migratedStateDirs.has(key)) return namespace;
  migratedStateDirs.add(key);
  try {
    adoptLegacyDeviceE2eeDirectoryCache(stateDir, { namespace });
  } catch {
    // Migration is an optimization: a refresh repopulates the cache anyway.
  }
  return namespace;
}

export function readDeviceE2eeDirectoryCache(stateDir, { namespace } = {}) {
  const path = deviceE2eeDirectoryCachePath(stateDir, { namespace });
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.schema !== 1 || !Array.isArray(value.identities)
      || !value.policy || !Number.isSafeInteger(value.policy.epoch)) {
    throw new Error("invalid E2EE directory cache");
  }
  return value;
}

/**
 * Carry a pre-existing session-scoped cache into the account namespace.
 *
 * Without this, moving the namespace from `sessionId` to the account scope
 * would start every client cold and discard the pinned key history — the same
 * history that lets a truncated chain be completed. Adopt the newest usable
 * session-scoped file once, then leave the stale files alone; they are no
 * longer consulted and can be cleaned up separately.
 *
 * The adopted file was written by this device and was verified when it was
 * stored, so this moves already-trusted state rather than importing anything
 * new. The highest epoch wins so the adoption cannot be used to walk the
 * account epoch backwards.
 */
export function adoptLegacyDeviceE2eeDirectoryCache(stateDir, {
  namespace,
  now = Date.now(),
  maxStaleMs = DEVICE_E2EE_DIRECTORY_MAX_STALE_MS,
} = {}) {
  if (!namespace || !namespace.startsWith("account:")) return null;
  const target = deviceE2eeDirectoryCachePath(stateDir, { namespace });
  let candidates;
  try {
    candidates = readdirSync(stateDir).filter((name) =>
      name.startsWith("device-e2ee-directory-v2-") && name.endsWith(".json"));
  } catch {
    return null;
  }
  const superseded = [];
  let best = null;
  for (const name of candidates) {
    const candidatePath = join(stateDir, name);
    if (candidatePath === target) continue;
    let value;
    try {
      value = JSON.parse(readFileSync(candidatePath, "utf8"));
    } catch {
      // Unreadable leftovers are removed too: nothing can consult them.
      superseded.push(candidatePath);
      continue;
    }
    superseded.push(candidatePath);
    if (value?.schema !== 1 || !Array.isArray(value.identities)
        || !Number.isSafeInteger(value?.policy?.epoch)) continue;
    if (!deviceE2eeDirectoryCacheState(value, { now, maxStaleMs }).usable) continue;
    const epoch = Number(value.policy.epoch);
    const fetchedAt = Date.parse(value.fetched_at) || 0;
    if (!best
        || epoch > best.epoch
        || (epoch === best.epoch && fetchedAt > best.fetchedAt)) {
      best = { value, epoch, fetchedAt };
    }
  }
  // Adopt only when the account namespace has nothing yet. An existing
  // account-scoped cache is already the authority and must not be overwritten
  // by an older session-scoped file.
  const adopted = best && !existsSync(target) ? best.value : null;
  if (adopted) writeCache(stateDir, adopted, { namespace });
  // Remove the session-scoped files once their content has been carried over.
  // They are never consulted again, and leaving them behind keeps
  // contradictory views of the same account on disk indefinitely.
  for (const path of superseded) {
    try {
      unlinkSync(path);
    } catch {
      // A file that cannot be removed is still unreachable; ignore it.
    }
  }
  return adopted;
}

function writeCache(stateDir, value, { namespace } = {}) {
  const path = deviceE2eeDirectoryCachePath(stateDir, { namespace });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: FILE_MODE });
  chmodSync(temporary, FILE_MODE);
  renameSync(temporary, path);
  chmodSync(path, FILE_MODE);
}

function sortedIdentities(directory) {
  return [...(directory?.identities || [])].sort((left, right) =>
    String(left.device_id).localeCompare(String(right.device_id))
      || Number(left.key_version) - Number(right.key_version));
}

function publicIdentityRecord(identity) {
  return {
    protocol: identity.protocol,
    device_id: identity.device_id,
    source: identity.source,
    epoch: identity.epoch,
    key_version: identity.key_version,
    signing_algorithm: identity.signing_algorithm,
    signing_public_key: identity.signing_public_key,
    agreement_algorithm: identity.agreement_algorithm,
    agreement_public_key: identity.agreement_public_key,
    previous_key_id: identity.previous_key_id ?? null,
    created_at: identity.created_at,
    key_id: identity.key_id,
    ...(identity.previous_key_signature
      ? { previous_key_signature: identity.previous_key_signature }
      : {}),
    self_signature: identity.self_signature,
  };
}

function verifyProof(proof, signer, domain) {
  if (!proof || typeof proof.signature !== "string") return false;
  const { signature, ...value } = proof;
  try {
    return verify(
      null,
      Buffer.from(`${domain}${canonicalJson(value)}`),
      createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: signer.signing_public_key,
        },
        format: "jwk",
      }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/**
 * Server timestamps arrive as epoch seconds; cached round-trips store ISO
 * strings. Normalize both to epoch milliseconds so comparisons never depend on
 * which representation a row happens to carry.
 */
function serverTime(value) {
  if (value === null || value === undefined || value === "" || value === 0) {
    return null;
  }
  if (typeof value === "number") return value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Was `signer` already trusted at `eventAt`?  A signature only carries weight
 * if the key that made it had already been vouched for when it was made, and it
 * stops counting from the moment that key is revoked or superseded — not from
 * the moment that is observed in the directory.
 *
 * Both ends of the window come from the row itself, and both had to be read off
 * `revoked_at` and the chain head rather than the more obvious fields:
 *
 *  - The end is `revoked_at`, which the server stamps on a key at the moment it
 *    is revoked *or* superseded by a rotation. The successor's `registered_at`
 *    looks like an alternative and is not: it carries the installation's
 *    binding time, which predates the rotation and so closes the window before
 *    it opens. Reading it that way made every signature by a superseded key
 *    unverifiable.
 *  - The start is the installation's approval. Only the bound key reports
 *    `approved_at`; the chain projection hard-clears it on every older key.
 */
function wasTrustedAt(signer, eventAt, identities) {
  if (signer.trust_status === "pending") return false;

  const chain = identities
    .filter((entry) => entry.device_id === signer.device_id
      && entry.source === signer.source
      && entry.epoch === signer.epoch)
    .sort((left, right) => (left.key_version ?? 0) - (right.key_version ?? 0));
  const signerIndex = chain.findIndex((entry) => entry.key_id === signer.key_id);
  if (signerIndex < 0) return false;

  // `list_account_identity_chains` hard-clears `approved_at` on every key
  // except the bound one, so a superseded key never carries one. Demanding it
  // anyway would mean that rotating a device's key retroactively invalidated
  // every signature that key ever made — including the policy every other
  // device vouches for — which wedges a perfectly healthy account until the
  // rotation is undone. The approval belongs to the installation, and the
  // bound key is the one row that still reports it, so fall back to the head.
  const approvedAt = serverTime(signer.approved_at)
    ?? serverTime(chain[chain.length - 1].approved_at);
  if (approvedAt === null || eventAt < approvedAt) return false;

  let inactiveAt = serverTime(signer.revoked_at);
  if (inactiveAt !== null && eventAt >= inactiveAt) return false;
  if (signerIndex === chain.length - 1) {
    // The chain head carries no successor, so its own trust status is the
    // only thing that can end its window — and "revoked" is a later state of
    // a key that was trusted until it was taken away.
    return signer.trust_status === "trusted" || signer.trust_status === "revoked";
  }
  return true;
}

function verifyTrustProofs(policy, identities) {
  const proof = policy.policy_proof;
  const grandfathered = proof?.grandfathered_key_ids;
  if (!proof && policy?.new_device_approval_required !== true) return;
  if (proof?.action !== "set_new_device_approval_required"
      || proof.account_epoch !== policy.epoch
      || proof.new_device_approval_required
        !== (policy.new_device_approval_required === true)
      || !Array.isArray(grandfathered)) {
    throw new Error("verified-device policy proof is missing or invalid");
  }
  const byKey = new Map(identities.map((item) => [item.key_id, item]));
  const policyApprover = byKey.get(proof.approver_key_id);
  // Ask whether the approver was trusted *when it signed*, not whether it is
  // trusted now. A signature does not stop verifying because the signer was
  // revoked afterwards, and `set_policy` freezes the proof rather than
  // re-signing it — so requiring present-tense trust means revoking any device
  // that ever signed the policy invalidates the entire directory, on this
  // side only. The App has always made the time-scoped check, so the two
  // halves disagreed about which devices exist and the CLI alone stopped
  // relaying. This is the same over-strict shape already handled for a revoked
  // grandfathered root below.
  const policyAcceptedAt = serverTime(policy.updated_at);
  if (!policyApprover || policyApprover.source !== KEY_SOURCE.ORIGINROUTER_APP
      || policyAcceptedAt === null
      || !wasTrustedAt(policyApprover, policyAcceptedAt, identities)
      || proof.device_id !== policyApprover.device_id
      || !verifyProof(proof, policyApprover, "originrouter/device-policy/v2\n")) {
    throw new Error("invalid verified-device policy signature");
  }
  if (policy.new_device_approval_required !== true) return;
  const chains = new Map();
  for (const identity of identities) {
    if (!chains.has(identity.device_id)) chains.set(identity.device_id, []);
    chains.get(identity.device_id).push(identity);
  }
  const grandfatheredSet = new Set(grandfathered.map(String));
  if (grandfatheredSet.size !== grandfathered.length) {
    throw new Error("duplicate grandfathered device key");
  }
  const authorizedDevices = new Set();
  for (const keyId of grandfatheredSet) {
    const identity = byKey.get(keyId);
    const head = identity ? chains.get(identity.device_id)?.at(-1) : null;
    // A grandfathered key is a historical record of what the approver
    // vouched for when the policy was set.  It stays in the signed list
    // forever, but an installation that is no longer trusted contributes
    // nothing as a trust root: skipping it here is what keeps a revoked
    // device from re-authorizing anything through the admission chain
    // below.  Demanding that every root is still trusted would instead let
    // removing one device invalidate the whole snapshot.
    if (!identity || !head || head.trust_status !== "trusted") continue;
    authorizedDevices.add(identity.device_id);
  }
  const unresolved = new Set(
    [...chains.entries()]
      .filter(([deviceId, chain]) =>
        chain.at(-1)?.trust_status === "trusted"
          && !authorizedDevices.has(deviceId))
      .map(([deviceId]) => deviceId),
  );
  let progressed = true;
  while (unresolved.size && progressed) {
    progressed = false;
    for (const deviceId of [...unresolved]) {
      const chain = chains.get(deviceId);
      const proofHolder = chain.at(-1)?.admission_proof ? chain.at(-1) : chain[0];
      const admission = proofHolder?.admission_proof;
      const approver = byKey.get(admission?.approver_key_id);
      const candidateMatches = chain.some((item) =>
        item.key_id === admission?.candidate_key_id);
      const proofAcceptedAt = serverTime(proofHolder?.approved_at);
      if (admission?.action !== "approve_device"
          || admission.account_epoch !== policy.epoch
          || admission.candidate_device_id !== deviceId
          || !candidateMatches
          || !approver
          || approver.source !== KEY_SOURCE.ORIGINROUTER_APP
          || admission.approver_device_id !== approver.device_id
          || proofAcceptedAt === null
          || !wasTrustedAt(approver, proofAcceptedAt, identities)
          || !authorizedDevices.has(approver.device_id)
          || !verifyProof(
            admission,
            approver,
            "originrouter/device-admission/v2\n",
          )) continue;
      authorizedDevices.add(deviceId);
      unresolved.delete(deviceId);
      progressed = true;
    }
  }
  if (unresolved.size) throw new Error("unverified trusted device in directory");
}

/**
 * Complete a truncated chain using key history this device already pinned.
 *
 * A directory that starts a device at key_version > 1 is not evidence of an
 * attack: the server may simply be serving only the currently bound key. The
 * pinned history is the authority here, because a previous fetch already
 * verified those keys and `verifyPinnedHistory` forbids them from changing.
 * Splicing them back in reconstructs a chain that can be verified in full,
 * which keeps a server-side omission from permanently wedging the client.
 *
 * Only keys whose key_id was pinned earlier are reused, so this can never
 * introduce key material the server did not previously vouch for.
 */
function splicePinnedHistory(identities, previous) {
  // Prefer the retained known set so history survives across refreshes even
  // for a device that is currently quarantined. Older caches only have
  // `identities`.
  const pinned = Array.isArray(previous?.known_identities)
      && previous.known_identities.length
    ? previous.known_identities
    : previous?.identities;
  if (!pinned?.length) return identities;
  const present = new Set(identities.map((item) => item.key_id));
  const byDevice = new Map();
  for (const identity of identities) {
    if (!byDevice.has(identity.device_id)) byDevice.set(identity.device_id, []);
    byDevice.get(identity.device_id).push(identity);
  }
  const restored = [];
  for (const [deviceId, chain] of byDevice) {
    const lowest = chain.reduce((left, right) =>
      Number(left.key_version) <= Number(right.key_version) ? left : right);
    if (Number(lowest.key_version) === 1 && lowest.previous_key_id == null) {
      continue;
    }
    const pinnedForDevice = pinned
      .filter((item) => item.device_id === deviceId
        && Number(item.key_version) < Number(lowest.key_version)
        && !present.has(item.key_id))
      .sort((left, right) => Number(left.key_version) - Number(right.key_version));
    restored.push(...pinnedForDevice);
  }
  if (!restored.length) return identities;
  return sortedIdentities({ identities: [...identities, ...restored] });
}

/**
 * Verify each device's chain independently.
 *
 * A single unverifiable device used to throw and reject the entire directory,
 * so one bad record made every other device unreachable. Isolate the failure
 * instead: the offending device is quarantined and reported in
 * `deviceStatus`, while every device that verifies stays usable. That is still
 * fail-closed for the device at fault — a quarantined device is never offered
 * as a peer — without taking the account down with it.
 *
 * Cryptographic failures are never tolerated. An invalid signature, a rotation
 * without a valid predecessor signature, or a mutated pinned key all keep the
 * device out of the trusted set.
 */
function verifyDirectory(directory, { previous = null } = {}) {
  const epoch = Number(directory?.policy?.epoch);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error("invalid E2EE directory epoch");
  }
  const received = sortedIdentities(directory);
  const keyIds = new Map();
  for (const identity of received) {
    const encoded = canonicalJson(publicIdentityRecord(identity));
    if (keyIds.has(identity.key_id) && keyIds.get(identity.key_id) !== encoded) {
      // A key id that resolves to two different records breaks the identity
      // of every chain that references it, so this stays fatal.
      throw new Error("directory key id collision");
    }
    keyIds.set(identity.key_id, encoded);
  }
  const spliced = splicePinnedHistory(received, previous);
  const identities = spliced;
  const chains = new Map();
  for (const identity of identities) {
    if (!chains.has(identity.device_id)) chains.set(identity.device_id, []);
    chains.get(identity.device_id).push(identity);
  }
  const deviceStatus = new Map();
  const verified = [];
  for (const [deviceId, chain] of chains) {
    let reason = "";
    for (let index = 0; index < chain.length; index += 1) {
      const identity = chain[index];
      if (index === 0) {
        if (Number(identity.key_version) !== 1 || identity.previous_key_id != null) {
          reason = "incomplete_key_chain";
          break;
        }
        if (!verifyDeviceE2eeIdentity(identity)) {
          reason = "invalid_identity_signature";
          break;
        }
        continue;
      }
      const prior = chain[index - 1];
      if (!verifyDeviceE2eeRotation(prior, identity)
          && !verifyRecoveryTransition(prior, identity)) {
        reason = "invalid_key_rotation";
        break;
      }
    }
    deviceStatus.set(deviceId, reason ? { usable: false, reason } : { usable: true, reason: "" });
    if (!reason) verified.push(...chain);
  }
  // Trust proofs are account-wide. Evaluate them over the devices that
  // verified so one quarantined device cannot invalidate the whole policy,
  // and keep a proof failure fatal because it governs the account itself.
  verifyTrustProofs(directory.policy, verified);
  return {
    policy: directory.policy,
    // Addressable peers: verified chains only, quarantined devices removed.
    identities: verified,
    // The head must describe exactly what the server served, before any local
    // splicing or quarantine. Peers compare heads across implementations, so
    // it can only agree if every client derives it from the same input.
    receivedIdentities: received,
    // Served keys plus history restored from the previous pin. Pinned-history
    // continuity is checked against this, so a key the server stopped serving
    // is retained rather than being reported as removed.
    knownIdentities: spliced,
    deviceStatus: Object.fromEntries(deviceStatus),
  };
}

// Account-key recovery is the one intentional break in the signed rotation
// chain.  The previous private key is unavailable, so the server accepts a
// self-signed replacement after an authenticated recovery flow and revokes
// the old head.  Once that replacement exists, all subsequent rotations must
// again carry a previous-key signature and are checked by
// verifyDeviceE2eeRotation above.
function verifyRecoveryTransition(previous, next) {
  return previous?.trust_status === "revoked"
    && next?.device_id === previous.device_id
    && next?.source === previous.source
    && Number(next?.key_version) === Number(previous.key_version) + 1
    && next?.previous_key_id === previous.key_id
    && !next?.previous_key_signature
    && verifyDeviceE2eeIdentity(next);
}

function verifyPinnedHistory(previous, next) {
  const nextByKey = new Map(next.identities.map((item) => [item.key_id, item]));
  for (const pinned of previous.identities) {
    const replacement = nextByKey.get(pinned.key_id);
    if (!replacement
        || canonicalJson(publicIdentityRecord(replacement))
          !== canonicalJson(publicIdentityRecord(pinned))) {
      throw new Error("pinned E2EE key history was removed or changed");
    }
  }
}

function verifyPolicyTransition(previous, next) {
  if ((previous?.policy?.new_device_approval_required === true)
      === (next?.policy?.new_device_approval_required === true)) return;
  if (!next?.policy?.policy_proof) {
    throw new Error("unsigned verified-device policy change");
  }
  const signerKeyId = next.policy.policy_proof.approver_key_id;
  const nextSigner = next.identities.find((item) => item.key_id === signerKeyId);
  const previouslyTrustedApp = nextSigner
    && previous.identities.some((item) =>
      item.device_id === nextSigner.device_id
        && item.source === KEY_SOURCE.ORIGINROUTER_APP
        && item.trust_status === "trusted");
  if (!previouslyTrustedApp) {
    throw new Error("verified-device policy signer was not previously trusted");
  }
  const previousCreatedAt = Date.parse(
    previous?.policy?.policy_proof?.created_at || "",
  );
  const nextCreatedAt = Date.parse(next.policy.policy_proof.created_at || "");
  if (!Number.isFinite(nextCreatedAt)
      || (Number.isFinite(previousCreatedAt) && nextCreatedAt <= previousCreatedAt)) {
    throw new Error("verified-device policy proof replay");
  }
}

export function storeDeviceE2eeDirectoryCache(stateDir, directory, {
  now = new Date(),
  namespace,
} = {}) {
  const previous = readDeviceE2eeDirectoryCache(stateDir, { namespace });
  const verified = verifyDirectory(directory, { previous });
  if (previous && verified.policy.epoch < previous.policy.epoch) {
    throw new Error("E2EE account epoch rollback");
  }
  if (previous && verified.policy.epoch === previous.policy.epoch) {
    // Compare against what the server served, not the post-quarantine set.
    // A quarantined device must not read as "history removed", and a genuinely
    // mutated pinned key must still be fatal.
    verifyPinnedHistory(previous, {
      identities: verified.knownIdentities,
    });
    verifyPolicyTransition(previous, verified);
  }
  const value = {
    schema: 1,
    fetched_at: now.toISOString(),
    policy: verified.policy,
    identities: verified.identities,
    // Retained so the directory head stays byte-identical to the served
    // directory.
    received_identities: verified.receivedIdentities,
    // Retained so a later fetch can still splice history the server has
    // stopped serving, including for a quarantined device that is absent from
    // `identities`.
    known_identities: verified.knownIdentities,
    device_status: verified.deviceStatus,
  };
  writeCache(stateDir, value, { namespace });
  return value;
}

export function deviceE2eeDirectoryCacheState(cache, {
  now = Date.now(),
  refreshAfterMs = DEVICE_E2EE_DIRECTORY_REFRESH_MS,
  maxStaleMs = DEVICE_E2EE_DIRECTORY_MAX_STALE_MS,
} = {}) {
  if (!cache) return { fresh: false, usable: false, ageMs: Infinity };
  const fetchedAt = Date.parse(cache.fetched_at);
  if (!Number.isFinite(fetchedAt)) return { fresh: false, usable: false, ageMs: Infinity };
  const ageMs = Math.max(0, Number(now) - fetchedAt);
  return {
    ageMs,
    fresh: ageMs <= refreshAfterMs,
    usable: ageMs <= maxStaleMs,
  };
}

export function currentCachedDeviceIdentity(cache, deviceId) {
  // `identities` already excludes quarantined devices, so a device whose chain
  // failed verification is never returned as an addressable peer.
  return (cache?.identities || [])
    .filter((item) => item.device_id === deviceId)
    .sort((left, right) => right.key_version - left.key_version)[0] || null;
}

/**
 * Why a device is unusable, when it is. Lets callers report the specific cause
 * instead of a generic "peer unavailable", and lets them distinguish a
 * quarantined device from one that is simply absent from the directory.
 */
export function cachedDeviceStatus(cache, deviceId) {
  const status = cache?.device_status?.[String(deviceId)];
  if (status) return status;
  const known = (cache?.identities || [])
    .some((item) => item.device_id === deviceId);
  return known ? { usable: true, reason: "" } : { usable: false, reason: "unknown_device" };
}

export function quarantinedDeviceIds(cache) {
  return Object.entries(cache?.device_status || {})
    .filter(([, status]) => status?.usable === false)
    .map(([deviceId]) => deviceId);
}

export function deviceE2eeDirectoryHead(cache) {
  if (!cache?.policy || !Array.isArray(cache.identities)) return null;
  // Prefer the served set so the head matches every other implementation's
  // view of the same directory. Older caches predate this field and fall back
  // to their verified identities, which were the served set at the time.
  const source = Array.isArray(cache.received_identities)
    ? { identities: cache.received_identities }
    : cache;
  const identities = sortedIdentities(source).map((identity) => ({
    protocol: identity.protocol,
    device_id: identity.device_id,
    source: identity.source,
    epoch: identity.epoch,
    key_version: identity.key_version,
    signing_algorithm: identity.signing_algorithm,
    signing_public_key: identity.signing_public_key,
    agreement_algorithm: identity.agreement_algorithm,
    agreement_public_key: identity.agreement_public_key,
    previous_key_id: identity.previous_key_id ?? null,
    created_at: identity.created_at,
    key_id: identity.key_id,
    previous_key_signature: identity.previous_key_signature ?? null,
    self_signature: identity.self_signature,
    trust_status: identity.trust_status,
    ...(identity.admission_proof
      ? { admission_proof: identity.admission_proof }
      : {}),
  }));
  return `sha256:${createHash("sha256").update(canonicalJson({
    epoch: cache.policy.epoch,
    new_device_approval_required:
      cache.policy.new_device_approval_required === true,
    ...(cache.policy.policy_proof
      ? { policy_proof: cache.policy.policy_proof }
      : {}),
    identities,
  })).digest("base64url")}`;
}
