import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeEventEnvelope,
  createTerminalActivityReporter,
  pollResolvedApprovals,
  reportLocalControlRuntime,
  reportRuntimeEvent,
  startApprovalDecisionPolling,
} from "../src/agent/bridgeReporter.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

test("buildRuntimeEventEnvelope normalizes and truncates strings", () => {
  const payload = buildRuntimeEventEnvelope({
    sessionId: "s1\n",
    agentType: "codex",
    title: "A".repeat(300),
    deviceName: "Mac\nStudio",
    eventType: "agent.tool_call.start",
    summary: "B".repeat(600),
  });

  assert.equal(payload.session_id, "s1");
  assert.equal(payload.device_name, "Mac Studio");
  assert.equal(payload.title.length, 191);
  assert.equal(payload.summary.length, 512);
});

test("reportRuntimeEvent fails closed without coding auth", async () => {
  const result = await reportRuntimeEvent(
    buildRuntimeEventEnvelope({
      sessionId: "s1",
      agentType: "codex",
      title: "Test",
      eventType: "session.started",
    }),
    {
      stateDir: "/tmp/originrouter-missing-auth",
      fetchFn: async () => {
        throw new Error("should not fetch");
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "no_access_token");
});

test("reportRuntimeEvent uses control access token and device id header", async () => {
  let called = null;
  const result = await reportRuntimeEvent(
    buildRuntimeEventEnvelope({
      sessionId: "s1",
      agentType: "codex",
      title: "Test",
      eventType: "session.started",
    }),
    {
      stateDir: "/tmp/originrouter-missing-auth",
      ensureFreshAccessTokenFn: async ({ resource }) => {
        assert.equal(resource, "originrouter.control");
        return makeOAuthCredential({ deviceId: "device-1" });
      },
      fetchFn: async (url, options) => {
        called = { url: String(url), options };
        return { ok: true, status: 200 };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.match(called.url, /\/cli\/v1\/agent\/runtime-event$/);
  assert.equal(called.options.headers.Authorization, "Bearer or_at_control_test");
  assert.equal(called.options.headers["X-OriginRouter-Device-Id"], "device-1");
});

test("reportLocalControlRuntime posts display-safe daemon status", async () => {
  let called = null;
  const result = await reportLocalControlRuntime(
    {
      cliRunning: true,
      cliVersion: "1.2.3",
      cliUptimeSeconds: 42,
      proxyRunning: true,
      proxyBaseUrl: "http://127.0.0.1:15432",
    },
    {
      stateDir: "/tmp/originrouter-missing-auth",
      ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
      fetchFn: async (url, options) => {
        called = { url: String(url), options };
        return { ok: true, status: 200 };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.match(called.url, /\/cli\/v1\/local-control\/runtime$/);
  assert.equal(called.options.headers.Authorization, "Bearer or_at_control_test");
  assert.equal(called.options.headers["X-OriginRouter-Device-Id"], "device-1");
  assert.deepEqual(JSON.parse(called.options.body), {
    cli_running: true,
    cli_version: "1.2.3",
    cli_uptime_seconds: 42,
    proxy_running: true,
    proxy_base_url: "http://127.0.0.1:15432",
  });
});

test("pollResolvedApprovals maps decided approvals into runtime decisions", async () => {
  let calledUrl = null;
  const result = await pollResolvedApprovals({
    sessionId: "session-1",
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async (url, options) => {
      calledUrl = String(url);
      assert.equal(options.headers.Authorization, "Bearer or_at_control_test");
      assert.equal(options.headers["X-OriginRouter-Device-Id"], "device-1");
      return {
        ok: true,
        async json() {
          return {
            data: {
              approvals: [
                {
                  approval_id: "call-1",
                  session_id: "session-1",
                  decision: "allow",
                  remember_for_session: true,
                  decided_at: 123,
                },
                {
                  approval_id: "call-2",
                  session_id: "session-1",
                  decision: "deny",
                  remember_for_session: false,
                  decided_at: 124,
                },
              ],
            },
          };
        },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.match(calledUrl, /session_id=session-1/);
  assert.equal(result.approvals.length, 2);
  assert.deepEqual(result.approvals[0], {
    approvalId: "call-1",
    sessionId: "session-1",
    runtimeDecision: "approved_for_session",
    rememberForSession: true,
    decidedAt: 123,
  });
  assert.deepEqual(result.approvals[1], {
    approvalId: "call-2",
    sessionId: "session-1",
    runtimeDecision: "denied",
    rememberForSession: false,
    decidedAt: 124,
  });
});

test("startApprovalDecisionPolling emits mapped permission resolves once", async () => {
  const decisions = [];
  let fetchCalls = 0;
  const stop = startApprovalDecisionPolling({
    sessionId: "session-1",
    intervalMs: 20,
    timeoutMs: 50,
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() {
          return {
            data: {
              approvals: [
                {
                  approval_id: "call-1",
                  session_id: "session-1",
                  decision: "allow",
                  remember_for_session: true,
                  decided_at: 123,
                },
              ],
            },
          };
        },
      };
    },
    onDecision: (payload) => decisions.push(payload),
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  assert.ok(fetchCalls >= 1);
  assert.deepEqual(decisions, [
    {
      type: "agent.permission.resolve",
      sessionId: "session-1",
      callId: "call-1",
      interactionId: "call-1",
      decision: "approved_for_session",
    },
  ]);
});

test("createTerminalActivityReporter emits display-safe terminal activity summaries", async () => {
  const reported = [];
  const reporter = createTerminalActivityReporter({
    sessionId: "session-1",
    agentType: "codex",
    title: "Runtime session",
    deviceName: "Mac Studio",
    flushIntervalMs: 20,
    reportRuntimeEventFn: async (payload) => {
      reported.push(payload);
      return { ok: true };
    },
  });

  reporter.ingest("\u001b[31mRunning tests\u001b[0m\nline two\n");
  reporter.ingest("line three");
  await new Promise((resolve) => setTimeout(resolve, 60));
  reporter.stop();

  assert.equal(reported.length, 1);
  assert.equal(reported[0].event_type, "terminal.activity");
  assert.equal(reported[0].summary, "Terminal activity detected");
  assert.deepEqual(reported[0].event, {
    chunk_count: 2,
    line_count: 3,
    byte_count: Buffer.byteLength("\u001b[31mRunning tests\u001b[0m\nline two\n", "utf8")
      + Buffer.byteLength("line three", "utf8"),
  });
  assert.equal(JSON.stringify(reported[0]).includes("Running tests"), false);
});
