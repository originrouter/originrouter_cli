import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
} from "../src/crypto/deviceE2eeIdentity.js";
import { DeviceE2eeSession } from "../src/crypto/deviceE2eeEnvelope.js";
import {
  deviceE2eeDirectoryHead,
  storeDeviceE2eeDirectoryCache,
} from "../src/security/deviceE2eeDirectoryCache.js";
import { DeviceE2eeRelayTransport } from "../src/security/deviceE2eeRelayTransport.js";
import {
  readSessionGroupKey,
  sessionGroupKeyPath,
} from "../src/security/sessionGroupKeyStore.js";
import { existsSync } from "node:fs";

const root = mkdtempSync(join(tmpdir(), "originrouter-e2ee-relay-"));
const app = ensureDeviceE2eeIdentity(join(root, "app"), { deviceId: "app-device" });
const app2 = ensureDeviceE2eeIdentity(join(root, "app-2"), { deviceId: "app-device-2" });
const cli = ensureDeviceE2eeIdentity(join(root, "cli"), { deviceId: "cli-device" });
// A device that is trusted and reachable but never subscribes: the shape of a
// collaboration worker being targeted before any App has subscribed.
const worker = ensureDeviceE2eeIdentity(join(root, "worker"), { deviceId: "worker-device" });
const stateDir = join(root, "state");
const credential = {
  sessionId: "or_ses_test",
  accessTokens: { control: { token: "or_at_test" } },
};
const cachedDirectory = storeDeviceE2eeDirectoryCache(stateDir, {
  policy: { epoch: 1, new_device_approval_required: false },
  identities: [
    { ...app.public_identity, trust_status: "trusted" },
    { ...app2.public_identity, trust_status: "trusted" },
    { ...cli.public_identity, trust_status: "trusted" },
    { ...worker.public_identity, trust_status: "trusted" },
  ],
}, { namespace: credential.sessionId });
const sent = [];
const transport = new DeviceE2eeRelayTransport({
  relayClient: {
    send: async (type, payload) => sent.push({ type, payload }),
    sendEnvelope: async (envelope) => sent.push(envelope),
  },
  localIdentity: cli,
  stateDir,
  controlBaseUrl: "https://example.invalid",
  credentialProvider: async () => credential,
});
// A subscribe now also carries a group key response, so each App session's
// receive counter advances by frames this test does not assert on. Open frames
// by draining each session in order and remembering how far it has been read,
// which keeps every later assertion independent of those extra deliveries.
// A group key is persisted under a hash of its session id, so the only honest
// question to ask of the key store is "does a key exist for this id" — not
// what the file is called.
function sessionGroupKeyExists(directory, id) {
  return existsSync(sessionGroupKeyPath(directory, id));
}
const drains = new Map();
function drain(session) {
  const frames = sent.filter((item) => item.protocol === "e2ee-v2"
    && item.session_id === session.sessionId);
  const from = drains.get(session.sessionId) || 0;
  const opened = frames.slice(from).map((frame) => session.open(frame));
  drains.set(session.sessionId, frames.length);
  return opened;
}
function latestFor(session) {
  const opened = drain(session);
  return opened.at(-1);
}
const appSession = DeviceE2eeSession.initiate({
  local: app,
  peer: cli.public_identity,
  sessionId: "e2s_relay_test",
});
const subscribe = appSession.seal("agent.control.subscribe", {
  sessionIds: ["agent-session-1"],
}, { routing: {
  session_id: "agent-session-1",
  directory_head: deviceE2eeDirectoryHead(cachedDirectory),
} });
const clear = await transport.handleInbound(subscribe);
assert.equal(clear.type, "agent.control.subscribe");

const app2Session = DeviceE2eeSession.initiate({
  local: app2,
  peer: cli.public_identity,
  sessionId: "e2s_relay_test_app_2",
});
const clearSecondSubscription = await transport.handleInbound(app2Session.seal(
  "agent.control.subscribe",
  { requestId: "subscribe-2", sessionIds: ["agent-session-1"] },
  { routing: {
    session_id: "agent-session-1",
    request_id: "subscribe-2",
    directory_head: deviceE2eeDirectoryHead(cachedDirectory),
  } },
));
assert.equal(clearSecondSubscription.type, "agent.control.subscribe");

