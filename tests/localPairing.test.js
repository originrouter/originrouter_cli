import assert from "node:assert/strict";
import {
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  verify,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  ensureDeviceE2eeIdentity,
} from "../src/crypto/deviceE2eeIdentity.js";
import {
  LOCAL_PAIRING_PROTOCOL,
  LOCAL_PAIRING_TTL_MS,
  LocalPairingManager,
} from "../src/local/localPairing.js";

const TICKET_DOMAIN = "originrouter/local-pair-ticket/v1\n";
const RESPONSE_DOMAIN = "originrouter/local-pair-response/v1\n";
const RESPONSE_KDF_INFO = "originrouter/local-pair-response/v1";
const stateDir = mkdtempSync(join(tmpdir(), "originrouter-local-pairing-test-"));
const deviceId = "device-pairing-test";
const token = "abcdef0123456789".repeat(4);
let now = Date.parse("2026-09-19T12:00:00.000Z");

function decodeLine(line) {
  const encoded = line.slice("ORIGINROUTER_LOCAL_PAIR_V1:".length);
  const bytes = Buffer.from(encoded, "base64url");
  const signatureOffset = bytes.length - 64;
  let offset = 0;
  const flags = bytes[offset++];
  const expiresAtSeconds = bytes.readUInt32BE(offset);
  offset += 4;
  const port = bytes.readUInt16BE(offset);
  offset += 2;
  const kind = flags & 3;
  let host;
  if (kind === 0) host = "127.0.0.1";
  else if (kind === 1) host = "localhost";
  else if (kind === 2) host = "::1";
  else {
    const length = bytes[offset++];
    host = bytes.subarray(offset, offset + length).toString("utf8");
    offset += length;
  }
  const ticket = bytes.subarray(offset, offset + 16).toString("base64url");
  offset += 16;
  const signingPublicKey = bytes.subarray(offset, offset + 32).toString("base64url");
  return {
    endpoint: `${(flags & 4) !== 0 ? "https" : "http"}://${
      host.includes(":") ? `[${host}]` : host
    }:${port}`,
    expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
    ticket,
    signing_public_key: signingPublicKey,
    unsigned: bytes.subarray(0, signatureOffset),
    signature: bytes.subarray(signatureOffset),
  };
}

function responseHeader(value) {
  return {
    protocol: value.protocol,
    ticket_hash: value.ticket_hash,
    app_ephemeral_public_key: value.app_ephemeral_public_key,
    server_ephemeral_public_key: value.server_ephemeral_public_key,
    request_nonce: value.request_nonce,
  };
}

function verifyBytes(domain, value, signature, signingPublicKey) {
  return verify(
    null,
    Buffer.concat([Buffer.from(domain), value]),
    createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: signingPublicKey },
      format: "jwk",
    }),
    signature,
  );
}

function responseSignedValue(value) {
  return {
    ...responseHeader(value),
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  };
}

function verifySignature(domain, value, signature, signingPublicKey) {
  return verify(
    null,
    Buffer.from(`${domain}${canonicalJson(value)}`),
    createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: signingPublicKey },
      format: "jwk",
    }),
    Buffer.from(signature, "base64url"),
  );
}

