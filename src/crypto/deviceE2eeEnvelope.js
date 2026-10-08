import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

import { canonicalJson } from "./deviceE2eeIdentity.js";

export const DEVICE_E2EE_ENVELOPE_PROTOCOL = "e2ee-v2";
const ENVELOPE_DOMAIN = "originrouter/device-envelope/v2\n";

function publicKey(crv, x) {
  return createPublicKey({ key: { kty: "OKP", crv, x }, format: "jwk" });
}

function privateKey(jwk) {
  return createPrivateKey({ key: jwk, format: "jwk" });
}

function header(envelope) {
  return {
    type: envelope.type,
    protocol: DEVICE_E2EE_ENVELOPE_PROTOCOL,
    source_device_id: envelope.source_device_id,
    target_device_id: envelope.target_device_id,
    sender_key_id: envelope.sender_key_id,
    recipient_key_id: envelope.recipient_key_id,
    epoch: envelope.epoch,
    session_id: envelope.session_id,
    direction: envelope.direction,
    sequence: envelope.sequence,
    routing: envelope.routing || {},
    ephemeral_public_key: envelope.ephemeral_public_key,
  };
}

function signedEnvelope(envelope) {
  return {
    ...header(envelope),
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
  };
}

function validatePeers(local, peer) {
  if (local.public_identity.device_id === peer.device_id) {
    throw new Error("invalid E2EE session peers");
  }
}

function deriveKeys({
  shared,
  sourceDeviceId,
  targetDeviceId,
  sourceKeyId,
  targetKeyId,
  epoch,
  sessionId,
  ephemeralPublicKey,
}) {
  const context = {
    protocol: DEVICE_E2EE_ENVELOPE_PROTOCOL,
    source_device_id: sourceDeviceId,
    target_device_id: targetDeviceId,
    source_key_id: sourceKeyId,
    target_key_id: targetKeyId,
    epoch,
    session_id: sessionId,
    ephemeral_public_key: ephemeralPublicKey,
  };
  const salt = createHash("sha256").update(canonicalJson(context)).digest();
  const expanded = Buffer.from(hkdfSync(
    "sha256",
    shared,
    salt,
    Buffer.from("originrouter/device-session/v2"),
    64,
  ));
  return {
    requestKey: expanded.subarray(0, 32),
    responseKey: expanded.subarray(32, 64),
  };
}

function verifyEnvelope(envelope, peer) {
  const valid = verify(
    null,
    Buffer.from(`${ENVELOPE_DOMAIN}${canonicalJson(signedEnvelope(envelope))}`),
    publicKey("Ed25519", peer.signing_public_key),
    Buffer.from(envelope.signature, "base64url"),
  );
  if (!valid) throw new Error("invalid E2EE envelope signature");
}

/**
 * A sender-side group session: one symmetric key, many recipients.
 *
 * The pairwise design binds `target_device_id` into the HKDF context, so a
 * pairwise key is readable by exactly one device by construction. That is the
 * right default for request/response traffic but it forces live events — which
 * are one publish to N viewers — into N encryptions.
 *
 * This class keeps everything the receiver must still be able to check and
 * changes only what made the fan-out necessary:
 *
 *  * the Ed25519 signature is unchanged, so a recipient still learns exactly
 *    which device authored the event;
 *  * the AEAD is unchanged (ChaCha20-Poly1305, same AAD, same canonical
 *    encoding), so the code paths stay comparable;
 *  * the derivation, and with it the recipient binding, is replaced by a key
 *    that every subscribed device holds.
 *
 * Losing the recipient binding in the key means the envelope can no longer
 * carry a real `target_device_id`. It carries a session-scoped group address
 * instead, which is what the relay uses to fan the single ciphertext out.
 */
export class DeviceE2eeGroupSession {
  constructor({ local, sessionId, groupKeyId, key }) {
    this.local = local;
    this.sessionId = sessionId;
    this.groupKeyId = groupKeyId;
    this.key = key;
    this.lastActivityAt = Date.now();
    this.nextSend = 0;
  }

  /**
   * Build the group address a relay can route on.
   *
   * `recipient_key_id` carries the group key id rather than a device key id,
   * which is what tells a receiver it may open the envelope with its group key
   * instead of looking for a pairwise session.
   */
  seal(type, payload, { routing = {} } = {}) {
    this.lastActivityAt = Date.now();
    const sequence = this.nextSend++;
    const local = this.local.public_identity;
    const base = {
      type,
      protocol: DEVICE_E2EE_ENVELOPE_PROTOCOL,
      source_device_id: local.device_id,
      target_device_id: targetDeviceIdForGroup(this.sessionId),
      sender_key_id: local.key_id,
      recipient_key_id: this.groupKeyId,
      epoch: local.epoch,
      session_id: `${this.sessionId}#group`,
      direction: "request",
      sequence,
      routing,
      ephemeral_public_key: groupPublicId(this.groupKeyId),
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv("chacha20-poly1305", this.key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(Buffer.from(canonicalJson(header(base))));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(payload))),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const envelope = {
      ...base,
      nonce: nonce.toString("base64url"),
      ciphertext: encrypted.toString("base64url"),
    };
    return {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(`${ENVELOPE_DOMAIN}${canonicalJson(signedEnvelope(envelope))}`),
        privateKey(this.local.signing_private_jwk),
      ).toString("base64url"),
    };
  }
}

