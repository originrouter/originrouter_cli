import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { readApiToken } from "../persistence/authToken.js";
import { readCodingAuth } from "../persistence/codingAuth.js";
import {
  canonicalJson,
  verifyDeviceE2eeIdentity,
  verifyDeviceE2eeLocalChallenge,
} from "../crypto/deviceE2eeIdentity.js";
import { DeviceE2eeSession } from "../crypto/deviceE2eeEnvelope.js";
import {
  deviceE2eeDirectoryCacheState,
  deviceE2eeDirectoryHead,
  readDeviceE2eeDirectoryCache,
} from "../security/deviceE2eeDirectoryCache.js";

const CHALLENGE_DOMAIN = "originrouter/local-e2ee-challenge/v2\n";
const CHALLENGE_TTL_MS = 60_000;
const MAX_RPC_BODY_BYTES = 8 * 1024 * 1024;
const AUTH_DEVICE_SIGNATURE = "device_signature_v1";
const AUTH_LOCAL_ACCESS_KEY = "local_access_key_v1";
const AUTH_LEGACY_HMAC = "legacy_hmac_v2";

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function proof(token, challenge) {
  return createHmac("sha256", token)
    .update(`${CHALLENGE_DOMAIN}${canonicalJson(challenge)}`)
    .digest("base64url");
}

function accessKeyBinding(token) {
  if (!token) return "";
  return createHash("sha256")
    .update(`originrouter/local-access-key-binding/v1\n${token}`)
    .digest("base64url");
}

function usesAccessKeyAuthentication(method) {
  return method === AUTH_LOCAL_ACCESS_KEY || method === AUTH_LEGACY_HMAC;
}

function currentTrustedIdentity(cache, deviceId, keyId) {
  return cache?.identities?.find((item) =>
    item.device_id === deviceId
      && item.key_id === keyId
      && item.trust_status === "trusted");
}

function localTrustContext(appIdentity, cliIdentity) {
  const binding = {
    protocol: "originrouter-local-trust-v1",
    app_device_id: appIdentity.device_id,
    app_key_id: appIdentity.key_id,
    cli_device_id: cliIdentity.device_id,
    cli_key_id: cliIdentity.key_id,
  };
  return `local:${createHash("sha256").update(canonicalJson(binding)).digest("base64url")}`;
}

export class DeviceE2eeLocalGateway {
  constructor({
    stateDir,
    localIdentity,
    localIdentityProvider = null,
    apiTokenPath,
    fetchFn = globalThis.fetch,
  }) {
    this.stateDir = stateDir;
    this.localIdentity = localIdentity;
    this.localIdentityProvider = localIdentityProvider;
    this.apiTokenPath = apiTokenPath;
    this.tokenStateDir = apiTokenPath ? dirname(apiTokenPath) : stateDir;
    this.fetchFn = fetchFn;
    this.challenges = new Map();
    this.approvedPeers = new Map();
    this.sessions = new Map();
    this.inboundTails = new Map();
  }

  setLocalIdentity(identity) {
    if (!identity?.public_identity
        || !verifyDeviceE2eeIdentity(identity.public_identity)) {
      throw new Error("invalid local device E2EE identity");
    }
    if (identity.public_identity.key_id === this.localIdentity?.public_identity?.key_id
        && identity.public_identity.device_id === this.localIdentity?.public_identity?.device_id) {
      return false;
    }
    this.localIdentity = identity;
    this.challenges.clear();
    this.clearTrustSessions();
    return true;
  }

  _refreshLocalIdentity() {
    const next = this.localIdentityProvider?.();
    if (next) this.setLocalIdentity(next);
    return this.localIdentity;
  }

  identityStatus(expectedDeviceId = "") {
    const identity = this._refreshLocalIdentity()?.public_identity;
    return {
      deviceId: identity?.device_id || "",
      keyId: identity?.key_id || "",
      keyVersion: Number(identity?.key_version || 0),
      epoch: Number(identity?.epoch || 0),
      matchesDaemonDevice: !expectedDeviceId || identity?.device_id === expectedDeviceId,
    };
  }

  _prune() {
    const now = Date.now();
    for (const [id, item] of this.challenges) {
      if (item.expires_at_ms <= now) this.challenges.delete(id);
    }
    for (const [keyId, item] of this.approvedPeers) {
      if (item.expires_at_ms <= now) this.approvedPeers.delete(keyId);
    }
    for (const [sessionId, entry] of this.sessions) {
      if (entry.session.lastActivityAt < now - 60 * 60_000) {
        this.sessions.delete(sessionId);
      }
    }
    while (this.challenges.size > 256) {
      this.challenges.delete(this.challenges.keys().next().value);
    }
    while (this.approvedPeers.size > 256) {
      this.approvedPeers.delete(this.approvedPeers.keys().next().value);
    }
    while (this.sessions.size > 512) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
  }

