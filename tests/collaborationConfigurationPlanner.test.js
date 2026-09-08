import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CollaborationConfigurationPlanner } from "../src/collaboration/collaborationConfigurationPlanner.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { CollaborationStore } from "../src/collaboration/collaborationStore.js";

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

function fixture(serverClient) {
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
      store, serverClient, deviceId: "device-local", capabilitiesForDevice: async () => capabilities,
      coordinator,
    }),
  };
}

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
  const accepted = await planner.accept(configuration.configuration_id);
  assert.equal(accepted.run.session_continuation, true);
  assert.equal(accepted.run.workspace_session_id, original.workspace_session_id);
  assert.equal(accepted.run.continued_from_run_id, original.run_id);
});