function decryptResponse(response, appKeyPair) {
  const header = responseHeader(response);
  const shared = diffieHellman({
    privateKey: appKeyPair.privateKey,
    publicKey: createPublicKey({
      key: {
        kty: "OKP",
        crv: "X25519",
        x: response.server_ephemeral_public_key,
      },
      format: "jwk",
    }),
  });
  const headerBytes = Buffer.from(canonicalJson(header));
  const key = Buffer.from(hkdfSync(
    "sha256",
    shared,
    createHash("sha256").update(headerBytes).digest(),
    Buffer.from(RESPONSE_KDF_INFO),
    32,
  ));
  const combined = Buffer.from(response.ciphertext, "base64url");
  const decipher = createDecipheriv(
    "chacha20-poly1305",
    key,
    Buffer.from(response.nonce, "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(combined.subarray(combined.length - 16));
  return JSON.parse(Buffer.concat([
    decipher.update(combined.subarray(0, combined.length - 16)),
    decipher.final(),
  ]).toString("utf8"));
}

try {
  const identity = ensureDeviceE2eeIdentity(stateDir, { deviceId });
  const manager = new LocalPairingManager({
    identityProvider: () => identity,
    accessTokenProvider: () => token,
    deviceNameProvider: () => "Pairing test CLI",
    clock: () => now,
  });

  const issued = manager.issue({ endpoint: "http://127.0.0.1:7437" });
  const bundle = decodeLine(issued.pairing_line);
  assert.ok(issued.pairing_line.length < 220);
  assert.equal(bundle.endpoint, "http://127.0.0.1:7437");
  assert.equal(bundle.expires_at, issued.expires_at);
  assert.equal(
    verifyBytes(
      TICKET_DOMAIN,
      bundle.unsigned,
      bundle.signature,
      bundle.signing_public_key,
    ),
    true,
  );

  const appKeyPair = generateKeyPairSync("x25519");
  const appPublicKey = appKeyPair.publicKey.export({ format: "jwk" }).x;
  const requestNonce = Buffer.alloc(24, 7).toString("base64url");
  const response = manager.redeem({
    ticket: bundle.ticket,
    appEphemeralPublicKey: appPublicKey,
    requestNonce,
    sourceAddress: "127.0.0.1",
  });
  assert.equal(
    verifySignature(
      RESPONSE_DOMAIN,
      responseSignedValue(response),
      response.signature,
      bundle.signing_public_key,
    ),
    true,
  );
  const clear = decryptResponse(response, appKeyPair);
  assert.equal(clear.bearer_token, token);
  assert.equal(clear.endpoint, bundle.endpoint);
  assert.equal(clear.device_id, deviceId);

  const retry = manager.redeem({
    ticket: bundle.ticket,
    appEphemeralPublicKey: appPublicKey,
    requestNonce,
    sourceAddress: "127.0.0.1",
  });
  assert.deepEqual(retry, response);

  const otherKeyPair = generateKeyPairSync("x25519");
  assert.throws(
    () => manager.redeem({
      ticket: bundle.ticket,
      appEphemeralPublicKey: otherKeyPair.publicKey.export({ format: "jwk" }).x,
      requestNonce: Buffer.alloc(24, 8).toString("base64url"),
      sourceAddress: "127.0.0.2",
    }),
    (error) => error?.code === "pair_already_redeemed",
  );

  const recoverable = decodeLine(
    manager.issue({ endpoint: "http://127.0.0.1:7437" }).pairing_line,
  );
  const encryptedResponse = manager._encryptedResponse.bind(manager);
  manager._encryptedResponse = () => {
    throw new Error("simulated crypto failure");
  };
  assert.throws(
    () => manager.redeem({
      ticket: recoverable.ticket,
      appEphemeralPublicKey: appPublicKey,
      requestNonce,
      sourceAddress: "127.0.0.4",
    }),
    /simulated crypto failure/,
  );
  manager._encryptedResponse = encryptedResponse;
  const recovered = manager.redeem({
    ticket: recoverable.ticket,
    appEphemeralPublicKey: appPublicKey,
    requestNonce,
    sourceAddress: "127.0.0.4",
  });
  assert.equal(decryptResponse(recovered, appKeyPair).bearer_token, token);

  const expiring = decodeLine(
    manager.issue({ endpoint: "http://127.0.0.1:7437" }).pairing_line,
  );
  now += LOCAL_PAIRING_TTL_MS + 1;
  assert.throws(
    () => manager.redeem({
      ticket: expiring.ticket,
      appEphemeralPublicKey: appPublicKey,
      requestNonce,
      sourceAddress: "127.0.0.3",
    }),
    (error) => error?.code === "pair_expired",
  );
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("local pairing tests ok");
