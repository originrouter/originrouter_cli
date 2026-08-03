import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { ensureDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import { storeDeviceE2eeDirectoryCache } from "../src/security/deviceE2eeDirectoryCache.js";
import { DeviceE2eeRelayTransport } from "../src/security/deviceE2eeRelayTransport.js";

class Registry {
  constructor() { this.sessions = new Map(); this.listeners = new Set(); this.commands = []; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list() { return [...this.sessions.values()]; }
  enqueueCommand(sessionId, command) {
    if (!this.sessions.has(sessionId)) throw new Error("session not active");
    this.commands.push({ sessionId, command });
  }
  emit(sessionId, payload) {
    for (const listener of this.listeners) listener({ type: "event", sessionId, payload });
  }
}

function makeNode(deviceId, network, { stateDir, identity, identities, envelopes }) {
  const credential = {
    sessionId: `or_ses_${deviceId}`,
    accessTokens: { control: { token: `or_at_${deviceId}` } },
  };
  storeDeviceE2eeDirectoryCache(stateDir, {
    policy: { epoch: 1, new_device_approval_required: false },
    identities: identities.map((item) => ({ ...item.public_identity, trust_status: "trusted" })),
  }, { namespace: credential.sessionId });
  const store = new CollaborationStore({ stateDir });
  const coordinator = new PlanImplementVerifyCoordinator({ store });
  const registry = new Registry();
  const launches = [];
  const relayClient = new DeviceE2eeRelayTransport({
    relayClient: {
      async send() { return { data: { accepted: true, queued: false } }; },
      async sendEnvelope(envelope) {
        envelopes.push(envelope);
        const target = network.get(envelope.target_device_id);
        if (!target) return { data: { accepted: false, queued: false, reason: "target_offline" } };
        const clear = await target.transport.handleInbound(envelope);
        await target.runtime.handleRelayEvent(clear);
        return { data: { accepted: true, queued: false } };
      },
    },
    localIdentity: identity,
    stateDir,
    controlBaseUrl: "https://example.invalid",
    credentialProvider: async () => credential,
  });
  const runtime = new CollaborationRuntime({
    store,
    coordinator,
    registry,
    relayClient,
    deviceId,
    supervisor: {
      async start(payload) {
        launches.push(payload);
        registry.sessions.set(payload.sessionId, { session_id: payload.sessionId, status: "running" });
        return payload;
      },
    },
    registrationTimeoutMs: 100,
    pollIntervalMs: 1,
  });
  const result = { store, coordinator, registry, runtime, transport: relayClient, launches };
  network.set(deviceId, result);
  return result;
}

const root = mkdtempSync(join(tmpdir(), "originrouter-agent-mcp-e2ee-"));
const sourceStateDir = join(root, "source");
const remoteStateDir = join(root, "remote");
const sourceIdentity = ensureDeviceE2eeIdentity(sourceStateDir, { deviceId: "device-a" });
const remoteIdentity = ensureDeviceE2eeIdentity(remoteStateDir, { deviceId: "device-b" });
const identities = [sourceIdentity, remoteIdentity];
const envelopes = [];
const network = new Map();
const source = makeNode("device-a", network, {
  stateDir: sourceStateDir, identity: sourceIdentity, identities, envelopes,
});
const remote = makeNode("device-b", network, {
  stateDir: remoteStateDir, identity: remoteIdentity, identities, envelopes,
});

const created = source.coordinator.create({
  objective: "A remote Agent asks a local Agent through the OriginRouter MCP gateway.",
  participants: [
    { participant_id: "requester", runtime: "claude", device_id: "device-b", workspace_id: "workspace-b", planner: true },
    { participant_id: "reviewer", runtime: "codex", device_id: "device-a", workspace_id: "workspace-a" },
  ],
  budget: { max_concurrency: 2 },
});
source.coordinator.start(created.run_id);
source.store.setAdaptivePlan(created.run_id, {
  title: "Cross-device MCP delegation",
  summary: "The remote requester dynamically delegates a child task.",
  tasks: [{
    id: "requester_work",
    title: "Ask the reviewer",
    instructions: "Use OriginRouter MCP to ask the reviewer for a marker.",
    participant_id: "requester",
    depends_on: [],
    mode: "discussion",
    deliverable: "The review marker.",
  }],
});
await source.runtime.confirm(created.run_id);

let sourceRun = source.store.getRun(created.run_id);
const requesterTask = sourceRun.tasks.find((task) => task.task_key === "requester_work");
const assignment = remote.store.getRemoteAssignment(
  `assign-${created.run_id}-requester-requester_work`,
);
assert.ok(assignment?.originrouter_session_id);

const listed = await remote.runtime.handleMcpGatewayRequest({
  sessionId: assignment.originrouter_session_id,
  action: "list",
});
assert.deepEqual(listed.participants.map((item) => item.participant_id), ["reviewer"]);

const delegated = await remote.runtime.handleMcpGatewayRequest({
  sessionId: assignment.originrouter_session_id,
  action: "delegate",
  payload: {
    participant_id: "reviewer",
    instructions: "Return CROSS_DEVICE_AGENT_MCP_OK.",
    mode: "discussion",
    wait_requested: true,
  },
});
sourceRun = source.store.getRun(created.run_id);
const child = sourceRun.tasks.find((task) => task.task_id === delegated.task_id);
assert.equal(child.parent_task_id, requesterTask.task_id);
assert.equal(child.state, "active");
const reviewerSession = sourceRun.agents.reviewer.originrouter_session_id;
source.registry.emit(reviewerSession, { type: "agent.text", text: "CROSS_DEVICE_AGENT_MCP_OK", eventId: "review-text" });
source.registry.emit(reviewerSession, { type: "agent.task.complete", eventId: "review-complete" });
await source.runtime.queue;

const status = await remote.runtime.handleMcpGatewayRequest({
  sessionId: assignment.originrouter_session_id,
  action: "status",
  payload: { task_id: delegated.task_id },
});
assert.equal(status.state, "completed");
assert.equal(status.result, "CROSS_DEVICE_AGENT_MCP_OK");

remote.registry.emit(assignment.originrouter_session_id, {
  type: "agent.text",
  text: "Requester received CROSS_DEVICE_AGENT_MCP_OK",
  eventId: "requester-text",
});
remote.registry.emit(assignment.originrouter_session_id, {
  type: "agent.task.complete",
  eventId: "requester-complete",
});
await remote.runtime.queue;
assert.equal(source.store.getRun(created.run_id).state, "completed");
assert.ok(envelopes.some((envelope) => envelope.target_device_id === "device-a"));
assert.equal(JSON.stringify(envelopes).includes("Return CROSS_DEVICE_AGENT_MCP_OK"), false);

source.runtime.close();
remote.runtime.close();
source.store.close();
remote.store.close();
console.log("cross-device Agent MCP gateway tests passed");