const GROUP_TARGET_PREFIX = "grp-session:";
const GROUP_EPHEMERAL_PREFIX = "grpkey:";

function groupText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The relay routes on `target_device_id`, so a fan-out needs an address that
 * names the audience rather than one device. The prefix keeps it unambiguous
 * against a real device id, which never contains a colon.
 */
export function targetDeviceIdForGroup(sessionId) {
  return `${GROUP_TARGET_PREFIX}${sessionId}`;
}

export function sessionIdFromGroupTarget(targetDeviceId) {
  const value = groupText(targetDeviceId);
  return value.startsWith(GROUP_TARGET_PREFIX)
    ? value.slice(GROUP_TARGET_PREFIX.length)
    : "";
}

export function isGroupTarget(targetDeviceId) {
  return groupText(targetDeviceId).startsWith(GROUP_TARGET_PREFIX);
}

export function isGroupKeyId(keyId) {
  return groupText(keyId).startsWith("grp:");
}

/**
 * `ephemeral_public_key` is part of the signed header and the relay validator
 * requires a 32-byte value there. A group envelope has no DH ephemeral, so it
 * carries a stable per-key identifier instead: deterministic, correctly sized,
 * and it lets a receiver confirm the envelope was sealed for the key it holds
 * before attempting decryption.
 */
function groupPublicId(groupKeyId) {
  return createHash("sha256")
    .update(`${GROUP_EPHEMERAL_PREFIX}${groupKeyId}`)
    .digest()
    .subarray(0, 32)
    .toString("base64url");
}

export class DeviceE2eeSession {
  constructor({
    local,
    peer,
    sessionId,
    ephemeralPublicKey,
    requestKey,
    responseKey,
    initiator,
  }) {
    this.local = local;
    this.peer = peer;
    this.sessionId = sessionId;
    this.ephemeralPublicKey = ephemeralPublicKey;
    this.requestKey = requestKey;
    this.responseKey = responseKey;
    this.initiator = initiator;
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.nextRequestSend = 0;
    this.nextResponseSend = 0;
    this.nextRequestReceive = 0;
    this.nextResponseReceive = 0;
  }

