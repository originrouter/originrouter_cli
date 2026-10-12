import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";

import {
  canonicalJson,
  verifyDeviceE2eeIdentity,
} from "../crypto/deviceE2eeIdentity.js";

export const LOCAL_PAIRING_PROTOCOL = "originrouter-local-pair-v1";
export const LOCAL_PAIRING_TTL_MS = 5 * 60_000;

const TICKET_DOMAIN = "originrouter/local-pair-ticket/v1\n";
const RESPONSE_DOMAIN = "originrouter/local-pair-response/v1\n";
const RESPONSE_KDF_INFO = "originrouter/local-pair-response/v1";
const PAIRING_PREFIX = "ORIGINROUTER_LOCAL_PAIR_V1:";
const PAIRING_TICKET_BYTES = 16;
const PAIRING_SIGNATURE_BYTES = 64;
const PAIRING_SIGNING_KEY_BYTES = 32;
const HOST_KIND_LOOPBACK = 0;
const HOST_KIND_LOCALHOST = 1;
const HOST_KIND_IPV6_LOOPBACK = 2;
const HOST_KIND_CUSTOM = 3;
const FLAG_HTTPS = 1 << 2;
const MAX_TICKETS = 256;
const FAILURE_WINDOW_MS = 60_000;
const MAX_SOURCE_FAILURES = 5;
const MAX_GLOBAL_FAILURES = 30;
// Short pairing code: 8 Crockford Base32 characters = 40 bits. That is well
// inside what the existing gates cover — a ticket lives 5 minutes and each
// source gets 5 failures per minute (30 globally), so the whole 2^40 space
// cannot be swept in the ticket's lifetime even by a distributed attacker.
// Crockford omits I/L/O/U to remove the glyphs people misread as 1/0, which
// is the whole reason a typed code is offered at all.
const SHORT_CODE_LENGTH = 8;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHORT_TICKET_BYTES = 5;


export class LocalPairingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LocalPairingError";
    this.code = code;
    this.status = status;
  }
}

function privateKey(jwk) {
  return createPrivateKey({ key: jwk, format: "jwk" });
}

function publicKey(crv, value) {
  return createPublicKey({
    key: { kty: "OKP", crv, x: value },
    format: "jwk",
  });
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function ticketHash(ticket) {
  return createHash("sha256").update(ticket, "utf8").digest("base64url");
}

export function encodeShortCode(bytes) {
  let value = 0;
  for (const byte of bytes) value = (value * 256) + byte;
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    const shift = 5 * (SHORT_CODE_LENGTH - 1 - i);
    code += CROCKFORD_ALPHABET[Math.floor(value / (2 ** shift)) % 32];
  }
  return code;
}

export function decodeShortCode(code) {
  const normalized = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    // Crockford's whole promise: these four read as other characters.
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .replace(/U/g, "V");
  if (normalized.length !== SHORT_CODE_LENGTH) return null;
  let value = 0;
  for (const char of normalized) {
    const digit = CROCKFORD_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = (value * 32) + digit;
  }
  const bytes = [];
  for (let i = SHORT_TICKET_BYTES - 1; i >= 0; i -= 1) {
    bytes.unshift(value % 256);
    value = Math.floor(value / 256);
  }
  return bytes;
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

function signedResponse(value) {
  return {
    ...responseHeader(value),
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  };
}

function validBase64Url(value, bytes) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").length === bytes;
  } catch {
    return false;
  }
}

function normalizeSource(value) {
  return String(value || "unknown").replace(/^::ffff:/, "").slice(0, 191);
}

function compactHost(hostname) {
  const raw = String(hostname || "").toLowerCase();
  const normalized = raw.startsWith("[") && raw.endsWith("]")
    ? raw.slice(1, -1)
    : raw;
  if (normalized === "127.0.0.1") {
    return { kind: HOST_KIND_LOOPBACK, bytes: Buffer.alloc(0) };
  }
  if (normalized === "localhost") {
    return { kind: HOST_KIND_LOCALHOST, bytes: Buffer.alloc(0) };
  }
  if (["::1", "[::1]"].includes(normalized)) {
    return { kind: HOST_KIND_IPV6_LOOPBACK, bytes: Buffer.alloc(0) };
  }
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length === 0 || bytes.length > 255) {
    throw new LocalPairingError(
      "pair_endpoint_invalid",
      "local pairing endpoint host is invalid",
    );
  }
  return { kind: HOST_KIND_CUSTOM, bytes };
}

