import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-collaboration-v2-"));
const store = new CollaborationStore({ stateDir });
const coordinator = new PlanImplementVerifyCoordinator({ store });

const created = coordinator.create({
  objective: "Implement and verify a production-safe status view.",
  supervisor_permission_profile: "ai_review",
  participants: [
    {
      participant_id: "planner",
      display_name: "Planner",
      runtime: "codex",
      device_id: "local",
      workspace_id: "/project",
      planner: true,
      permission_profile: "guarded",
      approval_policy_id: "protected",
    },
    {
      participant_id: "builder",
      display_name: "Builder",
      runtime: "claude",
      device_id: "local",
      workspace_id: "/project",
    },
  ],
});

let snapshot = store.getSnapshot(created.run_id);
assert.equal(snapshot.schema_version, 2);
assert.equal(snapshot.run.state, "created");
assert.equal(snapshot.run.legacy_state, "created");
assert.equal(snapshot.last_sequence, 1);
assert.equal(snapshot.tasks[0].state, "ready");
assert.equal(snapshot.participants[0].participant_id, "planner");
assert.equal(snapshot.run.supervisor_permission_profile, "ai_review");
assert.equal(snapshot.participants[0].permission_profile, "guarded");
assert.equal(snapshot.participants[0].approval_policy_id, "protected");
assert.equal(snapshot.attention.length, 0);

coordinator.start(created.run_id);
snapshot = store.getSnapshot(created.run_id);
assert.equal(snapshot.run.state, "planning");
assert.equal(snapshot.run.legacy_state, "designing");
assert.ok(snapshot.last_sequence > 1);

store.setAdaptivePlan(created.run_id, {
  version: 1,
  title: "Production-safe status view",
  summary: "Build the view and verify it independently.",
  tasks: [
    {
      id: "build",
      title: "Build status view",
      instructions: "Implement the view.",
      participant_id: "builder",
      depends_on: [],
      mode: "workspace_write",
      deliverable: "Implementation",
    },
    {
      id: "verify",
      title: "Verify status view",
      instructions: "Verify the implementation.",
      participant_id: "planner",
      depends_on: ["build"],
      mode: "verify",
      deliverable: "Verification report",
    },
  ],
});
snapshot = store.getSnapshot(created.run_id);
assert.equal(snapshot.run.state, "awaiting_confirmation");
assert.equal(snapshot.attention[0].kind, "plan_confirmation");
assert.equal(snapshot.tasks.find((task) => task.task_key === "build").state, "ready");
assert.equal(snapshot.tasks.find((task) => task.task_key === "verify").state, "pending");

store.confirmAdaptivePlan(created.run_id);
snapshot = store.getSnapshot(created.run_id);
assert.equal(snapshot.run.state, "running");
assert.equal(snapshot.attention.length, 0);

store.updateAdaptiveTask(created.run_id, "build", { state: "active" });
store.updateAdaptiveTask(created.run_id, "build", {
  state: "completed",
  resultSummary: "Implementation complete.",
});
snapshot = store.getSnapshot(created.run_id);
assert.equal(snapshot.tasks.find((task) => task.task_key === "build").state, "completed");
assert.equal(snapshot.tasks.find((task) => task.task_key === "verify").state, "ready");

const beforeDuplicate = snapshot.last_sequence;
const first = store.recordExecutionEvent(created.run_id, {
  type: "task.progress",
  summary: "Stable progress",
  idempotencyKey: "stable-progress-event",
});
const duplicate = store.recordExecutionEvent(created.run_id, {
  type: "task.progress",
  summary: "This duplicate must not be inserted",
  idempotencyKey: "stable-progress-event",
});
assert.equal(first.duplicate, false);
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.event_id, first.event_id);
assert.equal(store.getSnapshot(created.run_id).last_sequence, beforeDuplicate + 1);

const eventsAfter = store.listExecutionEvents(created.run_id, {
  afterSequence: beforeDuplicate,
});
assert.equal(eventsAfter.length, 1);
assert.equal(eventsAfter[0].summary, "Stable progress");
assert.equal(eventsAfter[0].schema_version, 2);

store.recordExecutionEvent(created.run_id, {
  type: "task.progress",
  summary: "Unix-second timestamp",
  createdAt: 1_787_222_222,
  idempotencyKey: "unix-second-timestamp-event",
});
const timestampedEvent = store.listExecutionEvents(created.run_id, {
  afterSequence: beforeDuplicate + 1,
})[0];
assert.match(timestampedEvent.created_at, /^2026-/, "Unix seconds must not be stored as a 1970 millisecond timestamp");

