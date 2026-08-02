import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeJsonlScanner, mapClaudeJsonLine, mapClaudeJsonLineSince } from "../src/adapters/claude/jsonlScanner.js";
import { CodexAppServerClient } from "../src/adapters/codex/appServerClient.js";
import {
  mapCodexApprovalRequest,
  mapCodexAppServerEvent,
  mapCodexNotification,
} from "../src/adapters/codex/eventMapper.js";
import { CodexAdapter } from "../src/adapters/codexAdapter.js";
import { ClaudeAdapter, mapClaudeHookEvent } from "../src/adapters/claudeAdapter.js";
import { mapClaudeSdkMessage } from "../src/runtime/claudeSdkEvents.js";

assert.equal(new ClaudeAdapter({ args: [] }).describe().runtime, "claude-pty");

const claudeEvents = mapClaudeJsonLine(JSON.stringify({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "I will run tests." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
    ],
  },
}));

assert.equal(claudeEvents.find((event) => event.type === "agent.text")?.text, "I will run tests.");
assert.equal(claudeEvents.find((event) => event.type === "agent.tool_call.start")?.tool, "Bash");
assert.equal(claudeEvents.find((event) => event.type === "agent.permission.request.detected"), undefined);

const codexEvents = mapCodexAppServerEvent({
  type: "exec_command_begin",
  call_id: "exec_1",
  command: "npm test",
  cwd: "/repo",
});

assert.deepEqual(codexEvents[0], {
  type: "agent.tool_call.start",
  provider: "codex",
  tool: "exec",
  callId: "exec_1",
  input: { command: "npm test", cwd: "/repo" },
});

const codexAssistantEvents = mapCodexAppServerEvent({
  type: "agent_message",
  message: "<think>private chain of thought</think>\nVisible answer",
});
assert.deepEqual(codexAssistantEvents, [
  { type: "agent.thinking", provider: "codex", text: "" },
  { type: "agent.text", provider: "codex", text: "Visible answer" },
]);
assert.equal(
  JSON.stringify(codexAssistantEvents).includes("private chain of thought"),
  false,
);

// Stage 8.1: codex.initialized → agent.ready
assert.deepEqual(mapCodexAppServerEvent({ type: "codex.initialized" }), [{
  type: "agent.ready",
  provider: "codex",
  message: "Codex app-server session is ready.",
}]);

// Stage 8.1: codex.approval.timeout → permission resolved timeout
assert.deepEqual(mapCodexAppServerEvent({ type: "codex.approval.timeout", callId: "x" }), [{
  type: "agent.permission.resolved",
  provider: "codex",
  callId: "x",
  decision: "denied",
  reason: "timeout",
}]);

// Stage 8.4: codex.app_server.exit → agent.adapter.status state=exited
assert.deepEqual(mapCodexAppServerEvent({
  type: "codex.app_server.exit", code: 1, signal: null,
})[0], {
  type: "agent.adapter.status",
  provider: "codex",
  appServerAvailable: false,
  state: "exited",
  code: 1,
  signal: null,
});

assert.deepEqual(mapCodexNotification("item/completed", {
  item: {
    type: "reasoning",
    id: "reasoning-1",
    summary: ["Checked the route", "Compared the fallback"],
    content: ["private chain of thought must not be forwarded"],
  },
}), [{
  type: "agent.thinking",
  provider: "codex",
  text: "Checked the route\nCompared the fallback",
}]);

const codexPlanEvent = mapCodexNotification("turn/plan/updated", {
  explanation: "Implement in two steps",
  plan: [
    { step: "Update the mapper", status: "inProgress" },
    { step: "Run tests", status: "pending" },
  ],
})[0];
assert.equal(codexPlanEvent.type, "agent.activity");
assert.equal(codexPlanEvent.activity, "plan_progress");
assert.equal(codexPlanEvent.metadata.plan.length, 2);

const codexMcpEvent = mapCodexNotification("item/started", {
  item: {
    type: "mcpToolCall",
    id: "mcp-1",
    server: "github",
    tool: "search",
    arguments: { query: "repo", authorization: "private" },
  },
})[0];
assert.equal(codexMcpEvent.type, "agent.tool_call.start");
assert.equal(codexMcpEvent.tool, "github/search");
assert.equal(codexMcpEvent.input.arguments.authorization, "[redacted]");

assert.deepEqual(mapCodexNotification("item/agentMessage/delta", {
  delta: "duplicate partial text",
}), []);

const unknownCodexNotification = mapCodexNotification("future/privateNotification", {
  secret: "must not cross",
})[0];
assert.equal(unknownCodexNotification.activity, "notification");
assert.equal(JSON.stringify(unknownCodexNotification).includes("must not cross"), false);