function pairingUnsignedBytes({ endpoint, expiresAtSeconds, ticket, signingPublicKey }) {
  const host = compactHost(endpoint.hostname);
  const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LocalPairingError(
      "pair_endpoint_invalid",
      "local pairing endpoint port is invalid",
    );
  }
  const header = Buffer.alloc(7);
  header[0] = host.kind | (endpoint.protocol === "https:" ? FLAG_HTTPS : 0);
  header.writeUInt32BE(expiresAtSeconds, 1);
  header.writeUInt16BE(port, 5);
  const hostLength = host.kind === HOST_KIND_CUSTOM
    ? Buffer.from([host.bytes.length])
    : Buffer.alloc(0);
  return Buffer.concat([
    header,
    hostLength,
    host.bytes,
    ticket,
    signingPublicKey,
  ]);
}

export class LocalPairingManager {
  constructor({
    identityProvider,
    accessTokenProvider,
    deviceNameProvider = () => null,
    clock = () => Date.now(),
  }) {
    this.identityProvider = identityProvider;
    this.accessTokenProvider = accessTokenProvider;
    this.deviceNameProvider = deviceNameProvider;
    this.clock = clock;
    this.tickets = new Map();
    this.sourceFailures = new Map();
    this.globalFailures = { window_started_at: 0, count: 0 };
  }

