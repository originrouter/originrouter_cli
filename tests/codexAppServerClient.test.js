// Stage 8.1: focused tests over CodexAppServerClient without spawning a
// real Codex. The pattern mirrors tests/adapters.test.js (lines 53-79):
// stub `client.child.stdin` with a writable sink, push writes to an
// array, feed synthesized JSON-RPC lines into handleLine, and assert
// against captured events.
//
// The construction uses the test-only `rpcTimeoutMs` / `approvalTimeoutMs`
// options so timeout-sensitive tests don't take 30s.
//
// Stage 8.4: extended with `spawnFn` / `createInterfaceFn` / `forceKillMs`
// / `child` options for the lifecycle tests. The `child` option overrides
// the default fake child so tests can drive SIGTERM/SIGKILL/exit behavior
// without spawning a real Codex.

import assert from "node:assert/strict";
import { CodexAppServerClient } from "../src/adapters/codex/appServerClient.js";
import { mapCodexApprovalRequest } from "../src/adapters/codex/eventMapper.js";
import {
  buildCodexCollaborationMode,
  createSerialAgentEventQueue,
} from "../src/runtime/codexAppServerSession.js";
import {
  permissionEventToInteraction,
  INTERACTION_SOURCES,
} from "../src/runtime/agentInteractionContract.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

{
  assert.deepEqual(buildCodexCollaborationMode("plan", "gpt-5.4"), {
    mode: "plan",
    settings: {
      model: "gpt-5.4",
      reasoning_effort: null,
      developer_instructions: null,
    },
  });
  assert.throws(
    () => buildCodexCollaborationMode("plan", undefined),
    /requires a resolved model/,
  );
}

{
  const delivered = [];
  const queue = createSerialAgentEventQueue(async (event) => {
    if (event.type === "agent.text") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    delivered.push(event.type);
  });
  void queue.enqueue({ type: "agent.text" });
  void queue.enqueue({ type: "agent.task.complete" });
  await queue.drain();
  assert.deepEqual(delivered, ["agent.text", "agent.task.complete"]);
}

function makeFakeChild({ killed = false } = {}) {
  const handlers = {};
  const killSignals = [];
  const child = {
    killed,
    killSignals,
    stdout: { on() { /* readline owns this in production */ } },
    stderr: {
      on(event, fn) { handlers[`stderr:${event}`] = fn; },
      emit(event, data) { handlers[`stderr:${event}`]?.(data); },
    },
    stdin: { writable: true, write() { /* default noop; tests may override */ } },
    on(event, fn) { handlers[event] = fn; },
    emit(event, ...args) { handlers[event]?.(...args); },
    kill(sig) {
      killSignals.push(sig);
      this.killed = true;
    },
  };
  return child;
}

function makeClient(options = {}) {
  const client = new CodexAppServerClient({
    rpcTimeoutMs: options.rpcTimeoutMs ?? 30_000,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 30_000,
    forceKillMs: options.forceKillMs,
    spawnFn: options.spawnFn,
    createInterfaceFn: options.createInterfaceFn,
  });
  const writes = [];
  const fakeChild = options.child ?? makeFakeChild();
  // Merge in the writable stdin unless the caller supplied their own.
  if (!options.child) {
    fakeChild.stdin = {
      writable: true,
      write(data) {
        writes.push(JSON.parse(data));
      },
    };
  }
  client.child = fakeChild;
  const events = [];
  client.onEvent((event) => events.push(event));
  return { client, writes, events, child: fakeChild };
}

function feed(client, obj) {
  client.handleLine(JSON.stringify(obj));
}

// ---- 1. Raw turn completed dedup ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t1" } } });
  feed(client, { jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "t1", status: "complete" } } });
  feed(client, { jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "t1", status: "complete" } } });
  const completes = events.filter((e) => e.type === "task_complete");
  assert.equal(completes.length, 1, "duplicate turn/completed must be deduped");
  assert.equal(completes[0].turn_id, "t1");
  assert.equal(client.notificationProtocol, "raw");
}

// ---- 2. Interrupted maps to aborted (no prior turn/started) ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "t2", status: "interrupted" } } });
  const aborts = events.filter((e) => e.type === "turn_aborted");
  assert.equal(aborts.length, 1, "interrupted must close the turn via turnId alone");
  assert.equal(aborts[0].turn_id, "t2");
  assert.equal(aborts[0].status, "interrupted");
}

