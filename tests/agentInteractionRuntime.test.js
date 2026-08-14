// Stage 8.9: offline coverage for the production dual-emit and
// resolve paths, and the agent.mode.status emission.
//
// What this file proves:
//   1. Claude dual-emits: legacy agent.permission.request.detected +
//      new agent.interaction.requested for one hook callback.
//   2. Codex dual-emits with appServerAvailable = true.
//   3. Codex dual-emits with appServerAvailable = false (runtime: null).
//   4. Codex resolvePermission routes via interactionId alias.
//   5. Codex resolvePermission emits resolve.error on unknown id.
//   6. handleRemoteEvent accepts agent.interaction.resolve.
//   7. handleRemoteEvent falls back to executor.write when no
//      permission resolver is present (defensive guard only).
//   8. buildModeStatusEvent emits the documented Stage 8.9 shape.

import assert from "node:assert/strict";
import { ClaudeAdapter } from "../src/adapters/claudeAdapter.js";
import { CodexAdapter } from "../src/adapters/codexAdapter.js";
import {
  buildModeStatusEvent,
  handleRemoteEvent,
} from "../src/local/localAgentSession.js";

// Capture the onPermissionRequest callback a fake hook server
// received so the test can invoke it with a synthetic legacy event.
function makeFakeHookServer() {
  let registered = null;
  let registeredElicitation = null;
  let registeredSessionStart = null;
  let registeredHookEvent = null;
  const fake = {
    port: 0,
    stop: () => {},
    resolvePermission: () => true,
    resolveElicitation: () => true,
  };
  return {
    fake,
    invokePermissionRequest(callId, event) {
      if (!registered) throw new Error("hook callback not registered");
      registered(callId, event);
    },
    invokeElicitationRequest(interactionId, event) {
      if (!registeredElicitation) throw new Error("elicitation callback not registered");
      registeredElicitation(interactionId, event);
    },
    invokeSessionStart(sessionId, event = {}) {
      if (!registeredSessionStart) throw new Error("session callback not registered");
      registeredSessionStart(sessionId, event);
    },
    invokeHookEvent(event) {
      if (!registeredHookEvent) throw new Error("hook callback not registered");
      registeredHookEvent(event);
    },
    async factory(opts) {
      registered = opts.onPermissionRequest;
      registeredElicitation = opts.onElicitationRequest;
      registeredSessionStart = opts.onSessionStart;
      registeredHookEvent = opts.onHookEvent;
      return fake;
    },
  };
}

// Native Claude MCP elicitation is routed through the same interaction
// registry and returned to the blocking Hook as structured content.
{
  const hook = makeFakeHookServer();
  let resolvedPayload = null;
  hook.fake.resolveElicitation = (payload) => {
    resolvedPayload = payload;
    return true;
  };
  const adapter = new ClaudeAdapter({
    args: [],
    cwd: "/tmp/proj",
    hookServerFactory: hook.factory,
  });
  await adapter.beforeStart({ sessionId: "s-claude-elicit", send: () => {} });
  hook.invokeElicitationRequest("elicit-1", {
    interactionId: "elicit-1",
    mode: "form",
    serverName: "github",
    message: "Choose an account",
    requestedSchema: {
      type: "object",
      properties: { account: { type: "string" } },
      required: ["account"],
    },
  });
  const interaction = adapter.scanStructuredEvents().at(-1);
  assert.equal(interaction.kind, "form");
  assert.equal(interaction.payload.server_name, "github");
  adapter.resolvePermission({
    interactionId: "elicit-1",
    decision: "approved",
    action: "submit",
    response: { values: { account: "primary" } },
  });
  assert.deepEqual(resolvedPayload, {
    interactionId: "elicit-1",
    action: "accept",
    content: { account: "primary" },
  });
}

const CLAUDE_CALL_ID = "claude-perm-1781663400000-a1b2c3d4e";
const CODEX_CALL_ID = "codex-approval-1781663500000-zyxwvu";

// ---- 1. Claude dual-emit ----

