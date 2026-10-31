import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

import { CollaborationConfigurationPlanner } from "../src/collaboration/collaborationConfigurationPlanner.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { CollaborationApprovalSupervisor } from "../src/collaboration/collaborationApprovalSupervisor.js";
import { compileApprovalPolicy, protectedApprovalPolicy } from "../src/runtime/approvalPolicy.js";

const capabilities = {
  runtimes: [{ id: "codex", available: true }, { id: "claude", available: true }],
  trusted_workspaces: [{ workspace_id: "workspace", display_name: "Workspace", canonical_path: "/workspace", unattended_execution: { remote_eligible: true } }],
  providers: [], resolved_routes: {}, permission_profiles: [{ id: "manual" }, { id: "guarded" }],
  defaults: { permission_profile: "guarded" }, budget_policy: null,
};
const proposal = {
  participants: [{ participant_id: "planner", display_name: "Planner", runtime: "codex", device_id: "device-local", workspace_id: "workspace", role_hint: "Plan and verify.", permission_profile: "guarded", provider: null, model: null }],
  planner: "planner", workflow_template_id: "adaptive", collaboration_preferences: "Use a safe plan.", max_concurrency: 1,
  independent_review: false, budget: { token_limit: null, amount_limit_micros: null, currency: null },
};

function serverSession(overrides = {}) {
  return {
    configuration_id: "server-config",
    revision: 1,
    state: "proposal_ready",
    questions: [],
    tool_requests: [],
    proposal,
    planning_source: "server_model",
    planner_invocation: {
      model: "planner-model",
      response_id: "resp_planner_1",
      duration_ms: 42,
      token_usage: { input_tokens: 10, output_tokens: 5 },
    },
    ...overrides,
  };
}

function fixture(serverClient, deviceCapabilities = capabilities) {
  const telemetry = [];
  const store = new CollaborationStore({
    stateDir: mkdtempSync(join(tmpdir(), "originrouter-config-")),
    telemetryQueue: {
      enqueue(input, context) {
        telemetry.push({ input, context });
        return { inserted: true };
      },
    },
    telemetryContextProvider: () => ({ providerType: "originrouter", trainingEligible: true }),
  });
  const coordinator = new PlanImplementVerifyCoordinator({ store });
  return {
    store,
    telemetry,
    coordinator,
    planner: new CollaborationConfigurationPlanner({
      store, serverClient, deviceId: "device-local", capabilitiesForDevice: async () => deviceCapabilities,
      coordinator,
    }),
  };
}

test("selected workflow reaches the planner and the accepted run", async () => {
  let request;
  const selected = { ...proposal, workflow_template_id: "plan_implement_verify" };
  const { planner } = fixture({
    async create(body) { request = body; return serverSession({ proposal: selected }); },
    async get() { return serverSession({ proposal: selected }); },
  });
  const configuration = await planner.create({ objective: "Fix", workflow_template_id: "plan_implement_verify" });
  assert.equal(request.request.workflow_template_id, "plan_implement_verify");
  assert.equal(configuration.state, "proposal_ready");
  const accepted = await planner.accept(configuration.configuration_id);
  assert.equal(accepted.run.workflow_template_id, "plan_implement_verify");
});

test("the selected Session permission is preserved and supervises Agent approvals", async () => {
  const { planner } = fixture({
    async create() { return serverSession(); },
    async get() { return serverSession(); },
  });
  const config = await planner.create({ objective: "Fix", supervisor_permission_profile: "manual" });
  assert.equal(config.proposal.supervisor_permission_profile, "manual");
  const { run } = await planner.accept(config.configuration_id);
  assert.equal(run.supervisor_permission_profile, "manual");
  const decision = await new CollaborationApprovalSupervisor().evaluate({
    request: { interactionId: "approval-1", kind: "permission", title: "Bash needs permission", payload: { tool: "Bash", command: "uptime", cwd: process.cwd() } },
    agent: { runtime: "codex", permission_profile: "guarded" },
    run,
    workspaceRoot: process.cwd(),
  });
  assert.equal(decision.effect, "ask");
});

