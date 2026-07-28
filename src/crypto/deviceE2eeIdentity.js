import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const DEVICE_E2EE_PROTOCOL = "originrouter-device-e2ee-v2";
const IDENTITY_DOMAIN = "originrouter/device-identity/v2\n";
const ROTATION_DOMAIN = "originrouter/device-key-rotation/v2\n";
const ENROLLMENT_DOMAIN = "originrouter/device-login/v2\n";
const FILE_MODE = 0o600;

function identityPath(stateDir) {
  return join(stateDir, "device-e2ee-v2.json");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean"
      || Number.isSafeInteger(value)) return value;
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function keyMaterial(record) {
  return {
    protocol: DEVICE_E2EE_PROTOCOL,
    device_id: record.device_id,
    source: record.source,
    epoch: record.epoch,
    key_version: record.key_version,
    signing_algorithm: "Ed25519",
    signing_public_key: record.signing_public_key,
    agreement_algorithm: "X25519",
    agreement_public_key: record.agreement_public_key,
    previous_key_id: record.previous_key_id ?? null,
    created_at: record.created_at,
  };
}

function signedIdentity(record) {
  return {
    ...keyMaterial(record),
    key_id: record.key_id,
    ...(record.previous_key_signature
      ? { previous_key_signature: record.previous_key_signature }
      : {}),
  };
}

function keyId(record) {
  return `sha256:${createHash("sha256").update(canonicalJson(keyMaterial(record))).digest("base64url")}`;
}

function exportJwk(key) {
  return key.export({ format: "jwk" });
}

function publicValue(jwk) {
  if (typeof jwk?.x !== "string" || !jwk.x) throw new Error("invalid public JWK");
  return jwk.x;
}

function writePrivate(path, value) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: FILE_MODE });
  chmodSync(temporary, FILE_MODE);
  renameSync(temporary, path);
  chmodSync(path, FILE_MODE);
}

function generateIdentity({ deviceId, epoch, keyVersion, previous = null, now = new Date() }) {
  const signing = generateKeyPairSync("ed25519");
  const agreement = generateKeyPairSync("x25519");
  const signingPrivateJwk = exportJwk(signing.privateKey);
  const agreementPrivateJwk = exportJwk(agreement.privateKey);
  const base = {
    protocol: DEVICE_E2EE_PROTOCOL,
    device_id: String(deviceId),
    source: "originrouter_cli",
    epoch: Number(epoch),
    key_version: Number(keyVersion),
    signing_algorithm: "Ed25519",
    signing_public_key: publicValue(exportJwk(signing.publicKey)),
    agreement_algorithm: "X25519",
    agreement_public_key: publicValue(exportJwk(agreement.publicKey)),
    previous_key_id: previous?.public_identity?.key_id ?? null,
    created_at: now.toISOString(),
  };
  base.key_id = keyId(base);
  if (previous) {
    const transition = { ...keyMaterial(base), key_id: base.key_id };
    base.previous_key_signature = sign(
      null,
      Buffer.from(`${ROTATION_DOMAIN}${canonicalJson(transition)}`),
      createPrivateKey({ key: previous.signing_private_jwk, format: "jwk" }),
    ).toString("base64url");
  }
  const publicIdentity = {
    ...base,
    self_signature: sign(
      null,
      Buffer.from(`${IDENTITY_DOMAIN}${canonicalJson(signedIdentity(base))}`),
      signing.privateKey,
    ).toString("base64url"),
  };
  return {
    public_identity: publicIdentity,
    signing_private_jwk: signingPrivateJwk,
    agreement_private_jwk: agreementPrivateJwk,
  };
}

export function readDeviceE2eeIdentity(stateDir) {
  const path = identityPath(stateDir);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed?.public_identity?.protocol !== DEVICE_E2EE_PROTOCOL) {
    throw new Error("unsupported stored device E2EE identity");
  }
  return parsed;
}

