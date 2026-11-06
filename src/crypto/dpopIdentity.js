// The key a CLI device proves possession of on every request — RFC 9449.
//
// An access token is a bearer credential: whoever holds it may use it. The
// CLI keeps its token on disk, on a machine that is often a server that is
// always on, and that is the case worth closing. This file is the other half
// of a request the server can hold to something stronger — a private key the
// CLI keeps to itself, and a proof signed with it that belongs to exactly
// one request.
//
// The key is not the device's E2EE signing key. That one is the device's
// long-term identity, registered with the server, and it is what signs the
// *registration* of this key. Keeping the two apart means a server that
// never learned to check proofs has learned nothing about what this one can
// do, and a device whose proof key is lost can replace it without giving up
// its identity.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

// The scheme RFC 9449 gives a proof-carrying request. It is not the name of
// the algorithm the proof is signed with: the scheme is how a server tells a
// request that carries a proof from one that only carries a token. Sending
// "EdDSA" here would leave the server reading a scheme it does not know.
export const DPOP_SCHEME = "DPoP";

// The proof's `typ` header (RFC 9449 section 4.1).
export const DPOP_PROOF_TYPE = "dpop+jwt";

// The signature algorithm. Ed25519 is what the server accepts, and it is
// what Node can produce without a dependency.
export const DPOP_ALGORITHM = "EdDSA";

export function generateDpopKeyPair() {
  const pair = generateKeyPairSync("ed25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  return {
    privateJwk: pair.privateKey.export({ format: "jwk" }),
    publicJwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x },
  };
}

/**
 * The public half of a private JWK.
 *
 * The store keeps both halves, but only the private one is the secret; the
 * public one can always be read back out of it. Deriving it rather than
 * trusting the stored copy means a store written by an older version — one
 * that kept only the private half — still produces a proof the server can
 * check.
 */
export function dpopPublicJwk(privateJwk) {
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  const exported = createPublicKey(key).export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", x: exported.x };
}

/**
 * The RFC 7638 thumbprint of a public key.
 *
 * Only the members RFC 7638 requires take part, in lexicographic order,
 * with no whitespace — the hash is over the canonical form, not over
 * whatever the client happened to send.
 */
export function dpopThumbprint(jwk) {
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("unsupported DPoP key");
  }
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canonical).digest("base64url");
}

/**
 * The target URI a proof names: scheme, host and path.
 *
 * No query, no fragment, and no default port — the server builds its side
 * the same way. RFC 9449 compares these three parts and nothing else.
 */
export function dpopTargetUri(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  const path = parsed.pathname || "/";
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * A proof that belongs to exactly one request.
 *
 * `url` is the URL the request is going to. `accessToken` is the token the
 * request carries — the proof is bound to it, so a proof cannot be lifted
 * from one request onto another with a different token.
 */
export function dpopProof({
  privateJwk,
  publicJwk,
  accessToken,
  method = "GET",
  url,
  jti = null,
  now = Date.now(),
}) {
  if (!privateJwk || !publicJwk) throw new Error("a DPoP proof needs a key");
  if (!accessToken) throw new Error("a DPoP proof needs an access token");
  const header = { typ: DPOP_PROOF_TYPE, alg: DPOP_ALGORITHM, jwk: publicJwk };
  const payload = {
    jti: jti || randomBytes(16).toString("base64url"),
    htm: String(method || "GET").toUpperCase(),
    htu: dpopTargetUri(url),
    iat: Math.floor(now / 1000),
    ath: createHash("sha256").update(String(accessToken)).digest("base64url"),
  };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = sign(
    null,
    Buffer.from(signingInput),
    createPrivateKey({ key: privateJwk, format: "jwk" }),
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}
