import {
  DeviceE2eeGroupSession,
  DeviceE2eeSession,
  isGroupKeyId,
  isGroupTarget,
} from "../crypto/deviceE2eeEnvelope.js";
import {
  cachedDeviceStatus,
  currentCachedDeviceIdentity,
  deviceE2eeDirectoryHead,
  deviceE2eeDirectoryCacheState,
  deviceE2eeDirectoryNamespace,
  ensureDeviceE2eeDirectoryCacheMigrated,
  readDeviceE2eeDirectoryCache,
  storeDeviceE2eeDirectoryCache,
} from "./deviceE2eeDirectoryCache.js";
import { getCliDeviceE2eeDirectory } from "./deviceE2eeClient.js";
import {
  ensureSessionGroupKey,
  readSessionGroupKey,
} from "./sessionGroupKeyStore.js";

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
  "approval.policy.capabilities",
  "approval.policy.capabilities.result",
  "approval.policy.validate",
  "approval.policy.validate.result",
  "approval.policy.simulate",
  "approval.policy.simulate.result",
  "approval.policy.revisions",
  "approval.policy.revisions.result",
  "approval.policy.rollback",
  "approval.policy.rollback.result",
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
  "collaboration.remote.event",
  "collaboration.remote.interaction.resolve",
  "collaboration.remote.pause",
  "collaboration.capabilities.request",
  "collaboration.capabilities.response",
  "collaboration.workspace.trust.request",
  "collaboration.workspace.trust.response",
  "collaboration.control.request",
  "collaboration.control.response",
  "collaboration.remote.result",
  "collaboration.remote.error",
  "collaboration.remote.usage",
  "collaboration.remote.cancel",
  "collaboration.mcp.request",
  "collaboration.mcp.response",
]);

const ROUTE_SUBSCRIBER_TTL_MS = 2 * 60 * 1000;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// E2EE envelopes are canonically signed before they are encrypted. Unlike
// JSON.stringify, the canonical encoder intentionally rejects `undefined`;
// optional fields from runtime responses therefore must be normalized at the
// transport boundary. Keep normal JSON wire semantics: omit object fields and
// represent missing array values as null.
function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : withoutUndefined(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)]),
    );
  }
  return value;
}

// The session ids a subscribe actually names.
//
// Deliberately narrower than `routeKeys`, which folds in requestId,
// interactionId, target/source device ids and the like. Those name a *route*
// — the address a reply travels back on — and a request id in particular is
// fresh on every call, so treating one as a session mints a group key that
// nothing ever publishes under and that no device will ever ask for again.
//
// Only a real session id may back a group key. A subscribe that names none
// (a pure snapshot poll, say) mints nothing, which is correct: there is no
// session for the key to belong to.
function subscribeSessionIds(payload = {}) {
  const values = [
    text(payload.sessionId),
    text(payload.session_id),
    ...(Array.isArray(payload.sessionIds) ? payload.sessionIds.map(text) : []),
  ];
  return [...new Set(values.filter(Boolean))];
}

