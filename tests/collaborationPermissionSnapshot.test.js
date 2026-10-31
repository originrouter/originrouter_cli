import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileApprovalPolicy, protectedApprovalPolicy } from "../src/runtime/approvalPolicy.js";
import { collaborationPermissionSnapshotDigest, normalizeCollaborationPermissionSnapshot, resolveCollaborationPermissionSnapshot } from "../src/collaboration/collaborationPermissionSnapshot.js";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { CollaborationApprovalSupervisor } from "../src/collaboration/collaborationApprovalSupervisor.js";
import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

function customSnapshot() {
  const policy = compileApprovalPolicy({ ...protectedApprovalPolicy(), id: "session-policy" });
  return { profile: "custom", policyBundle: { id: policy.policy.id, revision: policy.revision, content: policy.policy } };
}

function aiSnapshot() {
  const template = { allowed_scopes: ["read_tools"], applicability: {}, instructions: "Review reads.", name: "Review", protocol_version: "1", template_id: "ait_review_template" };
  return { profile: "ai_review", aiReviewPolicy: { ...template, version: 1, content_hash: createHash("sha256").update(JSON.stringify(template)).digest("hex") } };
}

test("custom and AI approval snapshots are validated and resolve independently", () => {
  const custom = customSnapshot();
  const frozen = normalizeCollaborationPermissionSnapshot(custom);
  const digest = collaborationPermissionSnapshotDigest(frozen);
  custom.policyBundle.content.name = "Changed after selection";
  assert.equal(collaborationPermissionSnapshotDigest(frozen), digest);
  assert.equal(resolveCollaborationPermissionSnapshot(frozen).approvalPolicy.revision, frozen.policyBundle.revision);
  const ai = resolveCollaborationPermissionSnapshot(aiSnapshot());
  assert.equal(ai.aiReviewPolicy.instructions, "Review reads.");
  assert.equal(ai.approvalPolicy, null);
});

test("missing and tampered policies cannot be accepted as snapshots", () => {
  const custom = customSnapshot();
  const ai = aiSnapshot();
  for (const input of [
    { profile: "custom" },
    { ...custom, policyBundle: { ...custom.policyBundle, id: "wrong" } },
    { ...custom, policyBundle: { ...custom.policyBundle, revision: "wrong" } },
    { profile: "ai_review" },
    { ...ai, aiReviewPolicy: { ...ai.aiReviewPolicy, instructions: "Tampered" } },
    { profile: "manual" },
  ]) assert.throws(() => normalizeCollaborationPermissionSnapshot(input));
});

test("permission snapshots remain private, survive restart, and reject corrupted storage", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "collab-permission-"));
  let store = new CollaborationStore({ stateDir });
  const session = store.createConfigurationSession({ objective: "Review", coordinator_device_id: "device", coordinator_runtime: "codex" });
  const digest = store.savePermissionSnapshot("configuration", session.configuration_id, aiSnapshot());
  assert.equal(JSON.stringify(store.getConfigurationSession(session.configuration_id)).includes("Review reads."), false);
  store.close();
  store = new CollaborationStore({ stateDir });
  const saved = store.getPermissionSnapshot("configuration", session.configuration_id);
  assert.equal(saved.digest, digest);
  assert.equal(saved.snapshot.aiReviewPolicy.instructions, "Review reads.");
  store.db.prepare("UPDATE collaboration_configuration_permissions SET digest = ? WHERE configuration_id = ?").run("tampered", session.configuration_id);
  assert.throws(() => store.getPermissionSnapshot("configuration", session.configuration_id), { code: "COLLABORATION_PERMISSION_SNAPSHOT_INVALID" });
  store.close();
});

test("Run and pinned approval policy are created atomically and remain linked", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "collab-permission-run-"));
  const store = new CollaborationStore({ stateDir });
  const input = {
    objective: "Review", supervisor_permission_profile: "custom", supervisor_policy_id: "session-policy",
    participants: [{ participant_id: "lead", display_name: "Lead", runtime: "codex", device_id: "device", workspace_id: "workspace", permission_profile: "guarded", role_hint: "Review", planner: true }],
  };
  const run = store.createRunWithPermissionSnapshot(input, customSnapshot());
  assert.equal(run.supervisor_snapshot_digest, store.getPermissionSnapshot("run", run.run_id).digest);
  const snapshot = store.getPermissionSnapshot("run", run.run_id).snapshot;
  assert.equal(snapshot.policyBundle.id, "session-policy");
  store.updateSupervisorApproval(run.run_id, { profile: "manual" });
  assert.equal(store.getRun(run.run_id).supervisor_snapshot_digest, null);
  const originalSave = store.savePermissionSnapshot;
  store.savePermissionSnapshot = () => { throw new Error("storage failed"); };
  assert.throws(() => store.createRunWithPermissionSnapshot(input, customSnapshot()), /storage failed/);
  store.savePermissionSnapshot = originalSave;
  assert.equal(store.listRuns().length, 1);
  store.close();
});

