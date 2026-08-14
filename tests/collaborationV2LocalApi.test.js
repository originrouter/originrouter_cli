import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { startLocalApi } from "../src/local/localApi.js";
import { ensureApiToken } from "../src/persistence/authToken.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-collaboration-v2-api-"));
process.env.ORIGINROUTER_HOME = stateDir;
const token = ensureApiToken(stateDir);
const store = new CollaborationStore({ stateDir });
const coordinator = new PlanImplementVerifyCoordinator({ store });
const created = coordinator.create({
  objective: "Exercise the collaboration V2 API.",
  participants: [{
    participant_id: "planner",
    runtime: "codex",
    device_id: "local",
    workspace_id: "/project",
    planner: true,
  }],
});

const handle = await startLocalApi({
  collaborationStore: store,
  collaborationCoordinator: coordinator,
  sessionManager: { sessions: new Map() },
}, { port: 0 });
const base = `http://127.0.0.1:${handle.port}`;
const headers = { Authorization: `Bearer ${token}` };

try {
  const capabilitiesResponse = await fetch(
    `${base}/collaboration/local/capabilities`,
    { headers },
  );
  assert.equal(capabilitiesResponse.status, 200);
  const capabilitiesPayload = await capabilitiesResponse.json();
  assert.equal(capabilitiesPayload.capabilities.schema_version, 1);
  assert.equal(capabilitiesPayload.capabilities.device.device_id, "local-dev");
  assert.deepEqual(
    capabilitiesPayload.capabilities.runtimes.map((runtime) => runtime.id),
    ["claude", "codex"],
  );
  assert.equal(capabilitiesPayload.capabilities.protocol_versions.collaboration_snapshot, 2);
  assert.equal(capabilitiesPayload.capabilities.freshness.stale, false);

  const snapshotResponse = await fetch(
    `${base}/collaboration/local/runs/${encodeURIComponent(created.run_id)}/snapshot`,
    { headers },
  );
  assert.equal(snapshotResponse.status, 200);
  const snapshotPayload = await snapshotResponse.json();
  assert.equal(snapshotPayload.snapshot.schema_version, 2);
  assert.equal(snapshotPayload.snapshot.run.state, "created");

  store.recordExecutionEvent(created.run_id, {
    type: "task.progress",
    summary: "API cursor event",
    idempotencyKey: "api-cursor-event",
  });
  const eventsResponse = await fetch(
    `${base}/collaboration/local/runs/${encodeURIComponent(created.run_id)}/events?after_sequence=1&limit=10`,
    { headers },
  );
  assert.equal(eventsResponse.status, 200);
  const eventsPayload = await eventsResponse.json();
  assert.equal(eventsPayload.events.length, 1);
  assert.equal(eventsPayload.events[0].summary, "API cursor event");
  assert.equal(eventsPayload.next_sequence, 2);
  assert.equal(eventsPayload.has_more, false);

  store.recordExecutionEvent(created.run_id, {
    type: "task.progress",
    participantId: "other",
    taskId: "task-other",
    summary: "Filtered cursor event",
    idempotencyKey: "api-filtered-cursor-event",
  });
  store.recordExecutionEvent(created.run_id, {
    type: "task.progress",
    participantId: "planner",
    taskId: "task-planner",
    summary: "Planner cursor event",
    idempotencyKey: "api-planner-cursor-event",
  });
  const filteredPageResponse = await fetch(
    `${base}/collaboration/local/runs/${encodeURIComponent(created.run_id)}/events?after_sequence=2&participant_id=planner&limit=1`,
    { headers },
  );
  const filteredPage = await filteredPageResponse.json();
  assert.equal(filteredPage.events.length, 0);
  assert.equal(filteredPage.next_sequence, 3);
  assert.equal(filteredPage.has_more, true);
  const plannerPageResponse = await fetch(
    `${base}/collaboration/local/runs/${encodeURIComponent(created.run_id)}/events?after_sequence=${filteredPage.next_sequence}&participant_id=planner&limit=1`,
    { headers },
  );
  const plannerPage = await plannerPageResponse.json();
  assert.equal(plannerPage.events[0].summary, "Planner cursor event");
  assert.equal(plannerPage.next_sequence, 4);
  const taskPageResponse = await fetch(
    `${base}/collaboration/local/runs/${encodeURIComponent(created.run_id)}/events?after_sequence=3&task_id=task-planner&limit=1`,
    { headers },
  );
  const taskPage = await taskPageResponse.json();
  assert.equal(taskPage.events.length, 1);
  assert.equal(taskPage.events[0].task_id, "task-planner");

  const diagnosticsResponse = await fetch(
    `${base}/collaboration/local/runs/${encodeURIComponent(created.run_id)}/diagnostics`,
    { headers },
  );
  assert.equal(diagnosticsResponse.status, 200);
  const diagnosticsPayload = await diagnosticsResponse.json();
  assert.equal(diagnosticsPayload.diagnostics.run.run_id, created.run_id);
  assert.equal(diagnosticsPayload.diagnostics.database_integrity, "ok");
  assert.equal("objective" in diagnosticsPayload.diagnostics.run, false);

  coordinator.start(created.run_id);
  store.setAdaptivePlan(created.run_id, {
    version: 1,
    title: "Initial API plan",
    summary: "A plan that will be revised through the API.",
    tasks: [{
      id: "inspect",
      title: "Inspect",
      instructions: "Inspect the current state.",
      participant_id: "planner",
      depends_on: [],
      mode: "read_only",
      deliverable: "Inspection",
    }],
  });
  const replanResponse = await fetch(
    `${base}/collaboration/local/runs/${encodeURIComponent(created.run_id)}/replan`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: "Add an independent verification step." }),
    },
  );
  assert.equal(replanResponse.status, 200);
  const replanPayload = await replanResponse.json();
  assert.equal(replanPayload.run.state, "designing");
  assert.equal(
    replanPayload.run.plan_revision_feedback,
    "Add an independent verification step.",
  );
} finally {
  await handle.close();
  store.close();
}

console.log("collaboration V2 local API tests passed");
