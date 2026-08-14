import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-collaboration-production-"));
const store = new CollaborationStore({ stateDir });
const createdAt = "2026-08-06T00:00:00.000Z";

const insertRun = store.db.prepare(`
  INSERT INTO collaboration_runs(
    run_id, conversation_id, template_id, template_version, objective,
    state, gates_json, budget_json, usage_json, counters_json,
    created_at, updated_at, finished_at
  ) VALUES (?, ?, 'adaptive', '2', ?, 'completed', '{}', '{}', '{}', '{}', ?, ?, ?)
`);
store.db.transaction(() => {
  for (let index = 0; index < 1_000; index += 1) {
    const suffix = String(index).padStart(4, "0");
    const updatedAt = `2026-08-06T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
    insertRun.run(
      `run-production-${suffix}`,
      `conversation-production-${suffix}`,
      `Production paging run ${suffix}`,
      createdAt,
      updatedAt,
      updatedAt,
    );
  }
})();

const firstPageStarted = performance.now();
const firstPage = store.listRunPage({ category: "recent", page: 1, pageSize: 5 });
const firstPageElapsed = performance.now() - firstPageStarted;
assert.equal(firstPage.total, 1_000);
assert.equal(firstPage.runs.length, 5);
assert.equal(new Set(firstPage.runs.map((run) => run.run_id)).size, 5);
const secondPage = store.listRunPage({ category: "recent", page: 2, pageSize: 5 });
assert.equal(secondPage.runs.length, 5);
assert.equal(
  firstPage.runs.some((run) => secondPage.runs.some((next) => next.run_id === run.run_id)),
  false,
);
assert.ok(firstPageElapsed < 2_000, `1000-run first page took ${firstPageElapsed}ms`);

const eventRunId = firstPage.runs[0].run_id;
const insertEvent = store.db.prepare(`
  INSERT INTO collaboration_execution_events(
    event_id, run_id, schema_version, sequence, type, category, severity,
    visibility, summary, detail, payload_json, metadata_json,
    idempotency_key, created_at, recorded_at
  ) VALUES (?, ?, 2, ?, 'agent.activity', 'agent', 'info', 'diagnostic',
    'Coalesced diagnostic activity', '', '{}', '{}', ?, ?, ?)
`);
store.db.transaction(() => {
  for (let sequence = 1; sequence <= 100_000; sequence += 1) {
    const id = `event-production-${sequence}`;
    insertEvent.run(id, eventRunId, sequence, id, createdAt, createdAt);
  }
  store.db.prepare(
    "UPDATE collaboration_runs SET last_event_sequence = 100000 WHERE run_id = ?",
  ).run(eventRunId);
})();

const cursorStarted = performance.now();
const eventPage = store.listExecutionEventPage(eventRunId, {
  afterSequence: 99_950,
  limit: 50,
});
const cursorElapsed = performance.now() - cursorStarted;
assert.equal(eventPage.events.length, 50);
assert.equal(eventPage.events[0].sequence, 99_951);
assert.equal(eventPage.events.at(-1).sequence, 100_000);
assert.equal(eventPage.next_sequence, 100_000);
assert.equal(eventPage.has_more, false);
assert.ok(cursorElapsed < 2_000, `100k-event cursor page took ${cursorElapsed}ms`);

// A transient writer lock must surface as SQLITE_BUSY and leave the store
// usable immediately after the lock is released.
const blocker = new CollaborationStore({ stateDir });
store.db.pragma("busy_timeout = 20");
blocker.db.exec("BEGIN IMMEDIATE");
assert.throws(
  () => store.recordExecutionEvent(eventRunId, {
    type: "task.progress",
    summary: "Must not be partially recorded while the database is busy.",
    idempotencyKey: "busy-fault-event",
  }),
  (error) => error?.code === "SQLITE_BUSY",
);
blocker.db.exec("ROLLBACK");
blocker.close();
assert.equal(
  store.recordExecutionEvent(eventRunId, {
    type: "task.progress",
    summary: "Recording recovered after the writer lock was released.",
    idempotencyKey: "busy-recovery-event",
  }).duplicate,
  false,
);

// SQLite's max_page_count gives a deterministic full-disk equivalent without
// consuming the developer machine's disk. A failed write must not corrupt the
// database, and normal writes must resume once capacity returns.
const pageCount = Number(store.db.pragma("page_count", { simple: true }));
store.db.pragma(`max_page_count = ${pageCount}`);
assert.throws(
  () => store.recordExecutionEvent(eventRunId, {
    type: "task.progress",
    summary: "x".repeat(1024),
    detail: "y".repeat(8192),
    idempotencyKey: "disk-full-fault-event",
  }),
  (error) => error?.code === "SQLITE_FULL",
);
store.db.pragma("max_page_count = 1073741823");
assert.equal(store.db.pragma("integrity_check", { simple: true }), "ok");
assert.equal(
  store.recordExecutionEvent(eventRunId, {
    type: "task.progress",
    summary: "Recording recovered after capacity returned.",
    idempotencyKey: "disk-full-recovery-event",
  }).duplicate,
  false,
);

// Product limits must remain usable at the supported 16-Agent / 24-task
// boundary, rather than only in the common two-Agent path.
const coordinator = new PlanImplementVerifyCoordinator({ store });
const participants = Array.from({ length: 16 }, (_, index) => ({
  participant_id: `agent_${index + 1}`,
  display_name: `Agent ${index + 1}`,
  runtime: index % 2 === 0 ? "codex" : "claude",
  device_id: index < 8 ? "device-a" : "device-b",
  workspace_id: "/workspace",
  permission_profile: "guarded",
  planner: index === 0,
}));
const boundaryRun = coordinator.create({
  objective: "Exercise the documented production participant and task limits.",
  participants,
  budget: { max_concurrency: 16 },
});
coordinator.start(boundaryRun.run_id);
const boundaryStarted = performance.now();
store.setAdaptivePlan(boundaryRun.run_id, {
  version: 1,
  title: "Boundary plan",
  summary: "Twenty-four independently addressable tasks.",
  tasks: Array.from({ length: 24 }, (_, index) => ({
    id: `task_${index + 1}`,
    title: `Boundary task ${index + 1}`,
    instructions: `Complete boundary task ${index + 1}.`,
    participant_id: participants[index % participants.length].participant_id,
    depends_on: index < 16 ? [] : [`task_${index - 15}`],
    mode: index % 3 === 0 ? "verify" : "workspace_write",
    deliverable: `Evidence for task ${index + 1}`,
  })),
});
const boundarySnapshot = store.getSnapshot(boundaryRun.run_id);
const boundaryElapsed = performance.now() - boundaryStarted;
assert.equal(boundarySnapshot.participants.length, 16);
assert.equal(
  boundarySnapshot.tasks.filter((task) => task.task_key !== "__planner__").length,
  24,
);
assert.equal(boundarySnapshot.run.budget.max_concurrency, 16);
assert.ok(boundaryElapsed < 2_000, `16-Agent / 24-task snapshot took ${boundaryElapsed}ms`);

store.close();
console.log("collaboration production reliability tests passed");
