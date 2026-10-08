/**
 * Session group keys: one ciphertext for N subscribers.
 *
 * The pairwise envelope binds `target_device_id` into its HKDF context, so a
 * pairwise key is single-recipient by construction. Live events are the one
 * path that is genuinely one-publish-to-many-viewers, and there they forced N
 * encryptions. These tests pin the properties that make the group path safe:
 *
 *  * a subscriber that asked for the key can open the published envelope;
 *  * a device holding a *different* key cannot;
 *  * an envelope addressed to a group is never mistaken for pairwise;
 *  * the pairwise path is untouched for request/response traffic.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import {
  DeviceE2eeGroupSession,
  DeviceE2eeSession,
  isGroupKeyId,
  isGroupTarget,
  openGroupEnvelope,
  sessionIdFromGroupTarget,
} from "../src/crypto/deviceE2eeEnvelope.js";
import {
  deviceE2eeDirectoryHead,
  storeDeviceE2eeDirectoryCache,
} from "../src/security/deviceE2eeDirectoryCache.js";
import { DeviceE2eeRelayTransport } from "../src/security/deviceE2eeRelayTransport.js";
import {
  ensureSessionGroupKey,
  forgetSessionGroupKey,
  readSessionGroupKey,
  sessionGroupKeyPath,
} from "../src/security/sessionGroupKeyStore.js";

const root = mkdtempSync(join(tmpdir(), "originrouter-groupkey-"));

/**
 * `relayClient.sendEnvelope` hands the transport a sealed frame, and the tests
 * below want to read it the way a subscriber would. Tagging each recorded
 * frame with its type keeps `sent.filter((item) => item.type === ...)` working
 * for both the raw-type sends and the sealed envelopes.
 */
function recordEnvelope(target, envelope) {
  target.push({ ...envelope, type: envelope.type });
  return { accepted: true };
}
const app = ensureDeviceE2eeIdentity(join(root, "app"), { deviceId: "app-device" });
const app2 = ensureDeviceE2eeIdentity(join(root, "app-2"), { deviceId: "app-device-2" });
const cli = ensureDeviceE2eeIdentity(join(root, "cli"), { deviceId: "cli-device" });
const stateDir = join(root, "state");
const credential = {
  sessionId: "or_ses_group",
  accessTokens: { control: { token: "or_at_group" } },
};
const cachedDirectory = storeDeviceE2eeDirectoryCache(stateDir, {
  policy: { epoch: 1, new_device_approval_required: false },
  identities: [
    { ...app.public_identity, trust_status: "trusted" },
    { ...app2.public_identity, trust_status: "trusted" },
    { ...cli.public_identity, trust_status: "trusted" },
  ],
}, { namespace: credential.sessionId });
const directoryHead = deviceE2eeDirectoryHead(cachedDirectory);