test("retry preserves the pinned policy and fails closed when it is missing", () => {
  const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), "collab-permission-retry-")) });
  const coordinator = new PlanImplementVerifyCoordinator({ store });
  const original = store.createRunWithPermissionSnapshot({
    objective: "Review", supervisor_permission_profile: "custom", supervisor_policy_id: "session-policy",
    participants: [{ participant_id: "lead", runtime: "codex", device_id: "device", workspace_id: "workspace", permission_profile: "guarded", role_hint: "Review", planner: true }],
  }, customSnapshot());
  coordinator.cancel(original.run_id);
  const retry = store.retryRun(original.run_id);
  assert.equal(retry.supervisor_snapshot_digest, original.supervisor_snapshot_digest);
  assert.equal(store.getPermissionSnapshot("run", retry.run_id).digest, original.supervisor_snapshot_digest);
  coordinator.cancel(retry.run_id);
  store.db.prepare("DELETE FROM collaboration_run_permissions WHERE run_id = ?").run(retry.run_id);
  assert.throws(() => store.retryRun(retry.run_id), { code: "COLLABORATION_PERMISSION_SNAPSHOT_INVALID" });
  assert.equal(store.listRuns().length, 2);
  store.close();
});

test("the supervisor evaluates the pinned custom policy without reading the shared policy library", async () => {
  const supervisor = new CollaborationApprovalSupervisor();
  const selected = customSnapshot();
  const decision = await supervisor.evaluate({
    request: { interactionId: "perm-1", kind: "permission", title: "Bash", payload: { tool: "Bash", command: "uptime", cwd: process.cwd() } },
    agent: { runtime: "codex", permission_profile: "unrestricted" },
    run: { supervisor_permission_profile: "custom", supervisor_policy_id: "session-policy" },
    workspaceRoot: process.cwd(),
    sessionPermissionSnapshot: selected,
  });
  assert.equal(decision.effect, "allow");
  await assert.rejects(supervisor.evaluate({
    request: { interactionId: "perm-2", kind: "permission", payload: { tool: "Bash", command: "uptime", cwd: process.cwd() } },
    agent: { runtime: "codex", permission_profile: "unrestricted" },
    run: { supervisor_permission_profile: "ai_review" },
    workspaceRoot: process.cwd(),
    sessionPermissionSnapshot: selected,
  }), { code: "COLLABORATION_PERMISSION_SNAPSHOT_INVALID" });
});

test("a scoped AI snapshot is used only on its intended device and workspace", async () => {
  const template = { allowed_scopes: ["plan_continue"], applicability: { device_id: "device-1", workspace_reference: "workspace-1" }, instructions: "Review plan.", name: "Plan", protocol_version: "1", template_id: "ait_review_plan" };
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const snapshot = { profile: "ai_review", aiReviewPolicy: { ...template, version: 1, content_hash: createHash("sha256").update(JSON.stringify(canonical(template))).digest("hex") } };
  const reviews = [];
  const supervisor = new CollaborationApprovalSupervisor({ aiReviewer: { async review(input) { reviews.push(input); return { decision: "allow", risk: "low", confidence: 0.95 }; } } });
  const request = { interactionId: "plan-1", kind: "confirm", title: "Continue?" };
  const run = { supervisor_permission_profile: "ai_review" };
  const agent = { runtime: "codex", permission_profile: "unrestricted", device_id: "device-1", workspace_id: "workspace-1" };
  const decision = await supervisor.evaluate({ request, agent, run, workspaceRoot: process.cwd(), sessionPermissionSnapshot: snapshot });
  assert.equal(decision.effect, "allow");
  assert.equal(reviews[0].aiReviewPolicy.instructions, "Review plan.");
  const outside = await supervisor.evaluate({ request, agent: { ...agent, device_id: "device-2" }, run, workspaceRoot: process.cwd(), sessionPermissionSnapshot: snapshot });
  assert.equal(outside.effect, "ask");
  assert.equal(reviews.length, 1);
});

