// The CLI's DPoP primitives.
//
// The server checks these against RFC 9449, and the App has its own copy of
// the same rules in Dart. What is tested here is not "the crypto works" —
// that is the server's job — but the exact spellings the server compares:
// the thumbprint is the RFC 7638 canonical hash, the header says
// `dpop+jwt` and `EdDSA`, the target URI carries no query, and the proof
// is bound to the token it travels with.
//
// A drift in any of those spellings is a 401 on every request this CLI
// makes to a server that has learned to ask for a proof, and it is a 401
// that says nothing about why. So each of them is pinned here.

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import test from "node:test";

import {
  DPOP_ALGORITHM,
  DPOP_PROOF_TYPE,
  DPOP_SCHEME,
  dpopProof,
  dpopPublicJwk,
  dpopTargetUri,
  dpopThumbprint,
  generateDpopKeyPair,
} from "../src/crypto/dpopIdentity.js";

const TOKEN = "or_at_the_token_this_proof_belongs_to";

function decodePart(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("the authorization scheme is not the algorithm name", () => {
  // RFC 9449 section 4.1: the scheme is `DPoP`, and the algorithm is named
  // in the proof's header. Sending the algorithm as the scheme leaves the
  // server reading a scheme it does not know.
  assert.equal(DPOP_SCHEME, "DPoP");
  assert.equal(DPOP_ALGORITHM, "EdDSA");
  assert.notEqual(DPOP_SCHEME, DPOP_ALGORITHM);
  assert.equal(DPOP_PROOF_TYPE, "dpop+jwt");
});

test("the thumbprint is the RFC 7638 canonical hash", () => {
  const pair = generateDpopKeyPair();
  // RFC 7638 section 3.2: the required members only, lexicographic, no
  // whitespace. Written out by hand so a change of member or of order in
  // the implementation cannot quietly agree with itself.
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${pair.publicJwk.x}"}`;
  const expected = createHash("sha256").update(canonical).digest("base64url");
  assert.equal(dpopThumbprint(pair.publicJwk), expected);
  // 32 bytes, base64url, unpadded.
  assert.match(dpopThumbprint(pair.publicJwk), /^[A-Za-z0-9_-]{43}$/);
});

test("extra members do not change the thumbprint", () => {
  const pair = generateDpopKeyPair();
  const decorated = { ...pair.publicJwk, kid: "key-1", use: "sig", alg: "EdDSA" };
  assert.equal(dpopThumbprint(decorated), dpopThumbprint(pair.publicJwk));
});

test("an unsupported key is refused rather than thumbprinted", () => {
  assert.throws(() => dpopThumbprint({ kty: "RSA", n: "x", e: "AQAB" }));
  assert.throws(() => dpopThumbprint({ kty: "OKP", crv: "X25519", x: "x" }));
  assert.throws(() => dpopThumbprint(null));
});

test("the public half can be derived from the private half", () => {
  const pair = generateDpopKeyPair();
  // A store written before the public half was kept still has to produce a
  // proof the server can check.
  assert.deepEqual(dpopPublicJwk(pair.privateJwk), pair.publicJwk);
});

test("the target URI drops the query and the fragment", () => {
  assert.equal(
    dpopTargetUri("https://app.easytransnote.com/cli/v1/devices?page=2#top"),
    "https://app.easytransnote.com/cli/v1/devices",
  );
  assert.equal(
    dpopTargetUri("https://app.easytransnote.com"),
    "https://app.easytransnote.com/",
  );
  assert.equal(
    dpopTargetUri("wss://app.easytransnote.com/relay/v1/devices/d1/ws"),
    "wss://app.easytransnote.com/relay/v1/devices/d1/ws",
  );
});

test("a proof carries the header and the claims RFC 9449 asks for", () => {
  const pair = generateDpopKeyPair();
  const proof = dpopProof({
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    accessToken: TOKEN,
    method: "post",
    url: "https://app.easytransnote.com/cli/v1/dpop/proof",
  });
  const parts = proof.split(".");
  assert.equal(parts.length, 3);
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  assert.equal(header.typ, "dpop+jwt");
  assert.equal(header.alg, "EdDSA");
  assert.deepEqual(header.jwk, pair.publicJwk);
  assert.equal(payload.htm, "POST");
  assert.equal(payload.htu, "https://app.easytransnote.com/cli/v1/dpop/proof");
  assert.equal(payload.ath, createHash("sha256").update(TOKEN).digest("base64url"));
  assert.ok(Number.isInteger(payload.iat));
  assert.ok(payload.jti && payload.jti.length > 0);
  assert.ok(parts[2].length > 0);
});

test("the proof's signature verifies against the public key", () => {
  const pair = generateDpopKeyPair();
  const proof = dpopProof({
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    accessToken: TOKEN,
    method: "GET",
    url: "https://app.easytransnote.com/cli/v1/devices",
  });
  const [headerPart, payloadPart, signaturePart] = proof.split(".");
  const valid = verify(
    null,
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey({ key: pair.publicJwk, format: "jwk" }),
    Buffer.from(signaturePart, "base64url"),
  );
  assert.equal(valid, true);
});

test("the proof is bound to the token it travels with", () => {
  const pair = generateDpopKeyPair();
  const one = dpopProof({
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    accessToken: TOKEN,
    method: "GET",
    url: "https://app.easytransnote.com/cli/v1/devices",
  });
  const two = dpopProof({
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    accessToken: "or_at_another_token",
    method: "GET",
    url: "https://app.easytransnote.com/cli/v1/devices",
  });
  // The `ath` claim is what stops a proof being lifted from one request
  // onto another that carries a different token.
  assert.notEqual(
    decodePart(one.split(".")[1]).ath,
    decodePart(two.split(".")[1]).ath,
  );
});

test("two proofs of the same request are not the same proof", () => {
  const pair = generateDpopKeyPair();
  const make = () => dpopProof({
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    accessToken: TOKEN,
    method: "GET",
    url: "https://app.easytransnote.com/cli/v1/devices",
  });
  const one = make();
  const two = make();
  assert.notEqual(one, two);
  assert.notEqual(
    decodePart(one.split(".")[1]).jti,
    decodePart(two.split(".")[1]).jti,
  );
});

test("a proof needs both a key and a token", () => {
  const pair = generateDpopKeyPair();
  assert.throws(() => dpopProof({
    publicJwk: pair.publicJwk,
    accessToken: TOKEN,
    url: "https://app.easytransnote.com/cli/v1/devices",
  }));
  assert.throws(() => dpopProof({
    privateJwk: pair.privateJwk,
    publicJwk: pair.publicJwk,
    url: "https://app.easytransnote.com/cli/v1/devices",
  }));
});
