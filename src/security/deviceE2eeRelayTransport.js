import { DeviceE2eeSession } from "../crypto/deviceE2eeEnvelope.js";
import {
  currentCachedDeviceIdentity,
  deviceE2eeDirectoryHead,
  deviceE2eeDirectoryCacheState,
  readDeviceE2eeDirectoryCache,
  storeDeviceE2eeDirectoryCache,
} from "./deviceE2eeDirectoryCache.js";
import { getCliDeviceE2eeDirectory } from "./deviceE2eeClient.js";

export const PROTECTED_DEVICE_MESSAGE_TYPES = new Set([
  "agent.control.subscribe",
  "agent.interactions.snapshot.request",
  "agent.interactions.snapshot",
  "agent.interaction.requested",
  "agent.interaction.resolve",
  "agent.interaction.result",
  "agent.history.request",
  "agent.history.page",
  "agent.audit.request",
  "agent.audit.page",
  "agent.inquiry.request",
  "agent.inquiry.page",
  "agent.message",
  "agent.message.result",
  "agent.stream.event",
  "agent.mode.set",
  "agent.autonomy.set",
  "agent.workspace.browse",
  "agent.workspace.page",
  "agent.workspace.trust",
  "agent.workspace.trust.result",
  "agent.launch.request",
  "session.stop",
  "session.start",
  "session.started",
  "session.exited",
  "session.error",
  "terminal.input",
  "terminal.output",
  "terminal.resize",
  "terminal.interrupt",
  "agent.event",
  "collaboration.remote.dispatch",
  "collaboration.remote.result",
  "collaboration.remote.error",
  "collaboration.remote.usage",
  "collaboration.remote.cancel",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function routeKeys(payload = {}, routing = {}) {
  const values = [
    text(payload.sessionId),
    text(payload.session_id),
    text(payload.requestId),
    text(payload.request_id),
    text(payload.interactionId),
    text(payload.interaction_id),
    text(payload.targetDeviceId),
    text(payload.target_device_id),
    text(payload.sourceDeviceId),
    text(payload.source_device_id),
    text(payload.assignmentId),
    text(payload.assignment_id),
    text(payload.runId),
    text(payload.run_id),
    text(payload.deliveryId),
    text(payload.delivery_id),
    text(routing.session_id),
    text(routing.request_id),
  ];
  if (Array.isArray(payload.sessionIds)) {
    values.push(...payload.sessionIds.map(text));
  }
  return [...new Set(values.filter(Boolean))];
}

export class DeviceE2eeRelayTransport {
  constructor({
    relayClient,
    localIdentity,
    stateDir,
    controlBaseUrl,
    credentialProvider,
  }) {
    this.relayClient = relayClient;
    this.localIdentity = localIdentity;
    this.stateDir = stateDir;
    this.controlBaseUrl = controlBaseUrl;
    this.credentialProvider = credentialProvider;
    this.sessions = new Map();
    this.routes = new Map();
    this.sendTails = new Map();
    this.inboundTail = Promise.resolve();
  }

  async _credential() {
    const credential = await this.credentialProvider();
    if (!credential?.accessTokens?.control?.token || !credential.sessionId) {
      const error = new Error("device E2EE directory authentication unavailable");
      error.code = "DEVICE_E2EE_AUTH_UNAVAILABLE";
      throw error;
    }
    return credential;
  }

  async _peer(deviceId, keyId, { refresh = false } = {}) {
    const credential = await this._credential();
    let cache = refresh ? null : readDeviceE2eeDirectoryCache(this.stateDir, {
      namespace: credential.sessionId,
    });
    let peer = cache?.identities?.find((item) =>
      item.device_id === deviceId
        && item.key_id === keyId
        && item.trust_status === "trusted");
    if (peer) return peer;
    const directory = await getCliDeviceE2eeDirectory({
      controlBaseUrl: this.controlBaseUrl,
      accessToken: credential.accessTokens.control.token,
    });
    cache = storeDeviceE2eeDirectoryCache(this.stateDir, directory, {
      namespace: credential.sessionId,
    });
    peer = cache.identities.find((item) =>
      item.device_id === deviceId
        && item.key_id === keyId
        && item.trust_status === "trusted");
    if (!peer) {
      const error = new Error("trusted E2EE peer key not found");
      error.code = "DEVICE_E2EE_PEER_UNAVAILABLE";
      throw error;
    }
    return peer;
  }

  async currentPeer(deviceId, { refresh = false } = {}) {
    const credential = await this._credential();
    let cache = refresh ? null : readDeviceE2eeDirectoryCache(this.stateDir, {
      namespace: credential.sessionId,
    });
    let peer = currentCachedDeviceIdentity(cache, deviceId);
    if (peer?.trust_status === "trusted") return peer;
    const directory = await getCliDeviceE2eeDirectory({
      controlBaseUrl: this.controlBaseUrl,
      accessToken: credential.accessTokens.control.token,
    });
    cache = storeDeviceE2eeDirectoryCache(this.stateDir, directory, {
      namespace: credential.sessionId,
    });
    peer = currentCachedDeviceIdentity(cache, deviceId);
    if (peer?.trust_status !== "trusted") {
      const error = new Error("target device is not trusted for E2EE");
      error.code = "DEVICE_E2EE_PEER_UNAVAILABLE";
      throw error;
    }
    return peer;
  }

  async _ensureDirectoryFresh() {
    const credential = await this._credential();
    let cache = readDeviceE2eeDirectoryCache(this.stateDir, {
      namespace: credential.sessionId,
    });
    if (deviceE2eeDirectoryCacheState(cache).fresh) return cache;
    try {
      const directory = await getCliDeviceE2eeDirectory({
        controlBaseUrl: this.controlBaseUrl,
        accessToken: credential.accessTokens.control.token,
      });
      cache = storeDeviceE2eeDirectoryCache(this.stateDir, directory, {
        namespace: credential.sessionId,
      });
      return cache;
    } catch (error) {
      if (deviceE2eeDirectoryCacheState(cache).usable) return cache;
      throw error;
    }
  }

  async refreshDirectory({ clearSessions = false } = {}) {
    const credential = await this._credential();
    const directory = await getCliDeviceE2eeDirectory({
      controlBaseUrl: this.controlBaseUrl,
      accessToken: credential.accessTokens.control.token,
    });
    const cache = storeDeviceE2eeDirectoryCache(this.stateDir, directory, {
      namespace: credential.sessionId,
    });
    if (clearSessions) this.clearSessions();
    return cache;
  }

  handleInbound(envelope) {
    const operation = this.inboundTail.then(() =>
      this._handleInboundSerial(envelope));
    this.inboundTail = operation.catch(() => {});
    return operation;
  }

  async _handleInboundSerial(envelope) {
    if (envelope?.protocol !== "e2ee-v2") return null;
    this._pruneSessions();
    await this._verifyPeerDirectoryHead(envelope?.routing?.directory_head);
    let session = this.sessions.get(envelope.session_id);
    let opened;
    if (session) {
      opened = session.open(envelope);
    } else {
      const peer = await this._peer(
        envelope.source_device_id,
        envelope.sender_key_id,
      );
      const accepted = DeviceE2eeSession.accept({
        local: this.localIdentity,
        peer,
        firstEnvelope: envelope,
      });
      session = accepted.session;
      opened = accepted.firstPayload;
      this.sessions.set(envelope.session_id, session);
    }
    const payload = { ...opened.payload, type: opened.type };
    for (const key of routeKeys(payload, envelope.routing)) {
      this.routes.delete(key);
      this.routes.set(key, session.sessionId);
    }
    this._pruneRoutes();
    return payload;
  }

  _pruneSessions() {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt >= cutoff) continue;
      this.sessions.delete(sessionId);
      for (const [key, value] of this.routes) {
        if (value === sessionId) this.routes.delete(key);
      }
    }
    while (this.sessions.size > 512) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
      for (const [key, value] of this.routes) {
        if (value === oldest) this.routes.delete(key);
      }
    }
    this._pruneRoutes();
  }

  _pruneRoutes() {
    for (const [key, sessionId] of this.routes) {
      if (!this.sessions.has(sessionId)) this.routes.delete(key);
    }
    while (this.routes.size > 8192) {
      const oldest = this.routes.keys().next().value;
      if (!oldest) break;
      this.routes.delete(oldest);
    }
  }

  async _verifyPeerDirectoryHead(peerHead) {
    if (!peerHead) {
      const error = new Error("E2EE peer omitted directory head");
      error.code = "DEVICE_E2EE_DIRECTORY_HEAD_REQUIRED";
      throw error;
    }
    let cache = await this._ensureDirectoryFresh();
    if (deviceE2eeDirectoryHead(cache) === peerHead) return;
    cache = await this.refreshDirectory();
    if (deviceE2eeDirectoryHead(cache) !== peerHead) {
      const error = new Error("E2EE directory views do not agree");
      error.code = "DEVICE_E2EE_DIRECTORY_FORK";
      throw error;
    }
  }

  async send(type, payload = {}) {
    if (!PROTECTED_DEVICE_MESSAGE_TYPES.has(type)) {
      return this.relayClient.send(type, payload);
    }
    const keys = routeKeys(payload);
    const route = keys.find((key) => this.routes.has(key));
    const sessionId = route ? this.routes.get(route) : null;
    let session = type === "collaboration.remote.dispatch"
      ? null
      : sessionId ? this.sessions.get(sessionId) : null;
    if (!session) {
      const targetDeviceId = text(payload.targetDeviceId)
        || text(payload.target_device_id);
      if (targetDeviceId) {
        const peer = await this.currentPeer(targetDeviceId);
        session = DeviceE2eeSession.initiate({
          local: this.localIdentity,
          peer,
        });
        this.sessions.set(session.sessionId, session);
        for (const key of keys) {
          this.routes.delete(key);
          this.routes.set(key, session.sessionId);
        }
        this._pruneRoutes();
      }
    }
    if (!session) {
      const error = new Error(`no E2EE session route for ${type}`);
      error.code = "DEVICE_E2EE_SESSION_REQUIRED";
      throw error;
    }
    const previous = this.sendTails.get(session.sessionId) || Promise.resolve();
    const operation = previous.then(async () => {
      const cache = await this._ensureDirectoryFresh();
      const currentPeer = currentCachedDeviceIdentity(cache, session.peer.device_id);
      if (currentPeer?.trust_status !== "trusted"
          || currentPeer.key_id !== session.peer.key_id) {
        this.sessions.delete(session.sessionId);
        for (const [key, value] of this.routes) {
          if (value === session.sessionId) this.routes.delete(key);
        }
        const error = new Error("E2EE peer trust or key changed");
        error.code = "DEVICE_E2EE_SESSION_STALE";
        throw error;
      }
      const routing = {
        ...(text(payload.sessionId) ? { session_id: text(payload.sessionId) } : {}),
        ...(text(payload.requestId) ? { request_id: text(payload.requestId) } : {}),
        directory_head: deviceE2eeDirectoryHead(cache),
      };
      const envelope = session.seal(type, payload, { routing });
      const result = await this.relayClient.sendEnvelope(envelope);
      const delivery = result?.data || result || {};
      if (delivery.accepted === false) {
        this.sessions.delete(session.sessionId);
        for (const [key, value] of this.routes) {
          if (value === session.sessionId) this.routes.delete(key);
        }
      }
      return result;
    });
    const tail = operation.catch(() => {});
    this.sendTails.set(session.sessionId, tail);
    return operation.finally(() => {
      if (this.sendTails.get(session.sessionId) === tail) {
        this.sendTails.delete(session.sessionId);
      }
    });
  }

  rejectsPlaintext(payload) {
    return payload?.protocol !== "e2ee-v2"
      && PROTECTED_DEVICE_MESSAGE_TYPES.has(payload?.type);
  }

  clearSessions() {
    this.sessions.clear();
    this.routes.clear();
    this.sendTails.clear();
  }
}
