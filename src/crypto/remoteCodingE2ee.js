import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REMOTE_CODING_E2EE_PROTOCOL = "e2ee-v1";

function identityPath(stateDir) {
  return join(stateDir, "remote-coding-e2ee.json");
}

function peerKeysPath(stateDir) {
  return join(stateDir, "remote-coding-peer-keys.json");
}

function publicKeyFromBase64(value) {
  return createPublicKey({
    key: Buffer.from(String(value || ""), "base64"),
    format: "der",
    type: "spki",
  });
}

function privateKeyFromBase64(value) {
  return createPrivateKey({
    key: Buffer.from(String(value || ""), "base64"),
    format: "der",
    type: "pkcs8",
  });
}

function exportPublicKey(key) {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

function exportPrivateKey(key) {
  return key.export({ format: "der", type: "pkcs8" }).toString("base64");
}

export function generateRemoteCodingIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    version: 1,
    algorithm: "X25519",
    publicKey: exportPublicKey(publicKey),
    privateKey: exportPrivateKey(privateKey),
  };
}

export function ensureRemoteCodingIdentity(stateDir) {
  const path = identityPath(stateDir);
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.publicKey && parsed?.privateKey) return parsed;
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const identity = generateRemoteCodingIdentity();
  writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

export function verifyAndPinRemotePublicKey(stateDir, deviceId, publicKey) {
  const path = peerKeysPath(stateDir);
  let peers = {};
  if (existsSync(path)) {
    try { peers = JSON.parse(readFileSync(path, "utf8")) || {}; } catch { peers = {}; }
  }
  const key = String(publicKey || "");
  const pinned = peers[deviceId];
  if (pinned && pinned !== key) {
    throw Object.assign(
      new Error(
        `target device encryption key changed; refusing possible relay key substitution. `
        + `Verify the device, then remove its entry from ${path} to trust the new key.`,
      ),
      { code: "e2ee_key_mismatch" },
    );
  }
  if (!pinned) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    peers[deviceId] = key;
    writeFileSync(path, `${JSON.stringify(peers, null, 2)}\n`, { mode: 0o600 });
  }
  return key;
}

function deriveKeys(sharedSecret, requestId, sourceDeviceId, targetDeviceId) {
  const salt = Buffer.from(
    `${REMOTE_CODING_E2EE_PROTOCOL}\n${sourceDeviceId}\n${targetDeviceId}\n${requestId}`,
    "utf8",
  );
  return {
    requestKey: Buffer.from(hkdfSync(
      "sha256",
      sharedSecret,
      salt,
      Buffer.from("originrouter remote coding request", "utf8"),
      32,
    )),
    responseKey: Buffer.from(hkdfSync(
      "sha256",
      sharedSecret,
      salt,
      Buffer.from("originrouter remote coding response", "utf8"),
      32,
    )),
  };
}

function aad({ type, sourceDeviceId, targetDeviceId, requestId, direction, sequence }) {
  return Buffer.from([
    REMOTE_CODING_E2EE_PROTOCOL,
    type,
    sourceDeviceId,
    targetDeviceId,
    requestId,
    direction,
    String(sequence),
  ].join("\n"), "utf8");
}

function sealJson(key, metadata, payload) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(metadata));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function openJson(key, metadata, nonceValue, ciphertextValue) {
  const nonce = Buffer.from(String(nonceValue || ""), "base64");
  const ciphertextAndTag = Buffer.from(String(ciphertextValue || ""), "base64");
  if (nonce.length !== 12 || ciphertextAndTag.length < 17) {
    throw Object.assign(new Error("invalid encrypted payload"), { code: "e2ee_invalid_envelope" });
  }
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad(metadata));
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw Object.assign(new Error("encrypted payload authentication failed"), { code: "e2ee_auth_failed" });
  }
  try {
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw Object.assign(new Error("encrypted payload is not valid JSON"), { code: "e2ee_invalid_payload" });
  }
}

