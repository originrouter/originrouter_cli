import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-collaboration-"));
const store = new CollaborationStore({ stateDir });
const coordinator = new PlanImplementVerifyCoordinator({ store });
const run = coordinator.create({
  objective: "Implement and verify account export.",
  agents: {
    lead: { runtime: "codex", device_id: "local", responsibilities: ["research", "review_plan", "verify_result"] },
    worker: { runtime: "claude", device_id: "local", responsibilities: ["propose_plan", "implement", "rework"] },
  },
  gates: { max_plan_revisions: 2, max_rework_rounds: 2 },
});
assert.equal(run.state, "created");
assert.equal(run.agents.lead.runtime, "codex");
assert.equal(run.tasks.length, 1);

coordinator.start(run.run_id);
coordinator.beginPlanning(run.run_id);
const base = {
  task_id: run.task_ids[0],
  sender: { agent_id: run.agents.worker.agent_id, device_id: "local" },
  recipient: { kind: "agent", agent_id: run.agents.lead.agent_id, device_id: "local" },
  payload: {},
};
let result = coordinator.receive(run.run_id, { ...base, type: "plan.submitted", idempotency_key: "plan-submit-1" });
assert.equal(result.run.state, "awaiting_plan_review");
result = coordinator.receive(run.run_id, { ...base, type: "review.revision_requested", idempotency_key: "revision-1" });
assert.equal(result.run.state, "revision_requested");
assert.equal(result.run.counters.plan_revisions, 1);
coordinator.beginPlanning(run.run_id);
coordinator.receive(run.run_id, { ...base, type: "plan.submitted", idempotency_key: "plan-submit-2" });
result = coordinator.receive(run.run_id, { ...base, type: "review.approved", idempotency_key: "approval-1" });
assert.equal(result.run.state, "plan_approved");
coordinator.beginImplementation(run.run_id);
result = coordinator.receive(run.run_id, { ...base, type: "implementation.completed", idempotency_key: "implementation-1" });
assert.equal(result.run.state, "awaiting_verification");
result = coordinator.receive(run.run_id, { ...base, type: "verification.failed", idempotency_key: "verification-1" });
assert.equal(result.run.state, "rework_requested");
assert.equal(result.run.counters.rework_rounds, 1);
coordinator.beginImplementation(run.run_id);
coordinator.receive(run.run_id, { ...base, type: "implementation.completed", idempotency_key: "implementation-2" });
result = coordinator.receive(run.run_id, { ...base, type: "verification.passed", idempotency_key: "verification-2" });
assert.equal(result.run.state, "completed");
assert.equal(result.run.tasks[0].state, "completed");

const duplicate = coordinator.receive(run.run_id, { ...base, type: "verification.passed", idempotency_key: "verification-2" });
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.run.messages.length, 8);
assert.throws(() => coordinator.beginImplementation(run.run_id), /invalid collaboration transition/);
assert.throws(() => coordinator.create({ objective: "bad", agents: { lead: { runtime: "codex", device_id: "local", responsibilities: ["lead"] }, worker: { runtime: "claude", device_id: "local", responsibilities: ["work"], api_key: "no" } } }), /forbidden_collaboration_field/);

store.close();
const reopened = new CollaborationStore({ stateDir });
assert.equal(reopened.getRun(run.run_id).state, "completed");
assert.equal(reopened.getRun(run.run_id).messages.length, 8);
reopened.close();

console.log("collaboration runtime tests passed");