{
  const hook = makeFakeHookServer();
  const adapter = new ClaudeAdapter({
    args: [],
    cwd: "/tmp/proj",
    hookServerFactory: hook.factory,
  });
  await adapter.beforeStart({ sessionId: "s-claude-1", send: () => {} });

  const legacyEvent = {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "npm test" },
    permissionSuggestions: [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }] },
    ],
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: ["approved", "approved_for_session", "denied", "abort"],
    },
  };
  hook.invokePermissionRequest(CLAUDE_CALL_ID, legacyEvent);

  const events = adapter.scanStructuredEvents();
  assert.equal(events.length, 2, "two events emitted (legacy + new)");
  assert.equal(events[0].type, "agent.permission.request.detected",
    "legacy event is pushed first");
  assert.equal(events[1].type, "agent.interaction.requested",
    "new envelope is pushed second");
  const interaction = events[1];
  assert.equal(interaction.kind, "permission");
  assert.equal(interaction.source, "hook");
  assert.equal(interaction.sessionId, "s-claude-1",
    "new envelope carries the sessionId the hook server never saw");
  assert.equal(interaction.runtime, "claude-pty");
  assert.equal(interaction.interactionId, CLAUDE_CALL_ID,
    "interactionId == legacy callId");
  assert.equal(interaction.callId, CLAUDE_CALL_ID);
  assert.equal(interaction.tool, "Bash");
  assert.deepEqual(interaction.input, { command: "npm test" });
  assert.deepEqual(interaction.permissionSuggestions, legacyEvent.permissionSuggestions);
  assert.equal(interaction.resolution.eventType, "agent.interaction.resolve");
}

// Native AskUserQuestion is a real questions interaction and its answer is
// returned to Claude through PermissionRequest.updatedInput.
{
  const hook = makeFakeHookServer();
  let resolvedPayload = null;
  hook.fake.resolvePermission = (payload) => {
    resolvedPayload = payload;
    return true;
  };
  const adapter = new ClaudeAdapter({
    args: [],
    cwd: "/tmp/proj",
    hookServerFactory: hook.factory,
  });
  await adapter.beforeStart({ sessionId: "s-claude-questions", send: () => {} });
  hook.invokePermissionRequest("ask-1", {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: "ask-1",
    tool: "AskUserQuestion",
    input: {
      questions: [{
        header: "Mode",
        question: "Which mode?",
        multiSelect: false,
        options: [{ label: "Plan" }, { label: "Build" }],
      }],
    },
  });
  const interaction = adapter.scanStructuredEvents().at(-1);
  assert.equal(interaction.kind, "questions");
  assert.equal(interaction.payload.questions[0].multiple, false);
  adapter.resolvePermission({
    interactionId: "ask-1",
    decision: "approved",
    response: { answers: { q1: ["Build"] } },
  });
  assert.equal(resolvedPayload.updatedInput.answers["Which mode?"], "Build");
}

// A response entered in Claude's original terminal closes the mirrored App
// interaction as soon as Claude reports that the tool completed.
{
  const hook = makeFakeHookServer();
  let terminalResolution = null;
  hook.fake.resolvePermission = (payload) => {
    terminalResolution = payload;
    return true;
  };
  const adapter = new ClaudeAdapter({
    args: [],
    cwd: "/tmp/proj",
    hookServerFactory: hook.factory,
  });
  await adapter.beforeStart({ sessionId: "s-claude-terminal", send: () => {} });
  hook.invokePermissionRequest("toolu-question-1", {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: "toolu-question-1",
    tool: "AskUserQuestion",
    input: { questions: [] },
  });
  adapter.scanStructuredEvents();

  hook.invokeHookEvent({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu-question-1",
  });

  assert.deepEqual(terminalResolution, {
    callId: "toolu-question-1",
    decision: "approved",
    reason: "handled_in_terminal",
  });
  const events = adapter.scanStructuredEvents();
  assert.ok(events.some((event) =>
    event.type === "agent.interaction.result" &&
    event.interactionId === "toolu-question-1" &&
    event.status === "applied" &&
    event.decisionSource === "terminal"
  ));
  assert.ok(events.some((event) =>
    event.type === "agent.permission.resolved" &&
    event.callId === "toolu-question-1" &&
    event.decisionSource === "terminal"
  ));
}

// ---- 2. Codex dual-emit (app-server available) ----