  _readLocalToken() {
    if (this.apiTokenPath) {
      try {
        const value = readFileSync(this.apiTokenPath, "utf8").trim();
        return /^[a-f0-9]{64}$/i.test(value) ? value : null;
      } catch {}
    }
    return readApiToken(this.tokenStateDir);
  }

  createChallenge({ appDeviceId, appKeyId }) {
    this._prune();
    const localIdentity = this._refreshLocalIdentity();
    const challenge = {
      protocol: "e2ee-v2",
      challenge_id: `e2c_${randomBytes(18).toString("base64url")}`,
      nonce: randomBytes(32).toString("base64url"),
      app_device_id: String(appDeviceId || "").slice(0, 191),
      app_key_id: String(appKeyId || "").slice(0, 96),
      cli_device_id: localIdentity.public_identity.device_id,
      cli_key_id: localIdentity.public_identity.key_id,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    };
    if (!challenge.app_device_id || !challenge.app_key_id) {
      const error = new Error("app device identity is required");
      error.code = "invalid_app_identity";
      throw error;
    }
    this.challenges.set(challenge.challenge_id, {
      challenge,
      expires_at_ms: Date.now() + CHALLENGE_TTL_MS,
    });
    return {
      challenge,
      cli_identity: localIdentity.public_identity,
      auth_methods: [AUTH_DEVICE_SIGNATURE, AUTH_LOCAL_ACCESS_KEY],
    };
  }

  authorize({
    challengeId,
    appIdentity,
    authMethod,
    hmacProof,
    deviceProof,
  }) {
    this._prune();
    const localIdentity = this._refreshLocalIdentity();
    const pending = this.challenges.get(String(challengeId || ""));
    this.challenges.delete(String(challengeId || ""));
    if (!pending || pending.expires_at_ms <= Date.now()) {
      const error = new Error("local E2EE challenge expired");
      error.code = "challenge_expired";
      throw error;
    }
    if (!verifyDeviceE2eeIdentity(appIdentity)
        || appIdentity.device_id !== pending.challenge.app_device_id
        || appIdentity.key_id !== pending.challenge.app_key_id) {
      const error = new Error("invalid App E2EE identity");
      error.code = "invalid_app_identity";
      throw error;
    }
    const method = String(authMethod || "").trim() || AUTH_LEGACY_HMAC;
    if (![AUTH_DEVICE_SIGNATURE, AUTH_LOCAL_ACCESS_KEY, AUTH_LEGACY_HMAC].includes(method)) {
      const error = new Error("unsupported local E2EE authentication method");
      error.code = "unsupported_auth_method";
      throw error;
    }
    const credential = readCodingAuth(this.stateDir);
    const cache = credential?.sessionId
      ? readDeviceE2eeDirectoryCache(this.stateDir, {
          namespace: credential.sessionId,
        })
      : null;
    const trusted = currentTrustedIdentity(
      cache,
      appIdentity.device_id,
      appIdentity.key_id,
    );
    const publicFieldsMatch = Boolean(trusted)
      && Object.entries(appIdentity).every(([key, value]) =>
        canonicalJson(trusted[key] ?? null) === canonicalJson(value ?? null));
    let trustContext;
    let localAccessKeyBinding = "";
    if (method === AUTH_DEVICE_SIGNATURE) {
      if (!deviceE2eeDirectoryCacheState(cache).usable) {
        const error = new Error("cached device trust state is too old");
        error.code = "device_trust_state_stale";
        throw error;
      }
      if (!publicFieldsMatch) {
        const error = new Error("App device is not trusted in the cached directory");
        error.code = "app_device_not_trusted";
        throw error;
      }
      if (!verifyDeviceE2eeLocalChallenge(
        appIdentity,
        pending.challenge,
        deviceProof,
      )) {
        const error = new Error("invalid trusted-device challenge signature");
        error.code = "invalid_device_signature";
        throw error;
      }
      trustContext = deviceE2eeDirectoryHead(cache);
    } else {
      const token = this._readLocalToken();
      if (!token || !safeEqual(hmacProof, proof(token, pending.challenge))) {
        const error = new Error("invalid local E2EE challenge proof");
        error.code = "invalid_challenge_proof";
        throw error;
      }
      localAccessKeyBinding = accessKeyBinding(token);
      if (method === AUTH_LEGACY_HMAC) {
        if (!deviceE2eeDirectoryCacheState(cache).usable) {
          const error = new Error("cached device trust state is too old");
          error.code = "device_trust_state_stale";
          throw error;
        }
        if (!publicFieldsMatch) {
          const error = new Error("App device is not trusted in the cached directory");
          error.code = "app_device_not_trusted";
          throw error;
        }
        trustContext = deviceE2eeDirectoryHead(cache);
      } else {
        // Explicit access-key pairing is the offline/local-deployment path.
        // The HMAC authenticates the self-signed App identity without
        // granting it any account or Relay trust.
        trustContext = localTrustContext(
          appIdentity,
          localIdentity.public_identity,
        );
      }
    }
    this.approvedPeers.set(appIdentity.key_id, {
      identity: appIdentity,
      auth_method: method,
      trust_context: trustContext,
      local_access_key_binding: localAccessKeyBinding,
      expires_at_ms: Date.now() + 24 * 60 * 60 * 1000,
    });
    return {
      accepted: true,
      auth_method: method,
      trust_context: trustContext,
      app_device_id: appIdentity.device_id,
      app_key_id: appIdentity.key_id,
      cli_key_id: localIdentity.public_identity.key_id,
    };
  }