await transport.sendBroadcast("agent.stream.event", {
  sessionId: "agent-session-1",
  event: { text: "secret stream" },
}, { routeKey: "agent-session-1" });
// Each subscribe delivers its group key, and the publish then costs one
// ciphertext instead of one per viewer. That is 2 key deliveries + 1 group
// envelope, plus the subscribe acknowledgements the two subscribes also send —
// which is why this counts 4, not 3.
const groupFrames = sent.filter(
  (item) => item.protocol === "e2ee-v2" && item.target_device_id?.startsWith("grp-session:"),
);
assert.equal(groupFrames.length, 1);
assert.equal(groupFrames[0].target_device_id, "grp-session:agent-session-1");
assert.equal(groupFrames[0].recipient_key_id.startsWith("grp:"), true);
assert.equal(JSON.stringify(groupFrames[0]).includes("secret stream"), false);

// A subscribe carries a fresh request id on every poll, and the App sends one
// per device on every snapshot. That id names a *route*, not a session: a
// group key minted for it would be persisted forever, delivered to nobody who
// asks for it again, and — because the App re-polls on a timer — would grow the
// key directory without bound, one dead file per poll, each costing a full
// round trip to deliver. The second subscription above carries
// `requestId: "subscribe-2"`; only a real session id may back a key.
assert.equal(
  sessionGroupKeyExists(stateDir, "agent-session-1"),
  true,
  "the real session id must still mint its group key",
);
assert.equal(
  sessionGroupKeyExists(stateDir, "subscribe-2"),
  false,
  "a request id must not mint a group key",
);

// A failed subscriber must be removed from both the subscription index and
// the route index. Otherwise a later single-subscriber broadcast can reuse
// the dead session and fail repeatedly instead of using the healthy device.
const failingTransport = new DeviceE2eeRelayTransport({
  relayClient: {
    send: async () => {},
    sendEnvelope: async (envelope) => {
      if (envelope.target_device_id === "app-device-2") {
        throw Object.assign(new Error("subscriber socket closed"), {
          code: "SOCKET_CLOSED",
        });
      }
      return { accepted: true };
    },
  },
  localIdentity: cli,
  stateDir,
  controlBaseUrl: "https://example.invalid",
  credentialProvider: async () => credential,
});
await failingTransport.handleInbound(subscribe);
await failingTransport.handleInbound(clearSecondSubscription);
await failingTransport.sendBroadcast("agent.stream.event", {
  sessionId: "agent-session-1",
  event: { text: "healthy after failure" },
}, { routeKey: "agent-session-1" });
assert.equal(failingTransport.routes.has("agent-session-1"), true);

// The coordinator is also a subscriber here, so it receives the shared group
// ciphertext like any other viewer. What the target parameter adds is a second,
// independent delivery: a copy sealed on the coordinator's own pairwise
// session, which does not depend on the relay having registered it as a
// subscriber. That redundancy is the contract, not an inefficiency to tune away.
const beforeTargetedSubscribers = sent.length;
await transport.sendTargetedAndSubscribers("agent.stream.event", {
  sessionId: "agent-session-1",
  event: { text: "target plus subscribers" },
}, {
  targetDeviceId: "app-device-2",
  routeKey: "agent-session-1",
});
const targetedFrames = sent.slice(beforeTargetedSubscribers);
assert.equal(
  targetedFrames.filter((frame) => frame.target_device_id === "app-device-2").length,
  1,
  "the explicit recipient always gets a copy sealed on its own session",
);

