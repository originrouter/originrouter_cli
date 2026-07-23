import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeEventEnvelope,
  buildAgentConversationMetadata,
  createRuntimeEventReporter,
  createTerminalActivityReporter,
  pollResolvedApprovals,
  reportAgentSessionHeartbeat,
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

test("buildAgentConversationMetadata excludes transcript prompt command and path data", () => {
  const payload = buildAgentConversationMetadata({
    conversationId: "conversation-1",
    agentType: "codex",
    nativeSessionId: "thread-1",
    title: "Fix checkout",
    status: "running",
    workspaceId: "workspace-1",
    workspaceName: "originrouter_app",
    runtime: "codex-app-server",
    provider: "originrouter-cloud",
    model: "gpt-codex",
    permissionProfile: "guarded",
    transcriptPath: "/private/transcript.jsonl",
    workspacePath: "/private/project",
    prompt: "private prompt",
    command: "rm -rf secret",
  });

  assert.equal(payload.conversation_id, "conversation-1");
  assert.equal(payload.native_session_id, "thread-1");
  assert.equal(payload.workspace_name, "originrouter_app");
  assert.equal("transcript_path" in payload, false);
  assert.equal("workspace_path" in payload, false);
  assert.equal("prompt" in payload, false);
  assert.equal("command" in payload, false);
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

test("reportRuntimeEvent uses relay access token and device id header", async () => {
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
        assert.equal(resource, "originrouter.relay");
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
  assert.equal(called.options.headers.Authorization, "Bearer or_at_relay_test");
  assert.equal(called.options.headers["X-OriginRouter-Device-Id"], "device-1");
});

test("reportAgentSessionHeartbeat refreshes presence without an event body", async () => {
  let called = null;
  const result = await reportAgentSessionHeartbeat("session/one", {
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async (url, options) => {
      called = { url: String(url), options };
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.ok, true);
  assert.match(called.url, /\/cli\/v1\/agent\/sessions\/session%2Fone\/heartbeat$/);
  assert.equal(called.options.method, "POST");
  assert.equal(called.options.body, undefined);
  assert.equal(called.options.headers.Authorization, "Bearer or_at_relay_test");
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
  assert.equal(called.options.headers.Authorization, "Bearer or_at_relay_test");
  assert.equal(called.options.headers["X-OriginRouter-Device-Id"], "device-1");
  assert.deepEqual(JSON.parse(called.options.body), {
    cli_running: true,
    cli_version: "1.2.3",
    cli_uptime_seconds: 42,
    proxy_running: true,
    proxy_base_url: "http://127.0.0.1:15432",
    remote_share_running: false,
    remote_share_base_url: "",
    remote_share_catalog: [],
    agent_detail_profile: "concise",
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
      assert.equal(options.headers.Authorization, "Bearer or_at_relay_test");
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
    interactionId: "call-1",
    sessionId: "session-1",
    runtimeDecision: "approved_for_session",
    rememberForSession: true,
    decidedAt: 123,
  });
  assert.deepEqual(result.approvals[1], {
    approvalId: "call-2",
    interactionId: "call-2",
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
      approvalId: "call-1",
      callId: "call-1",
      interactionId: "call-1",
      decision: "approved_for_session",
      decisionSource: "app_remote",
    },
  ]);
});

test("startApprovalDecisionPolling retries when the adapter rejects delivery", async () => {
  let attempts = 0;
  const stop = startApprovalDecisionPolling({
    sessionId: "session-retry",
    intervalMs: 20,
    timeoutMs: 50,
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            approvals: [{
              approval_id: "approval-public",
              interaction_id: "runtime-call",
              session_id: "session-retry",
              decision: "allow",
              remember_for_session: false,
              decided_at: 123,
            }],
          },
        };
      },
    }),
    onDecision: () => {
      attempts += 1;
      return attempts >= 2;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 650));
  stop();
  assert.equal(attempts, 2);
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
  assert.equal(reported[0].event, undefined);
  assert.equal(JSON.stringify(reported[0]).includes("Running tests"), false);
});

test("buildRuntimeEventEnvelope projects approvals without forwarding raw input", () => {
  const payload = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "codex",
    title: "Review auth",
    deviceName: "Worker Mac",
    eventType: "agent.event",
    sequence: 3,
    clientEventId: "orev-3",
    event: {
      type: "agent.interaction.requested",
      interactionId: "call-3",
      tool: "Bash",
      input: {
        command: "sudo rm -rf /tmp/example",
        secret: "must-not-cross-the-network",
      },
    },
  });

  assert.equal(payload.event_type, "approval_requested");
  assert.equal(payload.interaction_id, "call-3");
  assert.equal(payload.risk_level, "high");
  assert.equal(payload.command_preview, "");
  assert.equal(JSON.stringify(payload).includes("sudo rm -rf /tmp/example"), false);
  assert.equal(payload.sequence, 3);
  assert.equal(payload.client_event_id, "orev-3");
  assert.equal(payload.event, undefined);
  assert.equal(JSON.stringify(payload).includes("must-not-cross-the-network"), false);
});

