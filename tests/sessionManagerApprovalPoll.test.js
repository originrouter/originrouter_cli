import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "../src/daemon/sessionManager.js";

test("SessionManager applies the resolved Codex model before building the launch", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-session-model-test-"));
  process.env.ORIGINROUTER_HOME = home;
  let routedModel = null;
  let startOptions = null;
  let exitHandler = null;

  const telemetryEvents = [];

  const manager = new SessionManager({
    relayClient: { send: () => Promise.resolve() },
    deviceId: "device-test",
    defaultExecutor: "fake",
    telemetry: {
      queue: {
        enqueue(input, context) {
          telemetryEvents.push({ input, context });
          return { inserted: false };
        },
      },
    },
    createAdapterFn: () => ({
      async beforeStart() {},
      setRoutedModel(model) {
        routedModel = model;
      },
      buildLaunch() {
        assert.equal(routedModel, "gpt-5.6-sol");
        return {
          command: "codex",
          args: ["--model", routedModel],
          env: { OPENAI_MODEL: routedModel },
        };
      },
      describe: () => ({ runtime: "codex-pty" }),
      handleOutput: () => [],
      cleanup() {},
    }),
    createExecutorFn: () => ({
      async start(options) {
        startOptions = options;
        exitHandler = options.onExit;
        return { pid: 2468, executor: "fake" };
      },
      write() {},
      resize() {},
      interrupt() {},
      stop() {},
    }),
    buildAgentProviderEnvFn: async () => ({
      env: {
        OPENAI_BASE_URL: "https://api.example.test/codex",
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "gpt-5.6-sol",
      },
      provider: { name: "originrouter-cloud", type: "proxy", model: "gpt-5.6-sol" },
      source: "test",
    }),
    startApprovalDecisionPollingFn: () => () => {},
  });

  await manager.startSession({
    sessionId: "session-model-1",
    agent: "codex",
    cwd: "/tmp",
  });

  assert.equal(routedModel, "gpt-5.6-sol");
  assert.deepEqual(startOptions.args, ["--model", "gpt-5.6-sol"]);
  assert.equal(startOptions.env.OPENAI_MODEL, "gpt-5.6-sol");
  const startedTelemetry = telemetryEvents.find(({ input }) => input.eventType === "session_started");
  assert.ok(startedTelemetry, "session startup emits telemetry with the resolved Provider");
  assert.equal(startedTelemetry.context.providerSource, "test");
  assert.equal(startedTelemetry.context.providerType, "proxy");
  assert.equal(startedTelemetry.context.provider, "originrouter-cloud");
  assert.equal(startedTelemetry.context.model, "gpt-5.6-sol");

  const exitPromise = manager.sessions.get("session-model-1").exitPromise;
  exitHandler?.({ code: 0, signal: null });
  await exitPromise;
  assert.ok(telemetryEvents.some(({ input, context }) => (
    input.eventType === "session_terminated" && context.provider === "originrouter-cloud"
  )));
  rmSync(home, { recursive: true, force: true });
});

