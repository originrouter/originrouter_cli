import assert from "node:assert/strict";

import {
  createPayload,
  handleCollaborationCommand,
  interactiveCreatePayload,
} from "../src/commands/collaboration.js";

class ScriptedPrompt {
  constructor(answers) {
    this.answers = [...answers];
    this.questions = [];
  }

  async question(text) {
    this.questions.push(text);
    if (!this.answers.length) throw new Error(`No scripted answer for: ${text}`);
    return this.answers.shift();
  }
}

const capabilities = {
  schema_version: 1,
  device: {
    device_id: "device-local",
    name: "Test Mac",
    default_workspace_path: "/workspace",
  },
  runtimes: [{ id: "codex", available: true }],
  providers: [],
  resolved_routes: { codex: { main: null } },
  protocol_versions: {
    collaboration_snapshot: 2,
    collaboration_event: 2,
  },
  trusted_workspaces: [{
    workspace_id: "workspace-1",
    display_name: "Workspace",
    canonical_path: "/workspace",
  }],
  permission_profiles: [
    { id: "manual", label: "Manual", description: "Ask every time." },
    { id: "guarded", label: "Guarded", description: "Allow safe workspace work." },
  ],
};

const prompt = new ScriptedPrompt([
  "Build and verify the feature",
  "",
  "1",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
]);

const payload = await interactiveCreatePayload({
  prompt,
  saveDraftFn: (draft) => ({
    draft_id: draft.draft_id || "draft-test",
    created_at: draft.created_at || new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...draft,
  }),
  deleteDraftFn: () => true,
  cacheCapabilitiesFn: (value) => value,
  getCachedCapabilitiesFn: () => null,
  requestFn: async (path) => {
    assert.equal(path, "/collaboration/local/capabilities");
    return { capabilities };
  },
  loadDeviceDirectoryFn: async () => [],
});

assert.equal(payload.objective, "Build and verify the feature");
assert.equal(payload.workflow_template_id, "adaptive");
assert.match(payload.preferences, /independent review/i);
assert.equal(payload.participants.length, 1);
assert.equal(payload.participants[0].participant_id, "planner");
assert.equal(payload.participants[0].runtime, "codex");
assert.equal(payload.participants[0].workspace_id, "workspace-1");
assert.equal(payload.participants[0].permission_profile, "guarded");
assert.equal(payload.participants[0].planner, true);
assert.equal(payload.budget.max_concurrency, 1);
assert.equal(payload.budget.token_limit, undefined);
assert.equal(payload.budget.amount_limit_micros, undefined);
assert.equal(prompt.answers.length, 0);

const backPrompt = new ScriptedPrompt([
  ":back",
  "",
  "",
  "",
  "Updated collaboration preference",
  "",
  "",
  "",
  "",
  "",
]);
const resumedPayload = await interactiveCreatePayload({
  prompt: backPrompt,
  initialDraft: {
    draft_id: "draft-back-navigation",
    wizard_sequence_version: 2,
    step: 6,
    objective: "Review and improve the implementation",
    style_id: "single_agent",
    participant_count: 1,
    participants: [{
      participant_id: "planner",
      display_name: "Planner",
      runtime: "codex",
      device_id: "device-local",
      workspace_id: "workspace-1",
      permission_profile: "guarded",
      role_hint: "Implement and verify the result.",
      planner: true,
    }],
    concurrency: 1,
    token_limit: null,
    preference: "Initial preference",
  },
  saveDraftFn: (draft) => ({
    draft_id: draft.draft_id || "draft-back-navigation",
    created_at: draft.created_at || new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...draft,
  }),
  deleteDraftFn: () => true,
  cacheCapabilitiesFn: (value) => value,
  getCachedCapabilitiesFn: () => null,
  requestFn: async (path) => {
    assert.equal(path, "/collaboration/local/capabilities");
    return { capabilities };
  },
  loadDeviceDirectoryFn: async () => [],
});
assert.match(resumedPayload.preferences, /Updated collaboration preference/);
assert.match(resumedPayload.preferences, /explicit retry/);
assert.equal(resumedPayload.budget.max_concurrency, 1);
assert.equal(backPrompt.answers.length, 0);

const scripted = createPayload([
  "--objective", "Implement and review a release change",
  "--participant", "lead:codex:local:/project",
  "--participant", "builder:claude:remote:/srv/project",
  "--role", "builder=Implement the approved plan",
  "--route", "builder=private-provider:claude-sonnet:latest",
  "--permission", "builder=guarded",
  "--concurrency", "2",
  "--token-limit", "250000",
  "--amount-limit", "12.50",
  "--currency", "USD",
]);
assert.equal(scripted.participants[1].provider, "private-provider");
assert.equal(scripted.participants[1].model, "claude-sonnet:latest");
assert.equal(scripted.participants[1].permission_profile, "guarded");
assert.equal(scripted.budget.amount_limit_micros, 12_500_000);
assert.equal(scripted.budget.currency, "USD");

assert.throws(
  () => createPayload([
    "--objective", "Invalid participant option",
    "--participant", "lead:codex:local:/project",
    "--route", "missing=provider:model",
  ]),
  /unknown id 'missing'/,
);

await assert.rejects(
  handleCollaborationCommand(["list", "--category", "unknown"]),
  (error) => error.exitCode === 2
    && error.diagnosticCode === "COLLABORATION_INVALID_INPUT",
);

console.log("collaboration CLI wizard tests passed");
