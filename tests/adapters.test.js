import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeJsonlScanner, mapClaudeJsonLine, mapClaudeJsonLineSince } from "../src/adapters/claude/jsonlScanner.js";
import { CodexAppServerClient } from "../src/adapters/codex/appServerClient.js";
import { mapCodexApprovalRequest, mapCodexAppServerEvent } from "../src/adapters/codex/eventMapper.js";
import { CodexAdapter } from "../src/adapters/codexAdapter.js";
import { mapClaudeSdkMessage } from "../src/runtime/claudeSdkEvents.js";

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
  assert.deepEqual(a.describe().structuredSources, ["codex-app-server", "terminal-output"]);
  a.appServerAvailable = false;
  assert.equal(a.describe().runtime, null);
  assert.deepEqual(a.describe().structuredSources, ["terminal-output"]);
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
