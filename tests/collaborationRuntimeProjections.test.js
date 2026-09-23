import assert from "node:assert/strict";
import test from "node:test";

import {
  attentionRequestProjection,
  collaborationSnapshotSummary,
  interactionAttentionActions,
  interactionAttentionKind,
  interactionFormFieldsProjection,
  interactionQuestionsProjection,
} from "../src/collaboration/collaborationRuntimeProjections.js";

test("runtime interaction projections remain bounded and display-safe", () => {
  const questions = interactionQuestionsProjection([{
    question: "Enter the token",
    secret: true,
    options: [{ label: "one" }],
  }]);
  assert.equal(questions[0].requires_local_entry, true);
  assert.equal(questions[0].options[0].id, "o1");
  const fields = interactionFormFieldsProjection({
    properties: { api_key: { type: "string", format: "password" } },
    required: ["api_key"],
  });
  assert.equal(fields[0].requires_local_entry, true);
});

test("runtime attention projections preserve action policy", () => {
  assert.equal(interactionAttentionKind("permission"), "approval");
  assert.deepEqual(interactionAttentionActions("questions", {}, true), ["cancel"]);
  const request = attentionRequestProjection({
    kind: "permission",
    prompt: "Allow?",
    payload: { command: "echo safe", approval_options: [{ id: "allow_once", label: "Allow once" }] },
  });
  assert.equal(request.command, "echo safe");
  assert.equal(request.approval_options[0].id, "allow_once");
});

test("snapshot summary is a display projection, not a mutable store object", () => {
  const participant = { participant_id: "planner", runtime: "codex" };
  const summary = collaborationSnapshotSummary({
    run: { run_id: "run-1" },
    participants: [participant],
    tasks: [],
    attention: [],
    artifacts: [],
    budget: {},
    usage: {},
    final_report: null,
    capabilities: {},
    schema_version: 1,
    revision: 2,
    last_sequence: 3,
  });
  assert.equal(summary.agents.planner, participant);
  assert.equal(summary.revision, 2);
});
