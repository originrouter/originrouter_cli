import assert from "node:assert/strict";
import { RelayClient } from "../src/relay/relayClient.js";

const envelope = {
  protocol: "e2ee-v2",
  session_id: "e2s_ack_test",
  direction: "request",
  sequence: 3,
  target_device_id: "app-device",
};

let sent = null;
const client = new RelayClient({
  relayUrl: "https://example.invalid",
  deviceId: "cli-device",
  e2eeAckTimeoutMs: 1_000,
});
client._ws = {
  readyState: 1,
  send(raw, callback) {
    sent = JSON.parse(raw);
    callback?.();
  },
};
const delivery = client.sendEnvelope(envelope);
assert.equal(sent.session_id, "e2s_ack_test");
assert.equal(client._handleE2eeAck({
  type: "ack",
  session_id: "e2s_ack_test",
  direction: "request",
  sequence: 3,
  accepted: false,
  reason: "target_offline",
}), true);
assert.deepEqual(await delivery, {
  ok: false,
  accepted: false,
  reason: "target_offline",
  via: "ws",
});

const disconnected = client.sendEnvelope({ ...envelope, sequence: 4 });
client._failPendingE2eeAcks();
assert.equal((await disconnected).reason, "relay_disconnected");

console.log("relay client E2EE ACK tests ok");
