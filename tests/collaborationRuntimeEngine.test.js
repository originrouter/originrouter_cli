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
      permission_profile: "guarded",
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
assert.equal(launches[0].permissionProfile, "manual", "managed child Runtime must always report approvals to OriginRouter");
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
assert.deepEqual(attention[0].actions, ["allow", "deny"]);
await runtime.resolveAttention(created.run_id, attention[0].attention_id, {
  action: "allow",
  expected_revision: attention[0].revision,
});
assert.ok(registry.commands.some((item) => (
  item.sessionId === leadSession
  && item.command.type === "agent.interaction.resolve"
  && item.command.interactionId === "permission-1"
  && item.command.action === "allow"
  && item.command.response.remember_for_session === false
)));
assert.equal(store.getSnapshot(created.run_id).attention.length, 0);
registry.emit(leadSession, {
  type: "agent.interaction.requested",
  eventId: "lead-plan-confirmation",
  interactionId: "confirm-1",
  kind: "confirm",
  title: "Implement this plan?",
  prompt: "Review this action before continuing.",
  payload: { plan: "Inspect the current configuration without changing the device." },
});
await runtime.queue;
assert.equal(store.getSnapshot(created.run_id).attention.length, 0, "guarded policy continues a plan confirmation");
assert.ok(registry.commands.some((item) => (
  item.sessionId === leadSession
  && item.command.interactionId === "confirm-1"
  && item.command.kind === "confirm"
  && item.command.action === "allow"
  && item.command.response.policy_evaluated === true
)));
store.updateSupervisorApproval(created.run_id, { profile: "manual" });
registry.emit(leadSession, {
  type: "agent.interaction.requested", eventId: "lead-manual-confirmation",
  interactionId: "confirm-manual", kind: "confirm", title: "Continue?", prompt: "Review first.",
});
await runtime.queue;
attention = store.getSnapshot(created.run_id).attention;
const manualConfirm = attention.find((item) => item.kind === "confirm");
assert.ok(manualConfirm);
await runtime.resolveAttention(created.run_id, manualConfirm.attention_id, { action: "allow", expected_revision: manualConfirm.revision });
assert.ok(registry.commands.some((item) => item.command.interactionId === "confirm-manual" && item.command.action === "allow"));
store.updateSupervisorApproval(created.run_id, { profile: "guarded" });
registry.emit(leadSession, {
  type: "agent.interaction.requested",
  eventId: "lead-questions-request",
  interactionId: "questions-1",
  kind: "questions",
  title: "Choose a verification mode",
  prompt: "Answer the questions to continue.",
  payload: {
    questions: [{
      id: "mode",
      header: "Mode",
      question: "Which verification mode?",
      options: [{ id: "fast", label: "Fast" }, { id: "full", label: "Full" }],
    }],
  },
});
await runtime.queue;
attention = store.getSnapshot(created.run_id).attention;
assert.equal(attention.length, 1);
assert.equal(attention[0].kind, "questions");
assert.equal(attention[0].payload.request.questions[0].id, "mode");
assert.equal(attention[0].payload.request.questions[0].options[1].label, "Full");
await runtime.resolveAttention(created.run_id, attention[0].attention_id, {
  action: "submit",
  response: { answers: { mode: ["full"] } },
  expected_revision: attention[0].revision,
});
assert.ok(registry.commands.some((item) => (
  item.command.interactionId === "questions-1"
  && item.command.response.answers.mode[0] === "full"
)));
registry.emit(leadSession, {
  type: "agent.interaction.requested",
  eventId: "lead-form-request",
  interactionId: "form-1",
  kind: "form",
  title: "MCP request",
  prompt: "Choose an account.",
  payload: {
    schema: {
      type: "object",
      properties: { account: { type: "string", title: "Account" } },
      required: ["account"],
    },
  },
});
await runtime.queue;
attention = store.getSnapshot(created.run_id).attention;
assert.equal(attention.length, 1);
assert.equal(attention[0].kind, "form");
assert.deepEqual(attention[0].payload.request.form_fields, [{
  name: "account",
  label: "Account",
  description: "",
  type: "string",
  required: true,
  requires_local_entry: false,
  options: [],
}]);
await runtime.resolveAttention(created.run_id, attention[0].attention_id, {
  action: "submit",
  response: { values: { account: "primary" } },
  expected_revision: attention[0].revision,
});
assert.ok(registry.commands.some((item) => (
  item.command.interactionId === "form-1"
  && item.command.response.values.account === "primary"
)));
registry.emit(leadSession, {
  type: "agent.interaction.requested",
  eventId: "lead-url-request",
  interactionId: "url-1",
  kind: "url",
  title: "MCP authorization",
  prompt: "Authorize the MCP server in your browser.",
  payload: { url: "https://example.test/authorize" },
});
await runtime.queue;
attention = store.getSnapshot(created.run_id).attention;
assert.equal(attention.length, 1);
assert.equal(attention[0].kind, "url");
assert.equal(attention[0].payload.request.url, "https://example.test/authorize");
await runtime.resolveAttention(created.run_id, attention[0].attention_id, {
  action: "submit",
  expected_revision: attention[0].revision,
});
assert.ok(registry.commands.some((item) => (
  item.command.interactionId === "url-1"
  && item.command.action === "submit"
)));
registry.emit(leadSession, {
  type: "agent.interaction.requested",
  eventId: "lead-risky-approval-request",
  interactionId: "permission-risky-1",
  kind: "permission",
  title: "Bash needs permission",
  prompt: "Remove the generated build directory before rebuilding.",
  tool: "Bash",
  command: "rm -rf ./build",
  cwd: process.cwd(),
});
await runtime.queue;
attention = store.getSnapshot(created.run_id).attention;
assert.equal(attention.length, 1);
assert.equal(attention[0].payload.request.tool, "Bash");
assert.equal(attention[0].payload.request.command, "rm -rf ./build");
assert.equal(attention[0].payload.request.cwd, process.cwd());
assert.equal(attention[0].payload.supervisor_evaluation.effect, "ask");
assert.equal(attention[0].payload.supervisor_evaluation.session_profile, "guarded");
assert.deepEqual(
  attention[0].payload.supervisor_evaluation.layers.map((layer) => layer.name),
  ["agent", "session"],
);
await runtime.resolveAttention(created.run_id, attention[0].attention_id, {
  action: "deny",
  expected_revision: attention[0].revision,
});
registry.emit(leadSession, {
  type: "agent.interaction.requested",
  eventId: "lead-safe-approval-request",
  interactionId: "permission-safe-1",
  kind: "permission",
  title: "Bash needs permission",
  tool: "Bash",
  command: "uptime",
});
await runtime.queue;
assert.equal(store.getSnapshot(created.run_id).attention.length, 0, "routine requests should be centrally auto-approved");
assert.ok(registry.commands.some((item) => (
  item.sessionId === leadSession
  && item.command.interactionId === "permission-safe-1"
  && item.command.action === "allow"
  && item.command.decisionSource === "originrouter-session-supervisor"
)));
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