test("accept uses the proposal already presented instead of fetching a replacement", async () => {
  let refreshes = 0;
  const { planner } = fixture({
    async create() { return serverSession(); },
    async get() { refreshes++; return serverSession({ proposal: { ...proposal, workflow_template_id: "parallel_research" } }); },
  });
  const config = await planner.create({ objective: "Fix", workflow_template_id: "adaptive" });
  const accepted = await planner.accept(config.configuration_id);
  assert.equal(accepted.run.workflow_template_id, "adaptive");
  assert.equal(refreshes, 0);
});

test("confirmation rejects a proposal changed before or during live validation", async () => {
  const { planner, store } = fixture({ async create() { return serverSession(); } });
  const config = await planner.create({ objective: "Fix" });
  assert.ok(config.proposal_token);
  store.updateConfigurationSession(config.configuration_id, { proposal: { ...config.proposal, preferences: "changed" } });
  await assert.rejects(planner.accept(config.configuration_id, { expectedProposalToken: config.proposal_token }), { code: "CONFIGURATION_PROPOSAL_CHANGED" });

  const current = planner.local(config.configuration_id);
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  planner.capabilitiesForDevice = async () => { entered(); await gate; return capabilities; };
  const pending = planner.accept(config.configuration_id, { expectedProposalToken: current.proposal_token });
  await enteredPromise;
  store.updateConfigurationSession(config.configuration_id, { proposal: { ...current.proposal, preferences: "changed again" } });
  release();
  await assert.rejects(pending, { code: "CONFIGURATION_PROPOSAL_CHANGED" });
  assert.equal(store.listRuns().length, 0);
});

test("a refreshed server proposal is not exposed before live validation completes", async () => {
  const { planner } = fixture({ async create() { return serverSession(); }, async get() { return serverSession({ revision: 2 }); } });
  const config = await planner.create({ objective: "Fix" });
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  planner.capabilitiesForDevice = async () => { entered(); await gate; return capabilities; };
  const pending = planner.get(config.configuration_id);
  await enteredPromise;
  const intermediate = planner.local(config.configuration_id);
  assert.equal(intermediate.state, "planning");
  assert.equal(intermediate.proposal_token, null);
  release();
  const completed = await pending;
  assert.equal(completed.state, "proposal_ready");
  assert.ok(completed.proposal_token);
});

test("a late refresh cannot reopen an accepted configuration", async () => {
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const { planner, store } = fixture({
    async create() { return serverSession(); },
    async get() { entered(); await gate; return serverSession({ revision: 2 }); },
  });
  const config = await planner.create({ objective: "Fix" });
  const refresh = planner.get(config.configuration_id);
  await enteredPromise;
  await planner.accept(config.configuration_id, { expectedProposalToken: config.proposal_token });
  release();
  assert.equal((await refresh).state, "consumed");
  assert.equal(planner.local(config.configuration_id).state, "consumed");
  assert.equal(store.listRuns().length, 1);
  await assert.rejects(planner.accept(config.configuration_id), { code: "CONFIGURATION_NOT_READY" });
});

test("unsupported Session policy is rejected rather than silently replaced", async () => {
  const { planner, store } = fixture({ async create() { throw new Error("must not contact planner"); } });
  for (const profile of ["custom", "ai_review", "unknown"]) {
    await assert.rejects(planner.create({ objective: "Fix", supervisor_permission_profile: profile }), {
      code: "CONFIGURATION_SUPERVISOR_PROFILE_UNSUPPORTED",
    });
  }
  assert.equal(store.listRuns().length, 0);
});