store.recordExecutionEvent(created.run_id, {
  type: "task.progress",
  summary: "Provider replied with sk-v1-super-secret-value",
  detail: "authorization: Bearer or_at_super-secret-value",
  payload: { message: "password=hunter2" },
  idempotencyKey: "redacted-progress-event",
});
const redactedEvent = store.listExecutionEvents(created.run_id, {
  afterSequence: beforeDuplicate + 2,
})[0];
assert.ok(!redactedEvent.summary.includes("super-secret-value"));
assert.ok(!redactedEvent.detail.includes("or_at_"));
assert.ok(!redactedEvent.payload.message.includes("hunter2"));

const attention = store.createAttention(created.run_id, {
  kind: "approval",
  title: "Allow test command?",
  actions: ["approve_once", "deny"],
  idempotencyKey: "approval:test-command",
});
assert.equal(store.listAttention(created.run_id).length, 1);
const resolved = store.resolveAttention(created.run_id, attention.attention_id, {
  expectedRevision: attention.revision,
  resolution: "approve_once",
  resolvedBy: "test-user",
});
assert.equal(resolved.duplicate, false);
assert.equal(resolved.item.status, "resolved");
const resolvedAgain = store.resolveAttention(created.run_id, attention.attention_id, {
  expectedRevision: attention.revision,
  resolution: "approve_once",
});
assert.equal(resolvedAgain.duplicate, true);

const recoveryRun = coordinator.create({
  objective: "Exercise pause, resume, and task retry semantics.",
  participants: [
    {
      participant_id: "planner",
      runtime: "codex",
      device_id: "local",
      workspace_id: "/project",
      planner: true,
    },
    {
      participant_id: "builder",
      runtime: "claude",
      device_id: "local",
      workspace_id: "/project",
    },
  ],
});
coordinator.start(recoveryRun.run_id);
let recoverySnapshot = store.getSnapshot(recoveryRun.run_id);
store.pauseRun(recoveryRun.run_id);
recoverySnapshot = store.getSnapshot(recoveryRun.run_id);
assert.equal(recoverySnapshot.run.state, "paused");
assert.equal(recoverySnapshot.run.pause_reason, "user_requested");
store.resumeRun(recoveryRun.run_id);
recoverySnapshot = store.getSnapshot(recoveryRun.run_id);
assert.equal(recoverySnapshot.run.state, "planning");
assert.equal(recoverySnapshot.run.legacy_state, "designing");
store.setAdaptivePlan(recoveryRun.run_id, {
  version: 1,
  title: "Recoverable task",
  summary: "Exercise a retry.",
  tasks: [{
    id: "recoverable",
    title: "Recoverable task",
    instructions: "Perform the recoverable task.",
    participant_id: "builder",
    depends_on: [],
    mode: "workspace_write",
    deliverable: "Result",
  }],
});
store.confirmAdaptivePlan(recoveryRun.run_id);
store.updateAdaptiveTask(recoveryRun.run_id, "recoverable", { state: "active" });
store.updateAdaptiveTask(recoveryRun.run_id, "recoverable", {
  state: "failed",
  resultSummary: "Transient failure.",
});
store.retryAdaptiveTask(recoveryRun.run_id, "recoverable");
recoverySnapshot = store.getSnapshot(recoveryRun.run_id);
assert.equal(
  recoverySnapshot.tasks.find((task) => task.task_key === "recoverable").state,
  "ready",
);
assert.ok(store.listExecutionEvents(recoveryRun.run_id, { limit: 200 })
  .some((event) => event.type === "task.retry_scheduled"));

const revisionRun = coordinator.create({
  objective: "Exercise immutable plan revision history.",
  participants: [
    {
      participant_id: "planner",
      runtime: "codex",
      device_id: "local",
      workspace_id: "/project",
      planner: true,
    },
    {
      participant_id: "builder",
      runtime: "claude",
      device_id: "local",
      workspace_id: "/project",
    },
  ],
});
coordinator.start(revisionRun.run_id);
store.setAdaptivePlan(revisionRun.run_id, {
  version: 1,
  title: "Initial plan",
  summary: "The first proposal.",
  tasks: [{
    id: "initial_task",
    title: "Initial task",
    instructions: "Follow the initial approach.",
    participant_id: "builder",
    depends_on: [],
    mode: "workspace_write",
    deliverable: "Initial result",
  }],
});
let revisionSnapshot = store.getSnapshot(revisionRun.run_id);
assert.equal(revisionSnapshot.run.plan_revision, 1);
store.requestAdaptivePlanRevision(
  revisionRun.run_id,
  "Split implementation and verification into separate tasks.",
);
revisionSnapshot = store.getSnapshot(revisionRun.run_id);
assert.equal(revisionSnapshot.run.state, "planning");
assert.equal(revisionSnapshot.run.legacy_state, "designing");
assert.equal(
  revisionSnapshot.run.plan_revision_feedback,
  "Split implementation and verification into separate tasks.",
);
assert.equal(revisionSnapshot.tasks.length, 1);
assert.equal(revisionSnapshot.tasks[0].task_key, "__planner__");
assert.ok(store.listExecutionEvents(revisionRun.run_id, { limit: 200 })
  .some((event) => event.type === "plan.revision_requested"));