const pausedCreated = coordinator.create({
  objective: "Ignore interrupted turn results after a manual pause.",
  agents: {
    lead: { runtime: "codex", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["implement"] },
  },
});
await runtime.start(pausedCreated.run_id);
await new Promise((resolve) => setImmediate(resolve));
const pausedSession = store.getRun(pausedCreated.run_id).agents.lead.originrouter_session_id;
store.updateSupervisorApproval(pausedCreated.run_id, { profile: "manual" });
await runtime.handleRegistryNotification({ type: "event", sessionId: pausedSession, payload: {
  type: "agent.interaction.requested", eventId: "before-pause-request", interactionId: "before-pause", kind: "permission",
} });
const interruptedAttention = store.getSnapshot(pausedCreated.run_id).attention.find((item) => item.payload?.interaction_id === "before-pause");
assert.ok(interruptedAttention);
await runtime.pause(pausedCreated.run_id);
assert.equal(store.listAttention(pausedCreated.run_id).some((item) => item.attention_id === interruptedAttention.attention_id), false);
assert.equal(store.listAttention(pausedCreated.run_id, { status: "" }).find((item) => item.attention_id === interruptedAttention.attention_id).resolution, "interrupted");
await runtime.handleRegistryNotification({ type: "registered", sessionId: pausedSession, payload: { nativeSessionId: "late-native-id" } });
await runtime.handleRegistryNotification({ type: "unregistered", sessionId: pausedSession, payload: { status: "stopped" } });
assert.equal(store.getRun(pausedCreated.run_id).agents.lead.status, "paused", "late registration events must not erase the pause");
assert.equal(store.getRun(pausedCreated.run_id).agents.lead.native_session_id, "late-native-id");
for (const event of [
  { type: "agent.task.failed", eventId: "paused-failure" },
  { type: "agent.task.complete", status: "aborted", eventId: "paused-completion" },
  { type: "agent.usage", sampledTokens: 17, eventId: "paused-usage" },
]) {
  await runtime.handleRegistryNotification({ type: "event", sessionId: pausedSession, payload: event });
}
assert.equal(store.getRun(pausedCreated.run_id).state, "paused");
assert.equal(store.getRun(pausedCreated.run_id).usage.sampled_tokens, 17, "late usage must still be accounted for");
await runtime.resume(pausedCreated.run_id);
assert.equal(store.getRun(pausedCreated.run_id).state, "researching");
assert.equal(store.getRun(pausedCreated.run_id).agents.lead.status, "running");

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
const siblingBudgetRun = coordinator.create({
  objective: "An account limit affects every Run on a coordinator.",
  agents: {
    lead: { runtime: "codex", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["implement"] },
  },
});
coordinator.start(siblingBudgetRun.run_id);
await budgetRuntime.start(budgetCreated.run_id);
await new Promise((resolve) => setImmediate(resolve));
const budgetLeadSession = store.getRun(budgetCreated.run_id).agents.lead.originrouter_session_id;
const statusRequestsBeforeOrdinaryUsage = budgetRelayMessages.filter((item) => item.type === "collaboration.budget.status.request").length;
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", status_protocol: 1, blocked: false,
});
assert.equal(budgetRelayMessages.filter((item) => item.type === "collaboration.budget.status.request").length,
  statusRequestsBeforeOrdinaryUsage, "ordinary unblocked usage must not trigger a status request each time");
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status",
  targetDeviceId: "device-local",
  run_id: budgetCreated.run_id,
  blocked: true,
});
let budgetRun = store.getRun(budgetCreated.run_id);
assert.equal(budgetRun.state, "budget_exhausted");
assert.equal(budgetRun.account_budget_blocked, true);
for (const event of [
  { type: "agent.task.aborted", eventId: "late-budget-abort" },
  { type: "agent.task.complete", status: "aborted", eventId: "late-budget-completion" },
]) {
  await budgetRuntime.handleRegistryNotification({ type: "event", sessionId: budgetLeadSession, payload: event });
  assert.equal(store.getRun(budgetCreated.run_id).state, "budget_exhausted", "an interrupted turn cannot fail a budget-blocked Run");
}
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, true,
  "a status carrying a reporting Run ID still applies to sibling Runs");
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
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, false);
assert.ok(budgetRun.messages.some((message) => message.payload?.budget_status === "account_available"));