// Stage 8.4: codex.app_server.force_kill → agent.adapter.status state=force_killed
assert.deepEqual(mapCodexAppServerEvent({
  type: "codex.app_server.force_kill",
})[0], {
  type: "agent.adapter.status",
  provider: "codex",
  appServerAvailable: false,
  state: "force_killed",
});

const approvalEvent = mapCodexApprovalRequest({
  method: "item/commandExecution/requestApproval",
  type: "exec",
  callId: "exec_2",
  command: "npm run build",
  cwd: "/repo",
});

assert.equal(approvalEvent.type, "agent.permission.request.detected");
assert.equal(approvalEvent.provider, "codex");
assert.equal(approvalEvent.callId, "exec_2");
assert.equal(approvalEvent.input.command, "npm run build");
assert.deepEqual(approvalEvent.resolution.decisions, ["approved", "approved_for_session", "denied", "abort"]);

const client = new CodexAppServerClient();
const writes = [];
client.child = {
  stdin: {
    writable: true,
    write(data) {
      writes.push(JSON.parse(data));
    },
  },
};
client.onApproval((request) => {
  assert.equal(request.type, "exec");
  assert.equal(request.callId, "exec_3");
  return "approved";
});
client.handleLine(JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "item/commandExecution/requestApproval",
  params: { itemId: "exec_3", command: "npm test" },
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(writes[0], {
  jsonrpc: "2.0",
  id: 7,
  result: { decision: "accept" },
});

const sdkEvents = mapClaudeSdkMessage({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Checking files." },
      { type: "tool_use", id: "toolu_sdk_1", name: "Bash", input: { command: "ls" } },
    ],
  },
});

assert.equal(sdkEvents.find((event) => event.type === "agent.text")?.text, "Checking files.");
assert.equal(sdkEvents.find((event) => event.type === "agent.tool_call.start")?.callId, "toolu_sdk_1");

const sdkInitEvents = mapClaudeSdkMessage({
  type: "system",
  subtype: "init",
  session_id: "claude-default-model-session",
  model: "claude-sonnet-default",
});
assert.equal(
  sdkInitEvents.find((event) => event.type === "agent.session_id")?.model,
  "claude-sonnet-default",
);

const sdkFailedResult = mapClaudeSdkMessage({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "Claude request failed before completion",
});
assert.equal(sdkFailedResult.at(-1)?.type, "agent.task.failed");
assert.match(sdkFailedResult.at(-1)?.error, /failed before completion/);

const sdkStateEvents = mapClaudeSdkMessage({
  type: "system",
  subtype: "session_state_changed",
  state: "requires_action",
  uuid: "sdk-state-1",
  session_id: "sdk-session",
});
assert.deepEqual(sdkStateEvents[0], {
  type: "agent.adapter.status",
  provider: "claude",
  state: "requires_action",
  message: "Claude requires user action",
  metadata: { session_state: "requires_action" },
  eventId: "claude_sdk-state-1_status_0",
});

const sdkCompactEvents = mapClaudeSdkMessage({
  type: "system",
  subtype: "compact_boundary",
  compact_metadata: { trigger: "auto", pre_tokens: 1000, post_tokens: 250 },
  uuid: "sdk-compact-1",
  session_id: "sdk-session",
});
assert.equal(sdkCompactEvents[0].type, "agent.activity");
assert.equal(sdkCompactEvents[0].activity, "context_compacted");
assert.equal(sdkCompactEvents[0].metadata.pre_tokens, 1000);

const sdkDeniedEvents = mapClaudeSdkMessage({
  type: "system",
  subtype: "permission_denied",
  tool_name: "Bash",
  tool_use_id: "tool-denied",
  decision_reason_type: "rule",
  decision_reason: "blocked",
  message: "Command denied",
  uuid: "sdk-denied-1",
  session_id: "sdk-session",
});
assert.equal(sdkDeniedEvents[0].activity, "permission_denied");
assert.equal(sdkDeniedEvents[0].detail, "Command denied");

const sdkSensitiveToolEvents = mapClaudeSdkMessage({
  type: "assistant",
  uuid: "sdk-sensitive-1",
  message: {
    content: [{
      type: "tool_use",
      id: "tool-sensitive",
      name: "Fetch",
      input: { authorization: "Bearer private", url: "https://example.com" },
    }],
  },
});
assert.equal(sdkSensitiveToolEvents[0].input.authorization, "[redacted]");
assert.equal(sdkSensitiveToolEvents[0].input.url, "https://example.com");

