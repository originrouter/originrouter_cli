import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { readApiToken } from "../persistence/authToken.js";
import { readCodingAuth } from "../persistence/codingAuth.js";
import { canonicalJson, verifyDeviceE2eeIdentity } from "../crypto/deviceE2eeIdentity.js";
import { DeviceE2eeSession } from "../crypto/deviceE2eeEnvelope.js";
import {
  deviceE2eeDirectoryCacheState,
  deviceE2eeDirectoryHead,
  readDeviceE2eeDirectoryCache,
} from "../security/deviceE2eeDirectoryCache.js";

const CHALLENGE_DOMAIN = "originrouter/local-e2ee-challenge/v2\n";
const CHALLENGE_TTL_MS = 60_000;
const MAX_RPC_BODY_BYTES = 8 * 1024 * 1024;

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

function currentTrustedIdentity(cache, deviceId, keyId) {
  return cache?.identities?.find((item) =>
    item.device_id === deviceId
      && item.key_id === keyId
      && item.trust_status === "trusted");
}

export class DeviceE2eeLocalGateway {
  constructor({ stateDir, localIdentity, apiTokenPath, fetchFn = globalThis.fetch }) {
    this.stateDir = stateDir;
    this.localIdentity = localIdentity;
    this.apiTokenPath = apiTokenPath;
    this.tokenStateDir = apiTokenPath ? dirname(apiTokenPath) : stateDir;
    this.fetchFn = fetchFn;
    this.challenges = new Map();
    this.approvedPeers = new Map();
    this.sessions = new Map();
    this.inboundTails = new Map();
  }

  _prune() {
    const now = Date.now();
    for (const [id, item] of this.challenges) {
      if (item.expires_at_ms <= now) this.challenges.delete(id);
    }
    for (const [keyId, item] of this.approvedPeers) {
      if (item.expires_at_ms <= now) this.approvedPeers.delete(keyId);
    }
    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt < now - 60 * 60_000) {
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
    const challenge = {
      protocol: "e2ee-v2",
      challenge_id: `e2c_${randomBytes(18).toString("base64url")}`,
      nonce: randomBytes(32).toString("base64url"),
      app_device_id: String(appDeviceId || "").slice(0, 191),
      app_key_id: String(appKeyId || "").slice(0, 96),
      cli_device_id: this.localIdentity.public_identity.device_id,
      cli_key_id: this.localIdentity.public_identity.key_id,
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
      cli_identity: this.localIdentity.public_identity,
    };
  }

  authorize({ challengeId, appIdentity, hmacProof }) {
    this._prune();
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
    const token = this._readLocalToken();
    if (!token || !safeEqual(hmacProof, proof(token, pending.challenge))) {
      const error = new Error("invalid local E2EE challenge proof");
      error.code = "invalid_challenge_proof";
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
    if (!deviceE2eeDirectoryCacheState(cache).usable) {
      const error = new Error("cached device trust state is too old");
      error.code = "device_trust_state_stale";
      throw error;
    }
    const publicFieldsMatch = trusted
      && Object.entries(appIdentity).every(([key, value]) =>
        canonicalJson(trusted[key] ?? null) === canonicalJson(value ?? null));
    if (!publicFieldsMatch) {
      const error = new Error("App device is not trusted in the cached directory");
      error.code = "app_device_not_trusted";
      throw error;
    }
    this.approvedPeers.set(appIdentity.key_id, {
      identity: appIdentity,
      expires_at_ms: Date.now() + 24 * 60 * 60 * 1000,
    });
    return {
      accepted: true,
      app_device_id: appIdentity.device_id,
      app_key_id: appIdentity.key_id,
      cli_key_id: this.localIdentity.public_identity.key_id,
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
    const credential = readCodingAuth(this.stateDir);
    const cache = credential?.sessionId
      ? readDeviceE2eeDirectoryCache(this.stateDir, {
          namespace: credential.sessionId,
        })
      : null;
    const localHead = deviceE2eeDirectoryHead(cache);
    if (!localHead || envelope?.routing?.directory_head !== localHead) {
      const error = new Error("local E2EE directory views do not agree");
      error.code = "device_e2ee_directory_fork";
      throw error;
    }
    let session = this.sessions.get(envelope?.session_id);
    let opened;
    if (session) {
      opened = session.open(envelope);
    } else {
      const approved = this.approvedPeers.get(envelope?.sender_key_id);
      if (!approved || approved.identity.device_id !== envelope?.source_device_id) {
        const error = new Error("local E2EE peer authorization required");
        error.code = "peer_authorization_required";
        throw error;
      }
      const accepted = DeviceE2eeSession.accept({
        local: this.localIdentity,
        peer: approved.identity,
        firstEnvelope: envelope,
      });
      session = accepted.session;
      opened = accepted.firstPayload;
      this.sessions.set(session.sessionId, session);
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
    return session.seal("local.rpc.response", {
      requestId: rpc.requestId,
      statusCode: response.status,
      body: responseBody,
    }, { routing: {
      request_id: String(rpc.requestId || ""),
      directory_head: localHead,
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
