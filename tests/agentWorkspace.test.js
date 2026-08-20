import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildWorkspaceAppScreen,
  handleAgentWorkspaceCommand,
  parseAgentWorkspaceArgs,
  redrawPrompt,
} from "../src/commands/agentWorkspace.js";
import { buildAgentLaunchScreen } from "../src/local/agentLaunchScreen.js";
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
assert.equal(inferWorkspaceMode("check service status on server A"), "solo");
assert.equal(workspaceRequiresPlanReview("deploy to production", "auto"), true);
assert.equal(workspaceRequiresPlanReview("check service status on server A", "auto"), false);
assert.equal(workspaceRequiresPlanReview("check service status on server A", "remote-ops"), true);

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

assert.throws(
  () => buildLocalWorkspaceConfiguration({
    objective: "Inspect the remote computer",
    mode: "remote-ops",
    coordinator: "codex",
    devices: devices.map((device) => device.local ? device : {
      ...device,
      capabilities: { ...device.capabilities, trusted_workspaces: [] },
    }),
    currentDirectory: "/project",
  }),
  (error) => error.code === "AUTO_CONFIG_REMOTE_WORKSPACE_REQUIRED"
    && error.setup?.device_id === "server-a",
);

const workspaceScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 23,
});
assert.match(workspaceScreen, /╭─/);
assert.match(workspaceScreen, /OriginRouter/);
assert.match(workspaceScreen, /Agent Workspace/);
assert.match(workspaceScreen, /Team      Auto/);
assert.match(workspaceScreen, /Access    Guarded/);
assert.match(workspaceScreen, /● guarded · \/access/);
assert.doesNotMatch(workspaceScreen, /^OriginRouter\nWorkspace/m);

const launchScreen = buildAgentLaunchScreen({
  agent: "codex",
  workspaceName: "originrouter-cli",
  cwd: "~/Desktop/originrouter-cli",
  detailLabel: "Detailed",
  controlLabel: "local-only",
  sessionLabel: "Codex native session",
  columns: 80,
});
assert.match(launchScreen, /OriginRouter/);
assert.doesNotMatch(launchScreen, /Agent Console/);
assert.match(launchScreen, /OpenAI Codex/);
assert.match(launchScreen, /Runtime/);
assert.match(launchScreen, /Workspace/);
assert.match(launchScreen, /Starting session/);

const writes = [];
const output = {
  isTTY: true,
  columns: 20,
  write(chunk) {
    writes.push(String(chunk));
    return true;
  },
};
let rows = redrawPrompt(output, "", "auto");
rows = redrawPrompt(output, "我想分析一下我远程电脑的状态", "auto", rows);
assert(rows > 1);
rows = redrawPrompt(output, "我想分析一下我远程电脑的状态，包括机器状态和版本信息", "auto", rows);
assert.match(writes.join(""), /\x1b\[1A/);
assert.match(writes.join(""), /› 我想分析一下/);
assert.match(writes.join(""), /Auto · shift\+tab to cycle/);
assert.doesNotMatch(writes.join(""), /\[Auto\] >/);

function fakeTerminal(columns = 80, rows = 24) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  const terminalWrites = [];
  const terminalOutput = new EventEmitter();
  terminalOutput.isTTY = true;
  terminalOutput.columns = columns;
  terminalOutput.rows = rows;
  terminalOutput.write = (chunk) => {
    terminalWrites.push(String(chunk));
    return true;
  };
  return { input, output: terminalOutput, writes: terminalWrites };
}

function emitText(input, text) {
  for (const char of text) input.emit("keypress", char, { name: char });
}

const clearInputTerminal = fakeTerminal();
const clearInputCalls = [];
const clearInputRun = handleAgentWorkspaceCommand([], {
  input: clearInputTerminal.input,
  output: clearInputTerminal.output,
  collaborationRunner: async (args) => clearInputCalls.push(args),
});
await new Promise((resolve) => setImmediate(resolve));
emitText(clearInputTerminal.input, "draft text");
clearInputTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
emitText(clearInputTerminal.input, "/exit");
clearInputTerminal.input.emit("keypress", undefined, { name: "return" });
await clearInputRun;
assert.equal(clearInputCalls.length, 0);
assert.match(clearInputTerminal.writes.join(""), /Input cleared/);

