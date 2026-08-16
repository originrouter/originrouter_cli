import assert from "node:assert/strict";

import { handleAgentWorkspaceCommand, parseAgentWorkspaceArgs } from "../src/commands/agentWorkspace.js";
import {
  buildLocalWorkspaceConfiguration,
  inferWorkspaceMode,
  nextWorkspaceMode,
  normalizeWorkspaceMode,
  workspaceRequiresPlanReview,
} from "../src/collaboration/workspaceModes.js";

const localCapabilities = {
  device: { device_id: "local-device", default_workspace_path: "/project" },
  runtimes: [{ id: "codex", available: true }, { id: "claude", available: true }],
  trusted_workspaces: [{
    workspace_id: "workspace-local",
    canonical_path: "/project",
    repo_root: "/project",
  }],
  permission_profiles: [{ id: "guarded" }, { id: "manual" }],
  defaults: { permission_profile: "guarded" },
};

const remoteCapabilities = {
  device: { device_id: "server-a", default_workspace_path: "/srv/project" },
  runtimes: [{ id: "codex", available: true }, { id: "claude", available: true }],
  trusted_workspaces: [{
    workspace_id: "workspace-remote",
    canonical_path: "/srv/project",
    repo_root: "/srv/project",
  }],
  permission_profiles: [{ id: "guarded" }],
  defaults: { permission_profile: "guarded" },
};

const devices = [
  {
    deviceId: "local-device",
    deviceName: "Local Mac",
    local: true,
    online: true,
    trustStatus: "trusted",
    capabilities: localCapabilities,
  },
  {
    deviceId: "server-a",
    deviceName: "Server A",
    local: false,
    online: true,
    trustStatus: "trusted",
    capabilities: remoteCapabilities,
  },
];

assert.deepEqual(
  parseAgentWorkspaceArgs(["-c", "claude", "--mode", "build-review", "fix", "login"]),
  { coordinator: "claude", mode: "build_review", objective: "fix login", forwarded: [] },
);
assert.deepEqual(
  parseAgentWorkspaceArgs(["--cloud-advice", "--timeout=120", "review", "the", "rollout"]),
  {
    coordinator: "codex",
    mode: "auto",
    objective: "review the rollout",
    forwarded: ["--cloud-advice", "--timeout", "120"],
  },
);
assert.equal(normalizeWorkspaceMode("plan"), "plan_build_verify");
assert.equal(nextWorkspaceMode("auto").id, "solo");
assert.equal(inferWorkspaceMode("explain the authentication flow"), "solo");
assert.equal(inferWorkspaceMode("fix the authentication race and add tests"), "build_review");
assert.equal(inferWorkspaceMode("check service status on server A"), "remote_ops");
assert.equal(workspaceRequiresPlanReview("deploy to production", "auto"), true);
assert.equal(workspaceRequiresPlanReview("check service status on server A", "auto"), true);

const buildReview = buildLocalWorkspaceConfiguration({
  objective: "Fix login and add tests",
  mode: "build-review",
  coordinator: "codex",
  devices,
  currentDirectory: "/project",
});
assert.equal(buildReview.participants.length, 2);
assert.equal(buildReview.participants[0].runtime, "codex");
assert.equal(buildReview.participants[0].planner, true);
assert.equal(buildReview.participants[1].runtime, "claude");
assert.equal(buildReview.auto_configuration.workspace_mode, "build_review");
assert.equal(buildReview.auto_configuration.independent_review, true);

const automatic = buildLocalWorkspaceConfiguration({
  objective: "Investigate several possible causes of the latency",
  mode: "auto",
  coordinator: "claude",
  devices,
  currentDirectory: "/project",
});
assert.equal(automatic.auto_configuration.workspace_mode, "auto");
assert.equal(automatic.auto_configuration.resolved_workspace_mode, "parallel_research");
assert.equal(automatic.participants[0].runtime, "claude");
assert.equal(automatic.participants.length, 3);

const remote = buildLocalWorkspaceConfiguration({
  objective: "Check service status on server A",
  mode: "remote-ops",
  coordinator: "codex",
  devices,
  currentDirectory: "/project",
});
assert.equal(remote.participants.length, 2);
assert.equal(remote.participants[1].device_id, "server-a");
assert.equal(remote.auto_configuration.safe_to_skip_confirmation, false);

const calls = [];
await handleAgentWorkspaceCommand([
  "-c", "codex", "--mode", "solo", "explain", "this", "module",
], {
  collaborationRunner: async (args) => calls.push(args),
});
assert.equal(calls.length, 1);
assert.deepEqual(calls[0].slice(0, 6), [
  "create", "explain this module", "--workspace-mode", "solo", "--coordinator", "codex",
]);
assert(calls[0].includes("--yes"));

const remoteCalls = [];
await handleAgentWorkspaceCommand(["check", "service", "status", "on", "server", "A"], {
  collaborationRunner: async (args) => remoteCalls.push(args),
});
assert.equal(remoteCalls[0].includes("--yes"), false, "Auto-resolved Remote Ops must require review");

console.log("agent workspace tests passed");