// The group keys a subscriber says it already holds, as { sessionId: keyId }.
//
// A subscribe is not a one-off: the App re-subscribes on every reconnect and on
// every directory lifecycle event, and each subscribe names every session the
// device knows about. Answering each one with the full key set turns a steady
// state into a stream of redundant envelopes that saturates the per-session
// send queue — one live event then waits behind hundreds of key deliveries that
// carry no new information.
//
// The subscriber is the only party that knows what it holds, so it reports it
// and the CLI skips what has not changed. A key that is absent, or whose id
// differs from the current one, is still sent: that is rotation, and skipping
// it would silently strand a subscriber on a key nothing publishes under.
function knownGroupKeyIds(payload = {}) {
  const raw = payload.knownGroupKeyIds || payload.known_group_key_ids;
  const known = new Map();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [sessionId, keyId] of Object.entries(raw)) {
      const id = text(sessionId);
      const value = text(keyId);
      if (id && value) known.set(id, value);
    }
  }
  return known;
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
    localIdentityProvider = null,
    stateDir,
    controlBaseUrl,
    credentialProvider,
  }) {
    this.relayClient = relayClient;
    this.localIdentity = localIdentity;
    this.localIdentityProvider = localIdentityProvider;
    this.stateDir = stateDir;
    this.controlBaseUrl = controlBaseUrl;
    this.credentialProvider = credentialProvider;
    this.sessions = new Map();
    this.routes = new Map();
    // A route key historically pointed at one E2EE session. Keep that
    // compatibility lookup for request/response traffic, but retain all
    // recently subscribed control sessions so live agent events can be
    // delivered to more than one authorized App device without one device
    // silently evicting another.
    this.routeSubscribers = new Map();
    this.sendTails = new Map();
    this.inboundTail = Promise.resolve();
  }

  setLocalIdentity(identity) {
    const publicIdentity = identity?.public_identity;
    if (!publicIdentity?.device_id || !publicIdentity?.key_id) {
      throw new Error("invalid local device E2EE identity");
    }
    if (publicIdentity.key_id === this.localIdentity?.public_identity?.key_id
        && publicIdentity.device_id === this.localIdentity?.public_identity?.device_id) {
      return false;
    }
    this.localIdentity = identity;
    this.clearSessions();
    return true;
  }

  _refreshLocalIdentity() {
    const next = this.localIdentityProvider?.();
    if (next) this.setLocalIdentity(next);
    return this.localIdentity;
  }

  async _credential() {
    const credential = await this.credentialProvider();
    if (!credential?.accessTokens?.control?.token || !credential.sessionId) {
      const error = new Error("device E2EE directory authentication unavailable");
      error.code = "DEVICE_E2EE_AUTH_UNAVAILABLE";
      throw error;
    }
    // The cache moved from a per-sign-in namespace to the account scope. Carry
    // any existing session-scoped state over once so the upgrade keeps its
    // pinned key history instead of starting cold.
    ensureDeviceE2eeDirectoryCacheMigrated(this.stateDir, credential);
    return credential;
  }

  async _peer(deviceId, keyId, { refresh = false } = {}) {
    const credential = await this._credential();
    let cache = refresh ? null : readDeviceE2eeDirectoryCache(this.stateDir, {
      namespace: deviceE2eeDirectoryNamespace(credential),
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
      namespace: deviceE2eeDirectoryNamespace(credential),
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
      namespace: deviceE2eeDirectoryNamespace(credential),
    });
    let peer = currentCachedDeviceIdentity(cache, deviceId);
    if (peer?.trust_status === "trusted") return peer;
    const directory = await getCliDeviceE2eeDirectory({
      controlBaseUrl: this.controlBaseUrl,
      accessToken: credential.accessTokens.control.token,
    });
    cache = storeDeviceE2eeDirectoryCache(this.stateDir, directory, {
      namespace: deviceE2eeDirectoryNamespace(credential),
    });
    peer = currentCachedDeviceIdentity(cache, deviceId);
    if (peer?.trust_status !== "trusted") {
      const status = cachedDeviceStatus(cache, deviceId);
      // Name the actual cause. A quarantined device failed chain verification
      // and is a different problem from one that is absent or untrusted, and
      // the two need different operator action.
      const error = new Error(status.usable
        ? "target device is not trusted for E2EE"
        : `target device is unusable for E2EE (${status.reason})`);
      error.code = "DEVICE_E2EE_PEER_UNAVAILABLE";
      error.deviceStatus = status.reason;
      throw error;
    }
    return peer;
  }

  async _ensureDirectoryFresh() {
    const credential = await this._credential();
    let cache = readDeviceE2eeDirectoryCache(this.stateDir, {
      namespace: deviceE2eeDirectoryNamespace(credential),
    });
    if (deviceE2eeDirectoryCacheState(cache).fresh) return cache;
    try {
      const directory = await getCliDeviceE2eeDirectory({
        controlBaseUrl: this.controlBaseUrl,
        accessToken: credential.accessTokens.control.token,
      });
      cache = storeDeviceE2eeDirectoryCache(this.stateDir, directory, {
        namespace: deviceE2eeDirectoryNamespace(credential),
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
      namespace: deviceE2eeDirectoryNamespace(credential),
    });
    if (clearSessions) this.clearSessions();
    return cache;
  }

  bindRoute(routeKey, relatedKeys = []) {
    const key = text(routeKey);
    if (!key) return false;
    const candidates = Array.isArray(relatedKeys) ? relatedKeys : [relatedKeys];
    const sessionId = candidates
      .map(text)
      .filter(Boolean)
      .map((candidate) => this.routes.get(candidate))
      .find((candidate) => candidate && this.sessions.has(candidate));
    if (!sessionId) return false;
    this.routes.delete(key);
    this.routes.set(key, sessionId);
    this._pruneRoutes();
    return true;
  }

  _rememberSubscribers(keys, sessionId) {
    const now = Date.now();
    for (const key of keys) {
      if (!key) continue;
      let subscribers = this.routeSubscribers.get(key);
      if (!subscribers) {
        subscribers = new Map();
        this.routeSubscribers.set(key, subscribers);
      }
      subscribers.set(sessionId, now);
    }
  }

  // Hand a subscriber the session group key over the pairwise session it just
  // established. The server never sees this: the key is sealed the same way
  // every other payload is, so the relay forwards one more opaque envelope.
  async _deliverGroupKey(payload, session, sessionIds = null) {
    // Deliberately narrower than `routeKeys`, which also folds in requestId and
    // targetDeviceId. Only real session ids name a publish route; a group key
    // minted for a request id would be a key nothing ever publishes under.
    //
    // The caller passes the set it already minted for, so delivery and minting
    // can never disagree about which sessions this subscribe covers.
    const targets = sessionIds ?? subscribeSessionIds(payload);
    // A subscriber that already holds the current key for a session does not
    // need it again. This is what makes a re-subscribe cheap: the steady state
    // sends nothing at all, so a live event is never queued behind key
    // deliveries it does not depend on.
    const known = knownGroupKeyIds(payload);
    // Collect first, send once. A subscribe carries every session the App
    // knows about — dozens of them — and each key used to be its own awaited
    // round trip on the same pairwise session. Because `_sendOnSession`
    // serializes per session (and it must: the pairwise sequence has to
    // advance in send order), those round trips could not overlap, so a
    // 40-session subscribe spent ~6s here. Worse, this runs inside
    // `_handleInboundSerial`, so every envelope behind it waited on the
    // wire, not on the work: history pages arrived ~18s late and the App
    // rendered a partial conversation until they caught up.
    //
    // Delivery is the only thing being batched — each session keeps its own
    // key, and the frames are identical to the ones sent before.
    const keys = [];
    for (const sessionId of targets) {
      const record = ensureSessionGroupKey(this.stateDir, sessionId);
      if (!record) continue;
      if (known.get(sessionId) === record.group_key_id) continue;
      keys.push({
        sessionId,
        groupKeyId: record.group_key_id,
        // The App reads `groupKey`; the field name is the wire contract.
        groupKey: Buffer.from(record.key).toString("base64url"),
      });
    }
    if (keys.length === 0) return;
    await this._sendOnSession(session, "agent.groupkey.response", { keys });
  }

  async _publishGroup(type, payload, { routeKey, subscriberSessions = null }) {
    const sessionId = text(routeKey) || text(payload.sessionId) || text(payload.session_id);
    if (!sessionId) return null;
    const record = readSessionGroupKey(this.stateDir, sessionId);
    if (!record) return null;
    // The caller may already hold the subscriber set — and in the targeted case
    // it deliberately excludes the explicit recipient, which the relay does not
    // know as a subscriber. Recomputing it here would put that recipient back
    // in the fan-out and lose the sealed copy it needs.
    const subscribers = subscriberSessions
      ?? this._subscriberSessions(sessionId);
    if (subscribers.length === 0) return { accepted: false, reason: "no_subscribers" };
    const localIdentity = this._refreshLocalIdentity();
    const group = new DeviceE2eeGroupSession({
      local: localIdentity,
      sessionId,
      groupKeyId: record.group_key_id,
      key: record.key,
    });
    const envelope = group.seal(type, withoutUndefined(payload), {
      routing: { session_id: sessionId },
    });
    const result = await this.relayClient.sendEnvelope(envelope);
    const delivery = result?.data || result || {};
    return {
      accepted: delivery.accepted !== false,
      reason: delivery.accepted === false ? (delivery.reason || "relay_rejected") : "",
      // Report the fan-out the relay performed so callers can log the real
      // audience size; the wire carried exactly one ciphertext.
      recipients: Number(delivery.recipients || 0) || undefined,
    };
  }

  _subscriberSessions(routeKey, { excludeSessionIds = null } = {}) {
    const subscribers = this.routeSubscribers.get(text(routeKey));
    if (!subscribers) return [];
    const cutoff = Date.now() - ROUTE_SUBSCRIBER_TTL_MS;
    const sessions = [];
    for (const [sessionId, lastSeenAt] of subscribers) {
      if (lastSeenAt < cutoff || !this.sessions.has(sessionId)) {
        subscribers.delete(sessionId);
        continue;
      }
      if (!excludeSessionIds?.has(sessionId)) {
        sessions.push(this.sessions.get(sessionId));
      }
    }
    if (subscribers.size === 0) this.routeSubscribers.delete(text(routeKey));
    return sessions.filter(Boolean);
  }

  handleInbound(envelope) {
    const operation = this.inboundTail.then(() =>
      this._handleInboundSerial(envelope));
    this.inboundTail = operation.catch(() => {});
    return operation;
  }

  async _handleInboundSerial(envelope) {
    if (envelope?.protocol !== "e2ee-v2") return null;
    // The CLI publishes group envelopes; it does not consume them. One arriving
    // here is either a misrouted fan-out or an attempt to be read as pairwise,
    // and pairwise acceptance would fail confusingly (no `target_device_id`
    // match). Refuse it by shape, before the directory-head check, so the
    // rejection is legible and does not depend on what routing the sender used.
    if (isGroupTarget(envelope.target_device_id)
        || isGroupKeyId(envelope.recipient_key_id)) {
      return null;
    }
    const localIdentity = this._refreshLocalIdentity();
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
        local: localIdentity,
        peer,
        firstEnvelope: envelope,
      });
      session = accepted.session;
      opened = accepted.firstPayload;
      this.sessions.set(envelope.session_id, session);
    }
    const payload = { ...opened.payload, type: opened.type };
    const keys = routeKeys(payload, envelope.routing);
    for (const key of keys) {
      this.routes.delete(key);
      this.routes.set(key, session.sessionId);
    }
    if (payload.type === "agent.control.subscribe") {
      // Subscribers are remembered against every route key — the request id is
      // how a reply addressed to this poll is routed back, so it stays.
      this._rememberSubscribers(keys, session.sessionId);
      // Group keys, by contrast, are minted only for real session ids. See
      // `subscribeSessionIds` for why the two sets differ.
      const sessionIds = subscribeSessionIds(payload);
      // Mint synchronously, before the delivery is issued: a subscriber's own
      // group key must exist by the time the next event publishes, or the
      // first event after a subscribe would go out pairwise to everyone.
      for (const sessionId of sessionIds) {
        ensureSessionGroupKey(this.stateDir, sessionId);
      }
      // Deliver the key before returning this envelope's turn. This handler is
      // serialized by `inboundTail`, so anything awaited here parks every
      // envelope behind it — including the history page the App is waiting to
      // render — and a subscribe that brings new sessions must not do that more
      // than once: the key set is sent as one frame (see `_deliverGroupKey`),
      // so a 40-session subscribe costs a single round trip rather than forty.
      //
      // It is awaited rather than fired and forgotten because the App drops a
      // group event whose key it does not yet hold (`_openGroupIncoming`), and
      // the first event after a subscribe can follow immediately. Ordering
      // cannot be recovered later, so the key goes out first.
      await this._deliverGroupKey(payload, session, sessionIds);
    }
    this._pruneRoutes();
    // Keep the origin metadata internal to the daemon. It is deliberately
    // non-wire and is removed by callers that forward business payloads.
    return Object.defineProperties(payload, {
      __originrouterSourceDeviceId: {
        value: session.peer?.device_id || envelope.source_device_id || "",
        enumerable: false,
      },
      __originrouterE2eeSessionId: {
        value: session.sessionId,
        enumerable: false,
      },
    });
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
    for (const [key, subscribers] of this.routeSubscribers) {
      for (const [sessionId, lastSeenAt] of subscribers) {
        if (!this.sessions.has(sessionId) ||
            lastSeenAt < Date.now() - ROUTE_SUBSCRIBER_TTL_MS) {
          subscribers.delete(sessionId);
        }
      }
      if (subscribers.size === 0) this.routeSubscribers.delete(key);
    }
    while (this.routes.size > 8192) {
      const oldest = this.routes.keys().next().value;
      if (!oldest) break;
      this.routes.delete(oldest);
    }
  }

  _discardSession(sessionId) {
    const id = text(sessionId);
    if (!id) return;
    this.sessions.delete(id);
    for (const [key, value] of this.routes) {
      if (value === id) this.routes.delete(key);
    }
    for (const [key, subscribers] of this.routeSubscribers) {
      subscribers.delete(id);
      if (subscribers.size === 0) this.routeSubscribers.delete(key);
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
    const localIdentity = this._refreshLocalIdentity();
    if (!PROTECTED_DEVICE_MESSAGE_TYPES.has(type)) {
      return this.relayClient.send(type, payload);
    }
    const wirePayload = withoutUndefined(payload);
    const keys = routeKeys(wirePayload);
    const explicitTargetDeviceId = text(wirePayload.targetDeviceId)
      || text(wirePayload.target_device_id);
    // An explicit target is authoritative. Without this guard, a conflict
    // response carrying both sessionId and targetDeviceId could be sent to
    // whichever App most recently refreshed the session route.
    const route = explicitTargetDeviceId
      ? null
      : keys.find((key) => this.routes.has(key));
    const sessionId = route ? this.routes.get(route) : null;
    let session = type === "collaboration.remote.dispatch"
      ? null
      : sessionId ? this.sessions.get(sessionId) : null;
    if (!session) {
      const targetDeviceId = text(wirePayload.targetDeviceId)
        || text(wirePayload.target_device_id);
      if (targetDeviceId) {
        const peer = await this.currentPeer(targetDeviceId);
        session = DeviceE2eeSession.initiate({
          local: localIdentity,
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
    return this._sendOnSession(session, type, wirePayload);
  }

  async _ensureTargetSession({ targetDeviceId, keys = [], localIdentity }) {
    const peer = await this.currentPeer(targetDeviceId);
    const existing = [...this.sessions.values()].find((candidate) =>
      candidate?.peer?.device_id === targetDeviceId
        && candidate?.peer?.key_id === peer.key_id,
    );
    if (existing) return existing;
    // A device key rotation invalidates any prior E2EE session. Remove the
    // stale route before creating the replacement so one event is not sent to
    // both the old and new key.
    for (const [sessionId, candidate] of this.sessions) {
      if (candidate?.peer?.device_id !== targetDeviceId) continue;
      this.sessions.delete(sessionId);
      for (const [routeKey, routedSessionId] of this.routes) {
        if (routedSessionId === sessionId) this.routes.delete(routeKey);
      }
      for (const subscribers of this.routeSubscribers.values()) {
        subscribers.delete(sessionId);
      }
    }
    const session = DeviceE2eeSession.initiate({
      local: localIdentity,
      peer,
    });
    this.sessions.set(session.sessionId, session);
    for (const key of keys) {
      this.routes.delete(key);
      this.routes.set(key, session.sessionId);
    }
    this._pruneRoutes();
    return session;
  }

  async _sendOnSession(session, type, wirePayload) {
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
        ...(text(wirePayload.sessionId) ? { session_id: text(wirePayload.sessionId) } : {}),
        ...(text(wirePayload.requestId) ? { request_id: text(wirePayload.requestId) } : {}),
        directory_head: deviceE2eeDirectoryHead(cache),
      };
      const envelope = session.seal(type, wirePayload, { routing });
      const result = await this.relayClient.sendEnvelope(envelope);
      const delivery = result?.data || result || {};
      if (delivery.accepted === false) {
        this._discardSession(session.sessionId);
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

  /**
   * Forward a live event to every recently subscribed App for a session.
   * Request/response traffic continues to use send(), which intentionally
   * follows the latest route. A failed subscriber is discarded while healthy
   * subscribers still receive the event.
   */
  async sendBroadcast(type, payload = {}, { routeKey } = {}) {
    const key = text(routeKey) || text(payload.sessionId) || text(payload.session_id);
    const sessions = this._subscriberSessions(key);
    const wirePayload = withoutUndefined(payload);
    // No subscriber means the event went nowhere, and saying so is the useful
    // answer. Falling through to `send` would fail on a route this session has
    // no session for and raise a "no route" error for every streamed event,
    // thousands per session, describing a situation that is not an error.
    if (sessions.length === 0) return { accepted: false, reason: "no_subscribers" };
    // Exactly one subscriber is a delivery, not a degenerate broadcast: that
    // App must receive the event, and folding it into an early return would
    // drop the only copy.
    if (sessions.length === 1) {
      return this._sendOnSession(sessions[0], type, wirePayload);
    }
    // One ciphertext for N viewers is the whole point of the group key: seal
    // once under the session key and let the relay fan it out, instead of
    // re-encrypting per subscriber. Only fall back to per-session encryption
    // when there is no group key yet — a subscriber that has not finished its
    // key delivery still has to receive the event.
    const published = await this._publishGroup(type, wirePayload, { routeKey: key });
    if (published?.accepted) return published;
    const results = await Promise.allSettled(
      sessions.map((session) => this._sendOnSession(session, type, wirePayload)),
    );
    let accepted = false;
    let reason = "";
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        const delivery = result.value?.data || result.value || {};
        if (delivery.accepted !== false) accepted = true;
        else reason ||= delivery.reason || "relay_rejected";
      } else {
        reason ||= result.reason?.code || result.reason?.message || "relay_error";
        const session = sessions[index];
        if (session) this._discardSession(session.sessionId);
      }
    });
    return { accepted, reason };
  }

  /**
   * Deliver a targeted event to its explicit recipient and to every other
   * App that has an active control subscription for the same session. The
   * explicit recipient remains authoritative when no App subscription exists
   * yet (for example immediately after a collaboration worker starts).
   */
  async sendTargetedAndSubscribers(
    type,
    payload = {},
    { targetDeviceId, routeKey } = {},
  ) {
    const target = text(targetDeviceId)
      || text(payload.targetDeviceId)
      || text(payload.target_device_id);
    const key = text(routeKey) || text(payload.sessionId) || text(payload.session_id);
    if (!target) return this.sendBroadcast(type, payload, { routeKey: key });

    const localIdentity = this._refreshLocalIdentity();
    const wirePayload = withoutUndefined({
      ...payload,
      targetDeviceId: target,
    });
    const keys = routeKeys(wirePayload);
    const targetSession = await this._ensureTargetSession({
      targetDeviceId: target,
      keys,
      localIdentity,
    });
    const sessions = [
      targetSession,
      ...this._subscriberSessions(key, {
        excludeSessionIds: new Set([targetSession.sessionId]),
      }),
    ];
    // The target's own sealed copy is what makes it authoritative, and it is
    // sent on the pairwise session either way. The group publish is therefore
    // an *additional* delivery for the other subscribers, worth its own
    // ciphertext as soon as there is more than one of them. Dropping the target
    // out of the count is the point: including it would make a two-viewer
    // audience (target + one subscriber) pay two ciphertexts where one shared
    // one plus the target's copy would do.
    const subscribers = sessions.slice(1);
    const published = subscribers.length > 1
      ? await this._publishGroup(type, wirePayload, {
        routeKey: key,
        subscriberSessions: subscribers,
      })
      : null;
    const pairwise = published ? [targetSession] : sessions;
    const results = await Promise.allSettled(
      pairwise.map((session) => this._sendOnSession(session, type, wirePayload)),
    );
    let accepted = published ? published.accepted : false;
    let reason = published ? published.reason : "";
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        const delivery = result.value?.data || result.value || {};
        if (delivery.accepted !== false) accepted = true;
        else reason ||= delivery.reason || "relay_rejected";
      } else {
        reason ||= result.reason?.code || result.reason?.message || "relay_error";
        const session = pairwise[index];
        if (session) this._discardSession(session.sessionId);
      }
    });
    return { accepted, reason };
  }

  rejectsPlaintext(payload) {
    return payload?.protocol !== "e2ee-v2"
      && PROTECTED_DEVICE_MESSAGE_TYPES.has(payload?.type);
  }

  clearSessions() {
    this.sessions.clear();
    this.routes.clear();
    this.routeSubscribers.clear();
    this.sendTails.clear();
  }
}