await budgetRuntime.refreshAccountBudgetStatus();
assert.equal(budgetRelayMessages.at(-1).type, "collaboration.budget.status.request");
assert.equal(budgetRelayMessages.at(-1).payload.sourceDeviceId, "device-local");
assert.ok(budgetRelayMessages.at(-1).payload.requestId);

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

const multiBudgetRun = coordinator.create({
  objective: "Interrupt every participant when the task budget is exhausted.",
  agents: {
    lead: { runtime: "codex", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "device-remote", workspace_id: "workspace-2", responsibilities: ["implement"] },
  },
  budget: { token_limit: 100 },
});
coordinator.start(multiBudgetRun.run_id);
const multiTaskId = store.getRun(multiBudgetRun.run_id).task_ids[0];
registry.add("budget-local-session");
for (const role of ["lead", "worker"]) {
  store.issueAgentLease(multiBudgetRun.run_id, role, { dispatchKey: `budget-${role}` });
  store.updateAgent(multiBudgetRun.run_id, role, {
    currentTaskId: multiTaskId, status: "running",
    ...(role === "lead" ? { originrouterSessionId: "budget-local-session" } : {}),
  });
}
const exhausted = store.recordUsage(multiBudgetRun.run_id, {
  eventId: "multi-budget-usage-1", sampledTokens: 100,
});
await budgetRuntime.handleBudgetResult(multiBudgetRun.run_id, "lead", "budget-local-session", exhausted);
assert.ok(registry.commands.some((item) => item.sessionId === "budget-local-session" && item.command.type === "terminal.interrupt"));
const budgetCancel = budgetRelayMessages.find((item) => item.type === "collaboration.remote.cancel" && item.payload.runId === multiBudgetRun.run_id);
assert.equal(budgetCancel?.payload.taskId, multiTaskId);
assert.equal(budgetCancel?.payload.reason, "budget_exhausted");
assert.equal(budgetCancel?.payload.targetDeviceId, "device-remote");

