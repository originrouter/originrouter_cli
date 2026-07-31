import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

function runtimeFor(store, relayClient) {
  return new CollaborationRuntime({
    store,
    coordinator: new PlanImplementVerifyCoordinator({ store }),
    registry: { subscribe: () => () => {}, list: () => [] },
    supervisor: { start: async () => { throw new Error("not used"); } },
    relayClient,
    deviceId: "device-a",
  });
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-collaboration-reliability-"));
let store = new CollaborationStore({ stateDir });
let runtime = runtimeFor(store, {
  async send() {
    return { accepted: false, reason: "relay_ack_timeout" };
  },
});

const durablePayload = {
  protocolVersion: "1",
  sourceDeviceId: "device-a",
  targetDeviceId: "device-b",
  assignmentId: "assignment-reliability",
  runId: "run-reliability",
  taskId: "task-reliability",
  role: "worker",
  attempt: 1,
  fencingToken: 1,
  deliveryId: "delivery-reliability",
  prompt: "Private task content that must survive a local restart.",
};

await assert.rejects(
  runtime.sendRemoteDurable("collaboration.remote.dispatch", durablePayload, {
    outboxId: "dispatch:delivery-reliability",
  }),
  /relay_ack_timeout/,
);
let pending = store.getOutbox("dispatch:delivery-reliability");
assert.equal(pending.state, "pending");
assert.equal(pending.attempts, 1);
assert.equal(pending.last_error, "relay_ack_timeout");
runtime.close();
store.close();

// Pending messages are stored in SQLite and can be delivered by a new daemon
// process without reconstructing the original prompt from in-memory state.
store = new CollaborationStore({ stateDir });
const delivered = [];
runtime = runtimeFor(store, {
  async send(type, payload) {
    delivered.push({ type, payload });
    return { accepted: true };
  },
});
assert.deepEqual(await runtime.flushOutbox(), { pending: 0, delivered: 1 });
pending = store.getOutbox("dispatch:delivery-reliability");
assert.equal(pending.state, "delivered");
assert.equal(pending.attempts, 2);
assert.equal(delivered[0].payload.prompt, durablePayload.prompt);
assert.deepEqual(pending.payload, {});
assert.throws(
  () => store.enqueueOutbox({
    outboxId: "dispatch:delivery-reliability",
    messageType: "collaboration.remote.dispatch",
    targetDeviceId: "another-device",
    payload: durablePayload,
  }),
  /outbox id conflicts/,
);

let releaseConcurrentSend;
let concurrentSendCount = 0;
runtime.relayClient = {
  async send() {
    concurrentSendCount += 1;
    await new Promise((resolve) => { releaseConcurrentSend = resolve; });
    return { accepted: true };
  },
};
const concurrentPayload = {
  ...durablePayload,
  deliveryId: "delivery-single-flight",
};
const concurrentOne = runtime.sendRemoteDurable(
  "collaboration.remote.dispatch",
  concurrentPayload,
  { outboxId: "dispatch:delivery-single-flight" },
);
const concurrentTwo = runtime.sendRemoteDurable(
  "collaboration.remote.dispatch",
  concurrentPayload,
  { outboxId: "dispatch:delivery-single-flight" },
);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(concurrentSendCount, 1);
releaseConcurrentSend();
await Promise.all([concurrentOne, concurrentTwo]);

runtime.relayClient = {
  async send() {
    return { accepted: false, reason: "device_e2ee_required" };
  },
};
await assert.rejects(
  runtime.sendRemoteDurable(
    "collaboration.remote.dispatch",
    { ...durablePayload, deliveryId: "delivery-fatal" },
    { outboxId: "dispatch:delivery-fatal" },
  ),
  /device_e2ee_required/,
);
const fatal = store.getOutbox("dispatch:delivery-fatal");
assert.equal(fatal.state, "failed");
assert.deepEqual(fatal.payload, {});

const assignmentBase = {
  assignmentId: "assignment-fencing",
  runId: "run-fencing",
  taskId: "task-fencing",
  role: "worker",
  runtime: "claude",
  sourceDeviceId: "device-a",
  targetDeviceId: "device-b",
  workspaceId: "workspace-b",
  attempt: 2,
  fencingToken: 7,
  leaseId: "lease-seven",
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  deliveryId: "delivery-seven",
};
const accepted = store.upsertRemoteAssignment(assignmentBase);
assert.equal(accepted.duplicate, false);
assert.equal(accepted.stale, false);
assert.equal(accepted.assignment.fencing_token, 7);
assert.equal(accepted.assignment.fencing_mode, "strict");

const duplicate = store.upsertRemoteAssignment(assignmentBase);
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.stale, false);