test("pinned custom policy stays on the coordinator and survives Session continuation", async () => {
  const sent = [];
  const { planner, coordinator, store } = fixture({ async create(body) { sent.push(body); return serverSession(); } });
  const compiled = compileApprovalPolicy({ ...protectedApprovalPolicy(), id: "review-policy", description: "private-policy-description" });
  const permission = { profile: "custom", policyBundle: { id: compiled.policy.id, revision: compiled.revision, content: compiled.policy } };
  const config = await planner.create({ objective: "Fix", supervisor_permission_profile: "custom", supervisor_permission_snapshot: permission });
  assert.equal(config.state, "proposal_ready");
  assert.equal(config.proposal.supervisor_permission_profile, "custom");
  assert.equal(config.proposal.supervisor_policy_id, "review-policy");
  assert.equal(JSON.stringify(sent[0]).includes("private-policy-description"), false);
  assert.equal(JSON.stringify(config).includes("private-policy-description"), false);
  const first = await planner.accept(config.configuration_id, { expectedProposalToken: config.proposal_token });
  assert.equal(store.getPermissionSnapshot("run", first.run.run_id).digest, first.run.supervisor_snapshot_digest);
  coordinator.cancel(first.run.run_id);
  const followup = await planner.create({ objective: "Continue", workspace_session_id: first.run.workspace_session_id, continued_from_run_id: first.run.run_id, session_continuation: true });
  assert.equal(followup.state, "proposal_ready");
  assert.equal(followup.proposal.supervisor_snapshot_digest, first.run.supervisor_snapshot_digest);
  const second = await planner.accept(followup.configuration_id, { expectedProposalToken: followup.proposal_token });
  assert.equal(second.run.supervisor_snapshot_digest, first.run.supervisor_snapshot_digest);
  assert.equal(store.getPermissionSnapshot("run", second.run.run_id).snapshot.policyBundle.content.description, "private-policy-description");
});

test("AI approval snapshot is private, pinned, and a corrupted configuration cannot create a Run", async () => {
  const sent = [];
  const { planner, store } = fixture({ async create(body) { sent.push(body); return serverSession(); } });
  const template = { allowed_scopes: ["plan_continue"], applicability: {}, instructions: "private-review-instructions", name: "Review", protocol_version: "1", template_id: "ait_plan_review" };
  const snapshot = { profile: "ai_review", aiReviewPolicy: { ...template, version: 1, content_hash: createHash("sha256").update(JSON.stringify(template)).digest("hex") } };
  const config = await planner.create({ objective: "Fix", supervisor_permission_profile: "ai_review", supervisor_permission_snapshot: snapshot });
  assert.equal(config.state, "proposal_ready");
  assert.equal(config.proposal.auto_configuration.requires_explicit_confirmation, true);
  assert.equal(JSON.stringify(sent[0]).includes("private-review-instructions"), false);
  assert.equal(JSON.stringify(config).includes("private-review-instructions"), false);
  const accepted = await planner.accept(config.configuration_id, { expectedProposalToken: config.proposal_token });
  assert.equal(store.getPermissionSnapshot("run", accepted.run.run_id).snapshot.aiReviewPolicy.instructions, "private-review-instructions");
  const corrupt = await planner.create({ objective: "Fix again", supervisor_permission_profile: "ai_review", supervisor_permission_snapshot: snapshot });
  store.db.prepare("DELETE FROM collaboration_configuration_permissions WHERE configuration_id = ?").run(corrupt.configuration_id);
  await assert.rejects(planner.accept(corrupt.configuration_id, { expectedProposalToken: corrupt.proposal_token }), { code: "CONFIGURATION_PERMISSION_SNAPSHOT_CHANGED" });
  assert.equal(store.listRuns().length, 1);
});

test("unrestricted Session permission is retained and requires explicit confirmation", async () => {
  const { planner } = fixture({ async create() { return serverSession(); }, async get() { return serverSession(); } });
  const config = await planner.create({ objective: "Fix", supervisor_permission_profile: "unrestricted" });
  assert.equal(config.proposal.supervisor_permission_profile, "unrestricted");
  assert.equal(config.proposal.auto_configuration.requires_explicit_confirmation, true);
  assert.equal(config.proposal.auto_configuration.safe_to_skip_confirmation, false);
  assert.equal((await planner.accept(config.configuration_id)).run.supervisor_permission_profile, "unrestricted");
});

