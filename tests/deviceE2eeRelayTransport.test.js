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

const root = mkdtempSync(join(tmpdir(), "originrouter-e2ee-relay-"));
const app = ensureDeviceE2eeIdentity(join(root, "app"), { deviceId: "app-device" });
const cli = ensureDeviceE2eeIdentity(join(root, "cli"), { deviceId: "cli-device" });
const stateDir = join(root, "state");
const credential = {
  sessionId: "or_ses_test",
  accessTokens: { control: { token: "or_at_test" } },
};
const cachedDirectory = storeDeviceE2eeDirectoryCache(stateDir, {
  policy: { epoch: 1, new_device_approval_required: false },
  identities: [
    { ...app.public_identity, trust_status: "trusted" },
    { ...cli.public_identity, trust_status: "trusted" },
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

await transport.send("agent.stream.event", {
  sessionId: "agent-session-1",
  event: { text: "secret stream" },
});
assert.equal(sent.length, 1);
assert.equal(sent[0].protocol, "e2ee-v2");
assert.equal(JSON.stringify(sent[0]).includes("secret stream"), false);
const opened = appSession.open(sent[0]);
assert.equal(opened.payload.event.text, "secret stream");

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
  appSession.open(sent.at(-1)).payload.event.text,
  "bound collaboration stream",
);
assert.equal(transport.bindRoute("orphan-session", ["missing-assignment"]), false);
assert.equal(transport.rejectsPlaintext({
  type: "agent.message",
  message: "must reject",
}), true);

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
assert.equal(sent.length, 3);
assert.equal(sent[2].protocol, "e2ee-v2");
assert.equal(JSON.stringify(sent[2]).includes("private collaboration objective"), false);
const acceptedCollaboration = DeviceE2eeSession.accept({
  local: app,
  peer: cli.public_identity,
  firstEnvelope: sent[2],
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
assert.notEqual(sent[2].session_id, sent[3].session_id);
assert.equal(sent[2].sequence, 0);
assert.equal(sent[3].sequence, 0);

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const orderedSent = [];
const sendGates = [deferred(), deferred()];
const orderedTransport = new DeviceE2eeRelayTransport({
  relayClient: {
    send: async () => {},
    sendEnvelope: async (envelope) => {
      const index = orderedSent.push(envelope) - 1;
      await sendGates[index].promise;
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
const firstSend = orderedTransport.send("agent.stream.event", {
  sessionId: "agent-session-ordered",
  event: { text: "first" },
});
const secondSend = orderedTransport.send("agent.stream.event", {
  sessionId: "agent-session-ordered",
  event: { text: "second" },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(orderedSent.length, 1);
assert.equal(orderedSent[0].sequence, 0);
sendGates[0].resolve();
await firstSend;
await new Promise((resolve) => setImmediate(resolve));
assert.equal(orderedSent.length, 2);
assert.equal(orderedSent[1].sequence, 1);
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

console.log("device E2EE relay transport tests ok");