  handleEnvelope(envelope, { localPort }) {
    const sessionId = String(envelope?.session_id || "");
    const previous = this.inboundTails.get(sessionId) || Promise.resolve();
    const operation = previous.then(() =>
      this._handleEnvelopeSerial(envelope, { localPort }));
    const tail = operation.catch(() => {});
    this.inboundTails.set(sessionId, tail);
    return operation.finally(() => {
      if (this.inboundTails.get(sessionId) === tail) {
        this.inboundTails.delete(sessionId);
      }
    });
  }

  async _handleEnvelopeSerial(envelope, { localPort }) {
    this._prune();
    const localIdentity = this._refreshLocalIdentity();
    const sessionId = String(envelope?.session_id || "");
    let sessionEntry = this.sessions.get(sessionId);
    let opened;
    if (sessionEntry) {
      if (usesAccessKeyAuthentication(sessionEntry.auth_method)
          && sessionEntry.local_access_key_binding
            !== accessKeyBinding(this._readLocalToken())) {
        this.sessions.delete(sessionId);
        const error = new Error("local access key changed; reconnect required");
        error.code = "local_access_key_changed";
        throw error;
      }
      if (envelope?.routing?.directory_head !== sessionEntry.trust_context) {
        const error = new Error("local E2EE trust contexts do not agree");
        error.code = "device_e2ee_directory_fork";
        throw error;
      }
      opened = sessionEntry.session.open(envelope);
    } else {
      const approved = this.approvedPeers.get(envelope?.sender_key_id);
      if (!approved || approved.identity.device_id !== envelope?.source_device_id) {
        const error = new Error("local E2EE peer authorization required");
        error.code = "peer_authorization_required";
        throw error;
      }
      if (usesAccessKeyAuthentication(approved.auth_method)
          && approved.local_access_key_binding
            !== accessKeyBinding(this._readLocalToken())) {
        this.approvedPeers.delete(envelope?.sender_key_id);
        const error = new Error("local access key changed; reconnect required");
        error.code = "local_access_key_changed";
        throw error;
      }
      if (envelope?.routing?.directory_head !== approved.trust_context) {
        const error = new Error("local E2EE trust contexts do not agree");
        error.code = "device_e2ee_directory_fork";
        throw error;
      }
      const accepted = DeviceE2eeSession.accept({
        local: localIdentity,
        peer: approved.identity,
        firstEnvelope: envelope,
      });
      sessionEntry = {
        session: accepted.session,
        trust_context: approved.trust_context,
        auth_method: approved.auth_method,
        local_access_key_binding: approved.local_access_key_binding,
      };
      opened = accepted.firstPayload;
      this.sessions.set(accepted.session.sessionId, sessionEntry);
    }
    if (opened.type !== "local.rpc.request") {
      const error = new Error("unsupported local E2EE message type");
      error.code = "unsupported_local_e2ee_type";
      throw error;
    }
    const rpc = opened.payload;
    const method = String(rpc.method || "GET").toUpperCase();
    const path = String(rpc.path || "");
    if (!path.startsWith("/") || path.startsWith("/local/e2ee/")) {
      const error = new Error("invalid local RPC path");
      error.code = "invalid_local_rpc_path";
      throw error;
    }
    const token = this._readLocalToken();
    if (!token) throw new Error("local API token unavailable");
    const body = rpc.body == null ? null : JSON.stringify(rpc.body);
    if (body && Buffer.byteLength(body) > MAX_RPC_BODY_BYTES) {
      throw new Error("local RPC body too large");
    }
    const url = new URL(`http://127.0.0.1:${localPort}${path}`);
    for (const [key, value] of Object.entries(rpc.query || {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const response = await this.fetchFn(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      },
      ...(body ? { body } : {}),
    });
    const raw = await response.text();
    let responseBody = {};
    try { responseBody = raw ? JSON.parse(raw) : {}; }
    catch { responseBody = { error: "invalid local RPC response" }; }
    return sessionEntry.session.seal("local.rpc.response", {
      requestId: rpc.requestId,
      statusCode: response.status,
      body: responseBody,
    }, { routing: {
      request_id: String(rpc.requestId || ""),
      directory_head: sessionEntry.trust_context,
    } });
  }

  clearTrustSessions() {
    this.approvedPeers.clear();
    this.sessions.clear();
    this.inboundTails.clear();
  }
}

export function localE2eeChallengeProof(token, challenge) {
  return proof(token, challenge);
}