{
  // Stage 8.9 test seam: pass appServerAvailable: true and a fake
  // appServerClient that captures the registered onApproval handler.
  // No system probe, no real process spawn.
  let capturedOnApproval = null;
  const fakeClient = {
    onEvent(_h) {},
    onApproval(h) { capturedOnApproval = h; },
    async connect() { /* no-op */ },
    disconnect() {},
  };
  const adapter = new CodexAdapter({
    args: [],
    appServerAvailable: true,
    appServerClient: fakeClient,
  });
  await adapter.beforeStart({ sessionId: "s-codex-1", cwd: "/tmp/proj", env: {} });
  assert.equal(adapter.appServerAvailable, true);
  assert.equal(typeof capturedOnApproval, "function",
    "onApproval callback registered on the (fake) app-server client");

  const request = {
    method: "item/commandExecution/requestApproval",
    callId: CODEX_CALL_ID,
    params: { command: "pytest -q", cwd: "/tmp/proj" },
  };
  capturedOnApproval(request);

  const events = adapter.scanStructuredEvents();
  // scanStructuredEvents returns the agent.adapter.status push
  // at the end of beforeStart, then the two approval events. We
  // only care about the last two.
  const interaction = events[events.length - 1];
  const legacy = events[events.length - 2];
  assert.equal(legacy.type, "agent.permission.request.detected",
    "legacy event pushed first");
  assert.equal(interaction.type, "agent.interaction.requested",
    "new envelope pushed second");
  assert.equal(interaction.kind, "permission");
  assert.equal(interaction.source, "app-server");
  assert.equal(interaction.sessionId, "s-codex-1");
  assert.equal(interaction.runtime, "codex-app-server",
    "Codex runtime is codex-app-server when the app-server is available");
  assert.equal(interaction.interactionId, CODEX_CALL_ID);
  assert.equal(legacy.callId, CODEX_CALL_ID);
}

// ---- 3. Codex dual-emit (app-server unavailable) ----

{
  const adapter = new CodexAdapter({ args: [], appServerAvailable: false });
  await adapter.beforeStart({ sessionId: "s-codex-2", cwd: "/tmp/proj", env: {} });
  assert.equal(adapter.appServerAvailable, false);
  // No onApproval was registered (early return in beforeStart).
  // The only event is the agent.adapter.status.
  const events = adapter.scanStructuredEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agent.adapter.status");
  assert.equal(events[0].appServerAvailable, false);

  // No dual-emit envelope is emitted when the app-server is
  // unavailable — the onApproval path is not registered.
  const interactionEvents = events.filter(
    (e) => e.type === "agent.interaction.requested",
  );
  assert.equal(interactionEvents.length, 0,
    "no new envelope is emitted when the app-server is unavailable");
}

// ---- 4. Codex resolvePermission routes via interactionId ----

{
  let capturedOnApproval = null;
  const fakeClient = {
    onEvent(_h) {},
    onApproval(h) { capturedOnApproval = h; },
    async connect() {},
    disconnect() {},
  };
  const adapter = new CodexAdapter({
    args: [],
    appServerAvailable: true,
    appServerClient: fakeClient,
  });
  await adapter.beforeStart({ sessionId: "s-codex-3", cwd: "/tmp/proj", env: {} });

  capturedOnApproval({
    method: "item/commandExecution/requestApproval",
    callId: CODEX_CALL_ID,
    params: { command: "ls" },
  });
  // The pendingApprovals map was populated by the inner promise
  // executor; resolve via interactionId.
  adapter.resolvePermission({ interactionId: CODEX_CALL_ID, decision: "approved" });

  const events = adapter.scanStructuredEvents();
  const resolved = events.find((e) => e.type === "agent.permission.resolved");
  assert.ok(resolved, "agent.permission.resolved emitted after resolve");
  assert.equal(resolved.callId, CODEX_CALL_ID,
    "resolved callId is the interactionId we used to resolve");
  assert.equal(resolved.decision, "approved");
}

// ---- 5. Codex resolvePermission emits resolve.error on unknown id ----

{
  const adapter = new CodexAdapter({ args: [], appServerAvailable: true });
  // Force pendingApprovals to be empty without entering beforeStart.
  adapter.appServerAvailable = true;
  adapter.resolvePermission({ interactionId: "ghost-id", decision: "approved" });
  const events = adapter.scanStructuredEvents();
  const error = events.find((e) => e.type === "agent.permission.resolve.error");
  assert.ok(error, "agent.permission.resolve.error emitted on unknown id");
  assert.equal(error.callId, "ghost-id",
    "error event uses the unknown id as callId");
  assert.match(error.message, /No pending Codex approval/);
}

// ---- 6. handleRemoteEvent accepts agent.interaction.resolve ----

