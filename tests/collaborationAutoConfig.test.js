import assert from "node:assert/strict";
import test from "node:test";

import {
  autoConfigureCollaboration,
  publicCapabilitySnapshot,
  requestAutoConfiguration,
  validateAndNormalizeAutoConfiguration,
} from "../src/collaboration/collaborationAutoConfig.js";
import { taskPrompt } from "../src/collaboration/adaptivePlan.js";
import {
  automaticCreatePayload,
  autoConfigurationView,
  browseCollaborationWorkspaces,
  followExistingAgentWorkspaceCollaboration,
  MAX_COLLABORATION_RECONNECT_ATTEMPTS,
  retryAgentWorkspaceCollaboration,
  runAgentWorkspaceCollaboration,
  trustCollaborationWorkspace,
} from "../src/commands/collaboration.js";

function budgetPolicy(overrides = {}) {
  const status = {
    policy: {
      daily_token_limit: 100_000,
      weekly_token_limit: 500_000,
      daily_amount_limit_micros: 5_000_000,
      weekly_amount_limit_micros: 20_000_000,
      currency: "USD",
      enforcement: "block",
    },
    daily: { sampled_tokens: 10_000, amount_micros: 500_000 },
    weekly: { sampled_tokens: 20_000, amount_micros: 1_000_000 },
    blocked: false,
    ...overrides,
  };
  return { device: status, agents: { claude: status, codex: status } };
}

function capabilities({ workspaces, runtimes, budget = budgetPolicy() } = {}) {
  return {
    schema_version: 1,
    device: { device_id: "local", name: "This device" },
    runtimes: runtimes || [
      { id: "claude", available: true },
      { id: "codex", available: true },
    ],
    providers: [{
      name: "official",
      models: [{ id: "fast-model" }, { id: "review-model" }],
    }],
    resolved_routes: {
      claude: { main: { provider: "official", model: "fast-model" } },
      codex: { main: { provider: "official", model: "review-model" } },
    },
    trusted_workspaces: workspaces || [{
      workspace_id: "workspace-main",
      display_name: "originrouter-cli",
      canonical_path: "/private/project",
    }],
    permission_profiles: [
      { id: "manual" },
      { id: "guarded" },
      { id: "unrestricted" },
    ],
    defaults: { permission_profile: "guarded" },
    budget_policy: budget,
    protocol_versions: { collaboration_snapshot: 2, collaboration_event: 2 },
  };
}

test("remote task prompts identify the assigned device as the inspection target", () => {
  const prompt = taskPrompt({
    run_id: "acr_remote_prompt",
    objective: "Inspect the remote machine",
    coordinator_device_id: "local-device",
    agents: {
      remote_operator: { device_id: "remote-device" },
    },
    tasks: [],
  }, {
    task_key: "inspect",
    participant_id: "remote_operator",
    kind: "read_only",
    title: "Inspect machine status",
    instructions: "Collect OS and CLI version information.",
    deliverable: "A status report.",
    depends_on: [],
  });
  assert.match(prompt, /already running on the selected target device/);
  assert.match(prompt, /local shell, filesystem, OS, and workspace are the remote environment/);
  assert.match(prompt, /do not search for SSH/);
});

function device(overrides = {}) {
  return {
    deviceId: "local",
    deviceName: "This device",
    online: true,
    trustStatus: "trusted",
    local: true,
    capabilities: capabilities(),
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    participants: [{
      participant_id: "planner",
      display_name: "Coordinator",
      runtime: "codex",
      device_id: "local",
      workspace_id: "workspace-main",
      role_hint: "Coordinate implementation and final acceptance.",
      permission_profile: "guarded",
      provider: null,
      model: null,
    }],
    planner: "planner",
    workflow_template_id: "adaptive",
    collaboration_preferences: "Implement safely and report evidence.",
    max_concurrency: 1,
    independent_review: false,
    budget: { token_limit: null, amount_limit_micros: null, currency: null },
    ...overrides,
  };
}

test("clear objective produces an automatic configuration with zero questions", async () => {
  let modelCalls = 0;
  const result = await autoConfigureCollaboration({
    objective: "Fix the tests",
    devices: [device()],
    modelFn: async () => {
      modelCalls += 1;
      return JSON.stringify(proposal());
    },
  });
  assert.equal(modelCalls, 1);
  assert.equal(result.participants[0].planner, true);
  assert.equal(result.budget.max_concurrency, 1);
});

