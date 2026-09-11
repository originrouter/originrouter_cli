import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { executionEventProjection } from "../src/collaboration/collaborationRuntime.js";
import { normalizeTelemetryEvent } from "../src/telemetry/telemetryQueue.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "originrouter-collab-telemetry-"));
}

test("collaboration execution events are mirrored to telemetry without affecting writes", () => {
  const stateDir = tempDir();
  const events = [];
  const queue = { enqueue(input, context) { events.push({ input, context }); return { inserted: true }; } };
  const uploader = { schedule() { events.push({ scheduled: true }); } };
  try {
    const store = new CollaborationStore({
      stateDir,
      telemetryQueue: queue,
      telemetryUploader: uploader,
      telemetryContextProvider: () => ({ providerType: "originrouter", trainingEligible: true }),
    });
    const created = store.createRun({
      conversationId: "conv-telemetry",
      templateId: "plan_implement_verify",
      templateVersion: "1",
      objective: "test",
      agents: {
        lead: { agent_id: "agent-1", role: "lead", runtime: "codex", device_id: "dev-1", provider: "originrouter-cloud", model: "gpt-5", responsibilities: ["plan"] },
        worker: { agent_id: "agent-2", role: "worker", runtime: "codex", device_id: "dev-1", provider: "originrouter-cloud", model: "gpt-5", responsibilities: ["work"] },
      },
    });
    const result = store.recordExecutionEvent(created.run_id, {
      event_id: "event-1",
      type: "agent.task.completed",
      participant_id: "agent-1",
      summary: "done",
      idempotency_key: "idem-1",
      metadata: { from_model: "gpt-5.4", to_model: "gpt-5.5" },
      payload: {
        provider: "originrouter-cloud",
        model: "gpt-5.5",
        token_usage: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 3 },
      },
    });
    assert.equal(result.duplicate, false);
    const telemetry = events.find((item) => item.input?.eventId === "event-1");
    assert.equal(telemetry.context.providerSource, "originrouter-coding");
    assert.equal(telemetry.context.provider, "originrouter-cloud");
    assert.equal(telemetry.context.model, "gpt-5.5");
    assert.equal(telemetry.input.eventId, "event-1");
    assert.equal(telemetry.input.payload.provider, "originrouter-cloud");
    assert.equal(telemetry.input.payload.model, "gpt-5.5");
    assert.deepEqual(telemetry.input.payload.token_usage, {
      input_tokens: 10,
      output_tokens: 4,
      reasoning_tokens: undefined,
      cache_read_input_tokens: 3,
      cache_write_input_tokens: undefined,
      cache_write_5m_input_tokens: undefined,
      cache_write_1h_input_tokens: undefined,
    });
    assert.deepEqual(telemetry.input.payload.metadata, {
      from_model: "gpt-5.4",
      to_model: "gpt-5.5",
    });
    assert.ok(events.some((item) => item.scheduled));
    assert.equal(store.listExecutionEvents(created.run_id).length, 2);
    store.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("non-cloud collaboration events retain metadata-only source context", () => {
  const stateDir = tempDir();
  const events = [];
  try {
    const store = new CollaborationStore({
      stateDir,
      telemetryQueue: { enqueue(...args) { events.push(args); return { inserted: true }; } },
      telemetryContextProvider: () => ({ providerType: "proxy", trainingEligible: true }),
    });
    const created = store.createRun({ conversationId: "conv-local", templateId: "plan_implement_verify", templateVersion: "1", objective: "test", agents: {
      lead: { agent_id: "agent-1", role: "lead", runtime: "codex", device_id: "dev-1", provider: "local", model: "x", responsibilities: ["plan"] },
      worker: { agent_id: "agent-2", role: "worker", runtime: "codex", device_id: "dev-1", provider: "local", model: "x", responsibilities: ["work"] },
    } });
    store.recordExecutionEvent(created.run_id, { event_id: "event-local", participant_id: "agent-1", type: "agent.task.completed" });
    const localEvent = events.find((item) => item[0]?.eventId === "event-local");
    assert.ok(localEvent);
    assert.notEqual(localEvent[1].providerSource, "originrouter-coding");
    store.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("dynamic execution route type overrides the Agent's static route type", () => {
  const stateDir = tempDir();
  const events = [];
  try {
    const store = new CollaborationStore({
      stateDir,
      telemetryQueue: { enqueue(input, context) { events.push({ input, context }); return { inserted: true }; } },
      telemetryContextProvider: () => ({ providerType: "originrouter", trainingEligible: true }),
    });
    const created = store.createRun({ conversationId: "conv-reroute", templateId: "plan_implement_verify", templateVersion: "1", objective: "test", agents: {
      lead: { agent_id: "agent-1", role: "lead", runtime: "codex", device_id: "dev-1", provider: "cloud", model: "x", responsibilities: ["plan"] },
      worker: { agent_id: "agent-2", role: "worker", runtime: "codex", device_id: "dev-1", provider: "cloud", model: "x", responsibilities: ["work"] },
    } });
    store.recordExecutionEvent(created.run_id, {
      event_id: "event-reroute", participant_id: "agent-1", type: "agent.activity",
      payload: { provider: "local-route", provider_type: "proxy", model: "local-model" },
    });
    const telemetry = events.find((item) => item.input?.eventId === "event-reroute");
    assert.equal(telemetry.context.provider, "local-route");
    assert.equal(telemetry.context.providerType, "proxy");
    assert.equal(telemetry.context.providerSource, "");
    store.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("adaptive plans emit a body-free task graph for telemetry", () => {
  const stateDir = tempDir();
  const events = [];
  try {
    const store = new CollaborationStore({
      stateDir,
      telemetryQueue: { enqueue(input, context) { events.push({ input, context }); return { inserted: true }; } },
      telemetryUploader: { schedule() {} },
      telemetryContextProvider: () => ({ providerType: "proxy", trainingEligible: true }),
    });
    const coordinator = new PlanImplementVerifyCoordinator({ store });
    const created = coordinator.create({
      objective: "private objective must not be projected",
      participants: [
        { participant_id: "planner", runtime: "codex", device_id: "dev", planner: true },
        { participant_id: "worker", runtime: "claude", device_id: "dev" },
      ],
    });
    coordinator.start(created.run_id);
    store.setAdaptivePlan(created.run_id, {
      version: 1,
      title: "private plan title",
      summary: "private plan summary",
      tasks: [{
        id: "research",
        title: "private task title",
        instructions: "private task instructions",
        participant_id: "worker",
        depends_on: [],
        mode: "read_only",
        deliverable: "private deliverable",
      }],
    });
    const task = events.find((item) => item.input?.eventType === "task.planned");
    assert.ok(task);
    assert.equal(task.input.taskKind, "read_only");
    const normalized = normalizeTelemetryEvent(task.input, task.context);
    assert.equal(normalized.payload.plan_version, 1);
    assert.equal(normalized.payload.dependency_count, 0);
    assert.deepEqual(normalized.payload.depends_on_task_ids, []);
    assert.equal(JSON.stringify(task.input).includes("private task instructions"), false);
    assert.equal(JSON.stringify(task.input).includes("private deliverable"), false);
    store.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("collaboration relationship facts are projected without message or artifact bodies", () => {
  const stateDir = tempDir();
  const events = [];
  try {
    const store = new CollaborationStore({
      stateDir,
      telemetryQueue: { enqueue(input, context) { events.push({ input, context }); return { inserted: true }; } },
      telemetryUploader: { schedule() {} },
      telemetryContextProvider: () => ({ providerType: "originrouter", trainingEligible: true }),
    });
    const created = store.createRun({ conversationId: "conv-relationships", templateId: "plan_implement_verify", templateVersion: "1", objective: "private", agents: {
      lead: { agent_id: "agent-1", role: "lead", runtime: "codex", device_id: "dev-1", provider: "originrouter-cloud", model: "gpt-5", responsibilities: ["plan"] },
      worker: { agent_id: "agent-2", role: "worker", runtime: "claude", device_id: "dev-2", provider: "originrouter-cloud", model: "gpt-5", responsibilities: ["work"] },
    } });
    const taskId = created.task_ids[0];
    store.appendMessage(created.run_id, {
      taskId,
      type: "task.progress",
      idempotencyKey: "relationship-message-1",
      sender: { kind: "agent", agent_id: "agent-1" },
      recipient: { kind: "agent", agent_id: "agent-2" },
      payload: { content: "private collaboration content" },
      artifact_refs: ["artifact-private"],
      evidence_refs: ["evidence-private"],
      requires_ack: true,
    });
    store.registerArtifact(created.run_id, {
      taskId,
      artifactId: "artifact-private",
      ownerAgentId: "agent-1",
      kind: "report",
      displayName: "private report name",
      locator: "/private/path",
    });
    const assignment = store.upsertRemoteAssignment({
      assignmentId: "assignment-1",
      runId: created.run_id,
      taskId,
      role: "worker",
      phase: "implementing",
      sourceDeviceId: "dev-1",
      targetDeviceId: "dev-2",
      runtime: "claude",
      workspaceId: "workspace-1",
      provider: "originrouter-cloud",
      model: "gpt-5",
      deliveryId: "delivery-1",
      attempt: 1,
      fencingToken: 1,
      leaseId: "lease-1",
      leaseExpiresAt: "2026-09-07T00:30:00.000Z",
    });
    store.updateRemoteAssignment(assignment.assignment.assignment_id, { status: "running" });

    const message = events.find((item) => item.input?.eventType === "collaboration.message.recorded");
    const artifact = events.find((item) => item.input?.eventType === "artifact.created");
    const remoteCreated = events.find((item) => item.input?.eventType === "remote_assignment.created");
    const remoteUpdated = events.find((item) => item.input?.eventType === "remote_assignment.updated");
    assert.ok(message);
    assert.ok(artifact);
    assert.ok(remoteCreated);
    assert.ok(remoteUpdated);
    assert.equal(JSON.stringify(message.input).includes("private collaboration content"), false);
    assert.equal(JSON.stringify(artifact.input).includes("private report name"), false);
    assert.equal(JSON.stringify(artifact.input).includes("/private/path"), false);

    const normalizedMessage = normalizeTelemetryEvent(message.input, message.context);
    const normalizedArtifact = normalizeTelemetryEvent(artifact.input, artifact.context);
    const normalizedRemote = normalizeTelemetryEvent(remoteCreated.input, remoteCreated.context);
    assert.equal(normalizedMessage.payload.message_type, "task.progress");
    assert.equal(normalizedMessage.payload.artifact_ref_count, 1);
    assert.equal(normalizedArtifact.payload.artifact_kind, "report");
    assert.equal(normalizedRemote.payload.assignment_status, "pending");
    assert.equal(normalizedRemote.payload.assignment_target_device_id, "dev-2");
    store.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("execution projection preserves provider reroutes and gateway response facts", () => {
  const projected = executionEventProjection({
    type: "agent.activity",
    provider: "codex",
    providerType: "originrouter",
    model: "gpt-5.5",
    activity: "model_rerouted",
    metadata: {
      from_model: "gpt-5.4",
      to_model: "gpt-5.5",
      model_provider_id: "openai",
      prompt: "must not pass through",
    },
    gatewayResponseIds: ["resp_gateway_1"],
  });
  assert.equal(projected.payload.provider, "codex");
  assert.equal(projected.payload.provider_type, "originrouter");
  assert.equal(projected.payload.model, "gpt-5.5");
  assert.deepEqual(projected.payload.metadata, {
    from_model: "gpt-5.4",
    to_model: "gpt-5.5",
    model_provider_id: "openai",
  });
  assert.deepEqual(projected.payload.gateway_response_ids, ["resp_gateway_1"]);
  const normalized = normalizeTelemetryEvent({
    event_type: projected.type,
    payload: projected.payload,
    gateway_response_ids: projected.payload.gateway_response_ids,
  }, { runId: "acr_model_reroute", providerSource: "originrouter-coding" });
  assert.deepEqual(normalized.payload.metadata, projected.payload.metadata);
  assert.deepEqual(normalized.gateway_response_ids, ["resp_gateway_1"]);
});

test("execution projection preserves lifecycle identity in payload and metadata", () => {
  const projected = executionEventProjection({
    type: "plan.updated",
    lifecycleId: "turn-1",
    summary: "Plan updated",
  });

  assert.equal(projected.payload.lifecycle_id, "turn-1");
  assert.equal(projected.metadata.lifecycle_id, "turn-1");
});

test("terminal telemetry is rebuilt when a process dies after the state commit", () => {
  const stateDir = tempDir();
  const events = [];
  try {
    const first = new CollaborationStore({ stateDir });
    const created = first.createRun({
      conversationId: "conv-crash-recovery",
      templateId: "plan_implement_verify",
      templateVersion: "1",
      objective: "private",
      agents: {
        lead: { agent_id: "agent-1", role: "lead", runtime: "codex", device_id: "dev-1", responsibilities: ["plan"] },
        worker: { agent_id: "agent-2", role: "worker", runtime: "codex", device_id: "dev-1", responsibilities: ["work"] },
      },
    });
    first.db.prepare("UPDATE collaboration_runs SET state = 'completed', finished_at = ?, updated_at = ? WHERE run_id = ?")
      .run("2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z", created.run_id);
    first.close();

    const recovered = new CollaborationStore({
      stateDir,
      telemetryQueue: {
        enqueue(input, context) {
          events.push({ input, context });
          return { inserted: true };
        },
      },
      telemetryContextProvider: () => ({ providerType: "originrouter", trainingEligible: true }),
    });
    assert.ok(events.some((item) => item.input.eventType === "run.completed"));
    assert.equal(recovered.listExecutionEvents(created.run_id).filter((item) => item.type === "run.completed").length, 1);
    recovered.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