export function ensureDeviceE2eeIdentity(stateDir, { deviceId, epoch = 1 } = {}) {
  const existing = readDeviceE2eeIdentity(stateDir);
  if (existing) {
    if (existing.public_identity.device_id !== deviceId) {
      throw new Error("stored device E2EE identity belongs to another device");
    }
    if (existing.public_identity.epoch !== epoch) {
      throw new Error("stored device E2EE identity belongs to another account epoch");
    }
    return existing;
  }
  const created = generateIdentity({ deviceId, epoch, keyVersion: 1 });
  writePrivate(identityPath(stateDir), created);
  return created;
}

export function prepareDeviceE2eeRotation(stateDir, { deviceId, now = new Date() } = {}) {
  const previous = readDeviceE2eeIdentity(stateDir);
  if (!previous) throw new Error("device E2EE identity is not initialized");
  if (previous.public_identity.device_id !== deviceId) {
    throw new Error("stored device E2EE identity belongs to another device");
  }
  const next = generateIdentity({
    deviceId,
    epoch: previous.public_identity.epoch,
    keyVersion: previous.public_identity.key_version + 1,
    previous,
    now,
  });
  return {
    previous,
    next,
    commit() {
      writePrivate(identityPath(stateDir), next);
      return next;
    },
  };
}

export function signDeviceE2eeEnrollment(identity, enrollmentChallenge) {
  const challenge = String(enrollmentChallenge || "").trim();
  if (!challenge.startsWith("or_ch_")) {
    throw new Error("invalid device E2EE enrollment challenge");
  }
  const publicIdentity = identity?.public_identity;
  if (!publicIdentity || !verifyDeviceE2eeIdentity(publicIdentity)) {
    throw new Error("invalid device E2EE identity");
  }
  const value = {
    protocol: DEVICE_E2EE_PROTOCOL,
    device_id: publicIdentity.device_id,
    source: publicIdentity.source,
    key_id: publicIdentity.key_id,
    enrollment_challenge: challenge,
  };
  return sign(
    null,
    Buffer.from(`${ENROLLMENT_DOMAIN}${canonicalJson(value)}`),
    createPrivateKey({ key: identity.signing_private_jwk, format: "jwk" }),
  ).toString("base64url");
}

export function resetDeviceE2eeIdentityForEpoch(
  stateDir,
  { deviceId, epoch, now = new Date() } = {},
) {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error("invalid device E2EE account epoch");
  }
  const created = generateIdentity({
    deviceId,
    epoch,
    keyVersion: 1,
    now,
  });
  writePrivate(identityPath(stateDir), created);
  return created;
}

export function verifyDeviceE2eeIdentity(record) {
  if (record?.protocol !== DEVICE_E2EE_PROTOCOL || record.key_id !== keyId(record)) return false;
  return verify(
    null,
    Buffer.from(`${IDENTITY_DOMAIN}${canonicalJson(signedIdentity(record))}`),
    createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: record.signing_public_key,
      },
      format: "jwk",
    }),
    Buffer.from(record.self_signature, "base64url"),
  );
}

export function verifyDeviceE2eeRotation(previous, next) {
  if (!previous || !next
      || previous.device_id !== next.device_id
      || previous.source !== next.source
      || previous.epoch !== next.epoch
      || next.key_version !== previous.key_version + 1
      || next.previous_key_id !== previous.key_id
      || typeof next.previous_key_signature !== "string"
      || !verifyDeviceE2eeIdentity(next)) return false;
  const transition = { ...keyMaterial(next), key_id: next.key_id };
  return verify(
    null,
    Buffer.from(`${ROTATION_DOMAIN}${canonicalJson(transition)}`),
    createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: previous.signing_public_key,
      },
      format: "jwk",
    }),
    Buffer.from(next.previous_key_signature, "base64url"),
  );
}

export function deviceE2eeIdentityPath(stateDir) {
  return identityPath(stateDir);
}