test("Claude and Codex can be combined with an independent reviewer", () => {
  const raw = proposal({
    participants: [
      { ...proposal().participants[0], runtime: "claude", role_hint: "Implement the fix." },
      { ...proposal().participants[0], participant_id: "reviewer", display_name: "Reviewer", role_hint: "Independently review the fix." },
    ],
    max_concurrency: 2,
    independent_review: true,
  });
  const result = validateAndNormalizeAutoConfiguration(raw, {
    objective: "Fix and independently review",
    devices: [device()],
  });
  assert.deepEqual(result.participants.map((item) => item.runtime), ["claude", "codex"]);
  assert.equal(result.auto_configuration.independent_review, true);
});

test("multiple matching workspaces cause one actionable ambiguity", () => {
  const workspaces = [
    { workspace_id: "one", display_name: "One", canonical_path: "/one" },
    { workspace_id: "two", display_name: "Two", canonical_path: "/two" },
  ];
  assert.throws(
    () => validateAndNormalizeAutoConfiguration(
      proposal({ participants: [{ ...proposal().participants[0], workspace_id: "" }] }),
      { objective: "Fix tests", devices: [device({ capabilities: capabilities({ workspaces }) })] },
    ),
    (error) => error.code === "AUTO_CONFIG_WORKSPACE_AMBIGUOUS"
      && error.ambiguity.workspaces.length === 2,
  );
});

test("automatic setup asks exactly one workspace question and then validates again", async () => {
  const workspaces = [
    { workspace_id: "one", display_name: "One", canonical_path: "/one" },
    { workspace_id: "two", display_name: "Two", canonical_path: "/two" },
  ];
  const questions = [];
  const prompt = {
    async question(text) {
      questions.push(text);
      return "2";
    },
  };
  const local = capabilities({ workspaces });
  const result = await automaticCreatePayload({
    objective: "Fix tests",
    prompt,
    requestFn: async () => ({ capabilities: local }),
    loadDeviceDirectoryFn: async () => [],
    cacheCapabilitiesFn: (value) => value,
    getCachedCapabilitiesFn: () => null,
    modelFn: async () => JSON.stringify(proposal({
      participants: [{ ...proposal().participants[0], workspace_id: "" }],
    })),
  });
  assert.equal(questions.length, 1);
  assert.equal(result.participants[0].workspace_id, "two");
});

test("a fabricated device is rejected", () => {
  assert.throws(
    () => validateAndNormalizeAutoConfiguration(
      proposal({ participants: [{ ...proposal().participants[0], device_id: "invented" }] }),
      { objective: "Fix tests", devices: [device()] },
    ),
    (error) => error.code === "AUTO_CONFIG_UNKNOWN_DEVICE",
  );
});

test("permission escalation is rejected", () => {
  assert.throws(
    () => validateAndNormalizeAutoConfiguration(
      proposal({ participants: [{ ...proposal().participants[0], permission_profile: "unrestricted" }] }),
      { objective: "Fix tests", devices: [device()] },
    ),
    (error) => error.code === "AUTO_CONFIG_PERMISSION_ESCALATION",
  );
});

test("budgets above device policy are rejected", () => {
  assert.throws(
    () => validateAndNormalizeAutoConfiguration(
      proposal({ budget: { token_limit: 95_000, amount_limit_micros: null, currency: null } }),
      { objective: "Fix tests", devices: [device()] },
    ),
    (error) => error.code === "AUTO_CONFIG_BUDGET_EXCEEDED",
  );
});

test("production objectives require explicit configuration confirmation", () => {
  const result = validateAndNormalizeAutoConfiguration(proposal(), {
    objective: "Deploy this change to production",
    devices: [device()],
  });
  assert.equal(result.auto_configuration.requires_explicit_confirmation, true);
  assert.equal(result.auto_configuration.safe_to_skip_confirmation, false);
});

test("offline trusted devices remain waiting instead of being reported online", () => {
  const result = validateAndNormalizeAutoConfiguration(proposal(), {
    objective: "Fix tests when the device returns",
    devices: [device({ online: false })],
  });
  assert.equal(result.participants[0].waiting_for_device, true);
});

