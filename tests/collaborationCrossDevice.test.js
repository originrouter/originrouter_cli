import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";
import { ensureDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import { storeDeviceE2eeDirectoryCache } from "../src/security/deviceE2eeDirectoryCache.js";
import { DeviceE2eeRelayTransport } from "../src/security/deviceE2eeRelayTransport.js";

class Registry {
  constructor() { this.sessions = new Map(); this.listeners = new Set(); this.commands = []; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list() { return [...this.sessions.values()]; }
  add(id) { this.sessions.set(id, { session_id: id, status: "running" }); }
  enqueueCommand(sessionId, command) { this.commands.push({ sessionId, command }); return command; }
  emit(sessionId, event) {
    for (const listener of this.listeners) listener({ type: "event", sessionId, payload: event });
  }
}

function node(deviceId, network, { stateDir, identity, identities, envelopes, controls }) {
  const credential = {
    sessionId: `or_ses_${deviceId}`,
    accessTokens: { control: { token: `or_at_${deviceId}` } },
  };
  storeDeviceE2eeDirectoryCache(stateDir, {
    policy: { epoch: 1, new_device_approval_required: false },
    identities: identities.map((item) => ({
      ...item.public_identity,
      trust_status: "trusted",
    })),
  }, { namespace: credential.sessionId });
  const store = new CollaborationStore({ stateDir });
  const coordinator = new PlanImplementVerifyCoordinator({ store });
  const registry = new Registry();
  const launches = [];
  const supervisor = {
    async start(payload) {
      launches.push(payload);
      registry.add(payload.sessionId);
      return { launchId: payload.launchId, sessionId: payload.sessionId, conversationId: payload.conversationId };
    },
  };
  const relayClient = new DeviceE2eeRelayTransport({
    relayClient: {
      async send(type, payload) {
        controls.push({ deviceId, type, payload });
        return { data: { accepted: true, queued: false, reason: "" } };
      },
      async sendEnvelope(envelope) {
        envelopes.push(envelope);
        const target = network.get(envelope.target_device_id);
        if (!target) {
          return { data: { accepted: false, queued: false, reason: "target_offline" } };
        }
        const clear = await target.transport.handleInbound(envelope);
        await target.runtime.handleRelayEvent(clear);
        return { data: { accepted: true, queued: false, reason: "" } };
      },
    },
    localIdentity: identity,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  const runtime = new CollaborationRuntime({
    store, coordinator, registry, supervisor, relayClient, deviceId,
    registrationTimeoutMs: 100, pollIntervalMs: 1,
  });
  const value = { store, coordinator, registry, launches, runtime, transport: relayClient };
  network.set(deviceId, value);
  return value;
}

const root = mkdtempSync(join(tmpdir(), "originrouter-collaboration-e2ee-"));
const sourceStateDir = join(root, "device-a");
const workerStateDir = join(root, "device-b");
const sourceIdentity = ensureDeviceE2eeIdentity(sourceStateDir, { deviceId: "device-a" });
const workerIdentity = ensureDeviceE2eeIdentity(workerStateDir, { deviceId: "device-b" });
const identities = [sourceIdentity, workerIdentity];
const envelopes = [];
const controls = [];
const network = new Map();
const source = node("device-a", network, {
  stateDir: sourceStateDir,
  identity: sourceIdentity,
  identities,
  envelopes,
  controls,
});
const worker = node("device-b", network, {
  stateDir: workerStateDir,
  identity: workerIdentity,
  identities,
  envelopes,
  controls,
});
const run = source.coordinator.create({
  objective: "Implement and verify cross-device export.",
  agents: {
    lead: { runtime: "codex", device_id: "device-a", workspace_id: "workspace-a", responsibilities: ["research", "review_plan", "verify_result"] },
    worker: { runtime: "claude", device_id: "device-b", workspace_id: "workspace-b", responsibilities: ["propose_plan", "implement", "rework"] },
  },
});

await source.runtime.start(run.run_id);
await new Promise((resolve) => setImmediate(resolve));
let current = source.store.getRun(run.run_id);
const leadSession = current.agents.lead.originrouter_session_id;
source.registry.emit(leadSession, { type: "agent.text", text: "Cross-device research", eventId: "a-research" });
source.registry.emit(leadSession, { type: "agent.task.complete", eventId: "a-research-done" });
await source.runtime.queue;

current = source.store.getRun(run.run_id);
assert.equal(current.state, "planning");
assert.equal(current.agents.worker.status, "dispatched");
assert.equal(worker.launches.length, 1);
const dispatchEnvelope = envelopes.find((item) => item.target_device_id === "device-b");
assert.ok(dispatchEnvelope, "remote dispatch must use an E2EE envelope");
assert.equal(dispatchEnvelope.protocol, "e2ee-v2");
assert.equal(JSON.stringify(dispatchEnvelope).includes("Cross-device research"), false);
assert.equal(JSON.stringify(dispatchEnvelope).includes("Implement and verify cross-device export"), false);
assert.ok(controls.every((item) => item.payload.objectivePreview !== "Implement and verify cross-device export"));
const assignment = worker.store.getRemoteAssignment(`assign-${run.run_id}-worker`);
assert.ok(assignment);
assert.equal(assignment.fencing_token, current.agents.worker.fencing_token);
const workerSession = assignment.originrouter_session_id;
worker.registry.emit(workerSession, { type: "agent.text", text: "Remote plan", eventId: "b-plan" });
worker.registry.emit(workerSession, { type: "agent.task.completed", eventId: "b-plan-done" });
await worker.runtime.queue;
assert.equal(source.store.getRun(run.run_id).state, "awaiting_plan_review");
assert.ok(worker.registry.commands.some((item) => (
  item.sessionId === workerSession && item.command.type === "session.stop"
)), "the remote wrapper is released after its durable result is delivered");

source.registry.emit(leadSession, { type: "agent.text", text: "ORIGINROUTER_DECISION: APPROVE", eventId: "a-review" });
source.registry.emit(leadSession, { type: "agent.task.complete", eventId: "a-review-done" });
await source.runtime.queue;
assert.equal(source.store.getRun(run.run_id).state, "implementing");
assert.equal(worker.launches.length, 1, "the remote native session is reused for implementation");

worker.registry.emit(workerSession, { type: "agent.text", text: "Remote implementation", eventId: "b-impl" });
worker.registry.emit(workerSession, { type: "agent.task.completed", eventId: "b-impl-done" });
await worker.runtime.queue;
assert.equal(source.store.getRun(run.run_id).state, "awaiting_verification");
source.registry.emit(leadSession, { type: "agent.text", text: "ORIGINROUTER_VERIFICATION: PASS", eventId: "a-verify" });
source.registry.emit(leadSession, { type: "agent.task.complete", eventId: "a-verify-done" });
await source.runtime.queue;
assert.equal(source.store.getRun(run.run_id).state, "completed");
assert.ok(source.registry.commands.some((item) => (
  item.sessionId === leadSession && item.command.type === "session.stop"
)), "local managed sessions are released when the collaboration completes");

source.runtime.close(); worker.runtime.close();
source.store.close(); worker.store.close();
console.log("cross-device collaboration tests passed");