// The case the method exists for: the coordinator has never subscribed. A
// collaboration worker's first event is exactly this — the worker is targeted
// before any App has subscribed, so it appears in no subscription the relay
// knows about. A group envelope names no recipient, so it reaches only the
// registered subscribers; the coordinator must therefore be sealed separately
// or it would miss the event entirely while the call still reported success.
{
  const frames = [];
  const targeted = new DeviceE2eeRelayTransport({
    relayClient: {
      send: async () => ({ accepted: true }),
      sendEnvelope: async (envelope) => {
        frames.push(envelope);
        return { accepted: true };
      },
    },
    localIdentity: cli,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  // Two ordinary viewers subscribe to the session. Neither is the target.
  const viewerOne = DeviceE2eeSession.initiate({
    local: app,
    peer: cli.public_identity,
    sessionId: "e2s_targeted_viewer_one",
  });
  await targeted.handleInbound(viewerOne.seal(
    "agent.control.subscribe",
    { requestId: "viewer-one", sessionIds: ["agent-session-1"] },
    { routing: {
      session_id: "agent-session-1",
      request_id: "viewer-one",
      directory_head: deviceE2eeDirectoryHead(cachedDirectory),
    } },
  ));
  const viewerTwo = DeviceE2eeSession.initiate({
    local: app2,
    peer: cli.public_identity,
    sessionId: "e2s_targeted_viewer_two",
  });
  await targeted.handleInbound(viewerTwo.seal(
    "agent.control.subscribe",
    { requestId: "viewer-two", sessionIds: ["agent-session-1"] },
    { routing: {
      session_id: "agent-session-1",
      request_id: "viewer-two",
      directory_head: deviceE2eeDirectoryHead(cachedDirectory),
    } },
  ));
  frames.length = 0;
  await targeted.sendTargetedAndSubscribers("agent.stream.event", {
    sessionId: "agent-session-1",
    event: { text: "coordinator must receive this" },
  }, {
    // A trusted device that never subscribed: the relay cannot route a group
    // envelope to it, because a group envelope names no recipient.
    targetDeviceId: "worker-device",
    routeKey: "agent-session-1",
  });
  assert.equal(
    frames.filter((frame) => frame.target_device_id === "worker-device").length,
    1,
    "an unsubscribed explicit recipient must still get its own sealed copy",
  );
  assert.equal(
    frames.filter((frame) => frame.target_device_id === "grp-session:agent-session-1").length,
    1,
    "the two subscribers still share a single ciphertext",
  );
  assert.equal(JSON.stringify(frames).includes("coordinator must receive this"), false);
}

// No subscribed App is the ordinary case for an idle Agent — the App is open
// but sitting on another conversation. The broadcast must report that plainly
// instead of falling through to send(), which cannot route a payload that
// carries no targetDeviceId and throws. That throw became a "no E2EE session
// route" line for every streamed event, thousands per session, describing a
// situation that is not an error at all.
{
  const isolated = new DeviceE2eeRelayTransport({
    relayClient: {
      send: async () => ({ accepted: true }),
      sendEnvelope: async () => ({ accepted: true }),
    },
    localIdentity: cli,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  const result = await isolated.sendBroadcast("agent.stream.event", {
    sessionId: "session-with-no-watchers",
    event: { text: "nobody is subscribed" },
  }, { routeKey: "session-with-no-watchers" });
  assert.deepEqual(result, { accepted: false, reason: "no_subscribers" });
}

// Exactly one subscriber is a delivery, not a degenerate broadcast: that App
// must receive the event. Folding it into the no-subscriber branch would drop
// the only copy, and the caller would never learn the event went nowhere.
{
  const frames = [];
  const isolatedRelay = {
    send: async () => ({ accepted: true }),
    sendEnvelope: async (envelope) => {
      frames.push(envelope);
      return { accepted: true };
    },
  };
  const single = new DeviceE2eeRelayTransport({
    relayClient: isolatedRelay,
    localIdentity: cli,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  await single.handleInbound(subscribe);
  frames.length = 0;
  const result = await single.sendBroadcast("agent.stream.event", {
    sessionId: "agent-session-1",
    event: { text: "only watcher" },
  }, { routeKey: "agent-session-1" });
  assert.equal(result.accepted, true);
  assert.equal(frames.length, 1, "the single subscriber must receive the event");
  // Assert on the sealed frame, not a reopened payload: this transport holds
  // its own session started at sequence 0, so the shared `appSession` — whose
  // sequence has advanced through the earlier cases — cannot open it.
  assert.equal(frames[0].protocol, "e2ee-v2");
  assert.equal(frames[0].target_device_id, "app-device");
  assert.equal(JSON.stringify(frames[0]).includes("only watcher"), false);
}

await transport.send("collaboration.control.response", {
  sessionId: "agent-session-1",
  data: {
    text: "optional response fields are wire-safe",
    absent: undefined,
    nested: { absent: undefined, retained: true },
    values: ["present", undefined, { absent: undefined, retained: "nested" }],
  },
});
// Request/response traffic still uses one pairwise session per device. This
// App's session is a single receive counter, so drain its new frames in order
// and keep the opened results; re-opening an already-consumed sequence would
// trip the counter. The transport may also hold a second, CLI-initiated
// session to this device for an explicit target, which this App does not
// receive on and is excluded here.
const sanitized = latestFor(app2Session).payload.data;
assert.equal("absent" in sanitized, false);
assert.deepEqual(sanitized.nested, { retained: true });
assert.deepEqual(sanitized.values, ["present", null, { retained: "nested" }]);

// A conflict result carries both the logical session and the losing App's
// device id. The explicit device target must win over the session's latest
// subscriber route, otherwise the wrong App can receive the error. An explicit
// target opens its own session to that device rather than reusing the
// subscriber route, so read the frame on that session.
await transport.send("agent.interaction.result", {
  sessionId: "agent-session-1",
  interactionId: "permission-1",
  status: "conflict",
  targetDeviceId: "app-device-2",
});
const conflictFrame = sent.at(-1);
const targetedConflict = DeviceE2eeSession.accept({
  local: app2, peer: cli.public_identity, firstEnvelope: conflictFrame,
}).firstPayload;
assert.equal(targetedConflict.payload.targetDeviceId, "app-device-2");

const inboundCollaboration = appSession.seal("collaboration.remote.dispatch", {
  protocolVersion: "1",
  sourceDeviceId: "app-device",
  targetDeviceId: "cli-device",
  assignmentId: "assignment-inbound",
  runId: "run-inbound",
  taskId: "task-inbound",
  role: "worker",
  prompt: "private inbound objective",
}, { routing: {
  directory_head: deviceE2eeDirectoryHead(cachedDirectory),
} });
assert.equal(
  (await transport.handleInbound(inboundCollaboration)).assignmentId,
  "assignment-inbound",
);
assert.equal(
  transport.bindRoute("managed-session-inbound", ["assignment-inbound"]),
  true,
);
await transport.send("agent.stream.event", {
  sessionId: "managed-session-inbound",
  event: { text: "bound collaboration stream" },
});
assert.equal(
  latestFor(appSession).payload.event.text,
  "bound collaboration stream",
);
assert.equal(transport.bindRoute("orphan-session", ["missing-assignment"]), false);
assert.equal(transport.rejectsPlaintext({
  type: "agent.message",
  message: "must reject",
}), true);
for (const type of [
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
  "collaboration.capabilities.request",
  "collaboration.capabilities.response",
  "collaboration.control.request",
  "collaboration.control.response",
  "collaboration.workspace.trust.request",
  "collaboration.workspace.trust.response",
]) {
  assert.equal(transport.rejectsPlaintext({ type }), true, type);
}

await transport.send("collaboration.remote.dispatch", {
  protocolVersion: "1",
  sourceDeviceId: "cli-device",
  targetDeviceId: "app-device",
  assignmentId: "assignment-1",
  runId: "run-1",
  taskId: "task-1",
  role: "worker",
  prompt: "private collaboration objective",
});
const firstCollaborationEnvelope = sent.at(-1);
assert.equal(firstCollaborationEnvelope.protocol, "e2ee-v2");
assert.equal(JSON.stringify(firstCollaborationEnvelope).includes("private collaboration objective"), false);
const acceptedCollaboration = DeviceE2eeSession.accept({
  local: app,
  peer: cli.public_identity,
  firstEnvelope: firstCollaborationEnvelope,
});
assert.equal(
  acceptedCollaboration.firstPayload.payload.prompt,
  "private collaboration objective",
);
assert.equal(transport.rejectsPlaintext({
  type: "collaboration.remote.dispatch",
  prompt: "must reject",
}), true);
await transport.send("collaboration.remote.dispatch", {
  protocolVersion: "1",
  sourceDeviceId: "cli-device",
  targetDeviceId: "app-device",
  assignmentId: "assignment-2",
  runId: "run-2",
  taskId: "task-2",
  role: "worker",
  prompt: "second private objective",
});
const secondCollaborationEnvelope = sent.at(-1);
assert.notEqual(firstCollaborationEnvelope.session_id, secondCollaborationEnvelope.session_id);
assert.equal(firstCollaborationEnvelope.sequence, 0);
assert.equal(secondCollaborationEnvelope.sequence, 0);

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const orderedSent = [];
// Every stream envelope is gated so the test can prove they are serialized.
// The subscribe's group key response is not gated: `handleInbound` awaits it,
// so gating it here would deadlock the subscribe itself. Only stream sends
// consume a gate.
const sendGates = [deferred(), deferred()];
let orderedGateIndex = 0;
const orderedTransport = new DeviceE2eeRelayTransport({
  relayClient: {
    send: async () => {},
    sendEnvelope: async (envelope) => {
      orderedSent.push(envelope);
      if (envelope.type !== "agent.stream.event") return { accepted: true };
      const index = orderedGateIndex++;
      await sendGates[Math.min(index, sendGates.length - 1)].promise;
      return { accepted: true };
    },
  },
  localIdentity: cli,
  stateDir,
  controlBaseUrl: "https://example.invalid",
  credentialProvider: async () => credential,
});
const orderedAppSession = DeviceE2eeSession.initiate({
  local: app,
  peer: cli.public_identity,
  sessionId: "e2s_relay_ordered",
});
await orderedTransport.handleInbound(orderedAppSession.seal(
  "agent.control.subscribe",
  { sessionIds: ["agent-session-ordered"] },
  { routing: {
    session_id: "agent-session-ordered",
    directory_head: deviceE2eeDirectoryHead(cachedDirectory),
  } },
));
// Frame 0 is the subscribe's group key response and has already flushed. Both
// stream sends are issued before either is allowed to flush, which is what
// proves the per-session send tail serializes them.
const firstSend = orderedTransport.send("agent.stream.event", {
  sessionId: "agent-session-ordered",
  event: { text: "first" },
});
const secondSend = orderedTransport.send("agent.stream.event", {
  sessionId: "agent-session-ordered",
  event: { text: "second" },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(orderedSent.length, 2);
assert.equal(orderedSent[0].type, "agent.groupkey.response");
assert.equal(orderedSent[1].type, "agent.stream.event");
// Sequence 1, not 0: the group key response shares this pairwise session and
// consumed sequence 0.
assert.equal(orderedSent[1].sequence, 1);
sendGates[0].resolve();
await firstSend;
await new Promise((resolve) => setImmediate(resolve));
assert.equal(orderedSent.length, 3);
assert.equal(orderedSent[2].type, "agent.stream.event");
assert.equal(orderedSent[2].sequence, 2);
sendGates[1].resolve();
await secondSend;

// Relay encryption must also stop using a startup-time private-key snapshot.
// Switching the provider identity clears old routes and the next independent
// dispatch is sealed by the newly activated key.
let liveRelayIdentity = cli;
const hotReloadSent = [];
const hotReloadTransport = new DeviceE2eeRelayTransport({
  relayClient: {
    send: async () => {},
    sendEnvelope: async (envelope) => {
      hotReloadSent.push(envelope);
      return { accepted: true };
    },
  },
  localIdentity: cli,
  localIdentityProvider: () => liveRelayIdentity,
  stateDir,
  controlBaseUrl: "https://example.invalid",
  credentialProvider: async () => credential,
});
hotReloadTransport.sessions.set("stale-session", { lastActivityAt: Date.now() });
const relayRotation = prepareDeviceE2eeRotation(join(root, "cli"), {
  deviceId: cli.public_identity.device_id,
});
liveRelayIdentity = relayRotation.next;
relayRotation.commit();
await hotReloadTransport.send("collaboration.remote.dispatch", {
  protocolVersion: "1",
  sourceDeviceId: "cli-device",
  targetDeviceId: "app-device",
  assignmentId: "assignment-hot-reload",
  runId: "run-hot-reload",
  taskId: "task-hot-reload",
  role: "worker",
  prompt: "sealed after key rotation",
});
assert.equal(hotReloadTransport.sessions.has("stale-session"), false);
assert.equal(
  hotReloadSent[0].sender_key_id,
  relayRotation.next.public_identity.key_id,
);
const acceptedAfterRotation = DeviceE2eeSession.accept({
  local: app,
  peer: relayRotation.next.public_identity,
  firstEnvelope: hotReloadSent[0],
});
assert.equal(
  acceptedAfterRotation.firstPayload.payload.prompt,
  "sealed after key rotation",
);

// A re-subscribe that already holds the current key must draw no key delivery
// at all. The App re-subscribes on every reconnect and every directory event,
// each naming every session it knows; answering each with the full key set is
// what saturated the send queue and put a live event behind hundreds of
// redundant envelopes.
//
// This runs last, on its own transport and its own session, because a subscribe
// re-binds the route to the subscribing session — inserting it earlier would
// re-point the route away from the session the earlier cases drain on.
const dedupeSent = [];
const dedupeTransport = new DeviceE2eeRelayTransport({
  relayClient: {
    send: async () => {},
    sendEnvelope: async (envelope) => dedupeSent.push(envelope),
  },
  localIdentity: cli,
  stateDir,
  controlBaseUrl: "https://example.invalid",
  credentialProvider: async () => credential,
});
const dedupeApp = DeviceE2eeSession.initiate({
  local: app,
  peer: cli.public_identity,
  sessionId: "e2s_group_key_dedupe",
});
const dedupeSubscribe = (knownGroupKeyIds) => dedupeApp.seal(
  "agent.control.subscribe",
  {
    sessionIds: ["dedupe-session"],
    ...(knownGroupKeyIds ? { knownGroupKeyIds } : {}),
  },
  { routing: {
    session_id: "dedupe-session",
    directory_head: deviceE2eeDirectoryHead(cachedDirectory),
  } },
);
const keyDeliveries = () => dedupeSent.filter(
  (item) => item.type === "agent.groupkey.response",
).length;

// First subscribe: the App holds nothing, so the key is delivered.
await dedupeTransport.handleInbound(dedupeSubscribe(null));
assert.equal(keyDeliveries(), 1, "the first subscribe must deliver the key");
const dedupeKeyId = readSessionGroupKey(stateDir, "dedupe-session").group_key_id;

// Re-subscribe with the key it now holds: nothing to send.
await dedupeTransport.handleInbound(
  dedupeSubscribe({ "dedupe-session": dedupeKeyId }),
);
assert.equal(
  keyDeliveries(),
  1,
  "a subscribe that already holds the current key must not re-draw it",
);

// An empty map is the same as absent: a subscriber that claims nothing may not
// be used to suppress a delivery it needs.
await dedupeTransport.handleInbound(dedupeSubscribe({}));
assert.equal(
  keyDeliveries(),
  2,
  "an empty known-key map must not suppress the delivery",
);

// A stale id means the key rotated under the subscriber, so it must be sent —
// skipping it would strand that App on a key nothing publishes under.
await dedupeTransport.handleInbound(
  dedupeSubscribe({ "dedupe-session": "grp:stale-key-id" }),
);
assert.equal(
  keyDeliveries(),
  3,
  "a stale key id must still be delivered",
);

// A trust event makes the CLI drop every session, including the one the App is
// still sealing onto. The App cannot see that happen: the relay keeps
// delivering, the envelopes just stop being readable, and `accept()` refuses
// them all on `sequence !== 0`. That refusal used to propagate out of
// `handleInbound`, where the daemon only logged it — so the App kept sending
// into a dead session and the conversation spun until `shouldRekey` expired it
// half an hour later. The CLI now answers the refusal instead.
{
  const resetSent = [];
  const resetTransport = new DeviceE2eeRelayTransport({
    relayClient: {
      send: async () => {},
      sendEnvelope: async (envelope) => {
        resetSent.push(envelope);
        return { accepted: true };
      },
    },
    localIdentity: cli,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  const orphan = DeviceE2eeSession.initiate({
    local: app,
    peer: cli.public_identity,
    sessionId: "e2s_orphaned_by_trust_event",
  });
  // The App gets two envelopes out on this session, so its sequence is past 0.
  const head = { routing: { directory_head: deviceE2eeDirectoryHead(cachedDirectory) } };
  const first = orphan.seal("agent.message", { message: "one" }, head);
  await resetTransport.handleInbound(first);
  const second = orphan.seal("agent.message", { message: "two" }, head);
  await resetTransport.handleInbound(second);
  assert.equal(resetSent.length, 0);

  // The trust event arrives and the CLI forgets the session.
  resetTransport.clearSessions();
  resetSent.length = 0;

  // The App has no way to know, and sends again on the session it still holds.
  const third = orphan.seal("agent.message", { message: "three" }, head);
  assert.equal(third.sequence, 2);
  const routed = await resetTransport.handleInbound(third);
  assert.equal(routed, null, "an unusable envelope must be dropped, not thrown");

  const resetFrame = resetSent.at(-1);
  assert.ok(resetFrame, "the CLI must answer an envelope it cannot read");
  assert.equal(resetFrame.protocol, "e2ee-v2");
  assert.equal(resetFrame.target_device_id, "app-device");
  // Sequence 0 on a session of its own: `send()` initiates when the target has
  // none, so delivering the reset is itself a fresh, readable session.
  assert.equal(resetFrame.sequence, 0);
  assert.notEqual(resetFrame.session_id, orphan.sessionId);
  const resetPayload = DeviceE2eeSession.accept({
    local: app,
    peer: cli.public_identity,
    firstEnvelope: resetFrame,
  }).firstPayload;
  assert.equal(resetPayload.type, "e2ee.sessions.reset");
  assert.equal(resetPayload.payload.stale_session_id, orphan.sessionId);
  assert.equal(resetTransport.rejectsPlaintext({ type: "e2ee.sessions.reset" }), true);

  // And the App's next request, now on the new session it just accepted, is
  // readable again — which is the whole point of the exchange.
  const healed = await resetTransport.handleInbound(
    DeviceE2eeSession.initiate({
      local: app,
      peer: cli.public_identity,
      sessionId: "e2s_healed_after_reset",
    }).seal("agent.message", { message: "four" }, head),
  );
  assert.equal(healed.message, "four");
}

// The other direction: the App clears its sessions when it makes a trust
// change, and says so. The CLI drops its half before anything else reads the
// payload, so the very next envelope opens a clean session rather than failing
// the sequence-0 check against a session it no longer has.
{
  const inbound = new DeviceE2eeRelayTransport({
    relayClient: {
      send: async () => {},
      sendEnvelope: async () => ({ accepted: true }),
    },
    localIdentity: cli,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  const live = DeviceE2eeSession.initiate({
    local: app,
    peer: cli.public_identity,
    sessionId: "e2s_inbound_reset",
  });
  await inbound.handleInbound(live.seal("agent.control.subscribe", {
    sessionIds: ["agent-session-inbound-reset"],
  }, { routing: { directory_head: deviceE2eeDirectoryHead(cachedDirectory) } }));
  assert.equal(inbound.sessions.has(live.sessionId), true);

  const dropped = await inbound.handleInbound(DeviceE2eeSession.initiate({
    local: app,
    peer: cli.public_identity,
    sessionId: "e2s_inbound_reset_signal",
  }).seal("e2ee.sessions.reset", {
    target_device_id: "cli-device",
    reason: "trust_changed",
  }, { routing: { directory_head: deviceE2eeDirectoryHead(cachedDirectory) } }));
  assert.equal(dropped, null, "the reset is consumed by the transport");
  assert.equal(inbound.sessions.size, 0, "the peer's sessions must be gone");

  // The App re-initiates; the CLI must accept it rather than see a mid-stream
  // sequence and refuse.
  const resumed = await inbound.handleInbound(DeviceE2eeSession.initiate({
    local: app,
    peer: cli.public_identity,
    sessionId: "e2s_inbound_resumed",
  }).seal("agent.message", { message: "resumed" }, {
    routing: { directory_head: deviceE2eeDirectoryHead(cachedDirectory) },
  }));
  assert.equal(resumed.message, "resumed");
}

// `announceSessionReset` is what the daemon calls after a trust event, where
// the whole map goes at once and the sender is known. It must not throw when
// the peer has just become untrusted — a `device.revoked` event means the
// directory will refuse to seal to it at all, and the event itself must still
// be handled rather than turning into an unhandled rejection.
{
  const revoked = new DeviceE2eeRelayTransport({
    relayClient: {
      send: async () => {},
      sendEnvelope: async () => ({ accepted: true }),
    },
    localIdentity: cli,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  const frame = await revoked.send("collaboration.remote.dispatch", {
    targetDeviceId: "worker-device",
    sourceDeviceId: "cli-device",
    protocolVersion: "1",
    assignmentId: "warm",
    runId: "warm",
    taskId: "warm",
    role: "worker",
    prompt: "warm the directory",
  });
  assert.ok(frame, "a trusted target is reachable");
  await revoked.announceSessionReset("worker-device", "device.revoked");
}

console.log("device E2EE relay transport tests ok");
