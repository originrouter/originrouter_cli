import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildWorkspaceAppScreen,
  consumeWorkspaceMouseKeypress,
  createWorkspaceFrameScheduler,
  handleAgentWorkspaceCommand,
  normalizeWorkspacePathInput,
  parseAgentWorkspaceArgs,
  redrawPrompt,
  scrollRuntimeContent,
  workspaceSelectionText,
  workspaceInteractionSurface,
} from "../src/commands/agentWorkspace.js";
import {
  completeWorkspaceCommandInput,
  findWorkspaceCommand,
  parseWorkspaceCommand,
  workspaceInputSuggestions,
  workspaceCommandSuggestions,
  workspaceCommandUsage,
} from "../src/commands/workspaceCommands.js";
import {
  listAgentWorkspaceCollaborationRuns,
  resolveAgentWorkspaceSession,
} from "../src/commands/collaboration.js";
import {
  inferWorkspaceMode,
  nextWorkspaceMode,
  normalizeWorkspaceMode,
  objectiveMentionsRemoteTarget,
  workspaceRequiresPlanReview,
} from "../src/collaboration/workspaceModes.js";

assert.deepEqual(
  parseAgentWorkspaceArgs(["-c", "claude", "--mode", "build-review", "fix", "login"]),
  { coordinator: "claude", mode: "build_review", objective: "fix login", forwarded: [] },
);
assert.deepEqual(
  parseAgentWorkspaceArgs(["--timeout=120", "review", "the", "rollout"]),
  {
    coordinator: "codex",
    mode: "auto",
    objective: "review the rollout",
    forwarded: ["--timeout", "120"],
  },
);
assert.throws(
  () => parseAgentWorkspaceArgs(["--yes", "--review", "inspect", "the", "workspace"]),
  /cannot be used together/,
);
assert.equal(normalizeWorkspaceMode("plan"), "plan_build_verify");
assert.equal(nextWorkspaceMode("auto").id, "solo");
assert.equal(inferWorkspaceMode("explain the authentication flow"), "solo");
assert.equal(inferWorkspaceMode("fix the authentication race and add tests"), "build_review");
assert.equal(inferWorkspaceMode("check service status on server A"), "remote_ops");
assert.equal(workspaceRequiresPlanReview("deploy to production", "auto"), true);
assert.equal(workspaceRequiresPlanReview("check service status on server A", "auto"), true);
assert.equal(workspaceRequiresPlanReview("check service status on server A", "remote-ops"), true);
assert.equal(objectiveMentionsRemoteTarget("我想分析一下我远程电脑的状态"), true);
assert.equal(objectiveMentionsRemoteTarget("explain this local module"), false);
assert.equal(normalizeWorkspacePathInput('  "/Users/chengaoyan/Desktop/originrouter-cli"  '), "/Users/chengaoyan/Desktop/originrouter-cli");
assert.equal(normalizeWorkspacePathInput(" '/Users/chengaoyan/project'\n"), "/Users/chengaoyan/project");
assert.equal(workspaceInteractionSurface({ interaction: false }), "normal");
assert.equal(workspaceInteractionSurface({ interaction: true, interactionKind: "configuration" }), "focused");
assert.equal(workspaceInteractionSurface({ interaction: true, interactionKind: "live_workspace_mode" }), "inline");
assert.equal(workspaceInteractionSurface({ interaction: true, interactionKind: "paused" }), "inline");
assert.equal(workspaceInteractionSurface({
  interaction: true,
  interactionKind: "attention",
  attention: { actions: ["allow", "deny"], payload: { request: { command: "pwd" } } },
}, 100, 30), "inline");
assert.equal(workspaceInteractionSurface({
  interaction: true,
  interactionKind: "attention",
  attention: { actions: ["allow", "deny"], payload: { request: { command: "x".repeat(400) } } },
}, 100, 30), "focused");
assert.equal(workspaceInteractionSurface({
  interaction: true,
  interactionKind: "attention",
  interactionSurface: "inline",
  attention: { actions: ["allow", "deny"], payload: { request: { command: "x".repeat(400) } } },
}, 40, 10), "inline", "an open interaction keeps its surface across terminal resizes");
assert.equal(findWorkspaceCommand("/resume")?.name, "resume");
assert.equal(findWorkspaceCommand("run")?.name, "runs");
assert.equal(workspaceCommandUsage(findWorkspaceCommand("agents")), "/agents [run-id]");
assert.deepEqual(parseWorkspaceCommand("/resume aws_123"), {
  rawName: "resume",
  command: findWorkspaceCommand("resume"),
  args: ["aws_123"],
  argumentText: "aws_123",
});
assert.deepEqual(
  workspaceCommandSuggestions("/res").map((command) => command.name),
  ["resume"],
);
assert.deepEqual(
  workspaceInputSuggestions("/res").map((suggestion) => suggestion.value),
  ["/resume "],
);
assert.deepEqual(
  workspaceInputSuggestions("/mode re").map((suggestion) => suggestion.value),
  ["/mode review_panel", "/mode remote_ops"],
);
assert.deepEqual(
  workspaceInputSuggestions("/approval ai").map((suggestion) => suggestion.value),
  ["/approval ai_review"],
);
assert.deepEqual(
  workspaceInputSuggestions("/attach acr_", { runIds: ["acr_live", "run_elsewhere"] })
    .map((suggestion) => suggestion.value),
  ["/attach acr_live"],
);
assert.deepEqual(
  workspaceInputSuggestions("/resume aws_", { sessionIds: ["aws_session", "acr_not_a_session"] })
    .map((suggestion) => suggestion.value),
  ["/resume aws_session"],
);
await assert.rejects(
  resolveAgentWorkspaceSession("acr_old_run", { requestFn: async () => ({}) }),
  /Run IDs cannot be resumed/,
);
assert.equal(
  completeWorkspaceCommandInput("/mode re", { selection: 1 })?.value,
  "/mode remote_ops",
);
assert.equal(
  completeWorkspaceCommandInput("/can")?.value,
  "/cancel ",
);
assert.equal(parseWorkspaceCommand("/can")?.command, null);
assert.equal(parseWorkspaceCommand("explain this module"), null);
let runListPath = "";
const activeRunPage = await listAgentWorkspaceCollaborationRuns({
  category: "active",
  limit: 7,
  requestFn: async (path) => {
    runListPath = path;
    return { runs: [{ run_id: "acr_active" }], total: 1 };
  },
});
assert.match(runListPath, /category=active/);
assert.match(runListPath, /page_size=7/);
assert.deepEqual(activeRunPage, {
  category: "active",
  runs: [{ run_id: "acr_active" }],
  total: 1,
});
await assert.rejects(
  () => listAgentWorkspaceCollaborationRuns({ category: "invalid" }),
  /Run category must be all, attention, active, or recent/,
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
assert.doesNotMatch(workspaceScreen, /● Working/);
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
assert.match(inputScreen, /Tab completes · ↑\/↓ select · Enter submits · Esc hides · Ctrl\+C clears/);

const commandCompletionScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 100,
  rows: 26,
  composerBuffer: "/mode r",
  composerCursor: 7,
  commandSuggestions: workspaceInputSuggestions("/mode r"),
  commandSuggestionSelection: 1,
});
assert.match(commandCompletionScreen, /review_panel - Compare independent proposals/);
assert.match(
  commandCompletionScreen.replace(/\x1b\[[0-9;]*m/g, ""),
  /› remote_ops - Coordinate a trusted remote device/,
);

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
assert.match(wrappedInputScreen, /Tab completes · ↑\/↓ select · Enter submits · Esc hides · Ctrl\+C clears/);

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
assert.match(writes.join(""), /Auto · shift\+tab approval · \/mode changes team/);
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

const commandTerminal = fakeTerminal();
const commandLists = [];
const commandControls = [];
const resumedRuns = [];
const listedRun = {
  run_id: "acr_workspace_command",
  state: "running",
  objective: "Inspect the release configuration",
  tasks: [{ task_key: "inspect", state: "completed" }, { task_key: "verify", state: "running" }],
  agents: {
    coordinator: {
      participant_id: "coordinator",
      display_name: "Coordinator",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5-codex",
    },
  },
};
const commandRun = handleAgentWorkspaceCommand([], {
  input: commandTerminal.input,
  output: commandTerminal.output,
  listCollaborationRuns: async (options) => {
    commandLists.push(options);
    return { category: options.category, runs: [listedRun], total: 1 };
  },
  resolveWorkspaceSession: async (sessionId) => {
    assert.equal(sessionId, "aws_workspace_command");
    return { latestRunId: "acr_workspace_command", session: { workspace_session_id: sessionId } };
  },
  controlCollaborationRunFn: async (runId, action) => {
    commandControls.push({ runId, action });
    return { ...listedRun, run_id: runId, state: action === "pause" ? "paused" : "cancelled" };
  },
  followRunner: async (runId) => {
    resumedRuns.push(runId);
    setTimeout(() => {
      emitText(commandTerminal.input, "/exit");
      commandTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
    return { run: { ...listedRun, run_id: runId, state: "completed" }, tasks: listedRun.tasks, final_report: { summary: "Inspection complete." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(commandTerminal.input, "/runs active");
commandTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
emitText(commandTerminal.input, "/agents acr_workspace_command");
commandTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
emitText(commandTerminal.input, "/pause acr_workspace_command");
commandTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
emitText(commandTerminal.input, "/resume aws_workspace_command");
commandTerminal.input.emit("keypress", undefined, { name: "return" });
await commandRun;
assert.deepEqual(commandLists.map((call) => call.category), ["active"]);
assert.deepEqual(commandControls, [{ runId: "acr_workspace_command", action: "pause" }]);
assert.deepEqual(resumedRuns, ["acr_workspace_command"]);
assert.match(commandTerminal.writes.join(""), /Active Runs/);
assert.match(commandTerminal.writes.join(""), /Run Agents/);
assert.match(commandTerminal.writes.join(""), /Collaboration paused/);

const resumePickerTerminal = fakeTerminal();
const resumedPickerSessionIds = [];
const resumedPickerRunIds = [];
const resumePickerRun = handleAgentWorkspaceCommand([], {
  input: resumePickerTerminal.input,
  output: resumePickerTerminal.output,
  listCollaborationRuns: async ({ category }) => {
    assert.equal(category, "recent");
    return {
      category,
      total: 2,
      runs: [
        {
          run_id: "acr_picker_newer",
          workspace_session_id: "aws_picker_newer",
          state: "completed",
          objective: "Inspect the newest Workspace Session",
          tasks: [],
        },
        {
          run_id: "acr_picker_older",
          workspace_session_id: "aws_picker_older",
          state: "completed",
          objective: "Inspect the older Workspace Session",
          tasks: [],
        },
      ],
    };
  },
  resolveWorkspaceSession: async (sessionId) => {
    resumedPickerSessionIds.push(sessionId);
    return { latestRunId: sessionId === "aws_picker_older" ? "acr_picker_older" : "acr_picker_newer" };
  },
  followRunner: async (runId) => {
    resumedPickerRunIds.push(runId);
    setTimeout(() => {
      emitText(resumePickerTerminal.input, "/exit");
      resumePickerTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
    return { run: { run_id: runId, state: "completed" }, tasks: [], final_report: { summary: "Restored from picker." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(resumePickerTerminal.input, "/res");
resumePickerTerminal.input.emit("keypress", undefined, { name: "tab" });
resumePickerTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
resumePickerTerminal.input.emit("keypress", undefined, { name: "down" });
resumePickerTerminal.input.emit("keypress", undefined, { name: "return" });
await resumePickerRun;
assert.deepEqual(resumedPickerSessionIds, ["aws_picker_older"]);
assert.deepEqual(resumedPickerRunIds, ["acr_picker_older"]);
assert.match(resumePickerTerminal.writes.join(""), /Resume a Workspace Session/);
assert.match(resumePickerTerminal.writes.join(""), /Choose a Workspace Session to restore/);

const resumedSessionTerminal = fakeTerminal(100, 30);
const resumedSessionStarts = [];
const resumedSessionRun = handleAgentWorkspaceCommand([], {
  input: resumedSessionTerminal.input,
  output: resumedSessionTerminal.output,
  followRunner: async (runId) => ({
    run: {
      run_id: runId,
      state: "completed",
      workspace_mode: "remote_ops",
      resolved_workspace_mode: "remote_ops",
      coordinator_runtime: "codex",
      workflow_template_id: "adaptive",
      supervisor_permission_profile: "guarded",
      budget: { max_concurrency: 1 },
    },
    participants: [{
      participant_id: "remote_operator",
      display_name: "Remote Operator",
      runtime: "claude",
      device_id: "remote-device",
      workspace_id: "remote-workspace",
      permission_profile: "guarded",
      native_session_id: "native-remote",
      conversation_id: "conversation-remote",
      planner: true,
    }],
    tasks: [],
    final_report: { summary: "The restored Run completed." },
  }),
  resolveWorkspaceSession: async (sessionId) => {
    assert.equal(sessionId, "aws_restored");
    return { latestRunId: "acr_restored", session: { workspace_session_id: sessionId } };
  },
  workspaceRunner: async (options) => {
    resumedSessionStarts.push(options);
    options.onRunId?.("acr_resumed_followup");
    return { run: { run_id: "acr_resumed_followup", state: "completed" }, tasks: [], final_report: { summary: "Follow-up complete." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(resumedSessionTerminal.input, "/resume aws_restored");
resumedSessionTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => {
  emitText(resumedSessionTerminal.input, "check the newly requested service");
  resumedSessionTerminal.input.emit("keypress", undefined, { name: "return" });
}, 15);
setTimeout(() => {
  emitText(resumedSessionTerminal.input, "/exit");
  resumedSessionTerminal.input.emit("keypress", undefined, { name: "return" });
}, 35);
await resumedSessionRun;
assert.equal(resumedSessionStarts.length, 1);
assert.equal(resumedSessionStarts[0].continuedFromRunId, "acr_restored");
assert.equal(resumedSessionStarts[0].presetConfiguration.participants[0].native_session_id, "native-remote");

const retryCommandTerminal = fakeTerminal();
const retriedRuns = [];
const retryCommandRun = handleAgentWorkspaceCommand([], {
  input: retryCommandTerminal.input,
  output: retryCommandTerminal.output,
  retryRunner: async (runId) => {
    retriedRuns.push(runId);
    setTimeout(() => {
      emitText(retryCommandTerminal.input, "/exit");
      retryCommandTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
    return { run: { run_id: runId, state: "completed" }, tasks: [], final_report: { summary: "Retry complete." } };
  },
  followRunner: async () => {
    throw new Error("/retry must use the retry lifecycle rather than attach");
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(retryCommandTerminal.input, "/retry acr_workspace_retry");
retryCommandTerminal.input.emit("keypress", undefined, { name: "return" });
await retryCommandRun;
assert.deepEqual(retriedRuns, ["acr_workspace_retry"]);

const homeModeTerminal = fakeTerminal();
const homeModeRun = handleAgentWorkspaceCommand([], {
  input: homeModeTerminal.input,
  output: homeModeTerminal.output,
  collaborationRunner: async () => {
    throw new Error("mode selection must not create a collaboration Run");
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(homeModeTerminal.input, "/mode");
homeModeTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => {
  homeModeTerminal.input.emit("keypress", undefined, { name: "down" });
  homeModeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 10);
setTimeout(() => {
  emitText(homeModeTerminal.input, "/exit");
  homeModeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 25);
await homeModeRun;
assert.match(homeModeTerminal.writes.join(""), /Choose collaboration mode/);
assert.match(homeModeTerminal.writes.join(""), /Choose how OriginRouter should form the Agent team/);
assert.match(homeModeTerminal.writes.join(""), /Team\s+Solo/);

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
assert.match(largePasteTerminal.writes.join(""), /\x1b\[\?(?:2004|2026)h/);
assert.match(largePasteTerminal.writes.join(""), /\x1b\[\?(?:2004|2026)l/);
// The terminal adapter owns cursor wrapping and mouse tracking.  This test
// verifies the user-visible paste behaviour without pinning a particular
// terminal capability negotiation sequence.

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

const activeExitTerminal = fakeTerminal();
const activeExitCancelledRuns = [];
let activeExitStarted = false;
let activeExitReady;
const activeExitReadyPromise = new Promise((resolve) => {
  activeExitReady = resolve;
});
const activeExitRun = handleAgentWorkspaceCommand([], {
  input: activeExitTerminal.input,
  output: activeExitTerminal.output,
  workspaceRunner: async (options) => {
    activeExitStarted = true;
    options.onRunId?.("acr_active_exit");
    options.onUpdate?.({
      type: "snapshot",
      snapshot: {
        run: { run_id: "acr_active_exit", state: "running" },
        tasks: [{ task_key: "inspect", title: "Inspect service", state: "running" }],
      },
      events: [],
    });
    activeExitReady();
    await new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("detached");
        error.code = "ORIGINROUTER_INTERRUPTED";
        reject(error);
      }, { once: true });
    });
  },
  cancelCollaborationRun: async (runId) => activeExitCancelledRuns.push(runId),
});
await new Promise((resolve) => setImmediate(resolve));
emitText(activeExitTerminal.input, "inspect while I leave");
activeExitTerminal.input.emit("keypress", undefined, { name: "return" });
await activeExitReadyPromise;
emitText(activeExitTerminal.input, "/exit");
activeExitTerminal.input.emit("keypress", undefined, { name: "return" });
await activeExitRun;
assert.equal(activeExitStarted, true);
assert.deepEqual(activeExitCancelledRuns, [], "/exit detaches without cancelling the active Run");
assert.match(activeExitTerminal.writes.join(""), /collaboration Run will continue in the service/);

const liveApprovalTerminal = fakeTerminal();
const liveApprovalUpdates = [];
let liveApprovalResolve;
const liveApprovalRun = handleAgentWorkspaceCommand([], {
  input: liveApprovalTerminal.input,
  output: liveApprovalTerminal.output,
  collaborationRunner: async (_args, options = {}) => {
    options.onRunId?.("acr_live_approval");
    await new Promise((resolve, reject) => {
      liveApprovalResolve = resolve;
      options.signal?.addEventListener("abort", () => {
        const error = new Error("interrupted");
        error.code = "ORIGINROUTER_INTERRUPTED";
        reject(error);
      }, { once: true });
    });
  },
  updateSessionApproval: async (runId, approval) => {
    liveApprovalUpdates.push({ runId, ...approval });
    return {
      run_id: runId,
      state: "running",
      supervisor_permission_profile: approval.profile,
      supervisor_policy_id: approval.policyId || null,
    };
  },
  cancelCollaborationRun: async () => liveApprovalResolve?.(),
});
await new Promise((resolve) => setImmediate(resolve));
emitText(liveApprovalTerminal.input, "run with live approval");
liveApprovalTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
liveApprovalTerminal.input.emit("keypress", undefined, { shift: true, name: "tab", sequence: "\x1b[Z" });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(liveApprovalUpdates, [{
  runId: "acr_live_approval",
  profile: "ai_review",
  policyId: "",
}]);
assert.match(liveApprovalTerminal.writes.join(""), /Session approval set to AI Review/);
emitText(liveApprovalTerminal.input, "/approval");
liveApprovalTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
liveApprovalTerminal.input.emit("keypress", undefined, { name: "down" });
liveApprovalTerminal.input.emit("keypress", undefined, { name: "return" });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(liveApprovalUpdates.at(-1), {
  runId: "acr_live_approval",
  profile: "custom",
  policyId: "protected",
});
assert.match(liveApprovalTerminal.writes.join(""), /Change Session approval now/);
liveApprovalTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" });
setTimeout(() => {
  emitText(liveApprovalTerminal.input, "/exit");
  liveApprovalTerminal.input.emit("keypress", undefined, { name: "return" });
}, 20);
await liveApprovalRun;
assert.equal(
  liveApprovalTerminal.writes.join("").includes("\x1b[?1002h"),
  true,
  "the live workspace captures drag events for its own text selection",
);
assert.equal(
  liveApprovalTerminal.writes.join("").includes("\x1b[?1006h"),
  true,
  "the live workspace receives coordinate-rich SGR mouse reports",
);
assert.equal(
  liveApprovalTerminal.writes.join("").includes("\x1b[?1006l\x1b[?1002l"),
  true,
  "mouse reporting is disabled before leaving the alternate screen",
);
assert.doesNotMatch(liveApprovalTerminal.writes.join(""), /Ctrl\+T copy mode/);

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
      teamEditTerminal.input.emit("keypress", undefined, { name: "down" });
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

const teamSelectionTerminal = fakeTerminal();
let teamSelectionDecision;
const teamSelectionRun = handleAgentWorkspaceCommand([], {
  input: teamSelectionTerminal.input,
  output: teamSelectionTerminal.output,
  workspaceRunner: async (options) => {
    const configuration = {
      resolved_workspace_mode: "remote_ops",
      participants: [
        { participant_id: "coordinator", display_name: "Coordinator", runtime: "codex", device_id: "local-device", permission_profile: "guarded", planner: true },
        { participant_id: "remote_operator", display_name: "Remote Operator", runtime: "claude", device_id: "remote-device", permission_profile: "guarded" },
      ],
    };
    setImmediate(() => {
      teamSelectionTerminal.input.emit("keypress", undefined, { name: "down" });
      teamSelectionTerminal.input.emit("keypress", undefined, { name: "return" });
    });
    teamSelectionDecision = await options.onConfigurationConfirmation(configuration);
    setTimeout(() => {
      emitText(teamSelectionTerminal.input, "/exit");
      teamSelectionTerminal.input.emit("keypress", undefined, { name: "return" });
    }, 20);
    return { run: { state: "completed" }, tasks: [], final_report: { summary: "Done." } };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(teamSelectionTerminal.input, "inspect remote machine");
teamSelectionTerminal.input.emit("keypress", undefined, { name: "return" });
await teamSelectionRun;
assert.equal(teamSelectionDecision, "confirm", "selecting an Agent does not change Enter from confirming the team");
assert.match(teamSelectionTerminal.writes.join(""), /› ○ Remote Operator · Claude Code/);
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

const completedCtrlCTerminal = fakeTerminal();
const completedCtrlCRun = handleAgentWorkspaceCommand([], {
  input: completedCtrlCTerminal.input,
  output: completedCtrlCTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_completed_ctrl_c");
    return {
      run: { run_id: "acr_completed_ctrl_c", state: "completed" },
      tasks: [],
      final_report: { summary: "The result is preserved before exit." },
    };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(completedCtrlCTerminal.input, "complete a task");
completedCtrlCTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => completedCtrlCTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" }), 15);
setTimeout(() => completedCtrlCTerminal.input.emit("keypress", undefined, { ctrl: true, name: "c" }), 30);
await completedCtrlCRun;
assert.match(completedCtrlCTerminal.writes.join(""), /Press Ctrl\+C again to exit/);

const completedResumeTerminal = fakeTerminal(100, 30);
const completedResumeSessionIds = [];
const completedResumeRunIds = [];
const completedResumeRun = handleAgentWorkspaceCommand([], {
  input: completedResumeTerminal.input,
  output: completedResumeTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_completed_resume_source");
    return {
      run: { run_id: "acr_completed_resume_source", state: "completed" },
      tasks: [],
      final_report: { summary: "The source Run completed." },
    };
  },
  listCollaborationRuns: async ({ category }) => {
    assert.equal(category, "recent");
    return {
      category,
      total: 1,
      runs: [{
        run_id: "acr_completed_resume_target",
        workspace_session_id: "aws_completed_resume_target",
        state: "completed",
        objective: "Restore this Workspace Session",
        tasks: [],
      }],
    };
  },
  resolveWorkspaceSession: async (sessionId) => {
    completedResumeSessionIds.push(sessionId);
    return { latestRunId: "acr_completed_resume_target" };
  },
  followRunner: async (runId) => {
    completedResumeRunIds.push(runId);
    return {
      run: { run_id: runId, state: "completed" },
      tasks: [],
      final_report: { summary: "The selected Run completed." },
    };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(completedResumeTerminal.input, "complete the source Run");
completedResumeTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => {
  emitText(completedResumeTerminal.input, "/resume");
  completedResumeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 15);
setTimeout(() => completedResumeTerminal.input.emit("keypress", undefined, { name: "return" }), 30);
setTimeout(() => {
  emitText(completedResumeTerminal.input, "/exit");
  completedResumeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 50);
await completedResumeRun;
assert.deepEqual(completedResumeSessionIds, ["aws_completed_resume_target"]);
assert.deepEqual(completedResumeRunIds, ["acr_completed_resume_target"]);
assert.match(completedResumeTerminal.writes.join(""), /Choose a Workspace Session/);
assert.doesNotMatch(completedResumeTerminal.writes.join(""), /\/resume is available from the Workspace prompt after detaching/);

const activeModeTerminal = fakeTerminal(100, 30);
const activeModeRun = handleAgentWorkspaceCommand([], {
  input: activeModeTerminal.input,
  output: activeModeTerminal.output,
  workspaceRunner: async (options) => {
    options.onRunId?.("acr_mode_first");
    options.onUpdate?.({ type: "configuration", payload: continuedTeamConfiguration });
    return {
      run: { run_id: "acr_mode_first", state: "completed" },
      tasks: [],
      final_report: { summary: "Mode test complete." },
    };
  },
});
await new Promise((resolve) => setImmediate(resolve));
emitText(activeModeTerminal.input, "inspect remote machine");
activeModeTerminal.input.emit("keypress", undefined, { name: "return" });
setTimeout(() => {
  emitText(activeModeTerminal.input, "/mode");
  activeModeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 15);
setTimeout(() => {
  activeModeTerminal.input.emit("keypress", undefined, { name: "down" });
  activeModeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 25);
setTimeout(() => {
  emitText(activeModeTerminal.input, "/new");
  activeModeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 38);
setTimeout(() => {
  emitText(activeModeTerminal.input, "/team");
  activeModeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 52);
setTimeout(() => {
  emitText(activeModeTerminal.input, "/exit");
  activeModeTerminal.input.emit("keypress", undefined, { name: "return" });
}, 68);
await activeModeRun;
assert.match(activeModeTerminal.writes.join(""), /The active Run keeps its current team/);
assert.match(activeModeTerminal.writes.join(""), /use \/new to apply/i);
assert.match(activeModeTerminal.writes.join(""), /Team\s+Solo/);

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
assert.equal(remoteCalls[0].includes("--cloud-advice"), false, "Auto mode leaves team selection to local CLI rules");
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
assert.match(runtimeScreen, /● Agents are working · Esc to interrupt/);
assert.doesNotMatch(runtimeScreen, /Ctrl\+T copy mode/);
assert.match(runtimeScreen.replace(/\x1b\[[0-9;]*m/g, ""), /\n› Inspect the remote computer/);
const plainRuntimeScreen = runtimeScreen.replace(/\x1b\[[0-9;]*m/g, "");
assert.match(plainRuntimeScreen, /\n⠋ Agents are working/);
assert.match(plainRuntimeScreen, /\n  Remote Ops · 2 Agents · 2 devices/);
assert.match(plainRuntimeScreen, /\n  Run acr_runtime/);
assert.match(plainRuntimeScreen, /\n  ● Inspect remote status/);

const completedResultScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 100,
  rows: 28,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "completed",
    mode: "auto",
    runId: "acr_completed",
    snapshot: {
      run: { state: "completed" },
      tasks: [],
      final_report: {
        summary: "Completed 2 of 2 collaboration tasks.",
        completed_tasks: [
          { title: "Inspect the remote machine", result: "All inspection commands completed cleanly. No state was modified." },
          { title: "Verify connectivity", result: "Relay and device checks passed." },
        ],
      },
    },
    composerBuffer: "",
  },
});
assert.match(completedResultScreen, /Final result/);
assert.match(completedResultScreen, /All inspection commands completed cleanly/);
assert.match(completedResultScreen, /✓ Inspect the remote machine/);
assert.match(completedResultScreen, /Completed 2 of 2 collaboration tasks/);
assert.doesNotMatch(completedResultScreen, /\x1b\[38;5;250m  All inspection commands completed cleanly/);

const scrollingHeaderRuntime = {
  objective: "Review the remote machine report before continuing ".repeat(12),
  phase: "completed",
  mode: "auto",
  autoFollow: false,
  scrollOffset: 0,
  snapshot: {
    run: { state: "completed" },
    tasks: [],
    final_report: {
      summary: "Completed report summary.",
      completed_tasks: [{
        title: "Remote inspection",
        result: "Inspection detail ".repeat(48),
      }],
    },
  },
  composerBuffer: "",
};
const firstScrollScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 16,
  runtime: scrollingHeaderRuntime,
}).replace(/\x1b\[[0-9;]*m/g, "");
assert.match(firstScrollScreen, /^OriginRouter · originrouter-cli/, "a Run keeps a lightweight workspace header");
assert.match(firstScrollScreen, /new event.*↑\/↓ history.*PgDn latest/, "scroll controls appear while detached from the live tail");
assert.equal(scrollRuntimeContent(scrollingHeaderRuntime, 1, 100), true);
const laterScrollScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 80,
  rows: 16,
  runtime: scrollingHeaderRuntime,
}).replace(/\x1b\[[0-9;]*m/g, "");
assert.match(laterScrollScreen, /OriginRouter · originrouter-cli/, "the workspace header stays fixed");
assert.match(laterScrollScreen, /new event.*↑\/↓ history.*PgDn latest/, "scroll controls remain visible while detached");

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

const mouseState = { mouseSequenceBuffer: "" };
assert.deepEqual(
  consumeWorkspaceMouseKeypress(mouseState, undefined, { sequence: "\x1b[<0;4;3M" }),
  { handled: true, type: "press", button: 0, x: 4, y: 3 },
);
assert.deepEqual(
  consumeWorkspaceMouseKeypress(mouseState, undefined, { sequence: "\x1b[<32;12;7M" }),
  { handled: true, type: "move", button: 0, x: 12, y: 7 },
);
assert.deepEqual(
  consumeWorkspaceMouseKeypress(mouseState, undefined, { sequence: "\x1b[<0;12;7m" }),
  { handled: true, type: "release", button: 0, x: 12, y: 7 },
);
assert.deepEqual(
  consumeWorkspaceMouseKeypress(mouseState, undefined, { sequence: "\x1b[<64;12;7M" }),
  { handled: true, type: "wheel", direction: -1, x: 12, y: 7 },
);
const fragmentedMouseState = { mouseSequenceBuffer: "" };
assert.deepEqual(
  consumeWorkspaceMouseKeypress(fragmentedMouseState, "\x1b[<32;9", { sequence: "\x1b[<32;9" }),
  { handled: true },
);
assert.deepEqual(
  consumeWorkspaceMouseKeypress(fragmentedMouseState, ";4M", { sequence: ";4M" }),
  { handled: true, type: "move", button: 0, x: 9, y: 4 },
);
assert.equal(
  workspaceSelectionText(
    ["\x1b[1mAlpha bravo\x1b[0m", "Second line", "Third"],
    { anchor: { x: 7, y: 1 }, focus: { x: 6, y: 2 } },
  ),
  "bravo\nSecond",
  "selection text is reconstructed from visible terminal cells, without ANSI styling",
);

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
assert.match(configurationReviewScreen, /E edit selection/);
assert.match(configurationReviewScreen, /● Review the proposed team/);
assert.doesNotMatch(configurationReviewScreen, /Review the proposed team \(4m/);
const plainConfigurationReview = configurationReviewScreen.replace(/\x1b\[[0-9;]*m/g, "");
assert.match(plainConfigurationReview, /\nProposed collaboration team/);
assert.match(plainConfigurationReview, /\n  A remote operator is required/);
assert.match(plainConfigurationReview, /\n  › ● Coordinator · Codex/);
assert.match(plainConfigurationReview, /\n    local · local-workspace · Agent limit: Guarded/);
assert.match(plainConfigurationReview, /Session approval Guarded/);
assert.equal(configurationReviewScreen.split("\n").length <= 24, true, "interaction layout fits the terminal height");

const compactModePickerScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 52,
  rows: 8,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "executing",
    interaction: true,
    interactionKind: "live_workspace_mode",
    workspaceModeSelection: 6,
    mode: "auto",
    snapshot: { run: { state: "running" }, tasks: [] },
  },
});
assert.equal(compactModePickerScreen.split("\n").length <= 8, true, "a compact inline picker never writes past its viewport");
assert.match(compactModePickerScreen, /› Remote Ops/, "the selected inline option remains visible on a short terminal");

const compactApprovalPickerScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 100,
  rows: 24,
  runtime: {
    phase: "executing",
    interaction: true,
    interactionKind: "live_session_permission",
    mode: "auto",
    snapshot: { run: { state: "running" }, tasks: [] },
  },
}).replace(/\x1b\[[0-9;]*m/g, "");
assert.match(compactApprovalPickerScreen, /↑\/↓ selects · Enter applies · Esc keeps current approval/);
assert.doesNotMatch(compactApprovalPickerScreen, /Enter queues next objective/);

const resumePickerScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 100,
  rows: 24,
  runtime: {
    phase: "configuring",
    interaction: true,
    interactionKind: "session_resume",
    mode: "auto",
    sessionResumeChoices: [{ sessionId: "aws_recent", run: { run_id: "acr_recent", state: "completed" } }],
    snapshot: { run: { state: "running" }, tasks: [] },
  },
}).replace(/\x1b\[[0-9;]*m/g, "");
assert.match(resumePickerScreen, /↑\/↓ selects · Enter restores · Esc returns to the Workspace prompt/);
assert.doesNotMatch(resumePickerScreen, /Enter queues next objective/);

const undersizedTerminalScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 10,
  rows: 5,
  runtime: {
    phase: "executing",
    interaction: false,
    mode: "auto",
    composerBuffer: "",
    composerCursor: 0,
    composerPastes: [],
    snapshot: { run: { state: "running" }, tasks: [] },
  },
}).replace(/\x1b\[[0-9;]*m/g, "");
assert.equal(undersizedTerminalScreen.split("\n").length, 5, "an undersized terminal never receives extra rows");
assert.equal(Math.max(...undersizedTerminalScreen.split("\n").map((line) => [...line].length)) <= 10, true, "an undersized terminal never receives oversized rows");

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
      participant_id: "remote_operator",
      task_id: "inspect-remote",
      title: "Allow a read-only command?",
      summary: "The remote operator wants to inspect system status.",
      risk: "low",
      actions: ["allow", "deny"],
      payload: {
        request: {
          tool: "Bash",
          display_name: "Run a shell command",
          command: "system_profiler SPSoftwareDataType",
          cwd: "/Users/chengaoyan/Desktop/originrouter-cli",
          prompt: "Inspect the remote macOS version without changing files.",
        },
        supervisor_evaluation: {
          effect: "ask",
          reason: "user_confirmation_required",
          session_profile: "guarded",
          layers: [
            { name: "agent", profile: "guarded", effect: "ask" },
            { name: "session", profile: "guarded", effect: "ask" },
          ],
        },
      },
    },
    configuration: {
      supervisor_permission_profile: "guarded",
      participants: [{ participant_id: "remote_operator", display_name: "Remote Operator" }],
    },
    snapshot: {
      run: { state: "blocked", supervisor_permission_profile: "guarded" },
      tasks: [{ task_id: "inspect-remote", title: "Inspect the remote Mac" }],
    },
  },
});
assert.match(attentionScreen, /Allow a read-only command/);
assert.match(attentionScreen, /Requested by: Remote Operator · Inspect the remote Mac/);
assert.match(attentionScreen, /Command: system_profiler SPSoftwareDataType/);
assert.match(attentionScreen, /Session approval: Guarded/);
assert.match(attentionScreen, /active policy requires a person to decide/);
assert.match(attentionScreen, /› 2\. Deny/);
assert.match(attentionScreen, /Allow the request from Remote Operator/);
assert.equal(attentionScreen.split("\n").length <= 24, true, "attention layout fits the terminal height");

const confirmationScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "blocked",
    interaction: true,
    interactionKind: "attention",
    attention: {
      kind: "confirmation",
      participant_id: "remote_operator",
      title: "Implement this plan?",
      actions: ["allow", "cancel"],
      payload: {
        kind: "confirm",
        request: {
          kind: "confirm",
          prompt: "Review this action before continuing.",
          plan: "Inspect the CLI version and service status without changing the device.",
        },
      },
    },
    configuration: { participants: [{ participant_id: "remote_operator", display_name: "Remote Operator" }] },
    snapshot: { run: { state: "blocked" }, tasks: [] },
  },
});
assert.match(confirmationScreen, /Continue with Remote Operator/);
assert.match(confirmationScreen, /1\. Continue/);
assert.doesNotMatch(confirmationScreen, /Reply/);

const questionsScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 90,
  rows: 24,
  runtime: {
    objective: "Inspect the remote computer",
    phase: "blocked",
    interaction: true,
    interactionKind: "attention",
    attention: {
      kind: "questions",
      participant_id: "remote_operator",
      title: "Choose a mode",
      actions: ["submit", "cancel"],
      payload: {
        kind: "questions",
        request: {
          kind: "questions",
          questions: [{ id: "mode", header: "Mode", question: "Which mode?", options: [{ id: "fast", label: "Fast" }, { id: "full", label: "Full" }] }],
        },
      },
    },
    configuration: { participants: [{ participant_id: "remote_operator", display_name: "Remote Operator" }] },
    snapshot: { run: { state: "blocked" }, tasks: [] },
  },
});
assert.match(questionsScreen, /Answer questions from Remote Operator/);
assert.match(questionsScreen, /Mode: Which mode\? \(Fast \/ Full\)/);
assert.match(questionsScreen, /Answer questions/);

const activityRuntime = {
  objective: "Inspect local and remote status",
  phase: "executing",
  activitySelection: 1,
  expandedActivityParticipants: ["remote_operator"],
  configuration: {
    participants: [
      { participant_id: "coordinator", display_name: "Coordinator" },
      { participant_id: "remote_operator", display_name: "Remote Operator" },
    ],
  },
  snapshot: { run: { state: "running" }, tasks: [] },
  events: [
    { event_id: "a1", sequence: 1, type: "agent.tool_call.start", participant_id: "coordinator", category: "agent", visibility: "detail", metadata: { tool: "Read" }, summary: "Inspect local package metadata" },
    { event_id: "a2", sequence: 2, type: "agent.tool_call.end", participant_id: "coordinator", category: "agent", visibility: "detail", metadata: { tool: "Read" }, summary: "Local package metadata collected" },
    { event_id: "a3", sequence: 3, type: "agent.tool_call.start", participant_id: "remote_operator", category: "agent", visibility: "detail", metadata: { tool: "Bash" }, summary: "Check remote machine status" },
    { event_id: "a4", sequence: 4, type: "agent.text", participant_id: "remote_operator", category: "agent", visibility: "detail", metadata: {}, summary: "Remote status collected", detail: "macOS and CLI version data collected" },
  ],
};
const activityScreen = buildWorkspaceAppScreen({
  coordinator: "codex",
  mode: "auto",
  columns: 100,
  rows: 34,
  runtime: activityRuntime,
});
assert.match(activityScreen, /Coordinator worked/);
assert.match(activityScreen, /Inspect local package metadata/);
assert.match(activityScreen, /› ● Remote Operator is working/);
assert.match(activityScreen, /macOS and CLI version data collected/);
assert.match(activityScreen, /Ctrl\+O collapses Remote Operator/);
assert.deepEqual(activityRuntime.activityParticipantIds, ["coordinator", "remote_operator"]);

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
