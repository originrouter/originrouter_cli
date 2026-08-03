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
    if (!this.sessions.has(sessionId)) throw new Error("session not active");
    this.commands.push({ sessionId, command });
  }
  emit(sessionId, payload) {
    for (const listener of this.listeners) listener({ type: "event", sessionId, payload });
  }
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-agent-mcp-"));
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
  deviceId: "device-local",
  registrationTimeoutMs: 100,
  pollIntervalMs: 1,
});

const created = coordinator.create({
  objective: "Let one Agent dynamically ask another Agent for a review.",
  participants: [
    { participant_id: "requester", runtime: "claude", device_id: "device-local", workspace_id: "workspace-a", planner: true },
    { participant_id: "reviewer", runtime: "codex", device_id: "device-local", workspace_id: "workspace-b" },
  ],
  budget: { max_concurrency: 2 },
});
coordinator.start(created.run_id);
store.setAdaptivePlan(created.run_id, {
  title: "Dynamic MCP delegation",
  summary: "The requester uses the Agent MCP gateway.",
  tasks: [{
    id: "requester_work",
    title: "Request a review",
    instructions: "Use the OriginRouter MCP gateway to ask the reviewer.",
    participant_id: "requester",
    depends_on: [],
    mode: "discussion",
    deliverable: "A reviewed answer.",
  }],
});
await runtime.confirm(created.run_id);
let run = store.getRun(created.run_id);
const requesterSession = run.agents.requester.originrouter_session_id;

const listed = await runtime.handleMcpGatewayRequest({
  sessionId: requesterSession,
  action: "list",
});
assert.deepEqual(listed.participants.map((item) => item.participant_id), ["reviewer"]);

const delegated = await runtime.handleMcpGatewayRequest({
  sessionId: requesterSession,
  action: "delegate",
  payload: {
    participant_id: "reviewer",
    instructions: "Return the exact marker REVIEWER_MCP_OK.",
    deliverable: "The marker REVIEWER_MCP_OK.",
    mode: "discussion",
    wait_requested: true,
  },
});
run = store.getRun(created.run_id);
const delegatedTask = run.tasks.find((task) => task.task_id === delegated.task_id);
assert.equal(delegatedTask.parent_task_id, run.agents.requester.current_task_id);
assert.equal(delegatedTask.participant_id, "reviewer");
assert.equal(delegatedTask.state, "active");
assert.ok(run.messages.some((message) => message.type === "agent.mcp.delegated"));

const reviewerSession = run.agents.reviewer.originrouter_session_id;
registry.emit(reviewerSession, { type: "agent.text", text: "REVIEWER_MCP_OK", eventId: "review-text" });
registry.emit(reviewerSession, { type: "agent.task.complete", eventId: "review-complete" });
await runtime.queue;

const status = await runtime.handleMcpGatewayRequest({
  sessionId: requesterSession,
  action: "status",
  payload: { task_id: delegated.task_id },
});
assert.equal(status.state, "completed");
assert.equal(status.result, "REVIEWER_MCP_OK");

registry.emit(requesterSession, { type: "agent.text", text: "Requester accepted REVIEWER_MCP_OK", eventId: "requester-text" });
registry.emit(requesterSession, { type: "agent.task.complete", eventId: "requester-complete" });
await runtime.queue;
run = store.getRun(created.run_id);
assert.equal(run.state, "completed");
assert.ok(registry.commands.some((item) => item.command.type === "session.stop"));

await assert.rejects(
  runtime.handleMcpGatewayRequest({ sessionId: requesterSession, action: "status", payload: { task_id: "other" } }),
  /not attached to an active collaboration task|unavailable/,
);

runtime.close();
store.close();
console.log("Agent MCP gateway tests passed");