test("invalid JSON and unavailable fast models fail before Run creation", async () => {
  await assert.rejects(
    autoConfigureCollaboration({ objective: "Fix tests", devices: [device()], modelFn: async () => "not json" }),
    (error) => error.code === "AUTO_CONFIG_INVALID_JSON",
  );
  await assert.rejects(
    autoConfigureCollaboration({ objective: "Fix tests", devices: [device()], modelFn: async () => { throw Object.assign(new Error("offline"), { code: "AUTO_CONFIG_MODEL_UNAVAILABLE" }); } }),
    (error) => error.code === "AUTO_CONFIG_MODEL_UNAVAILABLE",
  );
});

test("automatic payload collection supports a mixed team without interactive prompts", async () => {
  const local = capabilities();
  const payload = await automaticCreatePayload({
    objective: "Implement with an independent review",
    requestFn: async (path) => {
      assert.equal(path, "/collaboration/local/capabilities");
      return { capabilities: local };
    },
    loadDeviceDirectoryFn: async () => [],
    cacheCapabilitiesFn: (value) => value,
    getCachedCapabilitiesFn: () => null,
    modelFn: async () => JSON.stringify(proposal({
      participants: [
        { ...proposal().participants[0], runtime: "claude", role_hint: "Implement." },
        { ...proposal().participants[0], participant_id: "reviewer", display_name: "Reviewer", role_hint: "Review." },
      ],
      max_concurrency: 2,
      independent_review: true,
    })),
  });
  assert.equal(payload.participants.length, 2);
  assert.equal(payload.budget.max_concurrency, 2);
  assert.equal(payload._workspace_editor.devices[0].device_name, "This device");
  assert.deepEqual(payload._workspace_editor.devices[0].runtimes, [{ id: "claude" }, { id: "codex" }]);
  assert.equal(payload._workspace_editor.devices[0].resolved_routes.codex.model, "review-model");
  assert.equal(JSON.stringify(payload).includes("_workspace_editor"), false, "editor metadata stays local to the CLI");
});

test("Auto never silently downgrades an explicit remote objective to Solo when advice is unavailable", async () => {
  await assert.rejects(
    automaticCreatePayload({
      objective: "Inspect my remote computer status",
      workspaceMode: "auto",
      cloudAdvice: true,
      requestFn: async () => ({ capabilities: capabilities() }),
      loadDeviceDirectoryFn: async () => [],
      cacheCapabilitiesFn: (value) => value,
      getCachedCapabilitiesFn: () => null,
      adviceFn: async () => {
        throw Object.assign(new Error("advice offline"), { code: "COLLABORATION_ADVICE_UNAVAILABLE" });
      },
    }),
    (error) => error.code === "AUTO_CONFIG_REMOTE_ADVICE_REQUIRED"
      && /Remote Ops/.test(error.message),
  );
});

test("workspace lifecycle does not create a Run before an unsafe configuration is confirmed", async () => {
  const requests = [];
  const result = await runAgentWorkspaceCollaboration({
    objective: "Inspect the remote computer",
    confirmation: "safe",
    automaticCreatePayloadFn: async () => ({
      objective: "Inspect the remote computer",
      workspace_mode: "auto",
      resolved_workspace_mode: "solo",
      planning_source: "local_fallback",
      participants: [{ participant_id: "coordinator", device_id: "local" }],
      auto_configuration: { safe_to_skip_confirmation: true },
    }),
    requestFn: async (...args) => {
      requests.push(args);
      throw new Error("a Run must not be created");
    },
    onConfigurationConfirmation: async () => "leave",
  });
  assert.equal(result.run.state, "configuration_pending");
  assert.equal(requests.length, 0);
});

test("workspace team edits are sent in the Run creation payload", async () => {
  let createdBody = null;
  const result = await runAgentWorkspaceCollaboration({
    objective: "Inspect the remote computer",
    confirmation: "safe",
    automaticCreatePayloadFn: async () => ({
      objective: "Inspect the remote computer",
      workspace_mode: "auto",
      resolved_workspace_mode: "remote_ops",
      planning_source: "cloud_advice",
      participants: [{
        participant_id: "coordinator",
        runtime: "codex",
        device_id: "local",
        workspace_id: "workspace-main",
        permission_profile: "guarded",
        planner: true,
      }],
      auto_configuration: { safe_to_skip_confirmation: false, coordinator: "codex", runtimes: ["codex"] },
    }),
    onConfigurationConfirmation: async (payload) => {
      payload.participants[0].runtime = "claude";
      payload.participants[0].provider = "official";
      payload.participants[0].model = "fast-model";
      payload.coordinator_runtime = "claude";
      payload.auto_configuration.coordinator = "claude";
      payload.auto_configuration.runtimes = ["claude"];
      return "confirm";
    },
    requestFn: async (path, options = {}) => {
      if (path === "/collaboration/local/runs") {
        createdBody = options.body;
        return { run: { run_id: "acr_edited", state: "created" } };
      }
      if (path.endsWith("/start")) return { run: { run_id: "acr_edited", state: "designing" } };
      if (path.includes("/snapshot")) {
        return { snapshot: { last_sequence: 0, run: { run_id: "acr_edited", state: "completed" }, tasks: [] } };
      }
      if (path.includes("/events?")) return { events: [] };
      throw new Error(`unexpected path ${path}`);
    },
  });
  assert.equal(result.run.state, "completed");
  assert.equal(createdBody.participants[0].runtime, "claude");
  assert.equal(createdBody.participants[0].provider, "official");
  assert.equal(createdBody.participants[0].model, "fast-model");
  assert.equal(createdBody.coordinator_runtime, "claude");
});