// ---- 3. cancelled / canceled / aborted all map to aborted ----

for (const status of ["cancelled", "canceled", "aborted"]) {
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "turn/started", params: { turn: { id: `t-${status}` } } });
  feed(client, { jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: `t-${status}`, status } } });
  const aborts = events.filter((e) => e.type === "turn_aborted");
  assert.equal(aborts.length, 1, `${status} must map to turn_aborted`);
}

// ---- 4. Thread idle fallback ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t-idle" } } });
  feed(client, { jsonrpc: "2.0", method: "thread/status/changed", params: { status: { type: "idle" } } });
  const completes = events.filter((e) => e.type === "task_complete");
  assert.equal(completes.length, 1, "idle must close the open turn once");
  // A follow-up turn/completed must NOT emit a duplicate.
  feed(client, { jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "t-idle", status: "complete" } } });
  assert.equal(
    events.filter((e) => e.type === "task_complete").length,
    1,
    "follow-up turn/completed must be a no-op after idle close",
  );
}

// ---- 5. Protocol lock raw (lifecycle-only) ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t-pl-raw" } } });
  assert.equal(client.notificationProtocol, "raw");
  // Lifecycle legacy wrapper is suppressed under raw lock.
  feed(client, { jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "task_started" } } });
  // Non-lifecycle legacy wrapper still passes through.
  feed(client, { jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "agent_message", message: "hi" } } });
  const started = events.filter((e) => e.type === "task_started");
  assert.equal(started.length, 1, "raw lifecycle must not duplicate via legacy wrapper");
  const agentMessages = events.filter((e) => e.type === "agent_message");
  assert.equal(agentMessages.length, 1, "non-lifecycle legacy wrapper still passes through under raw lock");
}

// ---- 6. Protocol lock legacy (lifecycle-only) ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "codex/event", params: { msg: { type: "task_started" } } });
  assert.equal(client.notificationProtocol, "legacy");
  // Raw lifecycle must NOT add a duplicate task_started under legacy lock.
  feed(client, { jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t-pl-legacy" } } });
  // Raw item/* still passes through under legacy lock.
  feed(client, { jsonrpc: "2.0", method: "item/started", params: { item: { id: "toolx", type: "commandExecution", command: "ls", cwd: "/" } } });
  const started = events.filter((e) => e.type === "task_started");
  assert.equal(started.length, 1, "raw lifecycle must not duplicate under legacy lock");
  const execBegins = events.filter((e) => e.type === "exec_command_begin");
  assert.equal(execBegins.length, 1, "raw item/started still passes through under legacy lock");
}

// ---- 7. agentMessage final closes turn ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t-am" } } });
  feed(client, {
    jsonrpc: "2.0",
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "msg1", text: "hello", phase: "final" } },
  });
  assert.equal(events.filter((e) => e.type === "agent_message").length, 1);
  assert.equal(events.filter((e) => e.type === "task_complete").length, 1);
}

// ---- 8. agentMessage non-final does not close ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t-stream" } } });
  feed(client, {
    jsonrpc: "2.0",
    method: "item/completed",
    params: { item: { type: "agentMessage", id: "msg2", text: "partial", phase: "streaming" } },
  });
  assert.equal(events.filter((e) => e.type === "agent_message").length, 1);
  assert.equal(events.filter((e) => e.type === "task_complete").length, 0, "non-final must not close turn");
}

// ---- 9. Unknown notification passthrough ----

{
  const { client, events } = makeClient();
  feed(client, { jsonrpc: "2.0", method: "foo/bar", params: { anything: 1 } });
  assert.equal(events.filter((e) => e.type === "codex.notification").length, 1);
}

// ---- 10. codex.initialized emit on successful initialize ----

{
  const { client, events } = makeClient();
  // Drive the readiness signal directly to avoid spawning a real Codex.
  client._emitReady();
  assert.equal(events.filter((e) => e.type === "codex.initialized").length, 1);
  const { client: client2, events: events2 } = makeClient();
  client2._emitInitError("boom");
  assert.equal(events2.filter((e) => e.type === "codex.initialize.error").length, 1);
  assert.equal(events2.filter((e) => e.type === "codex.initialized").length, 0);
}