test("buildRuntimeEventEnvelope maps wrapper lifecycle events to server vocabulary", () => {
  const started = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "claude",
    title: "Session",
    eventType: "session.started",
  });
  const exited = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "claude",
    title: "Session",
    eventType: "session.exited",
    event: { code: 1, signal: null },
  });
  const stopped = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "claude",
    title: "Session",
    eventType: "session.exited",
    event: { code: null, signal: "SIGHUP" },
  });

  assert.equal(started.event_type, "session_started");
  assert.equal(started.status, "running");
  assert.equal(exited.event_type, "session_failed");
  assert.equal(exited.status, "failed");
  assert.equal(stopped.event_type, "session_stopped");
  assert.equal(stopped.status, "stopped");
});

test("buildRuntimeEventEnvelope projects managed interactions and mode state", () => {
  const interaction = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.interaction.requested",
      interactionId: "ask-1",
      kind: "questions",
      title: "Choose a target",
      prompt: "Where should this deploy?",
      containsSecret: true,
      payload: {
        questions: [{ id: "target", options: [{ label: "Staging" }] }],
        response: { must_not_cross: true },
      },
    },
  });
  assert.equal(interaction.event_type, "interaction_requested");
  assert.equal(interaction.summary, "Agent input required");
  assert.equal(interaction.action, "questions");
  assert.equal("interaction_payload" in interaction, false);
  assert.equal("interaction_contains_secret" in interaction, false);
  assert.equal(JSON.stringify(interaction).includes("must_not_cross"), false);

  const mode = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.mode.status",
      mode: "plan",
      modeControl: "supported",
      availableModes: [{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }],
    },
  });
  assert.equal(mode.mode, "plan");
  assert.equal(mode.mode_control, "supported");
  assert.equal(mode.available_modes.length, 2);
});

test("buildRuntimeEventEnvelope normalizes SDK aliases and drops raw events", () => {
  const completed = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "claude",
    title: "Session",
    eventType: "agent.event",
    event: { type: "agent.task.completed" },
  });
  const raw = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "claude",
    title: "Session",
    eventType: "agent.event",
    event: { type: "agent.raw", payload: { secret: "hidden" } },
  });
  const text = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "claude",
    title: "Session",
    eventType: "agent.event",
    event: { type: "agent.text", text: "private response body" },
  });
  const activity = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "claude",
    title: "Session",
    eventType: "agent.event",
    event: {
      type: "agent.activity",
      activity: "context_compacted",
      summary: "Claude compacted the conversation context",
      detail: "trigger=auto",
      metadata: { secret: "must not persist" },
    },
  });

  assert.equal(completed.event_type, "agent.task.complete");
  assert.equal(completed.status, "running");
  assert.equal(raw, null);
  assert.equal(text.summary, "Assistant response received");
  assert.equal(JSON.stringify(text).includes("private response body"), false);
  assert.equal(activity.event_type, "agent.activity");
  assert.equal(activity.summary, "Claude compacted the conversation context");
  assert.equal(activity.detail, "trigger=auto");
  assert.equal(JSON.stringify(activity).includes("must not persist"), false);
});

test("createRuntimeEventReporter serializes events and deduplicates dual approval envelopes", async () => {
  const reported = [];
  const reporter = createRuntimeEventReporter({
    sessionId: "session-ordered",
    agentType: "codex",
    title: "Ordered session",
    deviceName: "Worker Mac",
    reportRuntimeEventFn: async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, payload.sequence === 1 ? 20 : 0));
      reported.push(payload);
      return { ok: true };
    },
  });

  reporter.report("session.started", {});
  reporter.report("agent.event", {
    event: {
      type: "agent.permission.request.detected",
      callId: "call-dual",
      tool: "Read",
      input: { path: "/tmp/example" },
    },
  });
  reporter.report("agent.event", {
    event: {
      type: "agent.interaction.requested",
      interactionId: "call-dual",
      tool: "Read",
      input: { path: "/tmp/example" },
    },
  });
  reporter.report("agent.event", {
    event: { type: "agent.task.complete" },
  });
  await reporter.flush();

  assert.deepEqual(reported.map((item) => item.sequence), [1, 2, 3]);
  assert.deepEqual(reported.map((item) => item.event_type), [
    "session_started",
    "approval_requested",
    "agent.task.complete",
  ]);
  assert.equal(new Set(reported.map((item) => item.client_event_id)).size, 3);
});
