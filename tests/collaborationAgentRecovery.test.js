import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

class Registry {
  constructor() {
    this.sessions = new Map();
    this.listeners = new Set();
    this.commands = [];
  }

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list() { return [...this.sessions.values()]; }
  enqueueCommand(sessionId, command) { this.commands.push({ sessionId, command }); return command; }
}

function createRuntime({ remote = false } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-agent-recovery-"));
  const store = new CollaborationStore({ stateDir });
  const coordinator = new PlanImplementVerifyCoordinator({ store });
  const registry = new Registry();
  const launches = [];
  const deliveries = [];
  const supervisor = {
    async start(payload) {
      launches.push(payload);
      if (payload.nativeSessionId === "stale-native-session") {
        const error = new Error("saved native session no longer exists");
        error.code = "RESUME_CONVERSATION_NOT_FOUND";
        throw error;
      }
      registry.sessions.set(payload.sessionId, { session_id: payload.sessionId, status: "running" });
      return {
        launchId: payload.launchId,
        sessionId: payload.sessionId,
        conversationId: payload.conversationId,
      };
    },
  };
  const relayClient = remote ? {
    async send(type, payload) {
      deliveries.push({ type, payload });
      return { data: { accepted: true, queued: false } };
    },
  } : null;
  const runtime = new CollaborationRuntime({
    store,
    coordinator,
    registry,
    supervisor,
    relayClient,
    deviceId: "device-local",
    registrationTimeoutMs: 100,
    pollIntervalMs: 1,
  });
  return { store, coordinator, registry, launches, deliveries, runtime };
}

{
  const context = createRuntime();
  const created = context.coordinator.create({
    objective: "Resume the local Lead Agent without replacing its identity.",
    participants: [{
      participant_id: "lead",
      display_name: "Coordinator",
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-local",
      planner: true,
      native_session_id: "stale-native-session",
      conversation_id: "conversation-local",
    }],
  });
  assert.equal(context.store.getRun(created.run_id).agents.lead.native_session_id, "stale-native-session");

  await context.runtime.start(created.run_id);
  await new Promise((resolve) => setImmediate(resolve));
  let snapshot = context.store.getSnapshot(created.run_id);
  assert.equal(snapshot.run.state, "blocked");
  const recovery = snapshot.attention.find((item) => item.kind === "agent_recovery");
  assert.ok(recovery, "an invalid native binding must require an explicit member recovery decision");
  assert.equal(context.launches.length, 1);
  assert.equal(context.launches[0].nativeSessionId, "stale-native-session");

  await context.runtime.resolveAttention(created.run_id, recovery.attention_id, { action: "rebuild" });
  snapshot = context.store.getSnapshot(created.run_id);
  assert.equal(snapshot.run.state, "planning");
  assert.equal(context.launches.length, 2);
  assert.equal(context.launches[1].nativeSessionId, undefined);
  assert.equal(snapshot.participants[0].native_session_id, null);
  context.runtime.close();
  context.store.close();
}

{
  const context = createRuntime({ remote: true });
  const created = context.coordinator.create({
    objective: "Resume a remote child Agent without silently replacing it.",
    participants: [{
      participant_id: "remote_operator",
      display_name: "Remote Operator",
      runtime: "claude",
      device_id: "device-remote",
      workspace_id: "workspace-remote",
      planner: true,
      native_session_id: "stale-native-session",
      conversation_id: "conversation-remote",
    }],
  });
  await context.runtime.start(created.run_id);
  await new Promise((resolve) => setImmediate(resolve));
  let run = context.store.getRun(created.run_id, { includeMessages: false });
  const firstDispatch = context.deliveries.find((item) => item.type === "collaboration.remote.dispatch");
  assert.equal(firstDispatch.payload.nativeSessionId, "stale-native-session");

  await context.runtime.handleRelayEvent({
    type: "collaboration.remote.error",
    sourceDeviceId: "device-remote",
    targetDeviceId: "device-local",
    runId: created.run_id,
    role: "remote_operator",
    attempt: run.agents.remote_operator.attempt,
    fencingToken: run.agents.remote_operator.fencing_token,
    code: "RESUME_CONVERSATION_NOT_FOUND",
    message: "saved remote native session no longer exists",
  });
  let snapshot = context.store.getSnapshot(created.run_id);
  assert.equal(snapshot.run.state, "blocked");
  const recovery = snapshot.attention.find((item) => item.kind === "agent_recovery");
  assert.ok(recovery);

  await context.runtime.resolveAttention(created.run_id, recovery.attention_id, { action: "rebuild" });
  const dispatches = context.deliveries.filter((item) => item.type === "collaboration.remote.dispatch");
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1].payload.nativeSessionId, null);
  assert.equal(dispatches[1].payload.resetAgentIdentity, true);

  const assignmentBase = {
    assignmentId: "assignment-reset-test",
    runId: created.run_id,
    taskId: context.store.getRun(created.run_id).task_ids[0],
    role: "remote_operator",
    phase: "plan_design",
    sourceDeviceId: "device-local",
    targetDeviceId: "device-remote",
    runtime: "claude",
    workspaceId: "workspace-remote",
    deliveryId: "delivery-reset-1",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-reset-1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    nativeSessionId: "stale-native-session",
    conversationId: "conversation-remote",
  };
  context.store.upsertRemoteAssignment(assignmentBase);
  context.store.upsertRemoteAssignment({
    ...assignmentBase,
    deliveryId: "delivery-reset-2",
    attempt: 2,
    fencingToken: 2,
    leaseId: "lease-reset-2",
    nativeSessionId: null,
    resetAgentIdentity: true,
  });
  assert.equal(
    context.store.getRemoteAssignment("assignment-reset-test").native_session_id,
    "",
  );
  context.runtime.close();
  context.store.close();
}

{
  const context = createRuntime();
  const first = context.coordinator.create({
    objective: "First Turn",
    participants: [{
      participant_id: "lead",
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-local",
      planner: true,
      native_session_id: "native-thread-1",
      conversation_id: "agent-conversation-1",
    }],
  });
  const second = context.coordinator.create({
    objective: "Follow-up Turn",
    auto_configuration: { continued_from_run_id: first.run_id },
    participants: [{
      participant_id: "lead",
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-local",
      planner: true,
      native_session_id: "native-thread-1",
      conversation_id: "agent-conversation-1",
    }],
  });
  assert.equal(second.workspace_session_id, first.workspace_session_id);
  assert.equal(second.continued_from_run_id, first.run_id);
  assert.equal(second.agents.lead.native_session_id, "native-thread-1");
  assert.equal(second.agents.lead.conversation_id, "agent-conversation-1");
  assert.deepEqual(
    context.store.listWorkspaceSession(second.run_id).map((run) => run.run_id),
    [first.run_id, second.run_id],
  );
  context.runtime.close();
  context.store.close();
}

console.log("collaboration Agent recovery tests passed");