test("workspace lifecycle streams a snapshot and completes without terminal logging", async () => {
  const updates = [];
  const paths = [];
  const result = await runAgentWorkspaceCollaboration({
    objective: "Inspect the remote computer",
    confirmation: "always",
    automaticCreatePayloadFn: async () => ({
      objective: "Inspect the remote computer",
      workspace_mode: "auto",
      resolved_workspace_mode: "remote_ops",
      planning_source: "cloud_advice",
      participants: [
        { participant_id: "coordinator", device_id: "local" },
        { participant_id: "remote_operator", device_id: "remote" },
      ],
      auto_configuration: { safe_to_skip_confirmation: false },
    }),
    onConfigurationConfirmation: async () => "confirm",
    requestFn: async (path) => {
      paths.push(path);
      if (path === "/collaboration/local/runs") return { run: { run_id: "acr_test", state: "created" } };
      if (path.endsWith("/start")) return { run: { run_id: "acr_test", state: "designing" } };
      if (path.includes("/snapshot")) {
        return { snapshot: {
          last_sequence: 1,
          run: { run_id: "acr_test", state: "completed", phase: "completed" },
          tasks: [{ task_key: "inspect", title: "Inspect remote status", state: "completed" }],
          final_report: { summary: "Remote inspection completed." },
        } };
      }
      if (path.includes("/events?")) return { events: [{ sequence: 1, summary: "Remote inspection completed." }] };
      throw new Error(`unexpected path ${path}`);
    },
    onUpdate: (update) => updates.push(update),
  });
  assert.equal(result.run.state, "completed");
  assert(paths.some((path) => path.includes("/snapshot")));
  assert(updates.some((update) => update.type === "snapshot" && update.events.length === 1));
});

test("workspace lifecycle reconnects transient snapshot failures without recreating the Run", async () => {
  const updates = [];
  const calls = [];
  let snapshotAttempts = 0;
  const result = await runAgentWorkspaceCollaboration({
    objective: "Inspect the remote computer",
    confirmation: "always",
    interval: 0,
    automaticCreatePayloadFn: async () => ({
      objective: "Inspect the remote computer",
      workspace_mode: "auto",
      resolved_workspace_mode: "remote_ops",
      planning_source: "cloud_advice",
      participants: [{ participant_id: "coordinator", device_id: "local" }],
      auto_configuration: { safe_to_skip_confirmation: true },
    }),
    requestFn: async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET" });
      if (path === "/collaboration/local/runs") {
        return { run: { run_id: "acr_reconnect", state: "created" } };
      }
      if (path.endsWith("/start")) {
        return { run: { run_id: "acr_reconnect", state: "designing" } };
      }
      if (path.includes("/snapshot")) {
        snapshotAttempts += 1;
        if (snapshotAttempts === 1) {
          throw Object.assign(new Error("local API connection failed"), {
            code: "LOCAL_API_CONNECTION_FAILED",
          });
        }
        return {
          snapshot: {
            last_sequence: 1,
            run: { run_id: "acr_reconnect", state: "completed", phase: "completed" },
            tasks: [],
            final_report: { summary: "Recovered and completed." },
          },
        };
      }
      if (path.includes("/events?")) return { events: [{ sequence: 1, summary: "Recovered" }] };
      throw new Error(`unexpected path ${path}`);
    },
    onUpdate: (update) => updates.push(update),
  });
  assert.equal(result.run.state, "completed");
  assert.equal(calls.filter((call) => call.method === "POST").length, 2, "Run creation and start happen once");
  assert.equal(calls.filter((call) => call.path.includes("/snapshot")).length, 2);
  assert.equal(updates[0].phase, "configuring");
  assert(updates.some((update) => update.phase === "reconnecting" && update.connectionAttempts === 1));
  assert(updates.some((update) => update.type === "connection" && update.connectionAttempts === 0));
});

