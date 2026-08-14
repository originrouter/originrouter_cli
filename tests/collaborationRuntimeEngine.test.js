import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";

class FakeRegistry {
  constructor() {
    this.sessions = new Map();
    this.listeners = new Set();
    this.commands = [];
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list() { return [...this.sessions.values()]; }
  add(sessionId) { this.sessions.set(sessionId, { session_id: sessionId, status: "running" }); }
  enqueueCommand(sessionId, command) {
    if (!this.sessions.has(sessionId)) throw new Error("session not active");
    this.commands.push({ sessionId, command });
    return command;
  }
  emit(sessionId, event) {
    for (const listener of this.listeners) {
      listener({ type: "event", sessionId, payload: event });
    }
  }
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-collaboration-engine-"));
const store = new CollaborationStore({ stateDir });
const coordinator = new PlanImplementVerifyCoordinator({ store });
const registry = new FakeRegistry();
const launches = [];
const supervisor = {
  async start(payload) {
    launches.push(payload);
    registry.add(payload.sessionId);
    return {
      launchId: payload.launchId,
      sessionId: payload.sessionId,
      conversationId: payload.conversationId,
      accepted: true,
    };
  },
};
const runtime = new CollaborationRuntime({
  store,
  coordinator,
  supervisor,
  registry,
  deviceId: "device-local",
  registrationTimeoutMs: 100,
  pollIntervalMs: 1,
});
const created = coordinator.create({
  objective: "Implement a safe export command.",
  agents: {
    lead: {
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-1",
      responsibilities: ["research", "review_plan", "verify_result"],
    },
    worker: {
      runtime: "claude",
      device_id: "device-local",
      workspace_id: "workspace-1",
      responsibilities: ["propose_plan", "implement", "rework"],
    },
  },
  gates: { max_plan_revisions: 2, max_rework_rounds: 2 },
});

await runtime.start(created.run_id);
await new Promise((resolve) => setImmediate(resolve));
let run = store.getRun(created.run_id);
assert.equal(run.state, "researching");
assert.equal(launches.length, 1);
assert.equal(launches[0].agentType, "codex");
let leadSession = run.agents.lead.originrouter_session_id;
registry.emit(leadSession, {
  type: "agent.interaction.requested",
  eventId: "lead-approval-request",
  interactionId: "permission-1",
  kind: "permission",
  title: "Allow a read-only command?",
  prompt: "The lead wants to inspect the workspace.",
});
await runtime.queue;
let attention = store.getSnapshot(created.run_id).attention;
assert.equal(attention.length, 1);
assert.equal(attention[0].kind, "approval");
await runtime.resolveAttention(created.run_id, attention[0].attention_id, {
  action: "allow",
  expected_revision: attention[0].revision,
});
assert.ok(registry.commands.some((item) => (
  item.sessionId === leadSession
  && item.command.type === "agent.interaction.resolve"
  && item.command.interactionId === "permission-1"
)));
assert.equal(store.getSnapshot(created.run_id).attention.length, 0);
registry.emit(leadSession, { type: "agent.text", text: "Research brief", eventId: "lead-text-1" });
registry.emit(leadSession, { type: "agent.task.complete", eventId: "lead-done-1" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.state, "planning");
assert.equal(launches.length, 2);
let workerSession = run.agents.worker.originrouter_session_id;
store.appendMessage(run.run_id, {
  task_id: run.task_ids[0],
  type: "task.progress",
  idempotency_key: "budget-warning-context-test",
  sender: { kind: "coordinator", device_id: "device-local" },
  recipient: { kind: "user" },
  payload: {
    content: "Task budget reached 80%; review usage before continuing.",
    budget_status: "warning",
  },
});
const planningPrompt = runtime.promptFor(store.getRun(run.run_id), "worker");
assert.match(planningPrompt, /Lead research:\nResearch brief/);
assert.doesNotMatch(planningPrompt, /Lead research:\nTask budget reached 80%/);

registry.emit(workerSession, { type: "agent.text", text: "Initial plan", eventId: "worker-text-1" });
registry.emit(workerSession, { type: "agent.task.completed", eventId: "worker-done-1" });
await runtime.queue;
assert.equal(store.getRun(created.run_id).state, "awaiting_plan_review");

registry.emit(leadSession, { type: "agent.text", text: "Add rollback. ORIGINROUTER_DECISION: REVISION_REQUIRED", eventId: "lead-text-2" });
registry.emit(leadSession, { type: "agent.task.complete", eventId: "lead-done-2" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.state, "planning");
assert.equal(run.counters.plan_revisions, 1);

registry.emit(workerSession, { type: "agent.text", text: "Revised plan with rollback", eventId: "worker-text-2" });
registry.emit(workerSession, { type: "agent.task.completed", eventId: "worker-done-2" });
await runtime.queue;
registry.emit(leadSession, { type: "agent.text", text: "ORIGINROUTER_DECISION: APPROVE", eventId: "lead-text-3" });
registry.emit(leadSession, { type: "agent.task.complete", eventId: "lead-done-3" });
await runtime.queue;
assert.equal(store.getRun(created.run_id).state, "implementing");

registry.emit(workerSession, { type: "agent.text", text: "Implementation report", eventId: "worker-text-3" });
registry.emit(workerSession, { type: "agent.task.completed", eventId: "worker-done-3" });
await runtime.queue;
assert.equal(store.getRun(created.run_id).state, "awaiting_verification");
registry.emit(leadSession, { type: "agent.text", text: "One test fails. ORIGINROUTER_VERIFICATION: REWORK", eventId: "lead-text-4" });
registry.emit(leadSession, { type: "agent.task.complete", eventId: "lead-done-4" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.state, "implementing");
assert.equal(run.counters.rework_rounds, 1);

registry.emit(workerSession, { type: "agent.text", text: "Rework completed", eventId: "worker-text-4" });
registry.emit(workerSession, { type: "agent.task.completed", eventId: "worker-done-4" });
await runtime.queue;
registry.emit(leadSession, { type: "agent.text", text: "ORIGINROUTER_VERIFICATION: PASS", eventId: "lead-text-5" });
registry.emit(leadSession, { type: "agent.task.complete", eventId: "lead-done-5" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.state, "completed");
assert.equal(run.tasks[0].state, "completed");
assert.equal(run.counters.plan_revisions, 1);
assert.equal(run.counters.rework_rounds, 1);
assert.ok(run.messages.some((message) => message.type === "plan.submitted"));
assert.ok(run.messages.some((message) => message.type === "verification.passed"));
assert.equal(launches.length, 2, "native sessions are reused across all turns");

const failedCreated = coordinator.create({
  objective: "Verify failed Agent turns stop the collaboration run.",
  agents: {
    lead: {
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-1",
      responsibilities: ["research"],
    },
    worker: {
      runtime: "claude",
      device_id: "device-local",
      workspace_id: "workspace-1",
      responsibilities: ["implement"],
    },
  },
});
await runtime.start(failedCreated.run_id);
await new Promise((resolve) => setImmediate(resolve));
const failedLeadSession = store.getRun(failedCreated.run_id).agents.lead.originrouter_session_id;
registry.emit(failedLeadSession, {
  type: "agent.task.complete",
  status: "failed",
  eventId: "lead-failed-turn",
});
await runtime.queue;
const failedRun = store.getRun(failedCreated.run_id);
assert.equal(failedRun.state, "failed");
assert.equal(
  failedRun.messages.find((message) => message.type === "task.failed")?.payload?.code,
  "COLLABORATION_AGENT_TURN_FAILED",
);
assert.ok(registry.commands.some((item) => (
  item.sessionId === failedLeadSession && item.command.type === "session.stop"
)));

const budgetRelayMessages = [];
const budgetRuntime = new CollaborationRuntime({
  store,
  coordinator,
  supervisor,
  registry,
  deviceId: "device-local",
  relayClient: {
    async send(type, payload) {
      budgetRelayMessages.push({ type, payload });
      return { accepted: true };
    },
  },
  registrationTimeoutMs: 100,
  pollIntervalMs: 1,
});
const budgetCreated = coordinator.create({
  objective: "Pause and resume from an account budget limit.",
  agents: {
    lead: {
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-1",
      responsibilities: ["research"],
    },
    worker: {
      runtime: "claude",
      device_id: "device-local",
      workspace_id: "workspace-1",
      responsibilities: ["implement"],
    },
  },
});
await budgetRuntime.start(budgetCreated.run_id);
await new Promise((resolve) => setImmediate(resolve));
const budgetLeadSession = store.getRun(budgetCreated.run_id).agents.lead.originrouter_session_id;
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status",
  targetDeviceId: "device-local",
  run_id: budgetCreated.run_id,
  blocked: true,
});
let budgetRun = store.getRun(budgetCreated.run_id);
assert.equal(budgetRun.state, "budget_exhausted");
assert.equal(budgetRun.account_budget_blocked, true);
assert.ok(registry.commands.some((item) => (
  item.sessionId === budgetLeadSession && item.command.type === "terminal.interrupt"
)));
const commandCountAfterBlock = registry.commands.length;
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status",
  targetDeviceId: "device-local",
  run_id: budgetCreated.run_id,
  blocked: true,
});
assert.equal(registry.commands.length, commandCountAfterBlock, "replayed block status is idempotent");

await budgetRuntime.updateBudget(budgetCreated.run_id, { token_limit: 900000 });
assert.equal(store.getRun(budgetCreated.run_id).state, "budget_exhausted");
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status",
  targetDeviceId: "device-local",
  run_id: budgetCreated.run_id,
  blocked: false,
});
await new Promise((resolve) => setImmediate(resolve));
budgetRun = store.getRun(budgetCreated.run_id);
assert.equal(budgetRun.state, "researching");
assert.equal(budgetRun.account_budget_blocked, false);
assert.ok(budgetRun.messages.some((message) => message.payload?.budget_status === "account_available"));

await budgetRuntime.refreshAccountBudgetStatus();
assert.deepEqual(budgetRelayMessages.at(-1), {
  type: "collaboration.budget.status.request",
  payload: { sourceDeviceId: "device-local" },
});

await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status",
  targetDeviceId: "device-local",
  run_id: "",
  blocked: true,
});
const createdWhileBlocked = coordinator.create({
  objective: "Do not dispatch a new run while the account is blocked.",
  agents: {
    lead: { runtime: "codex", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["implement"] },
  },
});
const launchCountBeforeBlockedStart = launches.length;
await budgetRuntime.start(createdWhileBlocked.run_id);
assert.equal(store.getRun(createdWhileBlocked.run_id).account_budget_blocked, true);
assert.equal(launches.length, launchCountBeforeBlockedStart);
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status",
  targetDeviceId: "device-local",
  run_id: "",
  blocked: false,
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(store.getRun(createdWhileBlocked.run_id).state, "researching");
assert.equal(launches.length, launchCountBeforeBlockedStart + 1);

budgetRuntime.close();
runtime.close();
store.close();
console.log("collaboration runtime engine tests passed");