test("selected workflow is enforced even when the planning service ignores or changes it", async () => {
  let current = { ...proposal, workflow_template_id: "parallel_research" };
  const { planner, store } = fixture({
    async create() { return serverSession({ proposal: current }); },
    async get() { return serverSession({ proposal: current }); },
  });
  const config = await planner.create({ objective: "Research", workflow_template_id: "parallel_research" });
  assert.equal(config.state, "proposal_ready");
  current = proposal;
  store.updateConfigurationSession(config.configuration_id, { server_proposal: current });
  await assert.rejects(planner.accept(config.configuration_id), { code: "CONFIGURATION_WORKFLOW_MISMATCH" });
  assert.equal(store.listRuns().length, 0);
  const ignored = await planner.create({ objective: "Research", workflow_template_id: "parallel_research" });
  assert.equal(ignored.state, "failed");
  assert.equal(ignored.fallback_reason, "CONFIGURATION_WORKFLOW_MISMATCH");
  await assert.rejects(planner.create({ objective: "Research", workflow_template_id: "unknown" }), { code: "CONFIGURATION_WORKFLOW_INVALID" });
});

test("server plans, target CLI executes only requested read-only probes, and accept alone creates a Run", async () => {
  const calls = [];
  const { planner, store, telemetry } = fixture({
    async create(body) { calls.push({ type: "create", body }); return serverSession({ state: "awaiting_tool", proposal: {}, tool_requests: [{ name: "get_workspace_details", device_id: "device-local", workspace_id: "workspace" }] }); },
    async toolResults(id, body) { calls.push({ type: "tool", id, body }); return serverSession({ revision: 2 }); },
    async get() { return serverSession({ revision: 2 }); },
  });
  const created = await planner.create({ objective: "Fix the release checklist", coordinator_runtime: "codex" });
  assert.equal(created.state, "proposal_ready");
  assert.equal(calls[0].body.policy.server_plans_only, true);
  assert.equal(calls[1].body.tool_results[0].name, "get_workspace_details");
  assert.equal(store.listRuns().length, 0, "planning must not create a Run");
  const accepted = await planner.accept(created.configuration_id);
  assert.equal(accepted.run.state, "created");
  assert.equal(accepted.run.planning_source, "server_model");
  const plannerFact = store.listExecutionEvents(accepted.run.run_id)
    .find((event) => event.type === "ai.planner.completed");
  assert.equal(plannerFact.payload.model, "planner-model");
  assert.equal(plannerFact.payload.response_id, "resp_planner_1");
  assert.deepEqual(plannerFact.payload.token_usage, { input_tokens: 10, output_tokens: 5 });
  const uploadedFact = telemetry.find((item) => item.input.eventType === "ai.planner.completed");
  assert.equal(uploadedFact.input.payload.model, "planner-model");
  assert.equal(uploadedFact.input.payload.response_id, "resp_planner_1");
  assert.match(uploadedFact.context.runId, /^acr_/);
  assert.equal(uploadedFact.context.providerSource, "originrouter-coding");
});

test("device-level tool results preserve a workspace ID requested by the server", async () => {
  const calls = [];
  const { planner } = fixture({
    async create() {
      return serverSession({
        state: "awaiting_tool",
        proposal: {},
        tool_requests: [{ name: "get_device_capabilities", device_id: "device-local", workspace_id: "workspace" }],
      });
    },
    async toolResults(id, body) {
      calls.push({ id, body });
      return serverSession({ revision: 2 });
    },
  });

  await planner.create({ objective: "Check the remote CLI version" });
  assert.equal(calls[0].body.tool_results[0].workspace_id, "workspace");
});

test("server failure is explicit and never switches to a second automatic planner", async () => {
  const { planner, store } = fixture({ async create() { throw Object.assign(new Error("offline"), { code: "COLLABORATION_CONFIGURATION_UNAVAILABLE" }); } });
  const created = await planner.create({ objective: "Fix the release checklist" });
  assert.equal(created.state, "failed");
  assert.equal(created.fallback_reason, "COLLABORATION_CONFIGURATION_UNAVAILABLE");
  assert.equal(store.listRuns().length, 0);
});

