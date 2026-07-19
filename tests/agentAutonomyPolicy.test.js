import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutonomyStatusEvent,
  effectiveAutonomyScopes,
  evaluateAutonomyInteraction,
  invalidAutonomyScopes,
  normalizeAutonomyScopes,
  normalizeAutonomyProfile,
  resolveWithAutonomy,
} from "../src/runtime/agentAutonomyPolicy.js";

const permission = (payload, extra = {}) => ({
  interactionId: "permission-1",
  kind: "permission",
  payload,
  containsSecret: false,
  ...extra,
});

test("guarded autonomy allows routine workspace work", () => {
  const command = evaluateAutonomyInteraction(
    permission({ tool: "command", command: "npm test", cwd: "/tmp/project" }),
    { profile: "guarded", workspaceRoot: "/tmp/project" },
  );
  assert.equal(command.autoResolve, true);
  assert.equal(command.action, "allow");

  const edit = evaluateAutonomyInteraction(
    permission({ tool: "Edit", tool_input: { file_path: "src/app.js" } }),
    { profile: "guarded", workspaceRoot: "/tmp/project" },
  );
  assert.equal(edit.autoResolve, true);
});

test("guarded autonomy stops for destructive, elevated, and out-of-workspace work", () => {
  for (const command of ["rm -rf build", "sudo systemctl restart app", "git push origin main"]) {
    const result = evaluateAutonomyInteraction(
      permission({ tool: "Bash", command, cwd: "/tmp/project" }),
      { profile: "guarded", workspaceRoot: "/tmp/project" },
    );
    assert.equal(result.autoResolve, false, command);
  }
  const outside = evaluateAutonomyInteraction(
    permission({ tool: "Write", tool_input: { file_path: "/etc/hosts" } }),
    { profile: "guarded", workspaceRoot: "/tmp/project" },
  );
  assert.equal(outside.autoResolve, false);
  const extraNetwork = evaluateAutonomyInteraction(
    permission({
      tool: "command",
      command: "npm test",
      cwd: "/tmp/project",
      additional_permissions: { network: true },
    }),
    { profile: "guarded", workspaceRoot: "/tmp/project" },
  );
  assert.equal(extraNetwork.autoResolve, false);
});

test("unrestricted autonomy still requires real answers and secrets", () => {
  assert.equal(evaluateAutonomyInteraction({
    interactionId: "q1",
    kind: "questions",
    payload: { questions: [] },
  }, { profile: "unrestricted" }).autoResolve, false);
  assert.equal(evaluateAutonomyInteraction(permission(
    { tool: "command", command: "npm test" },
    { containsSecret: true },
  ), { profile: "unrestricted" }).autoResolve, false);
  assert.equal(evaluateAutonomyInteraction(permission({
    tool: "permissions",
    requested: { network: true },
  }), { profile: "unrestricted" }).autoResolve, true);
});

test("unrestricted autonomy answers only explicit binary continue questions", () => {
  const result = evaluateAutonomyInteraction({
    interactionId: "q1",
    kind: "questions",
    payload: {
      questions: [{
        id: "continue",
        multiple: false,
        options: [{ label: "Continue" }, { label: "Cancel" }],
      }],
    },
  }, { profile: "unrestricted" });
  assert.equal(result.autoResolve, true);
  assert.equal(result.action, "submit");
  assert.deepEqual(result.response.answers, { continue: ["Continue"] });

  const ambiguous = evaluateAutonomyInteraction({
    interactionId: "q2",
    kind: "questions",
    payload: {
      questions: [{
        id: "target",
        options: [{ label: "Staging" }, { label: "Production" }],
      }],
    },
  }, { profile: "unrestricted" });
  assert.equal(ambiguous.autoResolve, false);
});

test("resolveWithAutonomy bypasses the pending registry only when allowed", async () => {
  let requested = 0;
  let autoResolved = 0;
  const result = await resolveWithAutonomy({
    request: permission({ tool: "command", command: "npm test", cwd: "/tmp/project" }),
    profile: "guarded",
    workspaceRoot: "/tmp/project",
    requestInteraction: async () => {
      requested += 1;
      return { action: "deny" };
    },
    onAutoResolved: async () => { autoResolved += 1; },
  });
  assert.equal(result.action, "allow");
  assert.equal(result.autoResolved, true);
  assert.equal(requested, 0);
  assert.equal(autoResolved, 1);
});

test("custom autonomy allows only explicitly selected scopes", () => {
  const edit = evaluateAutonomyInteraction(
    permission({ tool: "Edit", tool_input: { file_path: "src/app.js" } }),
    {
      profile: "custom",
      allowedScopes: ["workspace_edits"],
      workspaceRoot: "/tmp/project",
    },
  );
  const command = evaluateAutonomyInteraction(
    permission({ tool: "Bash", command: "npm test", cwd: "/tmp/project" }),
    {
      profile: "custom",
      allowedScopes: ["workspace_edits"],
      workspaceRoot: "/tmp/project",
    },
  );
  assert.equal(edit.autoResolve, true);
  assert.equal(edit.scope, "workspace_edits");
  assert.equal(command.autoResolve, false);
  assert.equal(command.scope, "workspace_commands");

  const push = evaluateAutonomyInteraction(
    permission({ tool: "Bash", command: "git push origin main", cwd: "/tmp/project" }),
    {
      profile: "custom",
      allowedScopes: ["network_mutations"],
      workspaceRoot: "/tmp/project",
    },
  );
  const sudo = evaluateAutonomyInteraction(
    permission({ tool: "Bash", command: "sudo systemctl restart app", cwd: "/tmp/project" }),
    {
      profile: "custom",
      allowedScopes: ["network_mutations"],
      workspaceRoot: "/tmp/project",
    },
  );
  assert.equal(push.autoResolve, true);
  assert.equal(push.scope, "network_mutations");
  assert.equal(sudo.autoResolve, false);
  assert.equal(sudo.scope, "elevated_commands");
});

test("custom scope normalization drops unknown and duplicate values", () => {
  assert.deepEqual(
    normalizeAutonomyScopes("workspace_edits,unknown,workspace_edits,read_tools"),
    ["workspace_edits", "read_tools"],
  );
  assert.deepEqual(invalidAutonomyScopes("workspace_edits,typo,typo"), ["typo"]);
  assert.deepEqual(effectiveAutonomyScopes("guarded", ["destructive_commands"]), [
    "plan_continue",
    "read_tools",
    "workspace_edits",
    "workspace_commands",
  ]);
});

test("autonomy status is display-safe and profile normalization is strict", () => {
  assert.equal(normalizeAutonomyProfile("FULL", "manual"), "manual");
  const status = buildAutonomyStatusEvent({
    provider: "claude",
    runtime: "claude-sdk",
    profile: "guarded",
  });
  assert.equal(status.autonomyProfile, "guarded");
  assert.equal(status.availableAutonomyProfiles.length, 4);
  assert.deepEqual(status.allowedAutonomyScopes, [
    "plan_continue",
    "read_tools",
    "workspace_edits",
    "workspace_commands",
  ]);
  assert.equal(status.availableAutonomyScopes.length, 11);
});
