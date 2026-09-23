import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoSecretFields,
  normalizeSessionTeam,
  parseJson,
  publicRun,
  safeText,
} from "../src/collaboration/collaborationStorePrimitives.js";

test("collaboration store primitives keep normalization and redaction boundaries pure", () => {
  assert.equal(safeText("  objective  ", 4), "obje");
  assert.deepEqual(parseJson('{"ok":true}', null), { ok: true });
  assert.equal(parseJson("not-json", "fallback"), "fallback");
  assert.throws(() => assertNoSecretFields({ nested: { api_key: "hidden" } }), /forbidden_collaboration_field/);
});

test("session team normalization returns the stable persisted shape", () => {
  const team = normalizeSessionTeam({
    participants: [{
      participant_id: "planner",
      runtime: "codex",
      device_id: "device-1",
      responsibilities: ["plan"],
    }],
    supervisor_permission_profile: "guarded",
  });
  assert.equal(team.version, 1);
  assert.equal(team.participants[0].participant_id, "planner");
  assert.equal(team.supervisor_policy_id, "");
});

test("public Run projection handles legacy empty JSON columns", () => {
  const run = publicRun({
    run_id: "run-1",
    template_id: "adaptive_collaboration",
    state: "created",
    plan_json: "",
    gates_json: "",
    budget_json: "",
    usage_json: "",
    counters_json: "",
    final_report_json: "",
  });
  assert.equal(run.run_id, "run-1");
  assert.equal(run.plan_status, "draft");
  assert.deepEqual(run.gates, {});
});