{
  let resolvePermissionCalls = [];
  const adapter = {
    resolvePermission: (payload) => {
      resolvePermissionCalls.push(payload);
    },
  };
  const writes = [];
  const executor = {
    write: (data) => writes.push(data),
    resize: () => {},
    interrupt: () => {},
    stop: () => {},
  };
  const ctx = { sessionId: "s-rt-1", adapter, executor };

  handleRemoteEvent(
    {
      type: "agent.interaction.resolve",
      sessionId: "s-rt-1",
      interactionId: "i-1",
      decision: "approved",
    },
    ctx,
  );
  assert.equal(resolvePermissionCalls.length, 1);
  assert.equal(resolvePermissionCalls[0].interactionId, "i-1");
  assert.equal(resolvePermissionCalls[0].decision, "approved");
  // Both callId and interactionId are forwarded so adapters that
  // key by either work.
  assert.equal(resolvePermissionCalls[0].callId, "i-1",
    "callId is populated from interactionId when not provided separately");

  // Different session id is ignored.
  handleRemoteEvent(
    { type: "agent.interaction.resolve", sessionId: "other", interactionId: "i-2" },
    ctx,
  );
  assert.equal(resolvePermissionCalls.length, 1,
    "events for a different sessionId are ignored");
}

// ---- 7. Raw fallback when no permission resolver exists ----

{
  let wrote = null;
  const adapter = {}; // no resolvePermission
  const executor = {
    write: (data) => { wrote = data; },
    resize: () => {},
    interrupt: () => {},
    stop: () => {},
  };
  handleRemoteEvent(
    {
      type: "agent.interaction.resolve",
      sessionId: "s-rt-2",
      interactionId: "i-3",
      decision: "approved",
      data: "ls\r",
    },
    { sessionId: "s-rt-2", adapter, executor },
  );
  assert.equal(wrote, "ls\r",
    "data is forwarded to executor.write when no resolver is present");
}

// ---- 8. buildModeStatusEvent emits the documented shape ----

{
  const submitted = [];
  const applied = await handleRemoteEvent(
    {
      type: "agent.message",
      sessionId: "s-message-1",
      message: "Explain the current changes",
    },
    {
      sessionId: "s-message-1",
      adapter: {},
      executor: {
        submitMessage: async (data) => submitted.push(data),
        write: () => {},
        resize: () => {},
        interrupt: () => {},
        stop: () => {},
      },
    },
  );
  assert.equal(applied, true);
  assert.deepEqual(submitted, ["Explain the current changes"]);
}

{
  const writes = [];
  const applied = await handleRemoteEvent(
    {
      type: "agent.message",
      sessionId: "s-message-fallback",
      message: "Submit this once",
    },
    {
      sessionId: "s-message-fallback",
      adapter: {},
      executor: {
        write: (data) => writes.push(data),
        resize: () => {},
        interrupt: () => {},
        stop: () => {},
      },
    },
  );
  assert.equal(applied, true);
  assert.deepEqual(writes, ["Submit this once", "\r"]);
}

// ---- 9. Native Claude mode switching waits for a Hook ACK ----

{
  const hook = makeFakeHookServer();
  const adapter = new ClaudeAdapter({
    args: [],
    cwd: "/tmp/proj",
    hookServerFactory: hook.factory,
    modeChangeTimeoutMs: 100,
    modeOutputSettleMs: 10,
  });
  await adapter.beforeStart({ sessionId: "s-native-mode", send: () => {} });
  hook.invokeSessionStart("native-session", {
    transcript_path: "/tmp/native.jsonl",
    cwd: "/tmp/proj",
    permission_mode: "default",
  });
  const writes = [];
  const modeFooters = [
    "accept edits on (shift+tab to cycle) · for agents",
    "accept edits on (shift+tab to cycle) · plan mode on (shift+tab to cycle) · for agents",
  ];
  const switching = handleRemoteEvent(
    {
      type: "agent.mode.set",
      sessionId: "s-native-mode",
      mode: "plan",
      requestId: "mode-request-1",
    },
    {
      sessionId: "s-native-mode",
      adapter,
      executor: {
        write: (data) => {
          writes.push(data);
          const footer = modeFooters[writes.length - 1];
          setTimeout(() => adapter.handleOutput(footer), 0);
        },
      },
    },
  );
  assert.equal(await switching, true);
  assert.deepEqual(writes, ["\x1b[Z", "\x1b[Z"]);
  assert.equal(adapter.currentMode, "plan");
  assert.equal(adapter.modeControl, "supported");
  assert.deepEqual(
    adapter.availableModes().map((item) => item.id),
    ["default", "acceptEdits", "plan", "auto"],
  );
  const result = adapter
    .scanStructuredEvents()
    .filter((event) => event.type === "agent.mode.status")
    .at(-1);
  assert.equal(result.mode, "plan");
  assert.equal(result.accepted, true);
  assert.equal(result.requestId, "mode-request-1");
  adapter.cleanup();
}