test("runtime asks if a pinned snapshot is missing or the policy changes during review", async () => {
  const run = { run_id: "run", supervisor_permission_profile: "custom", supervisor_policy_id: "session-policy", supervisor_snapshot_digest: "expected", agents: { lead: { device_id: "local", runtime: "codex", permission_profile: "guarded" } } };
  let current = run;
  let saved = null;
  let completeReview;
  const store = { stateDir: "", expireUnconfirmedPlans: () => [], getAccountBudgetBlockedState: () => null, hasAccountBudgetBlockedRuns: () => false, getPermissionSnapshot: () => saved, getRun: () => current };
  const runtime = new CollaborationRuntime({
    store,
    approvalSupervisor: { evaluate: () => new Promise((resolve) => { completeReview = resolve; }) },
  });
  const interaction = { run, role: "lead", taskId: "task", sessionId: "session", request: { interactionId: "approval", kind: "permission" } };
  const missing = await runtime.superviseInteractionRequest(interaction);
  assert.equal(missing.handled, false);
  assert.equal(missing.decision.reason, "COLLABORATION_PERMISSION_SNAPSHOT_INVALID");
  saved = { digest: "expected", snapshot: customSnapshot() };
  const pending = runtime.superviseInteractionRequest(interaction);
  current = { ...run, supervisor_permission_profile: "manual", supervisor_snapshot_digest: null };
  completeReview({ effect: "allow", action: "allow" });
  const changed = await pending;
  assert.equal(changed.handled, false);
  assert.equal(changed.decision.reason, "session_permission_changed");
  runtime.close();
});

test("old snapshots are ignored after a Session switches to a regular permission profile", async () => {
  const run = { run_id: "run", supervisor_permission_profile: "guarded", supervisor_policy_id: null, supervisor_snapshot_digest: null, agents: { lead: { device_id: "local", runtime: "codex", permission_profile: "guarded" } } };
  const delivered = [];
  const store = { stateDir: "", expireUnconfirmedPlans: () => [], getAccountBudgetBlockedState: () => null, hasAccountBudgetBlockedRuns: () => false, getPermissionSnapshot: () => { throw new Error("stale snapshot is corrupt"); }, getRun: () => run, recordExecutionEvent: () => {} };
  const runtime = new CollaborationRuntime({ store, registry: { enqueueCommand: (_session, command) => delivered.push(command) }, approvalSupervisor: { evaluate: async () => ({ effect: "allow", action: "allow", layers: [] }) } });
  const result = await runtime.superviseInteractionRequest({ run, role: "lead", taskId: "task", sessionId: "session", request: { interactionId: "approval", kind: "permission" } });
  assert.equal(result.handled, true);
  assert.equal(delivered.length, 1);
  runtime.close();
});

test("an Agent permission change while a review is pending requires a fresh decision", async () => {
  const run = { run_id: "run", supervisor_permission_profile: "guarded", supervisor_policy_id: null, supervisor_snapshot_digest: null, agents: { lead: { agent_id: "a1", device_id: "local", runtime: "codex", permission_profile: "guarded" } } };
  let current = run;
  let completeReview;
  const store = { stateDir: "", expireUnconfirmedPlans: () => [], getAccountBudgetBlockedState: () => null, hasAccountBudgetBlockedRuns: () => false, getRun: () => current };
  const runtime = new CollaborationRuntime({ store, approvalSupervisor: { evaluate: () => new Promise((resolve) => { completeReview = resolve; }) } });
  const pending = runtime.superviseInteractionRequest({ run, role: "lead", taskId: "task", sessionId: "session", request: { interactionId: "approval", kind: "permission" } });
  current = { ...run, agents: { lead: { ...run.agents.lead, permission_profile: "manual" } } };
  completeReview({ effect: "allow", action: "allow" });
  const result = await pending;
  assert.equal(result.handled, false);
  assert.equal(result.decision.reason, "agent_permission_changed");
  runtime.close();
});