const stale = store.upsertRemoteAssignment({
  ...assignmentBase,
  attempt: 1,
  fencingToken: 6,
  leaseId: "lease-six",
  deliveryId: "delivery-six",
});
assert.equal(stale.stale, true);
assert.equal(store.getRemoteAssignment("assignment-fencing").fencing_token, 7);
const lateLegacy = store.upsertRemoteAssignment({
  ...assignmentBase,
  attempt: undefined,
  fencingToken: undefined,
  leaseId: undefined,
  leaseExpiresAt: undefined,
  deliveryId: "late-legacy-delivery",
});
assert.equal(lateLegacy.stale, true);
assert.equal(store.getRemoteAssignment("assignment-fencing").fencing_mode, "strict");

assert.throws(
  () => store.upsertRemoteAssignment({
    ...assignmentBase,
    deliveryId: "conflicting-delivery-seven",
  }),
  /conflicting collaboration dispatch/,
);
assert.throws(
  () => store.upsertRemoteAssignment({
    ...assignmentBase,
    runId: "another-run",
    fencingToken: 8,
    attempt: 3,
    leaseId: "lease-eight",
    deliveryId: "delivery-eight",
  }),
  /assignment identity conflict/,
);

const legacyAssignment = store.upsertRemoteAssignment({
  ...assignmentBase,
  assignmentId: "assignment-legacy",
  deliveryId: "delivery-legacy",
  attempt: undefined,
  fencingToken: undefined,
  leaseId: undefined,
  leaseExpiresAt: undefined,
});
assert.equal(legacyAssignment.legacy, true);
assert.equal(legacyAssignment.assignment.fencing_token, 1);
assert.equal(legacyAssignment.assignment.fencing_mode, "legacy");
assert.equal(
  store.upsertRemoteAssignment({
    ...assignmentBase,
    assignmentId: "assignment-legacy",
    deliveryId: "delivery-legacy",
    attempt: undefined,
    fencingToken: undefined,
    leaseId: undefined,
    leaseExpiresAt: undefined,
  }).duplicate,
  true,
);
const legacyUpgraded = store.upsertRemoteAssignment({
  ...assignmentBase,
  assignmentId: "assignment-legacy",
  attempt: 1,
  fencingToken: 1,
  leaseId: "lease-legacy-upgrade",
  deliveryId: "delivery-legacy-upgrade",
});
assert.equal(legacyUpgraded.stale, false);
assert.equal(legacyUpgraded.assignment.fencing_mode, "strict");

const run = runtime.coordinator.create({
  objective: "Validate fencing acceptance.",
  agents: {
    lead: {
      runtime: "codex",
      device_id: "device-a",
      workspace_id: "workspace-a",
      responsibilities: ["research"],
    },
    worker: {
      runtime: "claude",
      device_id: "device-b",
      workspace_id: "workspace-b",
      responsibilities: ["implement"],
    },
  },
});
const lease = store.issueAgentLease(run.run_id, "worker", {
  dispatchKey: "worker-dispatch-one",
});
const leasedRun = store.getRun(run.run_id, { includeMessages: false });
assert.equal(runtime.acceptsFencing(leasedRun, "worker", {
  attempt: lease.attempt,
  fencingToken: lease.fencing_token,
}), true);
assert.equal(runtime.acceptsFencing(leasedRun, "worker", {
  attempt: lease.attempt,
  fencingToken: lease.fencing_token - 1,
}), false);
assert.equal(runtime.acceptsFencing(leasedRun, "worker", {}), true);

runtime.coordinator.start(run.run_id);
runtime.coordinator.beginPlanning(run.run_id);
await runtime.handleRelayEvent({
  type: "collaboration.remote.result",
  targetDeviceId: "device-a",
  assignmentId: "assignment-stale-result",
  runId: run.run_id,
  taskId: run.task_ids[0],
  role: "worker",
  attempt: lease.attempt,
  fencingToken: lease.fencing_token - 1,
  completionId: "completion-from-expired-attempt",
  output: "This stale result must not advance the run.",
});
assert.equal(store.getRun(run.run_id).state, "planning");
assert.equal(
  store.getRun(run.run_id).messages.some(
    (message) => message.payload?.content === "This stale result must not advance the run.",
  ),
  false,
);

runtime.close();
store.close();
console.log("collaboration reliability tests passed");