// A remote block arriving before its dispatch must fence that dispatch, but
// must not prevent a later attempt after the budget is raised.
await budgetRuntime.handleRelayEvent({ ...budgetCancel.payload, type: "collaboration.remote.cancel", targetDeviceId: "device-local" });
assert.equal(store.isRemoteAssignmentCancelled(budgetCancel.payload), true);
assert.equal(store.isRemoteAssignmentCancelled({ ...budgetCancel.payload, fencingToken: budgetCancel.payload.fencingToken + 1, attempt: budgetCancel.payload.attempt + 1 }), false);

const loweredBudgetRun = coordinator.create({
  objective: "Interrupt running work when a budget is lowered.",
  agents: {
    lead: { runtime: "codex", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["implement"] },
  },
  budget: { token_limit: 1000 },
});
coordinator.start(loweredBudgetRun.run_id);
store.recordUsage(loweredBudgetRun.run_id, { eventId: "lowered-budget-usage-1", sampledTokens: 500 });
registry.add("lowered-budget-session");
store.updateAgent(loweredBudgetRun.run_id, "lead", { currentTaskId: store.getRun(loweredBudgetRun.run_id).task_ids[0], originrouterSessionId: "lowered-budget-session", status: "running" });
assert.equal((await budgetRuntime.updateBudget(loweredBudgetRun.run_id, { token_limit: 400 })).state, "budget_exhausted");
assert.ok(registry.commands.some((item) => item.sessionId === "lowered-budget-session" && item.command.type === "terminal.interrupt"));

const startingRun = coordinator.create({
  objective: "Do not send a task after its budget is blocked during startup.",
  agents: {
    lead: { runtime: "codex", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["implement"] },
  },
});
coordinator.start(startingRun.run_id);
let releaseLaunch;
const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
let startingSessionId;
const slowRuntime = new CollaborationRuntime({
  store, coordinator, registry, deviceId: "device-local",
  supervisor: { async start(payload) {
    startingSessionId = payload.sessionId;
    await launchGate;
    registry.add(payload.sessionId);
    return { sessionId: payload.sessionId, conversationId: payload.conversationId };
  } },
  registrationTimeoutMs: 100, pollIntervalMs: 1,
});
const startingDispatch = slowRuntime.dispatchForState(startingRun.run_id);
assert.ok(startingSessionId);
store.setAccountBudgetBlocked(startingRun.run_id, true);
releaseLaunch();
await startingDispatch;
assert.ok(registry.commands.some((item) => item.sessionId === startingSessionId && item.command.type === "session.stop"));
assert.equal(registry.commands.some((item) => item.sessionId === startingSessionId && item.command.type === "agent.message"), false);
slowRuntime.close();

let releaseBudgetInterrupt;
let markBudgetInterruptStarted;
const budgetInterruptGate = new Promise((resolve) => { releaseBudgetInterrupt = resolve; });
const budgetInterruptStarted = new Promise((resolve) => { markBudgetInterruptStarted = resolve; });
const originalBudgetInterrupt = budgetRuntime.interruptBudgetAgents;
budgetRuntime.interruptBudgetAgents = async () => {
  markBudgetInterruptStarted();
  await budgetInterruptGate;
};
const blockInFlight = budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", blocked: true,
});
await budgetInterruptStarted;
let clearFinished = false;
const clearInFlight = budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", blocked: false,
}).then(() => { clearFinished = true; });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(clearFinished, false, "account status transitions must not interleave during remote interruption");
releaseBudgetInterrupt();
await Promise.all([blockInFlight, clearInFlight]);
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, false);
budgetRuntime.interruptBudgetAgents = originalBudgetInterrupt;