test("workspace lifecycle reconnects after a truncated JSON snapshot response", async () => {
  let snapshotAttempts = 0;
  const updates = [];
  const result = await followExistingAgentWorkspaceCollaboration("acr_truncated_json", {
    interval: 0,
    onUpdate: (update) => updates.push(update),
    requestFn: async (path) => {
      if (path.includes("/snapshot")) {
        snapshotAttempts += 1;
        if (snapshotAttempts === 1) throw new SyntaxError("Unexpected end of JSON input");
        return {
          snapshot: {
            last_sequence: 0,
            run: { run_id: "acr_truncated_json", state: "completed" },
            tasks: [],
            final_report: { summary: "Recovered after truncated JSON." },
          },
        };
      }
      if (path.includes("/events?")) return { events: [] };
      throw new Error(`unexpected path ${path}`);
    },
  });
  assert.equal(result.run.state, "completed");
  assert.equal(snapshotAttempts, 2);
  assert(updates.some((update) => update.phase === "reconnecting"));
  assert(updates.some((update) => update.type === "connection" && update.connectionAttempts === 0));
});

test("workspace follower pauses after five automatic reconnect attempts", async () => {
  let reads = 0;
  const reconnectUpdates = [];
  await assert.rejects(
    followExistingAgentWorkspaceCollaboration("acr_reconnect_exhausted", {
      interval: 0,
      onUpdate: (update) => reconnectUpdates.push(update),
      requestFn: async () => {
        reads += 1;
        const error = new Error("local API connection failed");
        error.code = "LOCAL_API_CONNECTION_FAILED";
        throw error;
      },
    }),
    (error) => {
      assert.equal(error.code, "COLLABORATION_FOLLOW_RECONNECT_EXHAUSTED");
      assert.equal(error.runId, "acr_reconnect_exhausted");
      return true;
    },
  );
  const attempts = reconnectUpdates.filter((update) => update.phase === "reconnecting");
  assert.equal(MAX_COLLABORATION_RECONNECT_ATTEMPTS, 5);
  assert.equal(attempts.length, 5);
  assert.deepEqual(attempts.map((update) => update.connectionAttempts), [1, 2, 3, 4, 5]);
  assert.match(attempts.at(-1).message, /retry 5\/5/);
  assert.equal(reads, 6, "the initial read is followed by exactly five retries");
});