function makeTransport(sent) {
  return new DeviceE2eeRelayTransport({
    relayClient: {
      send: async (type, payload) => {
        sent.push({ type, payload });
        return { accepted: true };
      },
      sendEnvelope: async (envelope) => recordEnvelope(sent, envelope),
    },
    localIdentity: cli,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
}

function subscribed(identity, sessionId, requestId) {
  const session = DeviceE2eeSession.initiate({
    local: identity,
    peer: cli.public_identity,
    sessionId,
  });
  return {
    session,
    frame: session.seal("agent.control.subscribe", {
      requestId,
      sessionIds: ["group-session"],
    }, {
      routing: {
        session_id: "group-session",
        request_id: requestId,
        directory_head: directoryHead,
      },
    }),
  };
}

// --- the store -------------------------------------------------------------

{
  const storeDir = mkdtempSync(join(tmpdir(), "originrouter-groupkey-store-"));
  const first = ensureSessionGroupKey(storeDir, "session-a");
  assert.equal(first.key.length, 32);
  assert.equal(isGroupKeyId(first.group_key_id), true);

  const again = ensureSessionGroupKey(storeDir, "session-a");
  assert.equal(again.group_key_id, first.group_key_id, "the key must be stable");
  assert.equal(again.key.equals(first.key), true);

  assert.equal(readSessionGroupKey(storeDir, "session-b"), null);
  assert.notEqual(
    ensureSessionGroupKey(storeDir, "session-b").group_key_id,
    first.group_key_id,
  );

  // The file is private and its name is not the raw session id.
  const path = sessionGroupKeyPath(storeDir, "session-a");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(path.includes("session-a"), false);

  forgetSessionGroupKey(storeDir, "session-a");
  assert.equal(readSessionGroupKey(storeDir, "session-a"), null);
  assert.equal(readdirSync(join(storeDir, "session-group-keys")).length, 1);
}

// A session id must not escape the state directory.
{
  const storeDir = mkdtempSync(join(tmpdir(), "originrouter-groupkey-path-"));
  const traversal = ensureSessionGroupKey(storeDir, "../../etc/passwd");
  assert.equal(
    sessionGroupKeyPath(storeDir, "../../etc/passwd")
      .startsWith(join(storeDir, "session-group-keys")),
    true,
  );
  assert.equal(traversal.session_id, "../../etc/passwd");
}

// --- the envelope ----------------------------------------------------------

{
  const record = ensureSessionGroupKey(stateDir, "envelope-session");
  const group = new DeviceE2eeGroupSession({
    local: cli,
    sessionId: "envelope-session",
    groupKeyId: record.group_key_id,
    key: record.key,
  });
  const envelope = group.seal("agent.stream.event", {
    sessionId: "envelope-session",
    event: { text: "group payload" },
  }, { routing: { session_id: "envelope-session" } });

  assert.equal(envelope.protocol, "e2ee-v2");
  assert.equal(isGroupTarget(envelope.target_device_id), true);
  assert.equal(sessionIdFromGroupTarget(envelope.target_device_id), "envelope-session");
  assert.equal(envelope.recipient_key_id, record.group_key_id);
  // The relay validator requires a 32-byte ephemeral field.
  assert.equal(Buffer.from(envelope.ephemeral_public_key, "base64url").length, 32);
  assert.equal(JSON.stringify(envelope).includes("group payload"), false);

  const opened = openGroupEnvelope(envelope, {
    key: record.key,
    groupKeyId: record.group_key_id,
    peer: cli.public_identity,
  });
  assert.equal(opened.type, "agent.stream.event");
  assert.equal(opened.payload.event.text, "group payload");

  // A second envelope on the same key opens too: a group publish is not a
  // sequence-checked stream, because one counter cannot serve N receivers.
  const second = group.seal("agent.stream.event", {
    sessionId: "envelope-session",
    event: { text: "second" },
  });
  assert.equal(second.sequence, 1);
  assert.equal(openGroupEnvelope(second, {
    key: record.key,
    groupKeyId: record.group_key_id,
    peer: cli.public_identity,
  }).payload.event.text, "second");

  // A device holding a different key gets a clean miss, not an exception.
  const other = ensureSessionGroupKey(stateDir, "other-session");
  assert.equal(openGroupEnvelope(envelope, {
    key: other.key,
    groupKeyId: other.group_key_id,
    peer: cli.public_identity,
  }), null);

  // A tampered ciphertext must fail the AEAD rather than decrypt to garbage.
  const tampered = {
    ...envelope,
    ciphertext: Buffer.concat([
      Buffer.from(envelope.ciphertext, "base64url"),
      Buffer.from([0]),
    ]).toString("base64url"),
  };
  assert.throws(() => openGroupEnvelope(tampered, {
    key: record.key,
    groupKeyId: record.group_key_id,
    peer: cli.public_identity,
  }));
}

// --- the transport ---------------------------------------------------------

// Two subscribers, one ciphertext.
{
  const sent = [];
  const transport = makeTransport(sent);
  const a = subscribed(app, "e2s_group_a", "sub-a");
  const b = subscribed(app2, "e2s_group_b", "sub-b");
  await transport.handleInbound(a.frame);
  await transport.handleInbound(b.frame);

  // The key response travels on each subscriber's own pairwise session, so
  // each opens its own copy. One frame may carry several keys; this subscribe
  // names one session, so it carries exactly one.
  const deliveryFor = (session) => {
    const frame = sent.filter((item) => item.type === "agent.groupkey.response"
      && item.session_id === session.sessionId).at(-1);
    assert.ok(frame, "the subscriber must be answered");
    const payload = session.open(frame).payload;
    return payload.keys;
  };
  const [deliveredA] = deliveryFor(a.session);
  const [deliveredB] = deliveryFor(b.session);
  for (const delivery of [deliveredA, deliveredB]) {
    assert.equal(typeof delivery.groupKey, "string");
    assert.equal(delivery.groupKeyId.startsWith("grp:"), true);
    assert.equal(delivery.sessionId, "group-session");
  }
  assert.equal(
    deliveredA.groupKeyId,
    deliveredB.groupKeyId,
    "both subscribers share one key for the session",
  );

  sent.length = 0;
  const result = await transport.sendBroadcast("agent.stream.event", {
    sessionId: "group-session",
    event: { text: "one ciphertext" },
  }, { routeKey: "group-session" });

  assert.equal(result.accepted, true);
  assert.equal(sent.length, 1, "two subscribers must cost one relay send");
  const published = sent[0];
  assert.equal(isGroupTarget(published.target_device_id), true);
  assert.equal(JSON.stringify(published).includes("one ciphertext"), false);

  // Both subscribers decrypt the same envelope with the key they were given.
  const key = Buffer.from(deliveredA.groupKey, "base64url");
  const groupKeyId = deliveredA.groupKeyId;
  const opened = openGroupEnvelope(published, {
    key, groupKeyId, peer: cli.public_identity,
  });
  assert.equal(opened.payload.event.text, "one ciphertext");
}

// The key is minted with the subscription, so the event right after a
// subscribe already publishes once — not after a round trip.
{
  const sent = [];
  const transport = makeTransport(sent);
  const a = subscribed(app, "e2s_race_a", "sub-race-a");
  const b = subscribed(app2, "e2s_race_b", "sub-race-b");
  await transport.handleInbound(a.frame);
  await transport.handleInbound(b.frame);
  sent.length = 0;
  await transport.sendBroadcast("agent.stream.event", {
    sessionId: "group-session",
    event: { text: "immediately after subscribe" },
  }, { routeKey: "group-session" });
  assert.equal(sent.length, 1);
  assert.equal(isGroupTarget(sent[0].target_device_id), true);
}

// With one subscriber there is no fan-out to save, so the event stays a
// pairwise delivery on the subscriber's own session.
{
  const sent = [];
  const transport = makeTransport(sent);
  const only = subscribed(app, "e2s_single", "sub-single");
  await transport.handleInbound(only.frame);
  sent.length = 0;
  await transport.sendBroadcast("agent.stream.event", {
    sessionId: "group-session",
    event: { text: "single viewer" },
  }, { routeKey: "group-session" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target_device_id, "app-device");
  assert.equal(isGroupTarget(sent[0].target_device_id), false);
}

// A session the CLI never published for has no key: the broadcast must report
// that plainly rather than inventing one.
{
  const sent = [];
  const transport = makeTransport(sent);
  await transport.handleInbound(subscribed(app, "e2s_unknown", "sub-unknown").frame);
  sent.length = 0;
  const result = await transport.sendBroadcast("agent.stream.event", {
    sessionId: "never-published",
    event: { text: "x" },
  }, { routeKey: "never-published" });
  assert.deepEqual(result, { accepted: false, reason: "no_subscribers" });
  assert.equal(sent.length, 0);
}

// The CLI must not accept a group envelope as if it were pairwise.
{
  const sent = [];
  const transport = makeTransport(sent);
  const record = ensureSessionGroupKey(stateDir, "inbound-session");
  const group = new DeviceE2eeGroupSession({
    local: app,
    sessionId: "inbound-session",
    groupKeyId: record.group_key_id,
    key: record.key,
  });
  const cleared = await transport.handleInbound(group.seal("agent.stream.event", {
    sessionId: "inbound-session",
    event: { text: "spoof" },
  }));
  assert.equal(cleared, null);
}

console.log("session group key tests ok");