const doubleExitTerminal = fakeTerminal();
const doubleExitRun = handleAgentWorkspaceCommand([], {
  input: doubleExitTerminal.input,
  output: doubleExitTerminal.output,
  collaborationRunner: async () => {
    throw new Error("collaboration should not start");
  },
});
await new Promise((resolve) => setImmediate(resolve));
doubleExitTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
doubleExitTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
await doubleExitRun;
assert.match(doubleExitTerminal.writes.join(""), /Press Ctrl\+C again to exit/);

const activeInterruptTerminal = fakeTerminal();
const cancelledRuns = [];
let activeRunnerStarted = false;
const activeInterruptRun = handleAgentWorkspaceCommand([], {
  input: activeInterruptTerminal.input,
  output: activeInterruptTerminal.output,
  collaborationRunner: async (_args, options = {}) => {
    activeRunnerStarted = true;
    options.onRunId?.("acr_test_interrupt");
    setImmediate(() => process.emit("SIGINT"));
    await new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.code = "ORIGINROUTER_INTERRUPTED";
        reject(error);
      }, { once: true });
      setTimeout(resolve, 1000);
    });
  },
  cancelCollaborationRun: async (runId) => {
    cancelledRuns.push(runId);
    setTimeout(() => {
      emitText(activeInterruptTerminal.input, "/exit");
      activeInterruptTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(activeInterruptTerminal.input, "run something");
activeInterruptTerminal.input.emit("keypress", undefined, { name: "return" });
await activeInterruptRun;
assert.equal(activeRunnerStarted, true);
assert.deepEqual(cancelledRuns, ["acr_test_interrupt"]);
assert.match(activeInterruptTerminal.writes.join(""), /Interrupting the collaboration/);
assert.match(activeInterruptTerminal.writes.join(""), /acr_test_interrupt/);

const queuedTerminal = fakeTerminal();
const queuedCalls = [];
const queuedRun = handleAgentWorkspaceCommand([], {
  input: queuedTerminal.input,
  output: queuedTerminal.output,
  collaborationRunner: async (args) => {
    queuedCalls.push(args);
    if (queuedCalls.length === 1) {
      await new Promise((resolve) => {
        setImmediate(() => {
          emitText(queuedTerminal.input, "inspect next device");
          queuedTerminal.input.emit("keypress", undefined, { name: "return" });
          setTimeout(resolve, 10);
        });
      });
      return;
    }
    setTimeout(() => {
      emitText(queuedTerminal.input, "/exit");
      queuedTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(queuedTerminal.input, "first objective");
queuedTerminal.input.emit("keypress", undefined, { name: "return" });
await queuedRun;
assert.equal(queuedCalls.length, 2);
assert.equal(queuedCalls[1][1], "inspect next device");
assert.match(queuedTerminal.writes.join(""), /next objective queued/i);

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
assert.equal(calls[0].includes("--yes"), false);

const remoteCalls = [];
await handleAgentWorkspaceCommand(["check", "service", "status", "on", "server", "A"], {
  collaborationRunner: async (args) => remoteCalls.push(args),
});
assert.equal(remoteCalls[0].includes("--cloud-advice"), true, "Auto mode asks the advisory model to choose a team");
assert.equal(remoteCalls[0].includes("--yes"), false, "Auto mode waits for the resolved configuration before deciding confirmation");

const runtimeScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "executing",
    mode: "auto",
    startedAt: Date.now() - 2500,
    runId: "acr_runtime",
    configuration: {
      resolved_workspace_mode: "remote_ops",
      participants: [
        { participant_id: "coordinator", device_id: "local-device" },
        { participant_id: "remote_operator", device_id: "server-a" },
      ],
    },
    snapshot: {
      run: { state: "running", phase: "execution" },
      tasks: [{ task_key: "inspect", title: "Inspect remote status", state: "running", participant_id: "remote_operator" }],
    },
    events: [{ sequence: 1, summary: "Remote Agent connected", visibility: "summary" }],
    composerBuffer: "queue another check",
  },
});
assert.match(runtimeScreen, /Agents are working/);
assert.match(runtimeScreen, /Remote Ops · 2 Agents · 2 devices/);
assert.match(runtimeScreen, /Inspect remote status/);
assert.match(runtimeScreen, /acr_runtime/);
assert.match(runtimeScreen, /› queue another check/);
assert.match(runtimeScreen, /Enter queues next objective/);

console.log("agent workspace tests passed");