// A delayed account-available push, or a snapshot requested before a newer
// block, must not resume work until a fresh status confirms it is available.
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", status_protocol: 1, blocked: true,
});
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, true);
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", status_protocol: 1, blocked: false,
});
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, true);
const oldBudgetRequest = budgetRelayMessages.at(-1).payload.requestId;
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", status_protocol: 1, blocked: true,
});
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", status_protocol: 1,
  request_id: oldBudgetRequest, blocked: false,
});
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, true);
const freshBudgetRequest = budgetRelayMessages.at(-1).payload.requestId;
assert.notEqual(freshBudgetRequest, oldBudgetRequest);
await budgetRuntime.handleRelayEvent({
  type: "collaboration.budget.status", targetDeviceId: "device-local", status_protocol: 1,
  request_id: freshBudgetRequest, blocked: false,
});
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, false);

// Acknowledged HTTP reports and status snapshots must work even if the
// WebSocket status notification never reaches the coordinator.
let acknowledgedBlocked = true;
budgetRuntime.relayClient.sendAcknowledged = async (_type, _payload) => ({
  data: { accepted: true, budget: { blocked: acknowledgedBlocked } },
});
const httpUsageId = "usage-http-budget-test";
const httpReportId = "account-usage-http-test";
const httpReport = budgetRuntime.accountUsageReport(siblingBudgetRun.run_id, httpUsageId, { sampledTokens: 5 });
store.recordUsage(siblingBudgetRun.run_id, {
  eventId: httpUsageId, sampledTokens: 5, accountReport: httpReport, accountReportOutboxId: httpReportId,
});
await budgetRuntime.deliverAccountUsage(httpReportId);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, true, "the report acknowledgement applies its blocked budget");
assert.equal(store.getOutbox(httpReportId).state, "delivered");
acknowledgedBlocked = false;
await budgetRuntime.refreshAccountBudgetStatus();
assert.equal(store.getRun(siblingBudgetRun.run_id).account_budget_blocked, false, "an acknowledged status snapshot clears the block without a WebSocket");

budgetRuntime.close();
const cancelledRun = coordinator.create({
  objective: "Do not resolve requests after cancellation.",
  agents: {
    lead: { runtime: "codex", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "device-local", workspace_id: "workspace-1", responsibilities: ["implement"] },
  },
});
const pendingAfterCancel = store.createAttention(cancelledRun.run_id, {
  kind: "approval", title: "Pending", actions: ["allow", "deny"], participantId: "lead",
  idempotencyKey: "cancelled-permission-test",
  payload: { session_id: leadSession, interaction_id: "cancelled-permission", kind: "permission" },
});
coordinator.cancel(cancelledRun.run_id);
// Reproduce an older persisted terminal Run with a stale pending attention.
store.db.prepare("UPDATE collaboration_attention_items SET status = 'pending' WHERE attention_id = ?").run(pendingAfterCancel.attention_id);
await assert.rejects(runtime.resolveAttention(cancelledRun.run_id, pendingAfterCancel.attention_id, { action: "allow" }), { code: "COLLABORATION_RUN_TERMINAL" });
assert.equal(registry.commands.some((item) => item.command.interactionId === "cancelled-permission"), false);
const retryResults = await Promise.all([
  runtime.retry(cancelledRun.run_id, "", "retry-concurrent-request"),
  runtime.retry(cancelledRun.run_id, "", "retry-concurrent-request"),
]);
assert.equal(retryResults[0].run_id, retryResults[1].run_id);
assert.equal(store.retryForRequest(cancelledRun.run_id, "retry-concurrent-request").run_id, retryResults[0].run_id);
assert.notEqual(retryResults[0].state, "created");
runtime.close();
store.close();
console.log("collaboration runtime engine tests passed");
