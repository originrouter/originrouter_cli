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
  enqueueCommand(sessionId, command) { this.commands.push({ sessionId, command }); }
  emit(sessionId, payload) {
    for (const listener of this.listeners) listener({ type: "event", sessionId, payload });
  }
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-adaptive-collaboration-"));
const store = new CollaborationStore({ stateDir });
const coordinator = new PlanImplementVerifyCoordinator({ store });
const registry = new Registry();
const launches = [];
const supervisor = {
  async start(payload) {
    launches.push(payload);
    registry.sessions.set(payload.sessionId, { session_id: payload.sessionId, status: "running" });
    return { launchId: payload.launchId, sessionId: payload.sessionId, conversationId: payload.conversationId };
  },
};
const runtime = new CollaborationRuntime({
  store,
  coordinator,
  registry,
  supervisor,
  deviceId: "local",
  registrationTimeoutMs: 100,
  pollIntervalMs: 1,
});

const created = coordinator.create({
  objective: "Investigate and implement a safe export command.",
  preferences: "Research and implementation may run in parallel when safe.",
  workflow_template_id: "adaptive",
  coordination_prompt: "Use the architect for the final verification.",
  participants: [
    { participant_id: "architect", runtime: "codex", device_id: "local", workspace_id: "/project", planner: true },
    { participant_id: "builder", runtime: "claude", device_id: "local", workspace_id: "/project" },
  ],
  budget: { max_concurrency: 2 },
});
assert.equal(created.template_id, "adaptive_collaboration");
assert.equal(created.budget.token_limit, null, "budgets are optional for adaptive collaborations");

await runtime.start(created.run_id);
await new Promise((resolve) => setImmediate(resolve));
let run = store.getRun(created.run_id);
assert.equal(run.state, "designing");
const plannerSession = run.agents.architect.originrouter_session_id;
const plannerMessage = registry.commands.find((item) => item.command.type === "agent.message")?.command.message;
assert.match(plannerMessage, /The user will review it before any task starts/);
assert.match(plannerMessage, /Use the architect for the final verification/);

const proposed = {
  title: "Safe export collaboration",
  summary: "Research and implementation run independently, followed by verification.",
  tasks: [
    { id: "research", title: "Research constraints", instructions: "Inspect the current behavior.", participant_id: "architect", depends_on: [], mode: "read_only", deliverable: "Research summary" },
    { id: "build", title: "Implement export", instructions: "Implement the export command.", participant_id: "builder", depends_on: [], mode: "workspace_write", deliverable: "Working implementation" },
    { id: "verify", title: "Verify result", instructions: "Check the implementation against the objective.", participant_id: "architect", depends_on: ["research", "build"], mode: "verify", deliverable: "Verification result" },
  ],
};
registry.emit(plannerSession, {
  type: "agent.text",
  text: `ORIGINROUTER_PLAN_JSON_START\n${JSON.stringify(proposed)}\nORIGINROUTER_PLAN_JSON_END`,
  eventId: "planner-text",
});
registry.emit(plannerSession, { type: "agent.task.complete", eventId: "planner-complete" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.state, "awaiting_plan_confirmation");
assert.equal(run.plan_status, "proposed");
assert.equal(run.tasks.filter((task) => task.task_key !== "__planner__").length, 3);
assert.equal(registry.commands.filter((item) => item.command.type === "agent.message").length, 1, "execution must not start before confirmation");

await runtime.confirm(created.run_id);
run = store.getRun(created.run_id);
assert.equal(run.state, "executing");
assert.equal(run.tasks.filter((task) => task.state === "active").length, 2, "independent tasks should run in parallel");
assert.equal(launches.length, 2, "the planner session is reused and the second participant is launched once");
const builderSession = run.agents.builder.originrouter_session_id;

registry.emit(plannerSession, { type: "agent.text", text: "Research complete", eventId: "research-text" });
registry.emit(plannerSession, { type: "agent.task.complete", eventId: "research-complete" });
await runtime.queue;
assert.equal(store.getRun(created.run_id).tasks.find((task) => task.task_key === "verify").state, "pending");

registry.emit(builderSession, { type: "agent.text", text: "Implementation complete", eventId: "build-text" });
registry.emit(builderSession, { type: "agent.task.complete", eventId: "build-complete" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.tasks.find((task) => task.task_key === "verify").state, "active");
assert.equal(run.agents.architect.current_task_id, run.tasks.find((task) => task.task_key === "verify").task_id);

registry.emit(plannerSession, { type: "agent.text", text: "Verification passed", eventId: "verify-text" });
registry.emit(plannerSession, { type: "agent.task.complete", eventId: "verify-complete" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.state, "completed");
assert.ok(run.tasks.filter((task) => task.task_key !== "__planner__").every((task) => task.state === "completed"));

const recoveryCreated = coordinator.create({
  objective: "Recover an interrupted adaptive task.",
  participants: [
    { participant_id: "worker", runtime: "codex", device_id: "local", workspace_id: "/project", planner: true },
  ],
});
coordinator.start(recoveryCreated.run_id);
store.setAdaptivePlan(recoveryCreated.run_id, {
  version: 1,
  title: "Recovery plan",
  summary: "One task",
  tasks: [
    { id: "work", title: "Do work", instructions: "Complete the task.", participant_id: "worker", depends_on: [], mode: "workspace_write", deliverable: "Result" },
  ],
});
await runtime.confirm(recoveryCreated.run_id);
let recoveryRun = store.getRun(recoveryCreated.run_id);
const oldSession = recoveryRun.agents.worker.originrouter_session_id;
const oldFencingToken = recoveryRun.agents.worker.fencing_token;
assert.equal(recoveryRun.tasks.find((task) => task.task_key === "work").state, "active");

runtime.close();
const recoveredRuntime = new CollaborationRuntime({
  store,
  coordinator,
  registry,
  supervisor,
  deviceId: "local",
  registrationTimeoutMs: 100,
  pollIntervalMs: 1,
});
await recoveredRuntime.recover();
await new Promise((resolve) => setImmediate(resolve));
recoveryRun = store.getRun(recoveryCreated.run_id);
const newSession = recoveryRun.agents.worker.originrouter_session_id;
assert.notEqual(newSession, oldSession, "recovery must detach the stale local session");
assert.ok(recoveryRun.agents.worker.fencing_token > oldFencingToken);

registry.emit(oldSession, { type: "agent.text", text: "Stale result", eventId: "stale-text" });
registry.emit(oldSession, { type: "agent.task.complete", eventId: "stale-complete" });
await recoveredRuntime.queue;
assert.equal(store.getRun(recoveryCreated.run_id).state, "executing", "stale local results must be ignored");

registry.emit(newSession, { type: "agent.text", text: "Recovered result", eventId: "recovered-text" });
registry.emit(newSession, { type: "agent.task.complete", eventId: "recovered-complete" });
await recoveredRuntime.queue;
assert.equal(store.getRun(recoveryCreated.run_id).state, "completed");

recoveredRuntime.close();
store.close();
console.log("adaptive collaboration tests passed");