export function encryptRemoteCodingRequest({
  sourceDeviceId,
  targetDeviceId,
  requestId,
  targetPublicKey,
  payload,
}) {
  const ephemeral = generateKeyPairSync("x25519");
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKeyFromBase64(targetPublicKey),
  });
  const keys = deriveKeys(sharedSecret, requestId, sourceDeviceId, targetDeviceId);
  const metadata = {
    type: "remote.coding.request",
    sourceDeviceId,
    targetDeviceId,
    requestId,
    direction: "request",
    sequence: 0,
  };
  const sealed = sealJson(keys.requestKey, metadata, payload);
  return {
    envelope: {
      type: metadata.type,
      protocol: REMOTE_CODING_E2EE_PROTOCOL,
      requestId,
      sourceDeviceId,
      targetDeviceId,
      sequence: 0,
      ephemeralPublicKey: exportPublicKey(ephemeral.publicKey),
      ...sealed,
    },
    context: {
      protocol: REMOTE_CODING_E2EE_PROTOCOL,
      requestId,
      sourceDeviceId,
      targetDeviceId,
      responseKey: keys.responseKey,
      nextResponseSequence: 0,
    },
  };
}

export function decryptRemoteCodingRequest(envelope, identity) {
  if (envelope?.protocol !== REMOTE_CODING_E2EE_PROTOCOL) {
    throw Object.assign(new Error("unsupported encryption protocol"), { code: "e2ee_unsupported" });
  }
  const sourceDeviceId = String(envelope.sourceDeviceId || "");
  const targetDeviceId = String(envelope.targetDeviceId || "");
  const requestId = String(envelope.requestId || "");
  const sharedSecret = diffieHellman({
    privateKey: privateKeyFromBase64(identity?.privateKey),
    publicKey: publicKeyFromBase64(envelope.ephemeralPublicKey),
  });
  const keys = deriveKeys(sharedSecret, requestId, sourceDeviceId, targetDeviceId);
  const metadata = {
    type: "remote.coding.request",
    sourceDeviceId,
    targetDeviceId,
    requestId,
    direction: "request",
    sequence: 0,
  };
  return {
    payload: openJson(keys.requestKey, metadata, envelope.nonce, envelope.ciphertext),
    context: {
      protocol: REMOTE_CODING_E2EE_PROTOCOL,
      requestId,
      sourceDeviceId,
      targetDeviceId,
      responseKey: keys.responseKey,
      nextResponseSequence: 0,
    },
  };
}

export function encryptRemoteCodingResponse(context, type, payload) {
  const sequence = context.nextResponseSequence++;
  const metadata = {
    type,
    sourceDeviceId: context.sourceDeviceId,
    targetDeviceId: context.targetDeviceId,
    requestId: context.requestId,
    direction: "response",
    sequence,
  };
  return {
    type,
    protocol: REMOTE_CODING_E2EE_PROTOCOL,
    requestId: context.requestId,
    sourceDeviceId: context.targetDeviceId,
    targetDeviceId: context.sourceDeviceId,
    sequence,
    ...sealJson(context.responseKey, metadata, payload),
  };
}

export function decryptRemoteCodingResponse(context, envelope) {
  if (envelope?.protocol !== REMOTE_CODING_E2EE_PROTOCOL) {
    throw Object.assign(new Error("unencrypted response for encrypted request"), { code: "e2ee_downgrade_rejected" });
  }
  const sequence = Number(envelope.sequence);
  if (!Number.isSafeInteger(sequence) || sequence !== context.nextResponseSequence) {
    throw Object.assign(new Error("encrypted response sequence mismatch"), { code: "e2ee_replay_detected" });
  }
  const type = String(envelope.type || "");
  const metadata = {
    type,
    sourceDeviceId: context.sourceDeviceId,
    targetDeviceId: context.targetDeviceId,
    requestId: context.requestId,
    direction: "response",
    sequence,
  };
  const payload = openJson(
    context.responseKey,
    metadata,
    envelope.nonce,
    envelope.ciphertext,
  );
  context.nextResponseSequence += 1;
  return { type, requestId: context.requestId, ...payload };
}
