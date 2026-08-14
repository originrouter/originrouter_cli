import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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

export function deviceE2eeDirectoryCachePath(stateDir, { namespace } = {}) {
  return join(stateDir, `device-e2ee-directory-v2${namespaceSuffix(namespace)}.json`);
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
  if (!policyApprover || policyApprover.source !== KEY_SOURCE.ORIGINROUTER_APP
      || policyApprover.trust_status !== "trusted"
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
    if (!identity || head?.trust_status !== "trusted") {
      throw new Error("unknown grandfathered device key");
    }
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
      const admission = chain.at(-1)?.admission_proof
        || chain[0]?.admission_proof;
      const approver = byKey.get(admission?.approver_key_id);
      const candidateMatches = chain.some((item) =>
        item.key_id === admission?.candidate_key_id);
      if (admission?.action !== "approve_device"
          || admission.account_epoch !== policy.epoch
          || admission.candidate_device_id !== deviceId
          || !candidateMatches
          || !approver
          || approver.source !== KEY_SOURCE.ORIGINROUTER_APP
          || admission.approver_device_id !== approver.device_id
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

function verifyDirectory(directory) {
  const epoch = Number(directory?.policy?.epoch);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error("invalid E2EE directory epoch");
  }
  const heads = new Map();
  const keyIds = new Map();
  const identities = sortedIdentities(directory);
  for (const identity of identities) {
    if (identity.epoch !== epoch) throw new Error("directory identity epoch mismatch");
    const encoded = canonicalJson(publicIdentityRecord(identity));
    if (keyIds.has(identity.key_id) && keyIds.get(identity.key_id) !== encoded) {
      throw new Error("directory key id collision");
    }
    keyIds.set(identity.key_id, encoded);
    const previous = heads.get(identity.device_id);
    if (!previous) {
      if (identity.key_version !== 1 || identity.previous_key_id != null
          || !verifyDeviceE2eeIdentity(identity)) {
        throw new Error("invalid initial directory identity");
      }
    } else if (!verifyDeviceE2eeRotation(previous, identity)) {
      throw new Error("invalid directory key rotation");
    }
    heads.set(identity.device_id, identity);
  }
  verifyTrustProofs(directory.policy, identities);
  return { policy: directory.policy, identities };
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
  const verified = verifyDirectory(directory);
  if (previous && verified.policy.epoch < previous.policy.epoch) {
    throw new Error("E2EE account epoch rollback");
  }
  if (previous && verified.policy.epoch === previous.policy.epoch) {
    verifyPinnedHistory(previous, verified);
    verifyPolicyTransition(previous, verified);
  }
  const value = {
    schema: 1,
    fetched_at: now.toISOString(),
    policy: verified.policy,
    identities: verified.identities,
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
  return (cache?.identities || [])
    .filter((item) => item.device_id === deviceId)
    .sort((left, right) => right.key_version - left.key_version)[0] || null;
}

export function deviceE2eeDirectoryHead(cache) {
  if (!cache?.policy || !Array.isArray(cache.identities)) return null;
  const identities = sortedIdentities(cache).map((identity) => ({
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