// ---- 11. RPC timeout constant behavior ----

{
  const { client } = makeClient({ rpcTimeoutMs: 5 });
  // Writable stub never resolves; timer fires after 5ms.
  await assert.rejects(
    () => client.request("ping"),
    /codex app-server request timeout/,
  );
}

// ---- 12. Approval timeout (exec, non-legacy) ----

{
  const { client, writes, events } = makeClient({ approvalTimeoutMs: 10 });
  client.onApproval(() => new Promise(() => {})); // never resolves
  feed(client, {
    jsonrpc: "2.0",
    id: 101,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "exec-101", command: "rm -rf /", cwd: "/" },
  });
  await flush();
  await new Promise((r) => setTimeout(r, 25));
  const timeouts = events.filter((e) => e.type === "codex.approval.timeout");
  assert.equal(timeouts.length, 1, "exec timeout event must fire once");
  assert.equal(timeouts[0].callId, "exec-101", "timeout callId must match UI-visible callId");
  assert.equal(timeouts[0].approvalType, "exec");
  const decisions = writes.filter((w) => w.result && Object.prototype.hasOwnProperty.call(w.result, "decision"));
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].result, { decision: "decline" });
}

// ---- 13. Approval timeout (exec, legacy) ----

{
  const { client, writes, events } = makeClient({ approvalTimeoutMs: 10 });
  client.onApproval(() => new Promise(() => {}));
  feed(client, {
    jsonrpc: "2.0",
    id: 102,
    method: "execCommandApproval",
    params: { itemId: "exec-102", command: "ls" },
  });
  await flush();
  await new Promise((r) => setTimeout(r, 25));
  const decisions = writes.filter((w) => w.result && Object.prototype.hasOwnProperty.call(w.result, "decision"));
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].result, { decision: "denied" });
  assert.equal(events.filter((e) => e.type === "codex.approval.timeout").length, 1);
}

// ---- 14. Approval timeout (patch, non-legacy) ----

{
  const { client, writes } = makeClient({ approvalTimeoutMs: 10 });
  client.onApproval(() => new Promise(() => {}));
  feed(client, {
    jsonrpc: "2.0",
    id: 103,
    method: "item/fileChange/requestApproval",
    params: { itemId: "patch-103", fileChanges: {} },
  });
  await flush();
  await new Promise((r) => setTimeout(r, 25));
  const decisions = writes.filter((w) => w.result && Object.prototype.hasOwnProperty.call(w.result, "decision"));
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].result, { decision: "decline" });
}

// ---- 15. Approval timeout (mcp) ----

{
  const { client, writes } = makeClient({ approvalTimeoutMs: 10 });
  client.onApproval(() => new Promise(() => {}));
  feed(client, {
    jsonrpc: "2.0",
    id: 104,
    method: "mcpServer/elicitation/request",
    params: { serverName: "fs", message: "ok?" },
  });
  await flush();
  await new Promise((r) => setTimeout(r, 25));
  const actions = writes.filter((w) => w.result && Object.prototype.hasOwnProperty.call(w.result, "action"));
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].result, { action: "decline", content: null, _meta: null });
}

// ---- 16. Late approval ignored ----

{
  const { client, writes, events } = makeClient({ approvalTimeoutMs: 10 });
  client.onApproval(() => new Promise((resolve) => setTimeout(() => resolve("approved"), 100)));
  feed(client, {
    jsonrpc: "2.0",
    id: 105,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "exec-105", command: "echo" },
  });
  await flush();
  await new Promise((r) => setTimeout(r, 200));
  const decisions = writes.filter((w) => w.result && Object.prototype.hasOwnProperty.call(w.result, "decision"));
  assert.equal(decisions.length, 1, "exactly one response, even with late approval");
  assert.deepEqual(decisions[0].result, { decision: "decline" });
  assert.equal(events.filter((e) => e.type === "codex.approval.timeout").length, 1);
}

// ---- 17. Disconnect clears timers ----

{
  const { client } = makeClient({ rpcTimeoutMs: 30_000 });
  const promise = client.request("ping");
  // No response is fed; timer would fire in 30s. Disconnect must reject now.
  client.disconnect();
  await assert.rejects(() => promise, /disconnected/, "disconnect must reject pending request");
}

// ---- 18. Stage 8.4: processEpoch increments on connect() ----