test("an invalid server proposal cannot be accepted or replaced by a local automatic plan", async () => {
  const { planner } = fixture({ async create() { return serverSession({ proposal: { ...proposal, participants: [{ ...proposal.participants[0], device_id: "untrusted-device" }] } }); } });
  const created = await planner.create({ objective: "Fix the release checklist" });
  assert.equal(created.state, "failed");
});

test("App draft participants do not become a second planner input", async () => {
  const selectedCapabilities = {
    ...capabilities,
    trusted_workspaces: [
      { workspace_id: "workspace-a", display_name: "A", canonical_path: "/workspace-a", unattended_execution: { remote_eligible: true } },
      { workspace_id: "workspace-b", display_name: "B", canonical_path: "/workspace-b", unattended_execution: { remote_eligible: true } },
    ],
  };
  const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), "originrouter-config-")) });
  const coordinator = new PlanImplementVerifyCoordinator({ store });
  let serverRequest;
  const planner = new CollaborationConfigurationPlanner({
    store,
    coordinator,
    deviceId: "device-local",
    capabilitiesForDevice: async () => selectedCapabilities,
    serverClient: {
      async create(body) {
        serverRequest = body.request;
        return serverSession({
          proposal: {
            ...proposal,
            participants: [{ ...proposal.participants[0], workspace_id: "workspace-a" }],
          },
        });
      },
    },
  });

  const created = await planner.create({
    objective: "Check the remote Mac mini system version",
    participants: [{ device_id: "device-local", workspace_id: "workspace-b" }],
  });

  assert.equal(created.state, "proposal_ready");
  assert.equal(serverRequest.participants, undefined);
});

test("selected coordinator workspace is resolved locally and enforced on the proposal", async () => {
  let sent;
  const { planner } = fixture({
    async create(body) { sent = body; return serverSession(); },
    async get() { return serverSession(); },
  });
  const created = await planner.create({ objective: "Fix this project", coordinator_workspace_reference: "/workspace" });
  assert.equal(created.state, "proposal_ready");
  assert.equal(sent.request.coordinator_workspace_id, "workspace");
  assert.equal(JSON.stringify(sent).includes("/workspace"), false);
  assert.equal((await planner.accept(created.configuration_id)).run.state, "created");
});

test("selected workspace must be trusted, ready, and present in the proposed team", async () => {
  const { planner } = fixture({
    async create() { return serverSession({ proposal: { ...proposal, participants: [{ ...proposal.participants[0], workspace_id: "other-workspace" }] } }); },
  }, { ...capabilities, trusted_workspaces: [...capabilities.trusted_workspaces,
    { workspace_id: "other-workspace", canonical_path: "/other", unattended_execution: { remote_eligible: true } }] });
  await assert.rejects(
    planner.create({ objective: "Fix", coordinator_workspace_reference: "/untrusted" }),
    { code: "CONFIGURATION_WORKSPACE_UNAVAILABLE" },
  );
  const mismatch = await planner.create({ objective: "Fix", coordinator_workspace_reference: "workspace" });
  assert.equal(mismatch.state, "failed");
  assert.equal(mismatch.fallback_reason, "CONFIGURATION_WORKSPACE_MISMATCH");
});

for (const change of ["untrusted", "authorization-required"]) {
  test(`accept rechecks a selected workspace that becomes ${change}`, async () => {
    const changing = { ...capabilities, trusted_workspaces: capabilities.trusted_workspaces.map((item) => ({ ...item })) };
    const { planner, store } = fixture({
      async create() { return serverSession(); },
      async get() { return serverSession(); },
    }, changing);
    const created = await planner.create({ objective: "Fix", coordinator_workspace_reference: "workspace" });
    assert.equal(created.state, "proposal_ready");
    if (change === "untrusted") changing.trusted_workspaces = [];
    else changing.trusted_workspaces[0].unattended_execution = {
      remote_eligible: false, status: "requires_local_authorization",
    };
    await assert.rejects(planner.accept(created.configuration_id));
    assert.equal(store.listRuns().length, 0);
  });
}