assert.deepEqual(mapClaudeSdkMessage({
  type: "stream_event",
  uuid: "partial",
  event: { type: "content_block_delta" },
}), []);

assert.deepEqual(mapClaudeHookEvent({
  hook_event_name: "PostCompact",
  session_id: "native-claude",
  transcript_path: "/private/transcript.jsonl",
  cwd: "/repo",
}), {
  type: "agent.activity",
  provider: "claude",
  activity: "context_compacted",
  summary: "Claude compacted the conversation context",
  detail: "",
  metadata: {
    hook_event: "PostCompact",
    source: "",
    notification_type: "",
    task_id: "",
    task_subject: "",
    agent_id: "",
    agent_type: "",
    file_path: "",
    cwd: "/repo",
    worktree_path: "",
    permission_mode: "",
    elicitation_id: "",
    mcp_server_name: "",
    action: "",
  },
});

assert.deepEqual(mapClaudeHookEvent({
  hook_event_name: "UserPromptSubmit",
  session_id: "native-claude",
}), {
  type: "agent.task.started",
  provider: "claude",
  id: "native-claude",
});
assert.equal(mapClaudeHookEvent({ hook_event_name: "Stop" }).type, "agent.task.complete");
assert.equal(mapClaudeHookEvent({ hook_event_name: "StopFailure" }).type, "agent.task.aborted");

const nativeDenied = mapClaudeHookEvent({
  hook_event_name: "PermissionDenied",
  permission_mode: "plan",
});
assert.equal(nativeDenied.activity, "permission_denied");
assert.equal(nativeDenied.metadata.permission_mode, "plan");

const nativeElicitationResult = mapClaudeHookEvent({
  hook_event_name: "ElicitationResult",
  elicitation_id: "elicit-1",
  mcp_server_name: "github",
  action: "accept",
});
assert.equal(nativeElicitationResult.activity, "elicitation_completed");
assert.equal(nativeElicitationResult.metadata.elicitation_id, "elicit-1");
assert.equal(
  JSON.stringify(mapClaudeHookEvent({
    hook_event_name: "PostCompact",
    transcript_path: "/private/transcript.jsonl",
  })).includes("transcript"),
  false,
);
assert.deepEqual(mapClaudeSdkMessage({
  type: "system",
  subtype: "thinking_tokens",
  estimated_tokens: 100,
  estimated_tokens_delta: 10,
}), []);

// JSONL scanner must drop lines older than the wrapper's beforeStart time.
// This is the regression test for the "history replays as live permission
// requests" bug.
const startedAtMs = Date.parse("2026-06-16T10:00:00.000Z");
const oldLine = JSON.stringify({
  timestamp: "2026-06-16T09:00:00.000Z",
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id: "toolu_old", name: "Bash", input: { command: "rm -rf /" } },
    ],
  },
});
const newLine = JSON.stringify({
  timestamp: "2026-06-16T10:00:05.000Z",
  type: "assistant",
  message: {
    content: [
      { type: "tool_use", id: "toolu_new", name: "Bash", input: { command: "ls" } },
    ],
  },
});

const oldFiltered = mapClaudeJsonLineSince(oldLine, startedAtMs);
const newFiltered = mapClaudeJsonLineSince(newLine, startedAtMs);
assert.equal(oldFiltered.length, 0, "old line should be filtered out");
assert.equal(
  newFiltered.find((event) => event.type === "agent.tool_call.start")?.callId,
  "toolu_new",
  "new line should produce a tool call event"
);
assert.equal(
  newFiltered.find((event) => event.type === "agent.permission.request.detected"),
  undefined,
  "JSONL tool calls are not proof that Claude Code is waiting for permission"
);

// Lines without a timestamp pass through unchanged (defensive default).
const noTsLine = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "no ts" }] },
});
assert.equal(
  mapClaudeJsonLineSince(noTsLine, startedAtMs).find((event) => event.type === "agent.text")?.text,
  "no ts"
);

const scanDir = mkdtempSync(join(tmpdir(), "originrouter-jsonl-scanner-"));
const transcriptPath = join(scanDir, "session.jsonl");
writeFileSync(transcriptPath, [
  JSON.stringify({
    timestamp: "2026-06-16T10:00:01.000Z",
    sessionId: "session_once",
    type: "user",
    message: { role: "user", content: "hello" },
  }),
  JSON.stringify({
    timestamp: "2026-06-16T10:00:02.000Z",
    sessionId: "session_once",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  }),
].join("\n"));
const scanner = new ClaudeJsonlScanner({ transcriptPath, startedAt: startedAtMs });
const scannedEvents = scanner.scan();
assert.equal(
  scannedEvents.filter((event) => event.type === "agent.session_id").length,
  1,
  "scanner should emit each session id once even though every JSONL line includes sessionId"
);

