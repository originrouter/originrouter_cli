import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildWorkspaceAppScreen,
  createWorkspaceFrameScheduler,
  handleAgentWorkspaceCommand,
  normalizeWorkspacePathInput,
  parseAgentWorkspaceArgs,
  redrawPrompt,
  scrollRuntimeContent,
} from "../src/commands/agentWorkspace.js";
import { buildAgentLaunchScreen } from "../src/local/agentLaunchScreen.js";
import {
  buildLocalWorkspaceConfiguration,
  inferWorkspaceMode,
  nextWorkspaceMode,
  normalizeWorkspaceMode,
  objectiveMentionsRemoteTarget,
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
assert.equal(objectiveMentionsRemoteTarget("我想分析一下我远程电脑的状态"), true);
assert.equal(objectiveMentionsRemoteTarget("explain this local module"), false);
assert.equal(normalizeWorkspacePathInput('  "/Users/chengaoyan/Desktop/originrouter-cli"  '), "/Users/chengaoyan/Desktop/originrouter-cli");
assert.equal(normalizeWorkspacePathInput(" '/Users/chengaoyan/project'\n"), "/Users/chengaoyan/project");

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

const secondRemoteCapabilities = {
  ...remoteCapabilities,
  device: { device_id: "server-b", default_workspace_path: "/srv/other" },
  trusted_workspaces: [{
    workspace_id: "workspace-remote-b",
    canonical_path: "/srv/other",
    repo_root: "/srv/other",
  }],
};
const multipleRemoteDevices = [
  ...devices,
  {
    deviceId: "server-b",
    deviceName: "Server B",
    local: false,
    online: true,
    trustStatus: "trusted",
    capabilities: secondRemoteCapabilities,
  },
];
assert.throws(
  () => buildLocalWorkspaceConfiguration({
    objective: "Inspect the remote computers",
    mode: "remote-ops",
    coordinator: "codex",
    devices: multipleRemoteDevices,
    currentDirectory: "/project",
  }),
  (error) => error.code === "AUTO_CONFIG_REMOTE_DEVICE_SELECTION_REQUIRED"
    && error.setup?.devices?.length === 2,
);
const multiRemote = buildLocalWorkspaceConfiguration({
  objective: "Inspect the remote computers",
  mode: "remote-ops",
  coordinator: "codex",
  devices: multipleRemoteDevices,
  currentDirectory: "/project",
  deviceSelections: ["server-a", "server-b"],
});
assert.deepEqual(
  multiRemote.participants.filter((participant) => !participant.planner).map((participant) => participant.device_id),
  ["server-a", "server-b"],
);
assert.equal(multiRemote.participants.length, 3);

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

const selectedRemote = buildLocalWorkspaceConfiguration({
  objective: "Inspect the remote computer",
  mode: "remote-ops",
  coordinator: "codex",
  devices: devices.map((device) => device.local ? device : {
    ...device,
    capabilities: {
      ...device.capabilities,
      trusted_workspaces: [
        { workspace_id: "workspace-a", canonical_path: "/srv/a" },
        { workspace_id: "workspace-b", canonical_path: "/srv/b" },
      ],
    },
  }),
  currentDirectory: "/project",
  workspaceSelections: { "server-a": "workspace-b" },
});
assert.equal(selectedRemote.participants[1].workspace_id, "workspace-b");

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
assert.match(workspaceScreen, /● guarded · session approval/);
assert.doesNotMatch(workspaceScreen, /^OriginRouter\nWorkspace/m);

const inputScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 24,
  composerBuffer: "draft objective",
  composerCursor: 4,
});
assert.match(inputScreen, /› draf▌t objective/);
assert.match(inputScreen, /Enter submits · Ctrl\+C clears/);

const wrappedInputScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 40,
  rows: 24,
  composerBuffer: "我想分析一下我远程电脑的状态，包括机器状态、是否安装originrouter-cli以及对应的版本信息",
  composerCursor: 18,
});
assert.doesNotMatch(wrappedInputScreen, /originrouter-cli以及…/);
assert.match(wrappedInputScreen, /我想分析一下我远程电脑的状态/);
assert.match(wrappedInputScreen, /是否安装originrouter-cli/);
assert.match(wrappedInputScreen, /▌/);
assert.match(wrappedInputScreen, /Enter submits · Ctrl\+C clears/);

const wrappedRuntimeInputScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 40,
  rows: 24,
  runtime: {
    phase: "planning",
    startedAt: Date.now(),
    composerBuffer: "queue a complete follow-up objective without truncating editable text",
    composerCursor: 30,
    events: [],
  },
});
assert.doesNotMatch(wrappedRuntimeInputScreen, /editable…/);
assert.match(wrappedRuntimeInputScreen, /without truncating/);
assert.match(wrappedRuntimeInputScreen, /editable text/);

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

const scheduledFrames = [];
const scheduledCallbacks = [];
const frameScheduler = createWorkspaceFrameScheduler({
  render: (force) => scheduledFrames.push(force),
  schedule: (callback) => {
    scheduledCallbacks.push(callback);
    return callback;
  },
  cancel: () => {},
});
frameScheduler.request();
frameScheduler.request();
assert.equal(scheduledCallbacks.length, 1, "background updates coalesce into one frame");
scheduledCallbacks.shift()();
assert.deepEqual(scheduledFrames, [false]);
frameScheduler.request(true);
assert.deepEqual(scheduledFrames, [false, true]);
frameScheduler.dispose();

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

function emitPaste(input, text) {
  input.emit("keypress", undefined, { name: "paste-start", sequence: "\x1b[200~" });
  for (const char of text) {
    if (char === "\n") input.emit("keypress", "\n", { name: "enter", sequence: "\n" });
    else if (char === "\t") input.emit("keypress", "\t", { name: "tab", sequence: "\t" });
    else input.emit("keypress", char, { name: char, sequence: char });
  }
  input.emit("keypress", undefined, { name: "paste-end", sequence: "\x1b[201~" });
}