test("a pending automatic review cannot authorize an interrupted or replaced turn", async () => {
  for (const replacement of ["paused", "budget_exhausted", "resumed"]) {
    const agent = { agent_id: "a1", device_id: "local", runtime: "codex", current_task_id: "task", attempt: 1, fencing_token: 1 };
    const run = { run_id: "run", state: "executing", agents: { lead: agent } };
    let current = run;
    let completeReview;
    const commands = [];
    const store = { stateDir: "", expireUnconfirmedPlans: () => [], getAccountBudgetBlockedState: () => null, hasAccountBudgetBlockedRuns: () => false, getRun: () => current };
    const runtime = new CollaborationRuntime({ store, registry: { enqueueCommand: (...args) => commands.push(args) }, approvalSupervisor: { evaluate: () => new Promise((resolve) => { completeReview = resolve; }) } });
    const pending = runtime.superviseInteractionRequest({ run, role: "lead", taskId: "task", sessionId: "session", request: { interactionId: "approval", kind: "permission" } });
    current = replacement === "resumed"
      ? { ...run, agents: { lead: { ...agent, attempt: 2, fencing_token: 2 } } }
      : { ...run, state: replacement };
    completeReview({ effect: "allow", action: "allow", layers: [] });
    assert.equal((await pending).handled, true);
    assert.equal(commands.length, 0);
    runtime.close();
  }
});

test("team changes retain the pinned policy only while the supervisor selection is unchanged", () => {
  const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), "collab-permission-team-")) });
  const run = store.createRunWithPermissionSnapshot({
    objective: "Review", supervisor_permission_profile: "custom", supervisor_policy_id: "session-policy",
    participants: [{ participant_id: "lead", runtime: "codex", device_id: "device", workspace_id: "workspace", permission_profile: "guarded", role_hint: "Review", planner: true }],
  }, customSnapshot());
  const team = store.getWorkspaceSession(run.workspace_session_id).team;
  const unchanged = store.applySessionTeamToRun(run.run_id, team, 2);
  assert.equal(unchanged.supervisor_snapshot_digest, run.supervisor_snapshot_digest);
  assert.equal(unchanged.approval_revision, run.approval_revision + 1);
  const changed = store.applySessionTeamToRun(run.run_id, { ...team, supervisor_permission_profile: "manual", supervisor_policy_id: "" }, 3);
  assert.equal(changed.supervisor_snapshot_digest, null);
  assert.equal(changed.approval_revision, unchanged.approval_revision + 1);
  store.close();
});

test("switching a Session policy away and back invalidates a pending review", async () => {
  const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), "collab-permission-aba-")) });
  const run = store.createRun({
    objective: "Review", supervisor_permission_profile: "guarded",
    participants: [{ participant_id: "lead", runtime: "codex", device_id: "local", workspace_id: "workspace", permission_profile: "guarded", role_hint: "Review", planner: true }],
  });
  let completeReview;
  const runtime = new CollaborationRuntime({ store, approvalSupervisor: { evaluate: () => new Promise((resolve) => { completeReview = resolve; }) } });
  const pending = runtime.superviseInteractionRequest({ run, role: "lead", taskId: "task", sessionId: "session", request: { interactionId: "approval", kind: "permission" } });
  store.updateSupervisorApproval(run.run_id, { profile: "manual" });
  store.updateSupervisorApproval(run.run_id, { profile: "guarded" });
  completeReview({ effect: "allow", action: "allow" });
  const result = await pending;
  assert.equal(result.handled, false);
  assert.equal(result.decision.reason, "session_permission_changed");
  runtime.close();
  store.close();
});

test("switching an Agent permission away and back invalidates a pending review", async () => {
  const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), "collab-agent-aba-")) });
  const run = store.createRun({
    objective: "Review", supervisor_permission_profile: "guarded",
    participants: [{ participant_id: "lead", runtime: "codex", device_id: "local", workspace_id: "workspace", permission_profile: "guarded", role_hint: "Review", planner: true }],
  });
  const team = store.getWorkspaceSession(run.workspace_session_id).team;
  let completeReview;
  const runtime = new CollaborationRuntime({ store, approvalSupervisor: { evaluate: () => new Promise((resolve) => { completeReview = resolve; }) } });
  const pending = runtime.superviseInteractionRequest({ run, role: "lead", taskId: "task", sessionId: "session", request: { interactionId: "approval", kind: "permission" } });
  store.applySessionTeamToRun(run.run_id, { ...team, participants: team.participants.map((participant) => ({ ...participant, permission_profile: "manual" })) }, 2);
  store.applySessionTeamToRun(run.run_id, team, 3);
  completeReview({ effect: "allow", action: "allow" });
  const result = await pending;
  assert.equal(result.handled, false);
  assert.equal(result.decision.reason, "session_permission_changed");
  runtime.close();
  store.close();
});