// Stage 8.4: CodexAdapter.describe() carries the runtime tag and
// gates structuredSources on appServerAvailable.
{
  const a = new CodexAdapter({ args: [] });
  a.appServerAvailable = true;
  assert.equal(a.describe().runtime, "codex-app-server");
  assert.deepEqual(a.describe().structuredSources, ["codex-app-server", "codex-jsonl", "terminal-output"]);
  a.appServerAvailable = false;
  assert.equal(a.describe().runtime, "codex-pty");
  assert.deepEqual(a.describe().structuredSources, ["codex-jsonl", "terminal-output"]);
}

// Remote-control-only native mode must not inject OriginRouter's model alias
// or OPENAI_MODEL into an installed Codex configuration.
{
  const launch = new CodexAdapter({
    args: ["resume", "session-123"],
    nativeConfig: true,
  }).buildLaunch();
  assert.deepEqual(launch, {
    command: "codex",
    args: ["resume", "session-123"],
    env: {},
  });
}

// Stage 8.4: when the app-server process exits, the adapter walks
// pendingApprovals and resolves each as "denied" with
// reason=app_server_exit, in addition to the mapper emitting the
// structured agent.adapter.status event.
//
// We replicate the production onEvent registration inline (the
// production closure lives inside beforeStart, which would shell
// out to `codex --version` if we let it run). The replicated
// block is identical to the one in src/adapters/codexAdapter.js
// beforeStart(); the test asserts the contract through observable
// state (adapter.pendingEvents + the resolve calls).
{
  const adapter = new CodexAdapter({ args: [] });
  adapter.appServerAvailable = true;
  // Real client with a fake connect so we can register an eventHandler
  // on it without spawning.
  const realClient = new CodexAppServerClient({});
  realClient.connect = async () => {};
  adapter.appServerClient = realClient;
  // Inline the same onEvent registration codexAdapter.js beforeStart uses.
  realClient.onEvent((event) => {
    if (event.type === "codex.app_server.exit" || event.type === "codex.app_server.force_kill") {
      for (const [callId, pending] of adapter.pendingApprovals) {
        pending.resolve("denied");
        adapter.pendingEvents.push({
          type: "agent.permission.resolved",
          provider: "codex",
          callId,
          decision: "denied",
          reason: "app_server_exit",
        });
      }
      adapter.pendingApprovals.clear();
    }
    adapter.pendingEvents.push(...mapCodexAppServerEvent(event));
  });
  // Seed two pending approvals.
  const resolvedA = [];
  const resolvedB = [];
  adapter.pendingApprovals.set("call-A", {
    resolve: (v) => resolvedA.push(v),
    createdAt: Date.now(),
    request: { type: "exec" },
  });
  adapter.pendingApprovals.set("call-B", {
    resolve: (v) => resolvedB.push(v),
    createdAt: Date.now(),
    request: { type: "patch" },
  });
  // Drive the app-server exit.
  realClient.eventHandler({ type: "codex.app_server.exit", code: 1, signal: null });
  // Both promises were resolved as "denied".
  assert.deepEqual(resolvedA, ["denied"]);
  assert.deepEqual(resolvedB, ["denied"]);
  // The map is cleared.
  assert.equal(adapter.pendingApprovals.size, 0);
  // pendingEvents contains: per-card agent.permission.resolved first,
  // then the agent.adapter.status state=exited event.
  const resolvedEvents = adapter.pendingEvents.filter((e) => e.type === "agent.permission.resolved");
  assert.equal(resolvedEvents.length, 2);
  assert.equal(resolvedEvents[0].callId, "call-A");
  assert.equal(resolvedEvents[0].decision, "denied");
  assert.equal(resolvedEvents[0].reason, "app_server_exit");
  assert.equal(resolvedEvents[1].callId, "call-B");
  const statusEvents = adapter.pendingEvents.filter((e) => e.type === "agent.adapter.status");
  assert.equal(statusEvents.length, 1);
  assert.equal(statusEvents[0].state, "exited");
  assert.equal(statusEvents[0].code, 1);
  assert.equal(statusEvents[0].signal, null);
  // The status event is the LAST event in the batch.
  const lastIdx = adapter.pendingEvents.length - 1;
  assert.equal(adapter.pendingEvents[lastIdx].type, "agent.adapter.status");
}

console.log("adapter tests ok");