// Default mode has no badge in Claude's footer. A complete footer redraw
// without another mode badge confirms that the cycle returned to default.
{
  const hook = makeFakeHookServer();
  const adapter = new ClaudeAdapter({
    args: ["--permission-mode", "auto"],
    cwd: "/tmp/proj",
    hookServerFactory: hook.factory,
    modeChangeTimeoutMs: 100,
    modeOutputSettleMs: 10,
  });
  await adapter.beforeStart({ sessionId: "s-native-mode-default", send: () => {} });
  hook.invokeSessionStart("native-session-default", {
    transcript_path: "/tmp/native-default.jsonl",
    cwd: "/tmp/proj",
    permission_mode: "auto",
  });
  const writes = [];
  const switching = handleRemoteEvent(
    {
      type: "agent.mode.set",
      sessionId: "s-native-mode-default",
      mode: "default",
      requestId: "mode-request-default",
    },
    {
      sessionId: "s-native-mode-default",
      adapter,
      executor: {
        write: (data) => {
          writes.push(data);
          setTimeout(
            () => adapter.handleOutput(
              "auto mode on (shift+tab to cycle) · for agents · for shortcuts",
            ),
            0,
          );
        },
      },
    },
  );
  assert.equal(await switching, true);
  assert.deepEqual(writes, ["\x1b[Z"]);
  assert.equal(adapter.currentMode, "default");
  adapter.cleanup();
}

// Mode changes are rejected while Claude is processing a turn. No terminal
// key is written and the current mode is preserved.
{
  const hook = makeFakeHookServer();
  const adapter = new ClaudeAdapter({
    args: [],
    cwd: "/tmp/proj",
    hookServerFactory: hook.factory,
  });
  await adapter.beforeStart({ sessionId: "s-native-mode-busy", send: () => {} });
  hook.invokeSessionStart("native-session-busy", {
    transcript_path: "/tmp/native-busy.jsonl",
    cwd: "/tmp/proj",
    permission_mode: "default",
  });
  hook.invokeHookEvent({ hook_event_name: "UserPromptSubmit" });
  const writes = [];
  const applied = await handleRemoteEvent(
    {
      type: "agent.mode.set",
      sessionId: "s-native-mode-busy",
      mode: "plan",
      commandId: "local-mode-command",
    },
    {
      sessionId: "s-native-mode-busy",
      adapter,
      executor: { write: (data) => writes.push(data) },
    },
  );
  assert.equal(applied, false);
  assert.deepEqual(writes, []);
  const result = adapter
    .scanStructuredEvents()
    .filter((event) => event.type === "agent.mode.status")
    .at(-1);
  assert.equal(result.mode, "default");
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "mode_change_busy");
  assert.equal(result.requestId, "local-mode-command");
  adapter.cleanup();
}

// ---- 10. buildModeStatusEvent keeps unsupported runtimes read-only ----

{
  const ev = buildModeStatusEvent({
    sessionId: "s-mode-1",
    provider: "claude",
    runtime: "claude-pty",
    availableModes: ["default", "acceptEdits"],
  });
  assert.equal(ev.type, "agent.mode.status");
  assert.equal(ev.sessionId, "s-mode-1");
  assert.equal(ev.provider, "claude");
  assert.equal(ev.runtime, "claude-pty");
  assert.deepEqual(ev.availableModes, ["default", "acceptEdits"]);
  assert.equal(ev.mode, "default");
  assert.equal(ev.modeControl, "unsupported");
  assert.match(ev.reason, /not available for this runtime/);

  // Codex branch returns null runtime by default if not provided.
  const codex = buildModeStatusEvent({
    sessionId: "s-mode-2",
    provider: "codex",
    runtime: "codex-app-server",
    availableModes: ["default", "read-only", "safe-yolo", "yolo"],
  });
  assert.equal(codex.provider, "codex");
  assert.equal(codex.runtime, "codex-app-server");
  assert.equal(codex.availableModes.length, 4);
  assert.equal(codex.modeControl, "unsupported");
}

console.log("agent interaction runtime tests ok");