{
  const fakeChild = makeFakeChild();
  const c = new CodexAppServerClient({});
  c.spawnFn = () => fakeChild;
  c.createInterfaceFn = () => ({ on() {}, close() {} });
  // Stub stdin so request() can write.
  fakeChild.stdin = { writable: true, write() {} };
  c.child = fakeChild;
  assert.equal(c.processEpoch, 0, "fresh client starts at epoch 0");
  // Drive connect() — the initialize request writes to stdin and
  // would otherwise hang. We feed a synthetic initialize response.
  const connectPromise = c.connect();
  // Find the initialize request id (first id issued = 1).
  await flush();
  // Feed the response.
  c.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: 1, result: { protocolVersion: "v1" },
  }));
  await connectPromise;
  assert.equal(c.processEpoch, 1, "first connect() bumps processEpoch to 1");
}

// ---- 19. Stage 8.4: stale stdout ignored ----

{
  const { client } = makeClient();
  // Force the next pending entry to look like it came from epoch 0.
  const captured = {};
  client.pending.set(99, {
    resolve: (v) => { captured.resolve = v; },
    reject: (e) => { captured.reject = e; },
    method: "ping",
    timer: setTimeout(() => {}, 60_000),
    epoch: 0,
  });
  // Bump the live epoch so the response is from a previous process.
  client.processEpoch = 2;
  feed(client, { jsonrpc: "2.0", id: 99, result: { ok: true } });
  assert.equal(captured.resolve, undefined, "stale response must not resolve");
  assert.equal(captured.reject, undefined, "stale response must not reject");
  assert.equal(client.pending.has(99), false, "stale pending entry must be cleared");
}

// ---- 20. Stage 8.4: stale stderr ignored ----

{
  // Drive a real connect() so the stderr listener is registered, then
  // bump the epoch and emit a stderr chunk to the captured handler.
  const fakeChild = makeFakeChild();
  const c = new CodexAppServerClient({});
  c.spawnFn = () => fakeChild;
  c.createInterfaceFn = () => ({ on() {}, close() {} });
  fakeChild.stdin = { writable: true, write() {} };
  c.child = fakeChild;
  const events = [];
  c.onEvent((e) => events.push(e));
  const connectPromise = c.connect();
  await flush();
  c.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  await connectPromise;
  // Now bump the epoch and emit stderr.
  const beforeCount = events.filter((e) => e.type === "codex.stderr").length;
  c.processEpoch = 99;
  fakeChild.stderr.emit("data", Buffer.from("old noise"));
  const afterCount = events.filter((e) => e.type === "codex.stderr").length;
  assert.equal(afterCount, beforeCount, "stale stderr must not be forwarded");
}

// ---- 21. Stage 8.4: stale _handleChildExit ignored ----

{
  const { client, events } = makeClient();
  client.processEpoch = 2;
  client._handleChildExit({ code: 1, signal: null, epoch: 1 });
  const exits = events.filter((e) => e.type === "codex.app_server.exit");
  assert.equal(exits.length, 0, "stale epoch exit must not emit codex.app_server.exit");
  assert.equal(client.childExited, false, "stale epoch exit must not flip childExited");
}

// ---- 22. Stage 8.4: current exit rejects pending RPC ----

{
  const { client } = makeClient();
  const captured = {};
  client.pending.set(7, {
    resolve: (v) => { captured.resolve = v; },
    reject: (e) => { captured.reject = e; },
    method: "ping",
    timer: setTimeout(() => {}, 60_000),
    epoch: client.processEpoch,
  });
  client._handleChildExit({ code: 1, signal: null, epoch: client.processEpoch });
  assert.equal(client.pending.size, 0, "pending map must be cleared");
  assert.ok(captured.reject instanceof Error, "pending RPC must be rejected");
  assert.match(captured.reject.message, /codex app-server exited \(code=1, signal=null\)/);
}

// ---- 23. Stage 8.4: current exit clears approval timers ----