test("workspace follow-up reuses the previous team but creates and reviews a new Run", async () => {
  const createdBodies = [];
  let automaticConfigurationCalls = 0;
  let configurationReviewCalls = 0;
  let planReviewCalls = 0;
  let snapshotReads = 0;
  const previousConfiguration = {
    objective: "Inspect the remote machine",
    workflow_template_id: "remote_ops",
    planning_source: "cloud_advice",
    risk_tier: "yellow",
    participants: [{
      participant_id: "remote_operator",
      display_name: "Remote Operator",
      runtime: "claude",
      device_id: "remote-device",
      workspace_id: "remote-workspace",
      permission_profile: "guarded",
      provider: "originrouter-cloud",
      model: "claude-model",
      planner: true,
    }],
    preferences: {},
    budget: { max_concurrency: 1 },
    auto_configuration: {
      resolved_workspace_mode: "remote_ops",
      safe_to_skip_confirmation: true,
    },
  };
  const result = await runAgentWorkspaceCollaboration({
    objective: "Also check the remote service status",
    presetConfiguration: previousConfiguration,
    continuedFromRunId: "acr_previous",
    confirmation: "safe",
    interval: 0,
    automaticCreatePayloadFn: async () => {
      automaticConfigurationCalls += 1;
      throw new Error("automatic configuration must not run for a same-team follow-up");
    },
    onConfigurationConfirmation: async () => {
      configurationReviewCalls += 1;
      return "confirm";
    },
    onPlanConfirmation: async () => {
      planReviewCalls += 1;
      return "confirm";
    },
    requestFn: async (path, options = {}) => {
      if (path === "/collaboration/local/runs") {
        createdBodies.push(options.body);
        return { run: { run_id: "acr_followup", state: "created" } };
      }
      if (path.endsWith("/start")) return { run: { run_id: "acr_followup", state: "designing" } };
      if (path.endsWith("/confirm")) return { run: { run_id: "acr_followup", state: "running" } };
      if (path.includes("/events?")) return { events: [] };
      if (path.includes("/snapshot")) {
        snapshotReads += 1;
        if (snapshotReads === 1) {
          return { snapshot: {
            last_sequence: 0,
            run: { run_id: "acr_followup", state: "awaiting_confirmation" },
            plan: { title: "Follow-up plan", tasks: [] },
            tasks: [],
          } };
        }
        return { snapshot: {
          last_sequence: 0,
          run: { run_id: "acr_followup", state: "completed" },
          tasks: [],
          final_report: { summary: "Follow-up completed." },
        } };
      }
      throw new Error(`unexpected path ${path}`);
    },
  });
  assert.equal(result.run.state, "completed");
  assert.equal(automaticConfigurationCalls, 0);
  assert.equal(configurationReviewCalls, 0, "the explicitly continued team is not selected again");
  assert.equal(planReviewCalls, 1, "the new objective still receives a new reviewable plan");
  assert.equal(createdBodies.length, 1);
  assert.equal(createdBodies[0].objective, "Also check the remote service status");
  assert.equal(createdBodies[0].participants[0].device_id, "remote-device");
  assert.equal(createdBodies[0].participants[0].runtime, "claude");
  assert.equal(createdBodies[0].participants[0].provider, "originrouter-cloud");
  assert.equal(createdBodies[0].participants[0].model, "claude-model");
  assert.equal(createdBodies[0].auto_configuration.continued_from_run_id, "acr_previous");
  assert.equal(createdBodies[0].planning_source, "continued_team");
  assert.equal(previousConfiguration.objective, "Inspect the remote machine", "the previous Run configuration remains immutable");
});

test("plan review can request changes and waits for the replacement plan", async () => {
  const paths = [];
  let snapshotReads = 0;
  const decisions = [];
  const result = await runAgentWorkspaceCollaboration({
    objective: "Inspect the remote computer",
    confirmation: "never",
    interval: 0,
    automaticCreatePayloadFn: async () => ({
      objective: "Inspect the remote computer",
      participants: [{ participant_id: "coordinator", device_id: "local" }],
      auto_configuration: { safe_to_skip_confirmation: false },
    }),
    onConfigurationConfirmation: async () => "confirm",
    requestFn: async (path) => {
      paths.push(path);
      if (path === "/collaboration/local/runs") return { run: { run_id: "acr_replan", state: "created" } };
      if (path.endsWith("/start")) return { run: { run_id: "acr_replan", state: "designing" } };
      if (path.endsWith("/replan")) return { run: { run_id: "acr_replan", state: "designing" } };
      if (path.includes("/events?")) return { events: [] };
      if (path.includes("/snapshot")) {
        snapshotReads += 1;
        if (snapshotReads === 1) {
          return { snapshot: { last_sequence: 0, run: { run_id: "acr_replan", state: "awaiting_confirmation" }, plan: { title: "First plan", tasks: [] }, tasks: [] } };
        }
        return { snapshot: { last_sequence: 0, run: { run_id: "acr_replan", state: "completed" }, plan: { title: "Revised plan", tasks: [] }, tasks: [] } };
      }
      throw new Error(`unexpected path ${path}`);
    },
    onPlanConfirmation: async () => {
      const decision = { action: "revise", feedback: "Do not modify the remote machine." };
      decisions.push(decision);
      return decision;
    },
  });
  assert.equal(result.run.state, "completed");
  assert.equal(decisions.length, 1);
  assert(paths.some((path) => path.endsWith("/replan")));
});

test("a failed workspace Run can be retried and followed in place", async () => {
  const paths = [];
  const result = await retryAgentWorkspaceCollaboration("acr_failed", {
    interval: 0,
    requestFn: async (path) => {
      paths.push(path);
      if (path.endsWith("/retry")) return { run: { run_id: "acr_failed", state: "planning" } };
      if (path.includes("/snapshot")) {
        return { snapshot: { last_sequence: 1, run: { run_id: "acr_failed", state: "completed" }, tasks: [], final_report: { summary: "Recovered." } } };
      }
      if (path.includes("/events?")) return { events: [{ sequence: 1, summary: "Retry completed" }] };
      throw new Error(`unexpected path ${path}`);
    },
  });
  assert.equal(result.run.state, "completed");
  assert.equal(paths.filter((path) => path.endsWith("/retry")).length, 1);
});

