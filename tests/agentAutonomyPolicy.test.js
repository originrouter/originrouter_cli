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
    permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    { profile: "guarded", workspaceRoot: "/tmp/project" },
  );
  assert.equal(command.autoResolve, true);
  assert.equal(command.action, "allow");

  const edit = evaluateAutonomyInteraction(
    permission({ tool: "Edit", tool_input: { file_path: "src/app.js" } }),
    { profile: "guarded", workspaceRoot: "/tmp/project" },
  );
  assert.equal(edit.autoResolve, true);

  for (const diagnostic of [
    "sw_vers",
    "uptime",
    "system_profiler SPSoftwareDataType",
    "command -v originrouter",
    "originrouter --version",
    "brew list --versions originrouter-cli",
    "launchctl list",
  ]) {
    const result = evaluateAutonomyInteraction(
      permission({ tool: "Bash", command: diagnostic, cwd: "/tmp/project" }),
      { profile: "guarded", workspaceRoot: "/tmp/project" },
    );
    assert.equal(result.autoResolve, true, diagnostic);
  }
});

test("guarded autonomy stops for destructive, elevated, and out-of-workspace work", () => {
  for (const command of [
    "rm -rf build",
    "sudo systemctl restart app",
    "git push origin main",
    "brew services restart originrouter",
  ]) {
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

test("guarded autonomy escalates indirect execution, outside reads, task, and network reads", () => {
  for (const payload of [
    { tool: "Bash", command: "env rm -rf /tmp/x", cwd: "/tmp/project" },
    { tool: "Bash", command: "npm exec evil-package", cwd: "/tmp/project" },
    { tool: "Bash", command: "npx evil-package", cwd: "/tmp/project" },
    { tool: "Bash", command: "./dangerous-script", cwd: "/tmp/project" },
    { tool: "Read", tool_input: { file_path: "/etc/passwd" } },
    { tool: "Task", prompt: "modify files" },
    { tool: "WebFetch", url: "http://127.0.0.1:7437/private" },
  ]) {
    const result = evaluateAutonomyInteraction(permission(payload), {
      profile: "guarded",
      workspaceRoot: "/tmp/project",
    });
    assert.equal(result.autoResolve, false, JSON.stringify(payload));
  }
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
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
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

test("workspace policies restrict guarded decisions and shadow policies never auto-resolve", async () => {
  let requested = 0;
  const workspacePolicy = {
    policy: {
      version: 2,
      id: "workspace-restrictions",
      defaults: { unmatched: "ask", parse_error: "ask", unknown: "ask" },
      rules: [{ id: "deny-git-read", effect: "deny", actions: ["vcs.read"] }],
    },
    revision: "workspace-revision",
    restrictionOnly: true,
    summary: { source: "workspace_restriction" },
  };
  const denied = await resolveWithAutonomy({
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    profile: "guarded",
    workspaceRoot: "/tmp/project",
    workspaceApprovalPolicy: workspacePolicy,
    requestInteraction: async () => {
      requested += 1;
      return { action: "allow", user: true };
    },
  });
  assert.equal(denied.action, "deny");
  assert.equal(requested, 0);

  let observed = 0;
  const shadow = await resolveWithAutonomy({
    request: permission({ tool: "Read", tool_input: { file_path: "README.md" } }),
    profile: "custom",
    workspaceRoot: "/tmp/project",
    approvalPolicy: {
      version: 2,
      id: "shadow-policy",
      metadata: { enforcement: "shadow" },
      rules: [{ id: "allow-read", effect: "allow", actions: ["fs.read"] }],
    },
    requestInteraction: async () => ({ action: "deny", user: true }),
    onPolicyObserved: async () => { observed += 1; },
  });
  assert.equal(shadow.action, "deny");
  assert.equal(shadow.policyShadow, true);
  assert.equal(observed, 1);
});

test("AI review allows routine work but never grants high-risk authority", async () => {
  let userRequests = 0;
  const allowReviewer = {
    review: async () => ({ decision: "allow", risk: "low", confidence: 0.98, reason: "bounded test command" }),
  };
  const routine = await resolveWithAutonomy({
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    profile: "ai_review",
    workspaceRoot: "/tmp/project",
    runtime: "codex-app-server",
    aiReviewer: allowReviewer,
    requestInteraction: async () => { userRequests += 1; return { action: "deny" }; },
  });
  assert.equal(routine.action, "allow");
  assert.equal(routine.decisionSource, "ai_reviewer");
  assert.equal(userRequests, 0);

  const destructive = await resolveWithAutonomy({
    request: permission({ tool: "command", command: "rm -rf build", cwd: "/tmp/project" }),
    profile: "ai_review",
    workspaceRoot: "/tmp/project",
    aiReviewer: allowReviewer,
    requestInteraction: async () => { userRequests += 1; return { action: "deny", user: true }; },
  });
  assert.equal(destructive.user, true);
  assert.equal(userRequests, 1);
});

test("AI review template scopes can narrow an allow decision", async () => {
  let reviewedPolicy;
  const result = await resolveWithAutonomy({
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    profile: "ai_review",
    workspaceRoot: "/tmp/project",
    aiReviewPolicy: {
      template_id: "ait_read_only",
      version: 3,
      content_hash: "b".repeat(64),
      allowed_scopes: ["read_tools"],
    },
    aiReviewer: {
      review: async ({ aiReviewPolicy }) => {
        reviewedPolicy = aiReviewPolicy;
        return { decision: "allow", risk: "low", confidence: 0.99 };
      },
    },
    requestInteraction: async () => ({ action: "deny", user: true }),
  });
  assert.equal(reviewedPolicy.template_id, "ait_read_only");
  assert.equal(result.user, true);
});

test("AI review can deny and falls back to the user when unavailable", async () => {
  const denied = await resolveWithAutonomy({
    request: permission({ tool: "command", command: "curl -X POST https://example.com", cwd: "/tmp/project" }),
    profile: "ai_review",
    workspaceRoot: "/tmp/project",
    aiReviewer: { review: async () => ({ decision: "deny", risk: "high", confidence: 0.9, reason: "unrelated mutation" }) },
    requestInteraction: async () => ({ action: "allow", user: true }),
  });
  assert.equal(denied.action, "deny");
  assert.equal(denied.autoResolved, true);

  const fallback = await resolveWithAutonomy({
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    profile: "ai_review",
    workspaceRoot: "/tmp/project",
    aiReviewer: { review: async () => { throw new Error("offline"); } },
    requestInteraction: async () => ({ action: "allow", user: true }),
  });
  assert.equal(fallback.user, true);
});

test("AI review escalates uncertain, invalid, secret, and reviewer-high-risk requests", async () => {
  let reviewerCalls = 0;
  let userRequests = 0;
  const requestInteraction = async () => {
    userRequests += 1;
    return { action: "deny", user: true };
  };
  const base = {
    profile: "ai_review",
    workspaceRoot: "/tmp/project",
    requestInteraction,
  };

  const escalated = await resolveWithAutonomy({
    ...base,
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    aiReviewer: {
      review: async () => {
        reviewerCalls += 1;
        return { decision: "escalate", risk: "medium", confidence: 0.5 };
      },
    },
  });
  assert.equal(escalated.user, true);

  const invalid = await resolveWithAutonomy({
    ...base,
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    aiReviewer: { review: async () => ({ decision: "maybe", risk: "low" }) },
  });
  assert.equal(invalid.user, true);

  const reviewerHighRisk = await resolveWithAutonomy({
    ...base,
    request: permission({ tool: "command", command: "git status", cwd: "/tmp/project" }),
    aiReviewer: { review: async () => ({ decision: "allow", risk: "high", confidence: 0.7 }) },
  });
  assert.equal(reviewerHighRisk.user, true);

  const secretRequest = permission({ tool: "command", command: "git status", cwd: "/tmp/project" });
  secretRequest.containsSecret = true;
  const secret = await resolveWithAutonomy({
    ...base,
    request: secretRequest,
    aiReviewer: {
      review: async () => {
        reviewerCalls += 1;
        return { decision: "allow", risk: "low" };
      },
    },
  });
  assert.equal(secret.user, true);
  assert.equal(reviewerCalls, 1, "secret requests never leave the device for AI review");
  assert.equal(userRequests, 4);
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
    permission({ tool: "Bash", command: "git status", cwd: "/tmp/project" }),
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
  assert.equal(status.availableAutonomyProfiles.length, 5);
  assert.deepEqual(status.allowedAutonomyScopes, [
    "plan_continue",
    "read_tools",
    "workspace_edits",
    "workspace_commands",
  ]);
  assert.equal(status.availableAutonomyScopes.length, 11);
});