{
  const { client } = makeClient();
  let cleared = 0;
  const fakeTimer = setTimeout(() => {}, 60_000);
  // Wrap clearTimeout via a Proxy? Simpler: monkey-patch the timer.
  const original = fakeTimer._onTimeout;
  // Track clearTimeout via a side channel: replace _approvalTimers
  // values with a wrapper whose clearTimeout is observable.
  // Instead, just verify the map is cleared and the timer would
  // not fire (we don't wait).
  client._approvalTimers.set(11, { timer: fakeTimer, epoch: client.processEpoch });
  assert.equal(client._approvalTimers.size, 1);
  client._handleChildExit({ code: 0, signal: null, epoch: client.processEpoch });
  assert.equal(client._approvalTimers.size, 0, "approval timers must be cleared");
  clearTimeout(fakeTimer); // avoid leak; ignore `cleared` counter
  void cleared; void original;
}

// ---- 24. Stage 8.4: disconnect is idempotent ----

{
  const { client, child } = makeClient();
  client.disconnect();
  client.disconnect();
  client.disconnect();
  // SIGTERM should have been sent exactly once.
  const termCount = child.killSignals.filter((s) => s === "SIGTERM").length;
  assert.equal(termCount, 1, "disconnect must send SIGTERM exactly once");
}

// ---- 25. Stage 8.4: disconnect escalates to SIGKILL ----

{
  // Use a small forceKillMs so the test runs in <100ms. The fake
  // child's `killed` getter is a controllable flag — see makeFakeChild.
  const { client, child, events } = makeClient({ forceKillMs: 5 });
  // Mark the fake child as not-yet-killed before disconnect.
  child.killed = false;
  client.disconnect();
  // First call sends SIGTERM and schedules the SIGKILL timer.
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  // Wait past the force-kill window.
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"], "SIGKILL must follow SIGTERM");
  const forceKills = events.filter((e) => e.type === "codex.app_server.force_kill");
  assert.equal(forceKills.length, 1, "force_kill event must fire");
}

// ---- 26. Stage 8.4: real exit clears the force-kill timer ----

{
  const { client, child, events } = makeClient({ forceKillMs: 20 });
  child.killed = false;
  // Drive a real connect() so the exit listener is live.
  const fakeChild = makeFakeChild();
  fakeChild.killed = false;
  // Reuse the writable stdin from `child` (we only swapped it).
  fakeChild.stdin = child.stdin;
  const c = new CodexAppServerClient({ forceKillMs: 20 });
  c.spawnFn = () => fakeChild;
  c.createInterfaceFn = () => ({ on() {}, close() {} });
  c.child = fakeChild;
  const evs = [];
  c.onEvent((e) => evs.push(e));
  const connectPromise = c.connect();
  await flush();
  c.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  await connectPromise;
  c.disconnect();
  // SIGTERM was sent.
  assert.deepEqual(fakeChild.killSignals, ["SIGTERM"]);
  // Drive the real exit BEFORE the 20ms timer fires. The exit
  // listener still uses the current epoch (processEpoch unchanged),
  // so _handleChildExit runs and clears the timer.
  fakeChild.emit("exit", 0, null);
  // Wait past the would-be SIGKILL deadline.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fakeChild.killSignals.length, 1, "SIGKILL must not be sent after real exit");
  assert.equal(c.childExited, true, "childExited must be true after real exit");
  const exits = evs.filter((e) => e.type === "codex.app_server.exit");
  assert.equal(exits.length, 1, "codex.app_server.exit must fire on real exit");
  // Suppress unused references.
  void client; void child; void events;
}

// ---- 27. Stage 8.4: request timeout respects epoch ----

{
  const { client } = makeClient({ rpcTimeoutMs: 10 });
  const captured = {};
  client.pending.set(42, {
    resolve: (v) => { captured.resolve = v; },
    reject: (e) => { captured.reject = e; },
    method: "ping",
    timer: setTimeout(() => {}, 60_000), // long; we want the rpcTimeoutMs timer to win
    epoch: 0,
  });
  // Bump the live epoch so the captured entry is stale.
  client.processEpoch = 7;
  // Wait past rpcTimeoutMs — the timer callback should be a no-op
  // because the captured epoch is stale.
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(captured.reject, undefined, "stale epoch request must not reject");
  assert.equal(client.pending.has(42), true, "stale epoch request must remain in map (timer was a no-op)");
  // Cleanup.
  clearTimeout(client.pending.get(42).timer);
  client.pending.delete(42);
}

// ---- 28. Stage 8.4: approval timeout respects epoch ----