store.setAdaptivePlan(revisionRun.run_id, {
  version: 2,
  title: "Revised plan",
  summary: "Implementation and verification are independent.",
  tasks: [
    {
      id: "implement",
      title: "Implement",
      instructions: "Implement the change.",
      participant_id: "builder",
      depends_on: [],
      mode: "workspace_write",
      deliverable: "Implementation",
    },
    {
      id: "verify",
      title: "Verify",
      instructions: "Verify the change.",
      participant_id: "planner",
      depends_on: ["implement"],
      mode: "verify",
      deliverable: "Verification report",
    },
  ],
});
revisionSnapshot = store.getSnapshot(revisionRun.run_id);
assert.equal(revisionSnapshot.run.plan_revision, 2);
store.confirmAdaptivePlan(revisionRun.run_id);
const revisionRows = store.db.prepare(`
  SELECT revision, status, feedback, confirmed_at, superseded_at
  FROM collaboration_plan_revisions
  WHERE run_id = ?
  ORDER BY revision ASC
`).all(revisionRun.run_id);
assert.equal(revisionRows.length, 2);
assert.equal(revisionRows[0].status, "superseded");
assert.equal(
  revisionRows[0].feedback,
  "Split implementation and verification into separate tasks.",
);
assert.ok(revisionRows[0].superseded_at);
assert.equal(revisionRows[1].status, "confirmed");
assert.ok(revisionRows[1].confirmed_at);

store.updateAdaptiveTask(created.run_id, "verify", { state: "active" });
store.updateAdaptiveTask(created.run_id, "verify", {
  state: "completed",
  resultSummary: "Verification passed.",
});
store.transition(created.run_id, "completed");
snapshot = store.getSnapshot(created.run_id);
assert.equal(snapshot.run.state, "completed");
assert.equal(snapshot.final_report.outcome, "completed");
assert.equal(snapshot.final_report.completed_tasks.length, 2);
assert.equal(snapshot.final_report.verification_result, "passed");
assert.equal(snapshot.artifacts.length, 2);
assert.ok(snapshot.artifacts.every((artifact) => artifact.kind === "agent_result"));

store.transition(recoveryRun.run_id, "failed", { taskState: "failed" });
assert.ok(store.listRunPage({ category: "recent" }).runs
  .some((run) => run.run_id === recoveryRun.run_id));
const retryAttention = store.createAttention(recoveryRun.run_id, {
  kind: "retry",
  title: "Review the failed task",
  actions: ["retry", "dismiss"],
  idempotencyKey: "retry:failed-recovery-run",
});
assert.ok(store.listRunPage({ category: "attention" }).runs
  .some((run) => run.run_id === recoveryRun.run_id));
assert.ok(!store.listRunPage({ category: "recent" }).runs
  .some((run) => run.run_id === recoveryRun.run_id));
store.resolveAttention(recoveryRun.run_id, retryAttention.attention_id, {
  expectedRevision: retryAttention.revision,
  resolution: "dismiss",
});
const retriedRun = store.retryRun(recoveryRun.run_id);
assert.equal(retriedRun.retry_of_run_id, recoveryRun.run_id);
assert.equal(retriedRun.state, "created");
assert.ok(store.listExecutionEvents(retriedRun.run_id, { limit: 20 })
  .some((event) => event.type === "run.retry_created"));

const lastSequence = snapshot.last_sequence;
store.close();

const reopened = new CollaborationStore({ stateDir });
const reopenedSnapshot = reopened.getSnapshot(created.run_id);
assert.equal(reopenedSnapshot.last_sequence, lastSequence);
assert.equal(reopenedSnapshot.final_report.outcome, "completed");
reopened.close();

console.log("collaboration V2 state tests passed");