  static initiate({ local, peer, sessionId = `e2s_${randomBytes(18).toString("base64url")}` }) {
    validatePeers(local, peer);
    const ephemeral = generateKeyPairSync("x25519");
    const ephemeralPublicKey = ephemeral.publicKey.export({ format: "jwk" }).x;
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: publicKey("X25519", peer.agreement_public_key),
    });
    const keys = deriveKeys({
      shared,
      sourceDeviceId: local.public_identity.device_id,
      targetDeviceId: peer.device_id,
      sourceKeyId: local.public_identity.key_id,
      targetKeyId: peer.key_id,
      epoch: local.public_identity.epoch,
      sessionId,
      ephemeralPublicKey,
    });
    return new DeviceE2eeSession({
      local,
      peer,
      sessionId,
      ephemeralPublicKey,
      ...keys,
      initiator: true,
    });
  }

  static accept({ local, peer, firstEnvelope }) {
    validatePeers(local, peer);
    if (firstEnvelope.direction !== "request" || firstEnvelope.sequence !== 0
        || firstEnvelope.source_device_id !== peer.device_id
        || firstEnvelope.target_device_id !== local.public_identity.device_id
        || firstEnvelope.sender_key_id !== peer.key_id
        || firstEnvelope.recipient_key_id !== local.public_identity.key_id
        || firstEnvelope.epoch !== peer.epoch) {
      throw new Error("invalid first E2EE envelope");
    }
    verifyEnvelope(firstEnvelope, peer);
    const shared = diffieHellman({
      privateKey: privateKey(local.agreement_private_jwk),
      publicKey: publicKey("X25519", firstEnvelope.ephemeral_public_key),
    });
    const keys = deriveKeys({
      shared,
      sourceDeviceId: peer.device_id,
      targetDeviceId: local.public_identity.device_id,
      sourceKeyId: peer.key_id,
      targetKeyId: local.public_identity.key_id,
      epoch: firstEnvelope.epoch,
      sessionId: firstEnvelope.session_id,
      ephemeralPublicKey: firstEnvelope.ephemeral_public_key,
    });
    const session = new DeviceE2eeSession({
      local,
      peer,
      sessionId: firstEnvelope.session_id,
      ephemeralPublicKey: firstEnvelope.ephemeral_public_key,
      ...keys,
      initiator: false,
    });
    return { session, firstPayload: session._openVerified(firstEnvelope) };
  }

  seal(type, payload, { routing = {} } = {}) {
    this.lastActivityAt = Date.now();
    const direction = this.initiator ? "request" : "response";
    const sequence = direction === "request"
      ? this.nextRequestSend++
      : this.nextResponseSend++;
    const local = this.local.public_identity;
    const base = {
      type,
      protocol: DEVICE_E2EE_ENVELOPE_PROTOCOL,
      source_device_id: local.device_id,
      target_device_id: this.peer.device_id,
      sender_key_id: local.key_id,
      recipient_key_id: this.peer.key_id,
      epoch: local.epoch,
      session_id: this.sessionId,
      direction,
      sequence,
      routing,
      ephemeral_public_key: this.ephemeralPublicKey,
    };
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "chacha20-poly1305",
      direction === "request" ? this.requestKey : this.responseKey,
      nonce,
      { authTagLength: 16 },
    );
    cipher.setAAD(Buffer.from(canonicalJson(header(base))));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(payload))),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const envelope = {
      ...base,
      nonce: nonce.toString("base64url"),
      ciphertext: encrypted.toString("base64url"),
    };
    return {
      ...envelope,
      signature: sign(
        null,
        Buffer.from(`${ENVELOPE_DOMAIN}${canonicalJson(signedEnvelope(envelope))}`),
        privateKey(this.local.signing_private_jwk),
      ).toString("base64url"),
    };
  }

  open(envelope) {
    this.lastActivityAt = Date.now();
    if (envelope.session_id !== this.sessionId
        || envelope.ephemeral_public_key !== this.ephemeralPublicKey
        || envelope.source_device_id !== this.peer.device_id
        || envelope.target_device_id !== this.local.public_identity.device_id
        || envelope.sender_key_id !== this.peer.key_id
        || envelope.recipient_key_id !== this.local.public_identity.key_id
        || envelope.epoch !== this.peer.epoch) {
      throw new Error("E2EE envelope session mismatch");
    }
    const expectedDirection = this.initiator ? "response" : "request";
    if (envelope.direction !== expectedDirection) {
      throw new Error("E2EE envelope direction mismatch");
    }
    verifyEnvelope(envelope, this.peer);
    return this._openVerified(envelope);
  }

  _openVerified(envelope) {
    const expected = envelope.direction === "request"
      ? this.nextRequestReceive
      : this.nextResponseReceive;
    if (envelope.sequence !== expected) throw new Error("E2EE envelope sequence mismatch");
    const combined = Buffer.from(envelope.ciphertext, "base64url");
    if (combined.length < 17) throw new Error("invalid E2EE ciphertext");
    const decipher = createDecipheriv(
      "chacha20-poly1305",
      envelope.direction === "request" ? this.requestKey : this.responseKey,
      Buffer.from(envelope.nonce, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(canonicalJson(header(envelope))));
    decipher.setAuthTag(combined.subarray(combined.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(combined.subarray(0, combined.length - 16)),
      decipher.final(),
    ]);
    if (envelope.direction === "request") this.nextRequestReceive += 1;
    else this.nextResponseReceive += 1;
    const payload = JSON.parse(plaintext.toString("utf8"));
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new Error("E2EE payload must be a JSON object");
    }
    return { type: envelope.type, payload };
  }
}

/**
 * Open a group envelope with a group key.
 *
 * Deliberately *not* sequence-checked. A pairwise sequence is a single counter
 * shared by two parties, which only works because there are exactly two. A
 * group key is sealed once and fanned out to N independent receivers, so a
 * strict per-recipient counter cannot exist: two subscribers legitimately
 * observe the same sequence, and one that reconnects legitimately misses
 * several. Replay is handled by the transport, which drops an envelope whose
 * (session, sequence) it has already delivered.
 *
 * Returns null rather than throwing when the envelope is simply not for this
 * key. A subscriber can hold a group key while a newer one is already in use —
 * that is a race, not an error — and one unknown envelope must not be allowed
 * to tear down the event stream.
 */
export function openGroupEnvelope(envelope, { key, groupKeyId, peer }) {
  if (!envelope || envelope.protocol !== DEVICE_E2EE_ENVELOPE_PROTOCOL) return null;
  if (envelope.recipient_key_id !== groupKeyId) return null;
  if (!isGroupTarget(envelope.target_device_id)) return null;
  if (sessionIdFromGroupTarget(envelope.target_device_id) !== envelope.session_id.replace(/#group$/, "")) {
    return null;
  }
  if (envelope.ephemeral_public_key !== groupPublicId(groupKeyId)) return null;
  verifyEnvelope(envelope, peer);
  const combined = Buffer.from(envelope.ciphertext, "base64url");
  if (combined.length < 17) return null;
  const decipher = createDecipheriv(
    "chacha20-poly1305",
    key,
    Buffer.from(envelope.nonce, "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(canonicalJson(header(envelope))));
  decipher.setAuthTag(combined.subarray(combined.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(combined.subarray(0, combined.length - 16)),
    decipher.final(),
  ]);
  const payload = JSON.parse(plaintext.toString("utf8"));
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("E2EE payload must be a JSON object");
  }
  return { type: envelope.type, payload };
}