test("an existing active workspace Run can be followed without recreating it", async () => {
  const paths = [];
  const result = await followExistingAgentWorkspaceCollaboration("acr_existing", {
    interval: 0,
    requestFn: async (path) => {
      paths.push(path);
      if (path.includes("/snapshot")) {
        return {
          snapshot: {
            last_sequence: 0,
            run: { run_id: "acr_existing", state: "completed" },
            tasks: [],
            final_report: { summary: "Existing Run completed." },
          },
        };
      }
      if (path.includes("/events?")) return { events: [] };
      throw new Error(`unexpected path ${path}`);
    },
  });
  assert.equal(result.run.state, "completed");
  assert.equal(paths.some((path) => path === "/collaboration/local/runs"), false);
  assert.equal(paths.some((path) => path.endsWith("/start")), false);
});

test("workspace lifecycle resolves an Agent attention request and continues", async () => {
  let snapshotReads = 0;
  const resolutions = [];
  const result = await runAgentWorkspaceCollaboration({
    objective: "Inspect the remote computer",
    confirmation: "always",
    interval: 0,
    automaticCreatePayloadFn: async () => ({
      objective: "Inspect the remote computer",
      participants: [{ participant_id: "coordinator", device_id: "local" }],
      auto_configuration: { safe_to_skip_confirmation: true },
    }),
    requestFn: async (path, options = {}) => {
      if (path === "/collaboration/local/runs") return { run: { run_id: "acr_attention", state: "created" } };
      if (path.endsWith("/start")) return { run: { run_id: "acr_attention", state: "running" } };
      if (path.includes("/attention/") && path.endsWith("/resolve")) {
        resolutions.push(options.body);
        return { item: { status: "resolved" } };
      }
      if (path.includes("/events?")) return { events: [] };
      if (path.includes("/snapshot")) {
        snapshotReads += 1;
        if (snapshotReads === 1) {
          return { snapshot: {
            last_sequence: 0,
            run: { run_id: "acr_attention", state: "blocked" },
            tasks: [],
            attention: [{ attention_id: "att_1", revision: 1, status: "pending", kind: "approval", actions: ["allow", "deny"] }],
          } };
        }
        return { snapshot: { last_sequence: 0, run: { run_id: "acr_attention", state: "completed" }, tasks: [], attention: [] } };
      }
      throw new Error(`unexpected path ${path}`);
    },
    onAttention: async () => ({ action: "allow", response: {} }),
  });
  assert.equal(result.run.state, "completed");
  assert.deepEqual(resolutions, [{ expected_revision: 1, action: "allow", response: {} }]);
});

test("workspace lifecycle resumes a paused Run in place", async () => {
  let snapshotReads = 0;
  let resumeCalls = 0;
  const result = await runAgentWorkspaceCollaboration({
    objective: "Inspect the remote computer",
    confirmation: "always",
    interval: 0,
    automaticCreatePayloadFn: async () => ({
      objective: "Inspect the remote computer",
      participants: [{ participant_id: "coordinator", device_id: "local" }],
      auto_configuration: { safe_to_skip_confirmation: true },
    }),
    requestFn: async (path) => {
      if (path === "/collaboration/local/runs") return { run: { run_id: "acr_paused", state: "created" } };
      if (path.endsWith("/start")) return { run: { run_id: "acr_paused", state: "running" } };
      if (path.endsWith("/resume")) {
        resumeCalls += 1;
        return { run: { run_id: "acr_paused", state: "running" } };
      }
      if (path.includes("/events?")) return { events: [] };
      if (path.includes("/snapshot")) {
        snapshotReads += 1;
        if (snapshotReads === 1) {
          return { snapshot: { revision: 2, last_sequence: 0, run: { run_id: "acr_paused", state: "paused", pause_reason: "device temporarily unavailable" }, tasks: [], attention: [] } };
        }
        return { snapshot: { revision: 3, last_sequence: 0, run: { run_id: "acr_paused", state: "completed" }, tasks: [], attention: [] } };
      }
      throw new Error(`unexpected path ${path}`);
    },
    onPaused: async () => "resume",
  });
  assert.equal(result.run.state, "completed");
  assert.equal(resumeCalls, 1);
});

