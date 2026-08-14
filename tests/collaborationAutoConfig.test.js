import assert from "node:assert/strict";
import test from "node:test";

import {
  autoConfigureCollaboration,
  publicCapabilitySnapshot,
  requestAutoConfiguration,
  validateAndNormalizeAutoConfiguration,
} from "../src/collaboration/collaborationAutoConfig.js";
import {
  automaticCreatePayload,
  autoConfigurationView,
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
});

test("JSON automation projection is stable and excludes capability secrets and paths", () => {
  const payload = validateAndNormalizeAutoConfiguration(proposal(), {
    objective: "Fix tests",
    devices: [device()],
  });
  assert.deepEqual(Object.keys(autoConfigurationView(payload)), [
    "objective", "participants", "workflow_template_id", "preferences",
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