  issue({ endpoint }) {
    this._prune();
    const identity = this._identity();
    const parsedEndpoint = new URL(String(endpoint || ""));
    if (!["http:", "https:"].includes(parsedEndpoint.protocol)
        || !parsedEndpoint.hostname
        || parsedEndpoint.pathname !== "/"
        || parsedEndpoint.search
        || parsedEndpoint.hash) {
      throw new LocalPairingError(
        "pair_endpoint_invalid",
        "local pairing endpoint is invalid",
      );
    }
    const ticketBytes = randomBytes(PAIRING_TICKET_BYTES);
    const ticket = ticketBytes.toString("base64url");
    const hash = ticketHash(ticket);
    const expiresAtSeconds = Math.floor(
      (this.clock() + LOCAL_PAIRING_TTL_MS) / 1000,
    );
    const expiresAtMs = expiresAtSeconds * 1000;
    const signingPublicKey = Buffer.from(
      identity.public_identity.signing_public_key,
      "base64url",
    );
    if (signingPublicKey.length !== PAIRING_SIGNING_KEY_BYTES) {
      throw new LocalPairingError(
        "pair_identity_unavailable",
        "CLI signing key is unavailable",
        503,
      );
    }
    const endpointValue = parsedEndpoint.toString().replace(/\/$/, "");
    const unsigned = pairingUnsignedBytes({
      endpoint: parsedEndpoint,
      expiresAtSeconds,
      ticket: ticketBytes,
      signingPublicKey,
    });
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(TICKET_DOMAIN), unsigned]),
      privateKey(identity.signing_private_jwk),
    );
    if (signature.length !== PAIRING_SIGNATURE_BYTES) {
      throw new LocalPairingError(
        "pair_identity_unavailable",
        "CLI signing key returned an invalid signature",
        503,
      );
    }
    this.tickets.set(hash, {
      ticket_hash: hash,
      endpoint: endpointValue,
      expires_at_ms: expiresAtMs,
      signing_public_key: identity.public_identity.signing_public_key,
      app_public_key: null,
      request_nonce: null,
      response: null,
    });
    this._trimTickets();
    return {
      pairing_line: `${PAIRING_PREFIX}${Buffer.concat([
        unsigned,
        signature,
      ]).toString("base64url")}`,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  }

  // The short-code sibling of `issue`. It registers a ticket under the same
  // one-time machinery but returns an 8-character code instead of a signed
  // binary blob, because the App is expected to receive it by scanning a QR
  // code or by typing it — neither of which can carry 190 base64 characters,
  // and neither of which should have to.
  //
  // Deliberately unsigned: the code is a routing hint, not a credential. The
  // App may point it at whatever address the user actually typed, which is
  // the point — localhost, a LAN address, a public host or a domain are all
  // legitimate and the CLI cannot know which. Authenticity is established
  // downstream by the redeem response, which this process signs with its
  // Ed25519 device key; a spoofed endpoint cannot forge that.
  issueShort({ endpoint }) {
    this._prune();
    this._identity();
    const parsedEndpoint = new URL(String(endpoint || ""));
    if (!["http:", "https:"].includes(parsedEndpoint.protocol)
        || !parsedEndpoint.hostname
        || parsedEndpoint.pathname !== "/"
        || parsedEndpoint.search
        || parsedEndpoint.hash) {
      throw new LocalPairingError(
        "pair_endpoint_invalid",
        "local pairing endpoint is invalid",
      );
    }
    const codeBytes = randomBytes(SHORT_TICKET_BYTES);
    const code = encodeShortCode(codeBytes);
    const expiresAtMs = this.clock() + LOCAL_PAIRING_TTL_MS;
    const ticket = Buffer.from(codeBytes).toString("base64url");
    const identity = this._identity();
    if (Buffer.from(
      identity.public_identity.signing_public_key,
      "base64url",
    ).length !== PAIRING_SIGNING_KEY_BYTES) {
      throw new LocalPairingError(
        "pair_identity_unavailable",
        "CLI signing key is unavailable",
        503,
      );
    }
    this.tickets.set(ticketHash(ticket), {
      ticket_hash: ticketHash(ticket),
      endpoint: parsedEndpoint.toString().replace(/\/$/, ""),
      expires_at_ms: expiresAtMs,
      signing_public_key: identity.public_identity.signing_public_key,
      app_public_key: null,
      request_nonce: null,
      response: null,
    });
    this._trimTickets();
    return {
      code,
      expires_at: new Date(expiresAtMs).toISOString(),
      // The App has no signed line to read a key out of, so the device signing
      // key travels alongside the code. It is what lets the App verify the
      // redeem response and thereby bind the token to this CLI.
      signing_public_key: identity.public_identity.signing_public_key,
    };
  }

  redeem({ ticket, appEphemeralPublicKey, requestNonce, sourceAddress }) {
    this._prune();
    const source = normalizeSource(sourceAddress);
    this._assertRateAllowed(source);
    try {
      // A ticket reaches this method in one of two encodings: the 22-character
      // base64url value a signed pairing line carries, or the 8-character
      // Crockford code a scanned or typed short code carries. Both normalize to
      // the same ticket string here, so nothing past this point differs.
      //
      // The full-length form is tested first, and deliberately: base64url
      // contains `-` and `_`, which are not Crockford characters, so a genuine
      // ticket can in principle collapse to 8 characters when normalized.
      // Checking the established encoding first makes that ambiguous input
      // resolve the same way it always has.
      const shortBytes = validBase64Url(ticket, PAIRING_TICKET_BYTES)
        ? null
        : decodeShortCode(ticket);
      const normalizedTicket = shortBytes
        ? Buffer.from(shortBytes).toString("base64url")
        : ticket;
      if (!validBase64Url(normalizedTicket, PAIRING_TICKET_BYTES)
          && !(shortBytes
            && validBase64Url(normalizedTicket, SHORT_TICKET_BYTES))
          || !validBase64Url(appEphemeralPublicKey, 32)
          || !validBase64Url(requestNonce, 24)) {
        throw new LocalPairingError(
          "pair_request_invalid",
          "pairing request is invalid",
        );
      }
      const hash = ticketHash(normalizedTicket);
      const entry = this.tickets.get(hash);
      if (!entry) {
        throw new LocalPairingError(
          "pair_invalid_or_expired",
          "pairing request is invalid or expired",
          403,
        );
      }
      if (entry.expires_at_ms <= this.clock()) {
        this.tickets.delete(hash);
        throw new LocalPairingError(
          "pair_expired",
          "pairing request expired",
          410,
        );
      }
      if (entry.app_public_key != null) {
        if (entry.app_public_key === appEphemeralPublicKey
            && entry.request_nonce === requestNonce
            && entry.response) {
          return entry.response;
        }
        throw new LocalPairingError(
          "pair_already_redeemed",
          "pairing request was already redeemed",
          409,
        );
      }
      const identity = this._identity();
      if (identity.public_identity.signing_public_key !== entry.signing_public_key) {
        this.tickets.delete(hash);
        throw new LocalPairingError(
          "pair_cli_key_changed",
          "CLI device key changed; create a new pairing request",
          409,
        );
      }
      const accessToken = String(this.accessTokenProvider?.() || "").trim();
      if (!/^[a-f0-9]{64}$/i.test(accessToken)) {
        throw new LocalPairingError(
          "pair_access_key_unavailable",
          "local access key is unavailable",
          503,
        );
      }

      // Bind before creating the response so a second claimant cannot race
      // the first successful validation in this single-threaded process.
      entry.app_public_key = appEphemeralPublicKey;
      entry.request_nonce = requestNonce;
      try {
        entry.response = this._encryptedResponse({
          entry,
          identity,
          accessToken,
          appEphemeralPublicKey,
          requestNonce,
        });
      } catch (error) {
        // An internal crypto failure must not consume the one-time ticket.
        // Leave it available for the same user to retry after the transient
        // problem clears, while still recording the failed attempt below.
        entry.app_public_key = null;
        entry.request_nonce = null;
        entry.response = null;
        throw error;
      }
      return entry.response;
    } catch (error) {
      this._recordFailure(source);
      throw error;
    }
  }

  _encryptedResponse({
    entry,
    identity,
    accessToken,
    appEphemeralPublicKey,
    requestNonce,
  }) {
    const ephemeral = generateKeyPairSync("x25519");
    const serverEphemeralPublicKey = ephemeral.publicKey.export({ format: "jwk" }).x;
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: publicKey("X25519", appEphemeralPublicKey),
    });
    const header = {
      protocol: LOCAL_PAIRING_PROTOCOL,
      ticket_hash: entry.ticket_hash,
      app_ephemeral_public_key: appEphemeralPublicKey,
      server_ephemeral_public_key: serverEphemeralPublicKey,
      request_nonce: requestNonce,
    };
    const headerBytes = Buffer.from(canonicalJson(header));
    const key = Buffer.from(hkdfSync(
      "sha256",
      shared,
      createHash("sha256").update(headerBytes).digest(),
      Buffer.from(RESPONSE_KDF_INFO),
      32,
    ));
    const nonce = randomBytes(12);
    const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(headerBytes);
    const plaintext = {
      version: 1,
      bearer_token: accessToken,
      endpoint: entry.endpoint,
      device_id: identity.public_identity.device_id,
      device_name: String(this.deviceNameProvider?.() || "").trim() || null,
      issued_at: new Date(this.clock()).toISOString(),
    };
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(plaintext))),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const response = {
      ...header,
      nonce: encode(nonce),
      ciphertext: encode(encrypted),
    };
    return {
      ...response,
      signature: sign(
        null,
        Buffer.from(`${RESPONSE_DOMAIN}${canonicalJson(signedResponse(response))}`),
        privateKey(identity.signing_private_jwk),
      ).toString("base64url"),
    };
  }

  _identity() {
    const identity = this.identityProvider?.();
    if (!identity?.public_identity
        || !verifyDeviceE2eeIdentity(identity.public_identity)
        || !identity.signing_private_jwk) {
      throw new LocalPairingError(
        "pair_identity_unavailable",
        "CLI device identity is unavailable",
        503,
      );
    }
    return identity;
  }

  _assertRateAllowed(source) {
    const now = this.clock();
    const local = this.sourceFailures.get(source);
    if (local && now - local.window_started_at < FAILURE_WINDOW_MS
        && local.count >= MAX_SOURCE_FAILURES) {
      throw new LocalPairingError(
        "pair_rate_limited",
        "too many pairing attempts; try again later",
        429,
      );
    }
    const global = this.globalFailures;
    if (now - global.window_started_at < FAILURE_WINDOW_MS
        && global.count >= MAX_GLOBAL_FAILURES) {
      throw new LocalPairingError(
        "pair_rate_limited",
        "too many pairing attempts; try again later",
        429,
      );
    }
  }

  _recordFailure(source) {
    const now = this.clock();
    const local = this.sourceFailures.get(source);
    if (!local || now - local.window_started_at >= FAILURE_WINDOW_MS) {
      this.sourceFailures.set(source, { window_started_at: now, count: 1 });
    } else {
      local.count += 1;
    }
    if (now - this.globalFailures.window_started_at >= FAILURE_WINDOW_MS) {
      this.globalFailures = { window_started_at: now, count: 1 };
    } else {
      this.globalFailures.count += 1;
    }
  }

  _prune() {
    const now = this.clock();
    for (const [hash, entry] of this.tickets) {
      // Retain a short tombstone window so redemption can distinguish an
      // expired ticket from a random invalid value without retaining it long.
      if (entry.expires_at_ms + FAILURE_WINDOW_MS <= now) {
        this.tickets.delete(hash);
      }
    }
    for (const [source, value] of this.sourceFailures) {
      if (now - value.window_started_at >= FAILURE_WINDOW_MS) {
        this.sourceFailures.delete(source);
      }
    }
    if (now - this.globalFailures.window_started_at >= FAILURE_WINDOW_MS) {
      this.globalFailures = { window_started_at: now, count: 0 };
    }
  }

  _trimTickets() {
    while (this.tickets.size > MAX_TICKETS) {
      this.tickets.delete(this.tickets.keys().next().value);
    }
  }
}