test("the target CLI discovers every trusted device before starting the server session", async () => {
  let requestBody;
  const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), "originrouter-config-")) });
  const coordinator = new PlanImplementVerifyCoordinator({ store });
  const remoteCapabilities = {
    ...capabilities,
    device: { name: "Studio Mac mini", cli_version: "0.2.2", platform: "darwin", architecture: "arm64" },
  };
  const planner = new CollaborationConfigurationPlanner({
    store,
    coordinator,
    deviceId: "device-local",
    listDevices: async () => [{
      deviceId: "device-remote",
      deviceName: "Studio Mac mini",
      online: true,
      trustStatus: "trusted",
    }],
    capabilitiesForDevice: async (deviceId) => (
      deviceId === "device-remote" ? remoteCapabilities : capabilities
    ),
    serverClient: {
      async create(body) {
        requestBody = body;
        return serverSession();
      },
    },
  });

  await planner.create({ objective: "Check the remote Mac mini CLI version" });

  assert.deepEqual(
    requestBody.capability_snapshot.devices.map((device) => device.device_id).sort(),
    ["device-local", "device-remote"],
  );
  const remote = requestBody.capability_snapshot.devices.find((device) => device.device_id === "device-remote");
  assert.equal(remote.device_name, "Studio Mac mini");
  assert.equal(remote.cli_version, "0.2.2");
});

test("a Session follow-up re-enters configuration and revalidates its durable team", async () => {
  const { planner, coordinator } = fixture({
    async create() { return serverSession(); },
  });
  const original = coordinator.create({
    objective: "Finish the first review.",
    participants: proposal.participants.map((participant) => ({
      ...participant,
      planner: participant.participant_id === proposal.planner,
    })),
    workspace_mode: "auto",
    workflow_template_id: "plan_implement_verify",
    supervisor_permission_profile: "manual",
  });
  coordinator.cancel(original.run_id);

  const configuration = await planner.create({
    objective: "Apply the review follow-up.",
    participants: proposal.participants.map((participant) => ({
      ...participant,
      planner: participant.participant_id === proposal.planner,
    })),
    workspace_session_id: original.workspace_session_id,
    continued_from_run_id: original.run_id,
    session_continuation: true,
  });
  assert.equal(configuration.proposal.workflow_template_id, "plan_implement_verify");
  assert.equal(configuration.proposal.supervisor_permission_profile, "manual");
  assert.equal(configuration.proposal.participants[0].participant_id, original.planner_role);
  const accepted = await planner.accept(configuration.configuration_id, { expectedProposalToken: configuration.proposal_token });
  assert.equal(accepted.run.session_continuation, true);
  assert.equal(accepted.run.workspace_session_id, original.workspace_session_id);
  assert.equal(accepted.run.continued_from_run_id, original.run_id);
  assert.equal(accepted.run.workflow_template_id, configuration.proposal.workflow_template_id);
  assert.equal(accepted.run.supervisor_permission_profile, configuration.proposal.supervisor_permission_profile);
});

test("a changed Session team cannot be accepted under an earlier proposal token", async () => {
  const { planner, coordinator, store } = fixture({ async create() { return serverSession(); } });
  const original = coordinator.create({
    objective: "Initial task",
    participants: proposal.participants.map((participant) => ({ ...participant, planner: true })),
    supervisor_permission_profile: "manual",
    workspace_mode: "auto",
  });
  coordinator.cancel(original.run_id);
  const configuration = await planner.create({
    objective: "Follow-up",
    workspace_session_id: original.workspace_session_id,
    continued_from_run_id: original.run_id,
    session_continuation: true,
  });
  assert.equal(configuration.proposal.supervisor_permission_profile, "manual");
  store.updateSupervisorApproval(original.run_id, { profile: "guarded" });
  await assert.rejects(planner.accept(configuration.configuration_id, { expectedProposalToken: configuration.proposal_token }), {
    code: "CONFIGURATION_PROPOSAL_CHANGED",
  });
  assert.equal(store.listRuns().length, 1);
});