{
  const { client, writes, events } = makeClient({ approvalTimeoutMs: 10 });
  client.onApproval(() => new Promise(() => {})); // never resolves
  feed(client, {
    jsonrpc: "2.0",
    id: 200,
    method: "item/commandExecution/requestApproval",
    params: { itemId: "exec-200", command: "echo", cwd: "/" },
  });
  await flush();
  // Bump the live epoch BEFORE the 10ms approval timer fires.
  client.processEpoch = 99;
  await new Promise((r) => setTimeout(r, 25));
  const timeouts = events.filter((e) => e.type === "codex.approval.timeout");
  assert.equal(timeouts.length, 0, "stale epoch approval must not fire codex.approval.timeout");
  const decisions = writes.filter((w) => w.result && Object.prototype.hasOwnProperty.call(w.result, "decision"));
  assert.equal(decisions.length, 0, "stale epoch approval must not write a response");
}

// ---- 29. Stage 8.4: late approval resolution respects epoch ----

{
  const { client, writes } = makeClient({ approvalTimeoutMs: 1_000 });
  let resolveApproval;
  const promise = client.withApprovalTimeout({
    id: 201,
    method: "item/commandExecution/requestApproval",
    callId: "exec-201",
    approvalType: "exec",
    legacy: false,
    fn: () => new Promise((resolve) => { resolveApproval = resolve; }),
  });
  // Simulate a new process epoch before the UI decision returns.
  client.processEpoch = 1;
  resolveApproval({ decision: "decline" });
  await promise;
  assert.equal(writes.length, 0, "late stale approval must not write to the current child");
  assert.equal(client._approvalTimers.size, 0, "late stale approval must clean its timer entry");
}

// ---- 30. Stage 8.4: disconnect during initialize does not emit init error ----

{
  const fakeChild = makeFakeChild();
  const c = new CodexAppServerClient({
    forceKillMs: 50,
    spawnFn: () => fakeChild,
    createInterfaceFn: () => ({ on() {}, close() {} }),
  });
  const events = [];
  c.onEvent((e) => events.push(e));
  const connectPromise = c.connect();
  await flush();
  c.disconnect();
  await connectPromise;
  fakeChild.emit("exit", null, "SIGTERM");
  const initErrors = events.filter((e) => e.type === "codex.initialize.error");
  assert.equal(initErrors.length, 0, "intentional disconnect during initialize must not emit init error");
  const exits = events.filter((e) => e.type === "codex.app_server.exit");
  assert.equal(exits.length, 1, "real exit after disconnect must still be emitted");
}

// ---- Stage 8.6: Codex app-server env contract (cases 31–34) ----
//
// The connect() handshake is async (it waits for the initialize
// response before resolving). captureSpawnEnv() drives the handshake
// to completion so the pending RPC timer is cleared and tests do not
// leak state between cases. The captured options.env is read only
// after `await connect()` returns.

async function captureSpawnEnv(env) {
  let capturedOptions = null;
  const fakeChild = makeFakeChild();
  const c = new CodexAppServerClient({
    spawnFn: (_cmd, _args, opts) => {
      capturedOptions = opts;
      return fakeChild;
    },
    createInterfaceFn: () => ({ on() {}, close() {} }),
  });
  fakeChild.stdin = { writable: true, write() {} };
  c.child = fakeChild;

  const connectPromise = c.connect({ env });
  await flush();
  c.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: 1, result: { protocolVersion: "v1" },
  }));
  await connectPromise;
  return capturedOptions.env;
}

// ---- 31. Stage 8.6: RUST_LOG default applied when env.RUST_LOG is absent ----

{
  const env = await captureSpawnEnv({});
  assert.equal(env.RUST_LOG, "codex_core::rollout::list=off",
    "OriginRouter must inject the default RUST_LOG filter when caller did not set one");
}

// ---- 32. Stage 8.6: caller-supplied RUST_LOG wins ----

{
  const env = await captureSpawnEnv({ RUST_LOG: "debug" });
  assert.equal(env.RUST_LOG, "debug",
    "caller-supplied RUST_LOG must be preserved verbatim");
}

// ---- 33. Stage 8.6: CODEX_SANDBOX not injected by default ----

{
  const env = await captureSpawnEnv({});
  assert.equal("CODEX_SANDBOX" in env, false,
    "OriginRouter must NOT inject CODEX_SANDBOX by default");
}