test("workspace lifecycle does not retry non-transient authorization errors", async () => {
  let calls = 0;
  await assert.rejects(
    runAgentWorkspaceCollaboration({
      objective: "Inspect the remote computer",
      confirmation: "always",
      automaticCreatePayloadFn: async () => ({
        objective: "Inspect the remote computer",
        workspace_mode: "solo",
        resolved_workspace_mode: "solo",
        participants: [{ participant_id: "coordinator", device_id: "local" }],
        auto_configuration: { safe_to_skip_confirmation: true },
      }),
      requestFn: async (path) => {
        calls += 1;
        if (path === "/collaboration/local/runs") return { run: { run_id: "acr_auth", state: "created" } };
        if (path.endsWith("/start")) return { run: { run_id: "acr_auth", state: "running" } };
        throw Object.assign(new Error("forbidden"), { code: "HTTP_403" });
      },
    }),
    (error) => error.code === "HTTP_403",
  );
  assert.equal(calls, 3, "creation, start, and one snapshot read only");
});

test("workspace authorization uses the injected authenticated request client", async () => {
  let captured;
  const workspace = await trustCollaborationWorkspace("remote/device", " '/srv/project' ", {
    requestFn: async (path, options) => {
      captured = { path, options };
      return { workspace: { workspace_id: "workspace-remote", canonical_path: options.body.path } };
    },
  });
  assert.equal(captured.path, "/collaboration/devices/remote%2Fdevice/workspaces/trust");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.body.path, " '/srv/project' ");
  assert.equal(workspace.workspace_id, "workspace-remote");
});

test("workspace browser encodes partial paths for remote completion", async () => {
  let captured;
  const page = await browseCollaborationWorkspaces("remote/device", "/Users/cheng", {
    limit: 6,
    requestFn: async (path, options) => {
      captured = { path, options };
      return { entries: [{ name: "chengaoyan", path: "/Users/chengaoyan" }] };
    },
  });
  assert.match(captured.path, /^\/collaboration\/devices\/remote%2Fdevice\/workspaces\/browse\?/);
  assert.match(captured.path, /path=%2FUsers%2Fcheng/);
  assert.match(captured.path, /limit=6/);
  assert.equal(captured.options.signal, undefined);
  assert.equal(page.entries[0].path, "/Users/chengaoyan");
});

test("JSON automation projection is stable and excludes capability secrets and paths", () => {
  const payload = validateAndNormalizeAutoConfiguration(proposal(), {
    objective: "Fix tests",
    devices: [device()],
  });
  assert.deepEqual(Object.keys(autoConfigurationView(payload)), [
    "objective", "supervisor_permission_profile", "supervisor_policy_id",
    "participants", "workflow_template_id", "preferences",
    "independent_review", "max_concurrency", "budget",
  ]);
  const projected = publicCapabilitySnapshot([device({
    capabilities: { ...capabilities(), api_key: "secret", environment: { TOKEN: "secret" } },
  })]);
  assert.doesNotMatch(JSON.stringify(projected), /secret|api_key|TOKEN|\/private\/project/);
});

test("cloud auto-configuration uses the logged-in control service and no local model route", async () => {
  let captured;
  const result = await requestAutoConfiguration({
    objective: "Fix tests",
    devices: [device()],
  }, {
    stateDir: "/state",
    ensureFreshAccessTokenFn: async ({ resource }) => {
      assert.equal(resource, "originrouter.control");
      return { accessTokens: { control: { token: "or_at_control" } } };
    },
    selectControlBaseUrlFn: async () => "https://control.example/",
    fetchFn: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return { code: 0, data: { status: "configured", ...proposal() } };
        },
      };
    },
  });
  assert.equal(captured.url, "https://control.example/cli/v1/collaboration/auto-configurations");
  assert.equal(captured.options.headers.Authorization, "Bearer or_at_control");
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(Object.keys(body), ["protocol_version", "objective", "capability_snapshot"]);
  assert.equal(body.objective, "Fix tests");
  assert.equal(result.planner, "planner");
  assert.equal(JSON.stringify(body).includes("originrouter-claude-fast-model"), false);
});

test("cloud capability projection contains no secrets or absolute workspace path", () => {
  const projected = publicCapabilitySnapshot([device({
    capabilities: { ...capabilities(), api_key: "secret", environment: { TOKEN: "secret" } },
  })]);
  const encoded = JSON.stringify(projected);
  assert.doesNotMatch(encoded, /secret|api_key|TOKEN|\/private\/project/);
});