const largePasteTerminal = fakeTerminal();
const largePasteCalls = [];
const largePasteText = `first line\n${"粘".repeat(1001)}\nlast line`;
const largePasteRun = handleAgentWorkspaceCommand([], {
  input: largePasteTerminal.input,
  output: largePasteTerminal.output,
  collaborationRunner: async (args) => {
    largePasteCalls.push(args);
    setTimeout(() => {
      emitText(largePasteTerminal.input, "/exit");
      largePasteTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(largePasteTerminal.input, "inspect ");
const largePasteWriteIndex = largePasteTerminal.writes.length;
emitPaste(largePasteTerminal.input, largePasteText);
emitText(largePasteTerminal.input, " carefully");
const pasteFrame = largePasteTerminal.writes.slice(largePasteWriteIndex).join("");
assert.match(pasteFrame, /\[Pasted Content 1022 chars\]/);
assert.doesNotMatch(pasteFrame, /粘{20}/);
largePasteTerminal.input.emit("keypress", undefined, { name: "return" });
await largePasteRun;
assert.equal(largePasteCalls[0][1], `inspect ${largePasteText} carefully`);
assert.match(largePasteTerminal.writes.join(""), /\x1b\[\?2004h/);
assert.match(largePasteTerminal.writes.join(""), /\x1b\[\?2004l/);

const deletePasteTerminal = fakeTerminal();
const deletePasteCalls = [];
const deletePasteRun = handleAgentWorkspaceCommand([], {
  input: deletePasteTerminal.input,
  output: deletePasteTerminal.output,
  collaborationRunner: async (args) => {
    deletePasteCalls.push(args);
    setTimeout(() => {
      emitText(deletePasteTerminal.input, "/exit");
      deletePasteTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitPaste(deletePasteTerminal.input, "x".repeat(1001));
deletePasteTerminal.input.emit("keypress", undefined, { name: "backspace" });
emitText(deletePasteTerminal.input, "replacement objective");
deletePasteTerminal.input.emit("keypress", undefined, { name: "return" });
await deletePasteRun;
assert.equal(deletePasteCalls[0][1], "replacement objective");

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
assert.equal(
  clearInputTerminal.writes.filter((chunk) => chunk === "\n").length,
  0,
  "full-screen input transitions must not scroll the terminal with a bare newline",
);

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

const resizeTerminal = fakeTerminal(80, 24);
const resizeRun = handleAgentWorkspaceCommand([], {
  input: resizeTerminal.input,
  output: resizeTerminal.output,
  collaborationRunner: async () => {
    throw new Error("collaboration should not start");
  },
});
await new Promise((resolve) => setImmediate(resolve));
const resizeWriteIndex = resizeTerminal.writes.length;
resizeTerminal.output.columns = 48;
resizeTerminal.output.rows = 14;
resizeTerminal.output.emit("resize");
await new Promise((resolve) => setTimeout(resolve, 25));
resizeTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
resizeTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
await resizeRun;
assert.equal(
  resizeTerminal.writes.slice(resizeWriteIndex).some((chunk) => chunk.includes("\x1b[2J\x1b[H")),
  true,
  "terminal resize forces a complete frame at the new dimensions",
);

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

const runtimeClearTerminal = fakeTerminal();
const runtimeClearCancelled = [];
let runtimeClearResolve;
const runtimeClearRun = handleAgentWorkspaceCommand([], {
  input: runtimeClearTerminal.input,
  output: runtimeClearTerminal.output,
  collaborationRunner: async (_args, options = {}) => {
    options.onRunId?.("acr_runtime_clear");
    await new Promise((resolve, reject) => {
      runtimeClearResolve = resolve;
      options.signal?.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.code = "ORIGINROUTER_INTERRUPTED";
        reject(error);
      }, { once: true });
    });
  },
  cancelCollaborationRun: async (runId) => {
    runtimeClearCancelled.push(runId);
    runtimeClearResolve?.();
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(runtimeClearTerminal.input, "run something");
runtimeClearTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
emitText(runtimeClearTerminal.input, "queued text");
runtimeClearTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
assert.deepEqual(runtimeClearCancelled, [], "Ctrl+C clears queued runtime input before cancelling");
assert.match(runtimeClearTerminal.writes.join(""), /Input cleared/);
runtimeClearTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
setTimeout(() => {
  emitText(runtimeClearTerminal.input, "/exit");
  runtimeClearTerminal.input.emit("keypress", undefined, { name: "return" });
}, 30);
await runtimeClearRun;
assert.deepEqual(runtimeClearCancelled, ["acr_runtime_clear"]);

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
const objectiveTransitionWriteIndex = queuedTerminal.writes.length;
queuedTerminal.input.emit("keypress", undefined, { name: "return" });
await queuedRun;
assert.equal(queuedCalls.length, 2);
assert.equal(queuedCalls[1][1], "inspect next device");
assert.match(queuedTerminal.writes.join(""), /next objective queued/i);
assert.equal(
  queuedTerminal.writes.slice(objectiveTransitionWriteIndex).some((chunk) => chunk.includes("\x1b[2J\x1b[H")),
  true,
  "submitting an objective starts the runtime with a complete frame",
);
assert.equal(
  queuedTerminal.writes.filter((chunk) => chunk === "\n").length,
  0,
  "runtime and prompt transitions must stay inside the frame renderer",
);

const devicePickerTerminal = fakeTerminal(100, 30);
const devicePickerCalls = [];
const devicePickerRun = handleAgentWorkspaceCommand([], {
  input: devicePickerTerminal.input,
  output: devicePickerTerminal.output,
  workspaceRunner: async (options) => {
    devicePickerCalls.push([...options.deviceSelections]);
    if (devicePickerCalls.length === 1) {
      const error = new Error("Choose remote devices");
      error.code = "AUTO_CONFIG_REMOTE_DEVICE_SELECTION_REQUIRED";
      error.setup = {
        kind: "device_selection",
        devices: [
          { device_id: "server-a", device_name: "Server A", online: true, runtimes: ["claude"], workspace_count: 1 },
          { device_id: "server-b", device_name: "Server B", online: true, runtimes: ["codex", "claude"], workspace_count: 2 },
        ],
      };
      setTimeout(() => {
        devicePickerTerminal.input.emit("keypress", " ", { name: "space" });
        devicePickerTerminal.input.emit("keypress", undefined, { name: "down" });
        devicePickerTerminal.input.emit("keypress", " ", { name: "space" });
        devicePickerTerminal.input.emit("keypress", undefined, { name: "return" });
      }, 10);
      throw error;
    }
    assert.deepEqual(options.deviceSelections, ["server-a", "server-b"]);
    setTimeout(() => {
      devicePickerTerminal.input.emit("keypress", undefined, { name: "return" });
      setTimeout(() => {
        emitText(devicePickerTerminal.input, "/exit");
        devicePickerTerminal.input.emit("keypress", undefined, { name: "return" });
      }, 15);
    }, 10);
    return { run: { state: "completed" }, tasks: [], final_report: { summary: "Done" } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(devicePickerTerminal.input, "inspect remote computers");
devicePickerTerminal.input.emit("keypress", undefined, { name: "return" });
await devicePickerRun;
assert.deepEqual(devicePickerCalls, [[], ["server-a", "server-b"]]);
assert.match(devicePickerTerminal.writes.join(""), /Which remote devices should participate/);
assert.match(devicePickerTerminal.writes.join(""), /2 selected/);

const runtimePasteTerminal = fakeTerminal();
const runtimePasteCalls = [];
const runtimePasteText = "r".repeat(1001);
const runtimePasteRun = handleAgentWorkspaceCommand([], {
  input: runtimePasteTerminal.input,
  output: runtimePasteTerminal.output,
  collaborationRunner: async (args) => {
    runtimePasteCalls.push(args);
    if (runtimePasteCalls.length === 1) {
      await new Promise((resolve) => {
        setImmediate(() => {
          emitPaste(runtimePasteTerminal.input, runtimePasteText);
          runtimePasteTerminal.input.emit("keypress", undefined, { name: "return" });
          setTimeout(resolve, 10);
        });
      });
      return;
    }
    setTimeout(() => {
      emitText(runtimePasteTerminal.input, "/exit");
      runtimePasteTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(runtimePasteTerminal.input, "first objective");
runtimePasteTerminal.input.emit("keypress", undefined, { name: "return" });
await runtimePasteRun;
assert.equal(runtimePasteCalls.length, 2);
assert.equal(runtimePasteCalls[1][1], runtimePasteText);
assert.match(runtimePasteTerminal.writes.join(""), /\[Pasted Content 1001 chars\]/);

const configurationDraftTerminal = fakeTerminal();
let configurationDecision;
const configurationDraftRun = handleAgentWorkspaceCommand([], {
  input: configurationDraftTerminal.input,
  output: configurationDraftTerminal.output,
  workspaceRunner: async (options) => {
    setImmediate(() => configurationDraftTerminal.input.emit("keypress", undefined, { name: "escape" }));
    configurationDecision = await options.onConfigurationConfirmation({
      resolved_workspace_mode: "remote_ops",
      planning_source: "cloud_advice",
      risk_tier: "yellow",
      participants: [{ participant_id: "coordinator", display_name: "Coordinator", runtime: "codex", device_id: "local", workspace_id: "workspace", permission_profile: "guarded", planner: true }],
      auto_configuration: { advice: { reason: "Remote inspection requested." } },
    });
    setTimeout(() => {
      configurationDraftTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
      emitText(configurationDraftTerminal.input, "/exit");
      configurationDraftTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
    return { run: { state: "configuration_pending" }, tasks: [] };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(configurationDraftTerminal.input, "inspect remote machine");
configurationDraftTerminal.input.emit("keypress", undefined, { name: "return" });
await configurationDraftRun;
assert.equal(configurationDecision, "leave");
assert.match(configurationDraftTerminal.writes.join(""), /› inspect remote machine▌/);

const configurationScrollTerminal = fakeTerminal(80, 14);
let configurationScrollDecision;
const configurationScrollRun = handleAgentWorkspaceCommand([], {
  input: configurationScrollTerminal.input,
  output: configurationScrollTerminal.output,
  workspaceRunner: async (options) => {
    setImmediate(() => {
      for (let page = 0; page < 5; page += 1) {
        configurationScrollTerminal.input.emit("keypress", undefined, { sequence: "\x1b[6~" });
      }
      configurationScrollTerminal.input.emit("keypress", undefined, { name: "escape" });
    });
    configurationScrollDecision = await options.onConfigurationConfirmation({
      resolved_workspace_mode: "remote_ops",
      planning_source: "cloud_advice",
      risk_tier: "yellow",
      participants: [
        { participant_id: "coordinator", display_name: "Coordinator", runtime: "codex", device_id: "local-device", workspace_id: "local-workspace", permission_profile: "guarded", planner: true, role_hint: "Coordinate the inspection and consolidate the report." },
        { participant_id: "remote_operator", display_name: "Remote Operator", runtime: "claude", device_id: "remote-device-visible-after-scroll", workspace_id: "remote-workspace", permission_profile: "guarded", role_hint: "Inspect machine status and the installed CLI version without modifying the device." },
      ],
      auto_configuration: {
        advice: {
          reason: "The objective explicitly requires a remote read-only inspection. The remote operator must collect machine status, verify whether OriginRouter CLI is installed, and report its version while the coordinator reviews the evidence.",
        },
      },
    });
    setTimeout(() => {
      configurationScrollTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
      emitText(configurationScrollTerminal.input, "/exit");
      configurationScrollTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
    return { run: { state: "configuration_pending" }, tasks: [] };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(configurationScrollTerminal.input, "inspect remote machine");
configurationScrollTerminal.input.emit("keypress", undefined, { name: "return" });
await configurationScrollRun;
assert.equal(configurationScrollDecision, "leave");
assert.match(
  configurationScrollTerminal.writes.join(""),
  /remote-device-visible-after-scroll/,
  "macOS PageDown escape sequences scroll long configuration reviews",
);

const teamEditTerminal = fakeTerminal(90, 24);
let editedConfiguration;
let teamEditDecision;
const teamEditRun = handleAgentWorkspaceCommand([], {
  input: teamEditTerminal.input,
  output: teamEditTerminal.output,
  workspaceRunner: async (options) => {
    const configuration = {
      resolved_workspace_mode: "remote_ops",
      coordinator_runtime: "codex",
      planning_source: "cloud_advice",
      risk_tier: "yellow",
      participants: [{
        participant_id: "coordinator",
        display_name: "Coordinator",
        runtime: "codex",
        device_id: "local-device",
        workspace_id: "local-workspace",
        permission_profile: "guarded",
        planner: true,
      }],
      auto_configuration: { coordinator: "codex", runtimes: ["codex"] },
    };
    Object.defineProperty(configuration, "_workspace_editor", {
      enumerable: false,
      value: {
        devices: [{
          device_id: "local-device",
          device_name: "Local Mac",
          runtimes: [{ id: "codex" }, { id: "claude" }],
          resolved_routes: {
            codex: { provider: "official", model: "review-model" },
            claude: { provider: "official", model: "fast-model" },
          },
          providers: [{ name: "official", models: [{ id: "fast-model" }, { id: "review-model" }] }],
        }],
      },
    });
    setImmediate(() => {
      teamEditTerminal.input.emit("keypress", "e", { name: "e" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "return" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "down" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "return" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "down" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "return" });
      teamEditTerminal.input.emit("keypress", "p", { name: "p" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "down" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "return" });
      teamEditTerminal.input.emit("keypress", "d", { name: "d" });
      teamEditTerminal.input.emit("keypress", undefined, { name: "return" });
    });
    teamEditDecision = await options.onConfigurationConfirmation(configuration);
    editedConfiguration = configuration;
    setTimeout(() => teamEditTerminal.input.emit("keypress", undefined, { name: "return" }), 20);
    setTimeout(() => {
      emitText(teamEditTerminal.input, "/exit");
      teamEditTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 45);
    return { run: { state: "completed" }, tasks: [], final_report: { summary: "Done." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(teamEditTerminal.input, "inspect remote machine");
teamEditTerminal.input.emit("keypress", undefined, { name: "return" });
await teamEditRun;
assert.equal(teamEditDecision, "confirm");
assert.equal(editedConfiguration.participants[0].runtime, "claude");
assert.equal(editedConfiguration.participants[0].provider, "official");
assert.equal(editedConfiguration.participants[0].model, "fast-model");
assert.equal(editedConfiguration.participants[0].permission_profile, "unrestricted");
assert.equal(editedConfiguration.coordinator_runtime, "claude");
assert.equal(editedConfiguration.auto_configuration.coordinator, "claude");
assert.deepEqual(editedConfiguration.auto_configuration.runtimes, ["claude"]);
assert.match(teamEditTerminal.writes.join(""), /Edit collaboration team/);
assert.match(teamEditTerminal.writes.join(""), /Done editing · return to team review/);
assert.match(teamEditTerminal.writes.join(""), /Review the updated team, then press Enter to continue/);
assert.match(teamEditTerminal.writes.join(""), /Choose the Agent Runtime/);
assert.match(teamEditTerminal.writes.join(""), /Choose the model route/);
assert.match(teamEditTerminal.writes.join(""), /Choose this Agent's access policy/);

const planRevisionTerminal = fakeTerminal();
let planDecision;
const planRevisionRun = handleAgentWorkspaceCommand([], {
  input: planRevisionTerminal.input,
  output: planRevisionTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_plan_revision");
    setImmediate(() => {
      planRevisionTerminal.input.emit("keypress", "e", { name: "e" });
      emitText(planRevisionTerminal.input, "keep the remote task read-only");
      planRevisionTerminal.input.emit("keypress", undefined, { name: "return" });
    });
    planDecision = await options.onPlanConfirmation({
      run: { run_id: "acr_plan_revision", state: "awaiting_confirmation" },
      plan: { title: "Inspect remote device", summary: "Inspect status.", tasks: [] },
      tasks: [],
    });
    setTimeout(() => planRevisionTerminal.input.emit("keypress", undefined, { name: "return" }), 20);
    setTimeout(() => {
      emitText(planRevisionTerminal.input, "/exit");
      planRevisionTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 45);
    return { run: { run_id: "acr_plan_revision", state: "completed" }, tasks: [], final_report: { summary: "Done." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(planRevisionTerminal.input, "inspect remote machine");
planRevisionTerminal.input.emit("keypress", undefined, { name: "return" });
await planRevisionRun;
assert.deepEqual(planDecision, { action: "revise", feedback: "keep the remote task read-only" });
assert.match(planRevisionTerminal.writes.join(""), /What should the Planner change/);

const attentionReplyTerminal = fakeTerminal();
let attentionDecision;
const attentionReplyRun = handleAgentWorkspaceCommand([], {
  input: attentionReplyTerminal.input,
  output: attentionReplyTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_attention_reply");
    setImmediate(() => {
      attentionReplyTerminal.input.emit("keypress", undefined, { name: "escape" });
      attentionReplyTerminal.input.emit("keypress", undefined, { name: "return" });
      emitText(attentionReplyTerminal.input, "only inspect version and service status");
      attentionReplyTerminal.input.emit("keypress", undefined, { name: "return" });
    });
    attentionDecision = await options.onAttention({
      attention_id: "attention-input",
      revision: 1,
      kind: "input",
      title: "What should the remote Agent inspect?",
      summary: "The Agent needs a precise read-only scope.",
      actions: ["submit", "cancel"],
    }, {
      run: { run_id: "acr_attention_reply", state: "blocked" },
      tasks: [],
    });
    setTimeout(() => attentionReplyTerminal.input.emit("keypress", undefined, { name: "return" }), 20);
    setTimeout(() => {
      emitText(attentionReplyTerminal.input, "/exit");
      attentionReplyTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 45);
    return { run: { run_id: "acr_attention_reply", state: "completed" }, tasks: [], final_report: { summary: "Done." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(attentionReplyTerminal.input, "inspect remote machine");
attentionReplyTerminal.input.emit("keypress", undefined, { name: "return" });
await attentionReplyRun;
assert.deepEqual(attentionDecision, {
  action: "submit",
  response: { text: "only inspect version and service status" },
});
assert.match(attentionReplyTerminal.writes.join(""), /What should the remote Agent inspect/);
assert.match(attentionReplyTerminal.writes.join(""), /Reply to the Agent/);
assert.match(attentionReplyTerminal.writes.join(""), /still waiting for a decision/);

const activeReturnTerminal = fakeTerminal();
let followCalls = 0;
const activeReturnRun = handleAgentWorkspaceCommand([], {
  input: activeReturnTerminal.input,
  output: activeReturnTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_active_return");
    options.onUpdate?.({
      type: "snapshot",
      snapshot: {
        run: { run_id: "acr_active_return", state: "running", phase: "execution" },
        tasks: [{ task_key: "inspect", title: "Inspect remote machine", state: "running" }],
      },
      events: [],
    });
    return {
      run: { run_id: "acr_active_return", state: "running", phase: "execution" },
      tasks: [{ task_key: "inspect", title: "Inspect remote machine", state: "running" }],
    };
  },
  followRunner: async (runId, options) => {
    followCalls += 1;
    assert.equal(runId, "acr_active_return");
    const snapshot = {
      run: { run_id: runId, state: "completed", phase: "completed" },
      tasks: [{ task_key: "inspect", title: "Inspect remote machine", state: "completed" }],
      final_report: { summary: "Recovered follow completed." },
    };
    options.onUpdate?.({ type: "snapshot", snapshot, events: [] });
    return snapshot;
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(activeReturnTerminal.input, "inspect remote machine");
activeReturnTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => activeReturnTerminal.input.emit("keypress", undefined, { name: "return" }), 20);
setTimeout(() => {
  emitText(activeReturnTerminal.input, "/exit");
  activeReturnTerminal.input.emit("keypress", undefined, { name: "return" });
}, 45);
await activeReturnRun;
assert.equal(followCalls, 1, "an active snapshot is followed again instead of returning to the home screen");
assert.match(activeReturnTerminal.writes.join(""), /restoring the live connection/);
assert.match(activeReturnTerminal.writes.join(""), /Recovered follow completed/);

const completedFollowupTerminal = fakeTerminal(100, 30);
const completedFollowupCalls = [];
const continuedTeamConfiguration = {
  objective: "inspect remote machine",
  resolved_workspace_mode: "remote_ops",
  planning_source: "cloud_advice",
  risk_tier: "yellow",
  workflow_template_id: "remote_operations",
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
    safe_to_skip_confirmation: false,
  },
};
const completedFollowupRun = handleAgentWorkspaceCommand([], {
  input: completedFollowupTerminal.input,
  output: completedFollowupTerminal.output,
  workspaceRunner: async (options) => {
    completedFollowupCalls.push(options);
    const index = completedFollowupCalls.length;
    const runId = index === 1 ? "acr_completed_first" : "acr_completed_followup";
    options.onRunId?.(runId);
    options.onUpdate?.({ type: "configuration", payload: continuedTeamConfiguration });
    return {
      run: { run_id: runId, state: "completed" },
      tasks: [{
        task_key: "inspect",
        title: "Inspect remote machine",
        state: "completed",
        result_summary: index === 1 ? "Full first result remains visible." : "Follow-up completed.",
      }],
      final_report: {
        summary: index === 1 ? "Full first result remains visible." : "Follow-up completed.",
        completed_tasks: [{ result: index === 1 ? "Detailed first result." : "Detailed follow-up result." }],
      },
    };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(completedFollowupTerminal.input, "inspect remote machine");
completedFollowupTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => {
  emitText(completedFollowupTerminal.input, "also check the service status");
  completedFollowupTerminal.input.emit("keypress", undefined, { name: "return" });
}, 15);
setTimeout(() => {
  emitText(completedFollowupTerminal.input, "/exit");
  completedFollowupTerminal.input.emit("keypress", undefined, { name: "return" });
}, 45);
await completedFollowupRun;
assert.equal(completedFollowupCalls.length, 2);
assert.equal(completedFollowupCalls[1].continuedFromRunId, "acr_completed_first");
assert.deepEqual(completedFollowupCalls[1].presetConfiguration, continuedTeamConfiguration);
assert.notEqual(completedFollowupCalls[1].presetConfiguration, continuedTeamConfiguration);
assert.match(completedFollowupTerminal.writes.join(""), /Full first result remains visible/);
assert.match(completedFollowupTerminal.writes.join(""), /Enter continues with this team/);

const reconnectResumeTerminal = fakeTerminal();
let reconnectResumeCreates = 0;
let reconnectResumeFollows = 0;
const reconnectResumeRun = handleAgentWorkspaceCommand([], {
  input: reconnectResumeTerminal.input,
  output: reconnectResumeTerminal.output,
  workspaceRunner: async (options) => {
    reconnectResumeCreates += 1;
    options.onRunId?.("acr_reconnect_resume");
    options.onUpdate?.({
      type: "snapshot",
      snapshot: {
        run: { run_id: "acr_reconnect_resume", state: "running" },
        tasks: [{ task_key: "inspect", title: "Inspect remote machine", state: "running" }],
      },
      events: [{ sequence: 1, summary: "Remote inspection started" }],
    });
    const error = new Error("connection retries exhausted");
    error.code = "COLLABORATION_FOLLOW_RECONNECT_EXHAUSTED";
    throw error;
  },
  followRunner: async (runId, options) => {
    reconnectResumeFollows += 1;
    assert.equal(runId, "acr_reconnect_resume");
    const snapshot = {
      run: { run_id: runId, state: "completed" },
      tasks: [{ task_key: "inspect", title: "Inspect remote machine", state: "completed" }],
      final_report: { summary: "Reconnected to the preserved Run." },
    };
    options.onUpdate?.({ type: "snapshot", snapshot, events: [] });
    return snapshot;
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(reconnectResumeTerminal.input, "inspect remote machine");
reconnectResumeTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => reconnectResumeTerminal.input.emit("keypress", undefined, { name: "return" }), 15);
setTimeout(() => reconnectResumeTerminal.input.emit("keypress", undefined, { name: "return" }), 35);
setTimeout(() => {
  emitText(reconnectResumeTerminal.input, "/exit");
  reconnectResumeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 60);
await reconnectResumeRun;
assert.equal(reconnectResumeCreates, 1, "manual recovery must not create a replacement Run");
assert.equal(reconnectResumeFollows, 1);
assert.match(reconnectResumeTerminal.writes.join(""), /Connection paused/);
assert.match(reconnectResumeTerminal.writes.join(""), /Reconnected to the preserved Run/);

const reconnectDetachTerminal = fakeTerminal();
let reconnectDetachCreates = 0;
let reconnectDetachFollows = 0;
const reconnectDetachCancelled = [];
const reconnectDetachRun = handleAgentWorkspaceCommand([], {
  input: reconnectDetachTerminal.input,
  output: reconnectDetachTerminal.output,
  workspaceRunner: async (options) => {
    reconnectDetachCreates += 1;
    options.onRunId?.("acr_reconnect_detach");
    const error = new Error("connection retries exhausted");
    error.code = "COLLABORATION_FOLLOW_RECONNECT_EXHAUSTED";
    throw error;
  },
  followRunner: async (runId) => {
    reconnectDetachFollows += 1;
    assert.equal(runId, "acr_reconnect_detach");
    const error = new Error("connection retries exhausted again");
    error.code = "COLLABORATION_FOLLOW_RECONNECT_EXHAUSTED";
    throw error;
  },
  cancelCollaborationRun: async (runId) => reconnectDetachCancelled.push(runId),
});
await new Promise((resolve) => setImmediate(resolve));
emitText(reconnectDetachTerminal.input, "inspect remote machine");
reconnectDetachTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => reconnectDetachTerminal.input.emit("keypress", undefined, { name: "return" }), 15);
setTimeout(() => reconnectDetachTerminal.input.emit("keypress", "d", { name: "d" }), 35);
setTimeout(() => {
  emitText(reconnectDetachTerminal.input, "/exit");
  reconnectDetachTerminal.input.emit("keypress", undefined, { name: "return" });
}, 60);
await reconnectDetachRun;
assert.equal(reconnectDetachCreates, 1, "repeated manual failures must not recreate the Run");
assert.equal(reconnectDetachFollows, 1);
assert.deepEqual(reconnectDetachCancelled, [], "detaching must not cancel the Run");
assert.match(reconnectDetachTerminal.writes.join(""), /Collaboration continues in the service/);

const reconnectInterruptTerminal = fakeTerminal();
const reconnectInterruptCancelled = [];
const reconnectInterruptRun = handleAgentWorkspaceCommand([], {
  input: reconnectInterruptTerminal.input,
  output: reconnectInterruptTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_reconnect_interrupt");
    const error = new Error("connection retries exhausted");
    error.code = "COLLABORATION_FOLLOW_RECONNECT_EXHAUSTED";
    throw error;
  },
  cancelCollaborationRun: async (runId) => reconnectInterruptCancelled.push(runId),
});
await new Promise((resolve) => setImmediate(resolve));
emitText(reconnectInterruptTerminal.input, "inspect remote machine");
reconnectInterruptTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => reconnectInterruptTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" }), 15);
setTimeout(() => {
  emitText(reconnectInterruptTerminal.input, "/exit");
  reconnectInterruptTerminal.input.emit("keypress", undefined, { name: "return" });
}, 40);
await reconnectInterruptRun;
assert.deepEqual(reconnectInterruptCancelled, ["acr_reconnect_interrupt"]);
assert.match(reconnectInterruptTerminal.writes.join(""), /Interrupting the collaboration/);

const pausedTerminal = fakeTerminal();
let pausedDecision;
const pausedRun = handleAgentWorkspaceCommand([], {
  input: pausedTerminal.input,
  output: pausedTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_paused");
    setImmediate(() => pausedTerminal.input.emit("keypress", undefined, { name: "return" }));
    pausedDecision = await options.onPaused({
      run: { run_id: "acr_paused", state: "paused", pause_reason: "Waiting for the remote device." },
      tasks: [],
    });
    setTimeout(() => pausedTerminal.input.emit("keypress", undefined, { name: "return" }), 20);
    setTimeout(() => {
      emitText(pausedTerminal.input, "/exit");
      pausedTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 45);
    return { run: { run_id: "acr_paused", state: "completed" }, tasks: [], final_report: { summary: "Done." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(pausedTerminal.input, "inspect remote machine");
pausedTerminal.input.emit("keypress", undefined, { name: "return" });
await pausedRun;
assert.equal(pausedDecision, "resume");
assert.match(pausedTerminal.writes.join(""), /Waiting for the remote device/);
assert.match(pausedTerminal.writes.join(""), /Resume this collaboration/);

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
assert.match(runtimeScreen.replace(/\x1b\[[0-9;]*m/g, ""), /\n› Inspect the remote computer/);
const plainRuntimeScreen = runtimeScreen.replace(/\x1b\[[0-9;]*m/g, "");
assert.match(plainRuntimeScreen, /\n⠋ Agents are working/);
assert.match(plainRuntimeScreen, /\n  Remote Ops · 2 Agents · 2 devices/);
assert.match(plainRuntimeScreen, /\n  Run acr_runtime/);
assert.match(plainRuntimeScreen, /\n  ● Inspect remote status/);

const scrollRuntime = {
  contentLineCount: 30,
  contentVisibleRows: 10,
  autoFollow: true,
  scrollOffset: 0,
  unseenActivityCount: 0,
};
assert.equal(scrollRuntimeContent(scrollRuntime, -1, 6), true);
assert.equal(scrollRuntime.autoFollow, false, "PageUp stops following the live tail");
assert.equal(scrollRuntime.scrollOffset, 14);
scrollRuntime.unseenActivityCount = 3;
scrollRuntime.contentLineCount = 34;
assert.equal(scrollRuntime.scrollOffset, 14, "new activity does not move a detached viewport");
assert.equal(scrollRuntimeContent(scrollRuntime, 1, 20), true);
assert.equal(scrollRuntime.autoFollow, true, "PageDown at the bottom resumes live following");
assert.equal(scrollRuntime.unseenActivityCount, 0);

const interactionScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "needs_setup",
    mode: "auto",
    startedAt: Date.now(),
    interaction: true,
    interactionKind: "setup",
    setupPath: "/Users/chengaoyan",
    setup: { default_path: "/Users/chengaoyan" },
    composerBuffer: "queued objective is preserved",
    snapshot: { run: { state: "running" }, tasks: [] },
  },
});
assert.match(interactionScreen, /\? Enter a folder path to authorize/);
assert.match(interactionScreen, /Enter authorize/);
assert.doesNotMatch(interactionScreen, /undefined is online/);

const emptyPathScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "needs_setup",
    mode: "auto",
    interaction: true,
    interactionKind: "setup",
    setupPath: "",
    setupCursor: 0,
    setup: { default_path: "/Users/chengaoyan", device_name: "Remote Mac mini" },
    snapshot: { run: { state: "running" }, tasks: [] },
  },
});
assert.match(emptyPathScreen, /› ▌/);
assert.match(emptyPathScreen, /example: \/Users\/chengaoyan/);
assert.doesNotMatch(emptyPathScreen, /Path  \/Users\/chengaoyan/);
assert.doesNotMatch(interactionScreen, /queued objective is preserved/);

const deviceSelectionScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 28,
  runtime: {
    objective: "Inspect the remote computers",
    phase: "needs_device",
    mode: "auto",
    interaction: true,
    interactionKind: "device",
    deviceSelection: 1,
    deviceSelections: ["server-a"],
    setup: {
      kind: "device_selection",
      devices: [
        { device_id: "server-a", device_name: "Server A", online: true, runtimes: ["codex", "claude"], workspace_count: 2 },
        { device_id: "server-b", device_name: "Server B", online: false, runtimes: ["claude"], workspace_count: 1 },
      ],
    },
  },
});
assert.match(deviceSelectionScreen, /Choose remote devices/);
assert.match(deviceSelectionScreen, /\[✓\] Server A/);
assert.match(deviceSelectionScreen, /› \[ \] Server B/);
assert.match(deviceSelectionScreen, /Space toggle/);
assert.match(deviceSelectionScreen, /1 selected/);

const pathSuggestionScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 28,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "needs_setup",
    mode: "auto",
    interaction: true,
    interactionKind: "setup",
    setupMode: "path",
    setupPath: "/Users/cheng",
    setupCursor: 12,
    setupSuggestionSelection: 1,
    setupSuggestions: [
      { name: "cheng", path: "/Users/cheng" },
      { name: "chengaoyan", path: "/Users/chengaoyan" },
    ],
    setup: { device_name: "Remote Mac mini", device_id: "remote-device", remote: true },
  },
});
assert.match(pathSuggestionScreen, /Matching folders/);
assert.match(pathSuggestionScreen, /› \/Users\/chengaoyan/);
assert.match(pathSuggestionScreen, /Tab completes the selected folder/);
assert.match(pathSuggestionScreen, /Tab completes · ↑\/↓ suggestions/);

const manyWorkspaceScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 100,
  rows: 30,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "needs_setup",
    interaction: true,
    interactionKind: "workspace",
    setupSelection: 7,
    setup: {
      device_name: "Remote Mac mini",
      workspaces: Array.from({ length: 10 }, (_, index) => ({
        workspace_id: `workspace-${index + 1}`,
        display_name: `Workspace ${index + 1}`,
        canonical_path: `/Users/chengaoyan/project-${index + 1}`,
      })),
    },
  },
});
assert.match(manyWorkspaceScreen, /Workspace 8/);
assert.match(manyWorkspaceScreen, /Workspace 10/);
assert.doesNotMatch(manyWorkspaceScreen, /Workspace 1  \/Users\/chengaoyan\/project-1/);
assert.match(manyWorkspaceScreen, /P\. Other folder · enter a path not listed above/);
assert.match(manyWorkspaceScreen, /Choose a listed folder, or enter another folder path/);
assert.match(manyWorkspaceScreen, /P or typing enters a folder not listed/);

const reconnectingScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "reconnecting",
    startedAt: Date.now() - 2200,
    connectionAttempts: 2,
    snapshot: { run: { state: "running" }, tasks: [] },
  },
});
assert.match(reconnectingScreen, /Reconnecting to the collaboration/);
assert.match(reconnectingScreen, /Connection interrupted · retry 2\/5/);
assert.match(reconnectingScreen, /retrying automatically/);

const connectionPausedScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 26,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "connection_paused",
    runId: "acr_connection_paused",
    connectionAttempts: 5,
    interaction: true,
    interactionKind: "reconnect",
    snapshot: {
      run: { run_id: "acr_connection_paused", state: "running" },
      tasks: [{ task_key: "inspect", title: "Inspect remote machine", state: "running" }],
    },
  },
});
assert.match(connectionPausedScreen, /Connection paused/);
assert.match(connectionPausedScreen, /OriginRouter service still owns this Run/);
assert.match(connectionPausedScreen, /No new Run will be created/);
assert.match(connectionPausedScreen, /Enter reconnect · D detach · Ctrl\+C interrupt Run/);

const spinnerFrameA = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "configuring",
    animationFrame: 0,
    snapshot: { run: { state: "created" }, tasks: [] },
  },
});
const spinnerFrameB = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "configuring",
    animationFrame: 1,
    snapshot: { run: { state: "created" }, tasks: [] },
  },
});
assert.match(spinnerFrameA, /⠋ Choosing the Agent team/);
assert.match(spinnerFrameB, /⠙ Choosing the Agent team/);

const configurationReviewScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "awaiting_configuration",
    startedAt: Date.now() - 245_000,
    interaction: true,
    interactionKind: "configuration",
    configuration: {
      resolved_workspace_mode: "remote_ops",
      planning_source: "cloud_advice",
      risk_tier: "yellow",
      auto_configuration: { advice: { reason: "A remote operator is required." } },
      participants: [
        { participant_id: "coordinator", display_name: "Coordinator", runtime: "codex", device_id: "local", workspace_id: "local-workspace", permission_profile: "guarded", planner: true, role_hint: "Coordinate the inspection." },
        { participant_id: "remote_operator", display_name: "Remote Operator", runtime: "claude", device_id: "remote", workspace_id: "remote-workspace", permission_profile: "guarded", role_hint: "Inspect the remote machine." },
      ],
    },
  },
});
assert.match(configurationReviewScreen, /Proposed collaboration team/);
assert.match(configurationReviewScreen, /A remote operator is required/);
assert.match(configurationReviewScreen, /Remote Operator · Claude Code/);
assert.match(configurationReviewScreen, /Esc return to objective/);
assert.match(configurationReviewScreen, /● Review the proposed team/);
assert.doesNotMatch(configurationReviewScreen, /Review the proposed team \(4m/);
const plainConfigurationReview = configurationReviewScreen.replace(/\x1b\[[0-9;]*m/g, "");
assert.match(plainConfigurationReview, /\nProposed collaboration team/);
assert.match(plainConfigurationReview, /\n  A remote operator is required/);
assert.match(plainConfigurationReview, /\n  ● Coordinator · Codex/);
assert.match(plainConfigurationReview, /\n    local · local-workspace · Agent limit: Guarded/);
assert.match(plainConfigurationReview, /Session approval Guarded/);
assert.equal(configurationReviewScreen.split("\n").length <= 24, true, "interaction layout fits the terminal height");

const planReviewScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "awaiting_confirmation",
    interaction: true,
    interactionKind: "plan",
    snapshot: {
      run: { state: "awaiting_confirmation" },
      plan: {
        title: "Inspect the remote Mac",
        summary: "Collect machine and CLI status without changing the device.",
        tasks: [{ id: "inspect", title: "Collect machine status", participant_id: "remote_operator", deliverable: "Version and health report", depends_on: [] }],
      },
      tasks: [],
    },
  },
});
assert.match(planReviewScreen, /Inspect the remote Mac/);
assert.match(planReviewScreen, /Collect machine status · remote_operator/);
assert.match(planReviewScreen, /E request changes/);
assert.equal(planReviewScreen.split("\n").length <= 24, true, "plan review layout fits the terminal height");

const attentionScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "blocked",
    interaction: true,
    interactionKind: "attention",
    attentionSelection: 1,
    attention: {
      kind: "approval",
      title: "Allow a read-only command?",
      summary: "The remote operator wants to inspect system status.",
      risk: "low",
      actions: ["allow", "deny"],
    },
    snapshot: { run: { state: "blocked" }, tasks: [] },
  },
});
assert.match(attentionScreen, /Allow a read-only command/);
assert.match(attentionScreen, /› 2\. Deny/);
assert.match(attentionScreen, /Agent needs your decision/);
assert.equal(attentionScreen.split("\n").length <= 24, true, "attention layout fits the terminal height");

const narrowScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 40,
  rows: 12,
  runtime: {
    objective: "Inspect remote status",
    phase: "executing",
    animationFrame: 2,
    snapshot: { run: { state: "running" }, tasks: [] },
  },
});
const narrowPlainLines = narrowScreen
  .replace(/\x1b\[[0-9;]*m/g, "")
  .split("\n");
assert.equal(narrowPlainLines.length <= 12, true, "narrow runtime fits the terminal height");
assert.equal(narrowPlainLines.every((line) => [...line].length <= 40), true, "narrow runtime never exceeds terminal width");

console.log("agent workspace tests passed");
