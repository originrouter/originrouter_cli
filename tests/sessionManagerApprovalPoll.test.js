import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "../src/daemon/sessionManager.js";

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