// ---- 34. Stage 8.6: caller-supplied CODEX_SANDBOX preserved ----

{
  const env = await captureSpawnEnv({ CODEX_SANDBOX: "seatbelt" });
  assert.equal(env.CODEX_SANDBOX, "seatbelt",
    "caller-supplied CODEX_SANDBOX must be preserved verbatim");
}

// ---- 35. Stage 8.9: structural round-trip via permissionEventToInteraction ----

{
  let capturedArgs = null;
  const fakeChild = makeFakeChild();
  const c = new CodexAppServerClient({
    spawnFn: (_cmd, args) => {
      capturedArgs = args;
      return fakeChild;
    },
    createInterfaceFn: () => ({ on() {}, close() {} }),
  });
  fakeChild.stdin = { writable: true, write() {} };
  const connectPromise = c.connect({
    env: { OPENAI_API_KEY: "test-key" },
    modelProvider: {
      id: "originrouter_proxy",
      name: "OriginRouter Route",
      baseUrl: "http://127.0.0.1:40123/v1",
      envKey: "OPENAI_API_KEY",
      wireApi: "responses",
    },
  });
  await flush();
  c.handleLine(JSON.stringify({
    jsonrpc: "2.0", id: 1, result: { protocolVersion: "v1" },
  }));
  await connectPromise;
  assert.deepEqual(capturedArgs.slice(0, 3), [
    "app-server",
    "-c",
    'model_provider="originrouter_proxy"',
  ]);
  assert.ok(capturedArgs.includes('model_providers.originrouter_proxy.base_url="http://127.0.0.1:40123/v1"'));
  assert.ok(capturedArgs.includes('model_providers.originrouter_proxy.wire_api="responses"'));
  assert.deepEqual(capturedArgs.slice(-2), ["--listen", "stdio://"]);
  c.disconnect();
}

// ---- 36. Stage 8.9: structural round-trip via permissionEventToInteraction ----

{
  const legacy = mapCodexApprovalRequest({
    method: "item/commandExecution/requestApproval",
    callId: "codex-perm-1",
    params: { command: "ls", cwd: "/tmp/proj" },
  });
  const interaction = permissionEventToInteraction(legacy, {
    source: INTERACTION_SOURCES.APP_SERVER,
    sessionId: "s-test",
  });
  assert.equal(interaction.interactionId, legacy.callId,
    "new envelope's interactionId equals the legacy callId from the Codex mapper");
  assert.equal(interaction.kind, "permission");
  assert.equal(interaction.source, "app-server");
  assert.equal(interaction.resolution.eventType, "agent.interaction.resolve",
    "new envelope always carries the new eventType");
}

// ---- 36. Managed app-server request and thread helpers ----

{
  const { client, writes } = makeClient();
  client.onServerRequest(async ({ method, params }) => {
    assert.equal(method, "item/tool/requestUserInput");
    assert.equal(params.itemId, "question-1");
    return { answers: { target: { answers: ["staging"] } } };
  });
  feed(client, {
    jsonrpc: "2.0",
    id: 90,
    method: "item/tool/requestUserInput",
    params: { itemId: "question-1" },
  });
  await flush();
  assert.deepEqual(writes.at(-1), {
    jsonrpc: "2.0",
    id: 90,
    result: { answers: { target: { answers: ["staging"] } } },
  });

  const threadPromise = client.startThread({ cwd: "/tmp/project" });
  const threadRequest = writes.at(-1);
  assert.equal(threadRequest.method, "thread/start");
  feed(client, {
    jsonrpc: "2.0",
    id: threadRequest.id,
    result: { thread: { id: "thread-1" } },
  });
  assert.equal((await threadPromise).thread.id, "thread-1");
}

// ---- 37. Stop-current-task uses Codex turn/interrupt ----

{
  const { client, writes } = makeClient();
  const interruptPromise = client.interruptTurn("thread-stop-1", "turn-stop-1");
  const request = writes.at(-1);
  assert.equal(request.method, "turn/interrupt");
  assert.deepEqual(request.params, {
    threadId: "thread-stop-1",
    turnId: "turn-stop-1",
  });
  feed(client, {
    jsonrpc: "2.0",
    id: request.id,
    result: {},
  });
  await interruptPromise;
}

console.log("codex app-server client tests ok");
