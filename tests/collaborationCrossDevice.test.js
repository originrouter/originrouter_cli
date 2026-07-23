import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";

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

function node(deviceId, network) {
  const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), `or-collab-${deviceId}-`)) });
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
  const relayClient = {
    async send(type, payload) {
      const target = network.get(payload.targetDeviceId);
      if (!target) return { data: { accepted: true, queued: true, reason: "target_offline" } };
      await target.handleRelayEvent({ type, ...payload });
      return { data: { accepted: true, queued: false, reason: "" } };
    },
  };
  const runtime = new CollaborationRuntime({
    store, coordinator, registry, supervisor, relayClient, deviceId,
    registrationTimeoutMs: 100, pollIntervalMs: 1,
  });
  network.set(deviceId, runtime);
  return { store, coordinator, registry, launches, runtime };
}

const network = new Map();
const source = node("device-a", network);
const worker = node("device-b", network);
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
const assignment = worker.store.getRemoteAssignment(`assign-${run.run_id}-worker`);
assert.ok(assignment);
const workerSession = assignment.originrouter_session_id;
worker.registry.emit(workerSession, { type: "agent.text", text: "Remote plan", eventId: "b-plan" });
worker.registry.emit(workerSession, { type: "agent.task.completed", eventId: "b-plan-done" });
await worker.runtime.queue;
assert.equal(source.store.getRun(run.run_id).state, "awaiting_plan_review");

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

source.runtime.close(); worker.runtime.close();
source.store.close(); worker.store.close();
console.log("cross-device collaboration tests passed");
