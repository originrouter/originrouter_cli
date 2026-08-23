import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

class Registry {
  constructor() { this.sessions = new Map(); this.listeners = new Set(); this.commands = []; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list() { return [...this.sessions.values()]; }
  enqueueCommand(sessionId, command) {
    this.commands.push({ sessionId, command });
  }
  emit(sessionId, payload) {
    for (const listener of this.listeners) listener({ type: "event", sessionId, payload });
  }
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-session-team-"));
const store = new CollaborationStore({ stateDir });
const coordinator = new PlanImplementVerifyCoordinator({ store });
const registry = new Registry();
const launches = [];
const runtime = new CollaborationRuntime({
  store,
  coordinator,
  registry,
  supervisor: {
    async start(payload) {
      launches.push(payload);
      registry.sessions.set(payload.sessionId, { session_id: payload.sessionId, status: "running" });
      return payload;
    },
  },
  relayClient: {
    async currentPeer(deviceId) {
      assert.equal(deviceId, "device-linux");
      return { device_id: deviceId, trust_status: "trusted" };
    },
  },
  deviceId: "device-local",
  registrationTimeoutMs: 100,
  pollIntervalMs: 1,
});

const first = coordinator.create({
  objective: "Establish a persistent collaboration Team.",
  coordinator_runtime: "codex",
  workspace_mode: "selected",
  resolved_workspace_mode: "selected",
  participants: [
    {
      participant_id: "lead",
      display_name: "Lead",
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-main",
      permission_profile: "guarded",
      role_hint: "Primary implementation Agent",
      planner: true,
    },
    {
      participant_id: "reviewer",
      display_name: "Reviewer",
      runtime: "claude",
      device_id: "device-remote",
      workspace_id: "workspace-review",
      permission_profile: "manual",
      role_hint: "Independent review Agent",
    },
  ],
  budget: { max_concurrency: 2 },
});

let session = store.getWorkspaceSession(first.run_id);
assert.equal(session.team_revision, 1);
assert.deepEqual(session.team.participants.map((item) => item.participant_id), ["lead", "reviewer"]);

store.updateAgent(first.run_id, "lead", {
  nativeSessionId: "native-lead-1",
  conversationId: "conversation-lead-1",
});
session = store.getWorkspaceSession(first.run_id);
assert.equal(session.team.participants[0].native_session_id, "native-lead-1");

const second = coordinator.create({
  objective: "Handle a follow-up without redesigning the Team.",
  continued_from_run_id: first.run_id,
  session_continuation: true,
  // A continuation must use the persisted Team, not caller-supplied drift.
  participants: [{
    participant_id: "other",
    runtime: "claude",
    device_id: "untrusted-drift",
    workspace_id: "wrong",
    planner: true,
  }],
});

assert.equal(second.workspace_session_id, first.workspace_session_id);
assert.equal(second.continued_from_run_id, first.run_id);
assert.equal(second.team_revision, 1);
assert.equal(second.session_continuation, true);
assert.equal(second.planning_source, "session_team");
assert.deepEqual(Object.keys(second.agents), ["lead", "reviewer"]);
assert.equal(second.agents.lead.native_session_id, "native-lead-1");
assert.equal(second.tasks[0].task_key, "__session_turn__");

assert.throws(
  () => store.createRun({
    objective: "Attempt to branch an existing Session without continuation.",
    workspace_session_id: first.workspace_session_id,
    participants: session.team.participants,
  }),
  (error) => error?.code === "COLLABORATION_SESSION_CONTINUATION_REQUIRED",
);

coordinator.start(second.run_id);
await runtime.dispatchForState(second.run_id);
let run = store.getRun(second.run_id);
assert.equal(run.state, "executing");
assert.equal(launches.length, 1);
const firstPrompt = registry.commands.find((item) => item.command.type === "agent.message")?.command.message;
assert.match(firstPrompt, /persistent OriginRouter Workspace Session/);
assert.doesNotMatch(firstPrompt, /ORIGINROUTER_PLAN_JSON_START/);

const leadSession = run.agents.lead.originrouter_session_id;
const roster = await runtime.handleMcpGatewayRequest({ sessionId: leadSession, action: "list" });
assert.equal(roster.team_revision, 1);
assert.deepEqual(roster.participants, [{
  participant_id: "reviewer",
  display_name: "Reviewer",
  runtime: "claude",
  device_id: "device-remote",
  workspace_id: "workspace-review",
  route_label: "device-default",
  permission_profile: "manual",
  approval_policy_id: "",
  status: "idle",
  role_hint: "Independent review Agent",
  capabilities: ["Independent review Agent"],
}]);
assert.equal(JSON.stringify(roster).includes("token"), false);

const requested = await runtime.handleMcpGatewayRequest({
  sessionId: leadSession,
  action: "team_change",
  payload: {
    operation: "add",
    reason: "The current Team needs a bounded Linux verification workspace.",
    participant: {
      participant_id: "linux_verifier",
      display_name: "Linux verifier",
      runtime: "codex",
      device_id: "device-linux",
      workspace_id: "workspace-linux",
      permission_profile: "guarded",
      role_hint: "Linux-only verification",
    },
  },
});
assert.equal(requested.status, "awaiting_user_confirmation");
assert.equal(store.getWorkspaceSession(second.run_id).team_revision, 1);
assert.equal(store.getRun(second.run_id).agents.linux_verifier, undefined);

registry.emit(leadSession, { type: "agent.text", text: "Waiting for Team confirmation.", eventId: "lead-text" });
registry.emit(leadSession, { type: "agent.task.complete", eventId: "lead-complete" });
await runtime.queue;
run = store.getRun(second.run_id);
assert.equal(run.state, "blocked");

const attention = store.listAttention(second.run_id)[0];
await assert.rejects(
  runtime.resolveAttention(second.run_id, attention.attention_id, {
    action: "confirm_team_change",
    expectedRevision: attention.revision + 1,
    resolvedBy: "stale-test-user",
  }),
  (error) => error?.code === "COLLABORATION_ATTENTION_REVISION_CONFLICT",
);
assert.equal(store.getWorkspaceSession(second.run_id).team_revision, 1);
assert.equal(store.listAttention(second.run_id)[0].status, "pending");
await runtime.resolveAttention(second.run_id, attention.attention_id, {
  action: "confirm_team_change",
  expectedRevision: attention.revision,
  resolvedBy: "test-user",
});
run = store.getRun(second.run_id);
session = store.getWorkspaceSession(second.run_id);
assert.equal(session.team_revision, 2);
assert.equal(run.team_revision, 2);
assert.equal(run.state, "executing");
assert.ok(run.agents.linux_verifier);
assert.ok(run.tasks.some((task) => task.task_key === "team_change_resume_2"));
assert.equal(launches.length, 1, "the unchanged primary Agent keeps its native process binding");
assert.equal(registry.commands.filter((item) => item.command.type === "agent.message").length, 2);

runtime.close();
store.close();
console.log("Collaboration Session Team tests passed");