test("SessionManager reports adapter beforeStart failures with telemetry enabled", async () => {
  const previousHome = process.env.ORIGINROUTER_HOME;
  const home = mkdtempSync(join(tmpdir(), "originrouter-session-telemetry-error-"));
  process.env.ORIGINROUTER_HOME = home;
  const sent = [];
  const telemetryEvents = [];
  try {
    const manager = new SessionManager({
      relayClient: { send: async (type, payload) => { sent.push({ type, payload }); } },
      deviceId: "device-test",
      defaultExecutor: "fake",
      telemetry: {
        queue: {
          enqueue(input, context) {
            telemetryEvents.push({ input, context });
            return { inserted: false };
          },
        },
      },
      createAdapterFn: () => ({
        async beforeStart() { throw new Error("adapter unavailable"); },
      }),
      createExecutorFn: () => ({}),
    });
    const start = manager.startSession({ sessionId: "session-telemetry-error", agent: "terminal" });
    const exitPromise = manager.sessions.get("session-telemetry-error").exitPromise;
    await start;
    await exitPromise;
    assert.equal(manager.sessions.size, 0);
    assert.ok(sent.some(({ type, payload }) => (
      type === "session.error" && payload.message === "adapter unavailable"
    )));
    assert.equal(telemetryEvents[0].input.eventType, "session_runtime_error");
    // Provider resolution now runs before adapter.beforeStart(), because the
    // Claude adapter writes its --settings file there and that file carries
    // the transport override built from the resolved route. A beforeStart
    // failure therefore reports the resolved provider context rather than an
    // empty one; "none" is providers.js's value for an agent with no provider
    // configured, which is correct for the terminal agent used here.
    assert.equal(telemetryEvents[0].context.providerSource, "none");
    assert.equal(telemetryEvents[0].context.provider, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.ORIGINROUTER_HOME;
    else process.env.ORIGINROUTER_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionManager feeds polled approval decisions back into the running adapter", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-session-manager-test-"));
  process.env.ORIGINROUTER_HOME = home;
  const sent = [];
  let pollArgs = null;
  let stoppedPolling = false;
  let exitHandler = null;
  let errorHandler = null;

  const fakeAdapter = {
    resolved: [],
    async beforeStart() {},
    buildLaunch() {
      return { command: "bash", args: [], env: {} };
    },
    describe() {
      return { runtime: "test-runtime" };
    },
    handleOutput() {
      return [];
    },
    resolvePermission(payload) {
      this.resolved.push(payload);
    },
    cleanup() {},
  };

  const fakeExecutor = {
    async start({ onExit, onError }) {
      exitHandler = onExit;
      errorHandler = onError;
      return { pid: 4321, executor: "fake" };
    },
    write() {},
    resize() {},
    interrupt() {},
    stop() {},
  };

  const manager = new SessionManager({
    relayClient: {
      send(type, payload) {
        sent.push({ type, payload });
        return Promise.resolve();
      },
    },
    deviceId: "device-test",
    defaultExecutor: "fake",
    createAdapterFn: () => fakeAdapter,
    createExecutorFn: () => fakeExecutor,
    buildAgentProviderEnvFn: async () => ({ env: {}, provider: null, source: "test" }),
    startApprovalDecisionPollingFn: (args) => {
      pollArgs = args;
      return () => {
        stoppedPolling = true;
      };
    },
  });

  await manager.startSession({
    sessionId: "session-approval-1",
    agent: "terminal",
    command: "bash",
    args: [],
    cwd: "/tmp",
    title: "Approval loop",
  });

  assert.ok(pollArgs, "approval poller should start for daemon sessions");
  assert.equal(pollArgs.sessionId, "session-approval-1");

  pollArgs.onDecision({
    type: "agent.permission.resolve",
    sessionId: "session-approval-1",
    callId: "apr_test",
    decision: "approved_for_session",
  });

  assert.deepEqual(fakeAdapter.resolved, [
    {
      type: "agent.permission.resolve",
      sessionId: "session-approval-1",
      callId: "apr_test",
      decision: "approved_for_session",
    },
  ]);

  assert.ok(
    sent.some((item) => item.type == "session.started"),
    "session.started should still be emitted",
  );

  exitHandler?.({ code: 0, signal: null });
  assert.equal(stoppedPolling, true, "approval poller should stop when the session exits");
  assert.equal(typeof errorHandler, "function");
  rmSync(home, { recursive: true, force: true });
});

test("SessionManager shutdown stops sessions and reports their exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "originrouter-session-shutdown-test-"));
  process.env.ORIGINROUTER_HOME = home;
  const sent = [];
  let exitHandler = null;
  let stopCalls = 0;

  const manager = new SessionManager({
    relayClient: {
      send(type, payload) {
        sent.push({ type, payload });
        return Promise.resolve();
      },
    },
    deviceId: "device-test",
    defaultExecutor: "fake",
    createAdapterFn: () => ({
      async beforeStart() {},
      buildLaunch: () => ({ command: "bash", args: [], env: {} }),
      describe: () => ({ runtime: "test-runtime" }),
      handleOutput: () => [],
      cleanup() {},
    }),
    createExecutorFn: () => ({
      async start({ onExit }) {
        exitHandler = onExit;
        return { pid: 9876, executor: "fake" };
      },
      write() {},
      resize() {},
      interrupt() {},
      stop() {
        stopCalls += 1;
        exitHandler?.({ code: null, signal: "SIGTERM" });
      },
    }),
    buildAgentProviderEnvFn: async () => ({ env: {}, provider: null, source: "test" }),
    startApprovalDecisionPollingFn: () => () => {},
  });

  await manager.startSession({
    sessionId: "session-shutdown-1",
    agent: "terminal",
    command: "bash",
    args: [],
    cwd: "/tmp",
  });
  await manager.shutdown("SIGTERM");

  assert.equal(stopCalls, 1);
  assert.equal(manager.sessions.size, 0);
  assert.ok(sent.some((item) => item.type === "session.exited"));
  rmSync(home, { recursive: true, force: true });
});
