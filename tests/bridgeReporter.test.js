import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimeEventEnvelope,
  buildAgentConversationMetadata,
  createRuntimeEventReporter,
  pollResolvedApprovals,
  reportAgentConversationMetadata,
  reportAgentHistoryChunk,
  reportAgentHistoryManifest,
  reconcileAgentCatalogPreview,
  reportAgentSessionHeartbeat,
  reportLocalControlRuntime,
  reportRuntimeEvent,
  startApprovalDecisionPolling,
  shouldSyncAgentActivitySnapshot,
  updateAgentActivitySnapshot,
} from "../src/agent/bridgeReporter.js";
import { agentActivityMetadataFromCatalog } from "../src/agent/agentActivityCatalogSync.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";
import { accountStateDir, activateAccount } from "../src/persistence/accounts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("catalog and history uploads reject credentials from another account", async () => {
  const accountA = "sha256:account-a";
  const accountB = "sha256:account-b";
  const expectedAccountStateDir = accountStateDir("/tmp/originrouter-account-test", accountA);
  let requests = 0;
  const options = { stateDir: "/tmp/originrouter-account-test", expectedAccountStateDir,
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ accountScope: accountB, deviceId: "device-1" }),
    fetchFn: async () => { requests++; return { ok: true, status: 200, json: async () => ({}) }; } };
  const metadata = await reportAgentConversationMetadata({ conversationId: "c1" }, options);
  const preview = await reconcileAgentCatalogPreview({ conversation_id: "c1", field: "summary",
    previous_value: "old", next_value: "new" }, options);
  const history = await reportAgentHistoryChunk({ device_id: "device-1" }, options);
  const manifest = await reportAgentHistoryManifest("start", { conversation_id: "c1", content_version: 1 }, options);
  const event = await reportRuntimeEvent({ session_id: "s1", event_type: "agent.ready" }, options);
  const heartbeat = await reportAgentSessionHeartbeat("s1", options);
  const approvals = await pollResolvedApprovals({ sessionId: "s1", ...options });
  for (const result of [metadata, preview, history, manifest, event, heartbeat, approvals]) {
    assert.equal(result.ok, false);
    assert.equal(result.error, "account_context_changed");
  }
  assert.equal(requests, 0);
  const noAccount = await reportAgentConversationMetadata({ conversationId: "c1" }, {
    ...options, expectedAccountStateDir: "/tmp/originrouter-account-test",
  });
  assert.equal(noAccount.error, "account_context_changed");
  const sameAccount = await reportAgentConversationMetadata({ conversationId: "c1" }, {
    ...options, ensureFreshAccessTokenFn: async () => makeOAuthCredential({ accountScope: accountA, deviceId: "device-1" }),
  });
  assert.equal(sameAccount.ok, true);
  assert.equal(requests, 1);
});

test("manifest reporter requires a valid confirmation and fails closed on old servers", async () => {
  const credential = makeOAuthCredential({ deviceId: "device-1" });
  const options = { ensureFreshAccessTokenFn: async () => credential,
    fetchFn: async () => ({ ok: false, status: 404, json: async () => ({}) }) };
  assert.equal((await reportAgentHistoryManifest("start", {}, options)).error, "http_404");
  options.fetchFn = async () => ({ ok: false, status: 409, json: async () => ({ detail: { code: "history_version_stale" } }) });
  assert.equal((await reportAgentHistoryManifest("start", {}, options)).error, "history_version_stale");
  options.fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { state: "queued" } }) });
  assert.equal((await reportAgentHistoryManifest("complete", {}, options)).error, "invalid_manifest_response");
  options.fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { state: "already_stored" } }) });
  assert.equal((await reportAgentHistoryManifest("start", {}, options)).error, "invalid_manifest_response");
  options.fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { state: "stored" } }) });
  assert.equal((await reportAgentHistoryManifest("complete", {}, options)).ok, true);
  options.fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { pending_chunk_ids: ["other"], published: false } }) });
  assert.equal((await reportAgentHistoryManifest("status", { chunk_ids: ["one"] }, options)).error, "invalid_manifest_response");
  options.fetchFn = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { pending_chunk_ids: ["one"], published: false } }) });
  assert.deepEqual((await reportAgentHistoryManifest("status", { chunk_ids: ["one"] }, options)).pendingChunkIds, ["one"]);
});

test("approval decisions arriving after an account change are discarded", async () => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-approval-account-"));
  const accountA = "sha256:account-a";
  const scopedA = activateAccount(root, accountA);
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  try {
    const pending = pollResolvedApprovals({ sessionId: "s1", stateDir: scopedA,
      expectedAccountStateDir: scopedA, accountSelectionRoot: root,
      ensureFreshAccessTokenFn: async () => makeOAuthCredential({ accountScope: accountA }),
      fetchFn: async () => { requestStarted(); await waiting; return { ok: true, status: 200,
        json: async () => ({ data: { approvals: [{ approval_id: "a1", decision: "allow" }] } }) }; },
    });
    await started;
    activateAccount(root, "sha256:account-b");
    release();
    const result = await pending;
    assert.equal(result.error, "account_context_changed");
    assert.deepEqual(result.approvals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account selection change during token refresh prevents catalog upload", async () => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-upload-account-"));
  const accountA = "sha256:account-a";
  const accountB = "sha256:account-b";
  const scopedA = activateAccount(root, accountA);
  let release;
  const token = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  try {
    const pending = reportAgentConversationMetadata({ conversationId: "c1" }, {
      stateDir: scopedA, expectedAccountStateDir: scopedA, accountSelectionRoot: root,
      ensureFreshAccessTokenFn: () => token,
      fetchFn: async () => { requests++; return { ok: true, status: 200 }; },
    });
    activateAccount(root, accountB);
    release(makeOAuthCredential({ accountScope: accountA }));
    assert.equal((await pending).error, "account_context_changed");
    assert.equal(requests, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("runtime events carry only the CLI-computed workspace display path", () => {
  const payload = buildRuntimeEventEnvelope({
    sessionId: "s1",
    agentType: "claude",
    title: "Claude session",
    deviceName: "Mac Studio",
    workspaceDisplayPath: "~/Desktop/originrouter_app",
    eventType: "agent.ready",
  });

  assert.equal(payload.workspace_display_path, "~/Desktop/originrouter_app");
  assert.equal("workspace_path" in payload, false);
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
    workspaceDisplayPath: "~/Desktop/originrouter_app",
    runtime: "codex-app-server",
    provider: "originrouter-cloud",
    model: "gpt-codex",
    permissionProfile: "guarded",
    summary: "Use token=or_at_secretvalue123 for the task",
    firstPromptPreview: "Investigate Relay auth with api_key=sk-secretvalue123",
    lastMessagePreview: "Authorization: Bearer or_at_anothersecret123",
    transcriptPath: "/private/transcript.jsonl",
    workspacePath: "/private/project",
    prompt: "private prompt",
    command: "rm -rf secret",
    createdAt: 1782871200,
    lastActivityAt: "2026-07-01T02:10:00Z",
  });

  assert.equal(payload.conversation_id, "conversation-1");
  assert.equal(payload.native_session_id, "thread-1");
  assert.equal(payload.workspace_name, "originrouter_app");
  assert.equal(payload.workspace_display_path, "~/Desktop/originrouter_app");
  assert.equal("transcript_path" in payload, false);
  assert.equal("workspace_path" in payload, false);
  assert.equal("prompt" in payload, false);
  assert.equal("command" in payload, false);
  assert.equal(payload.summary.includes("or_at_secretvalue123"), false);
  assert.equal(payload.first_prompt_preview.includes("sk-secretvalue123"), false);
  assert.equal(payload.last_message_preview.includes("or_at_anothersecret123"), false);
  assert.equal(payload.created_at, "2026-07-01T02:00:00.000Z");
  assert.equal(payload.last_activity_at, "2026-07-01T02:10:00.000Z");
});

test("redaction cannot make catalog fields exceed their schema limits", () => {
  const input = `${"a".repeat(1011)} sk-abcdefgh`;
  const payload = buildAgentConversationMetadata({ conversationId: "c1", lastMessagePreview: input });
  assert.ok(payload.last_message_preview.length <= 1024);
  assert.equal(payload.last_message_preview.includes("sk-abcdefgh"), false);
  const title = buildAgentConversationMetadata({ conversationId: "c1", title: `${"a".repeat(178)} sk-abcdefgh` });
  assert.ok(title.title.length <= 191);
  assert.equal(title.title.includes("sk-abcdefgh"), false);
});

test("catalog projection does not emit invalid Unicode at a truncation boundary", () => {
  const value = `${"a".repeat(1023)}😀`;
  const payload = buildAgentConversationMetadata({ conversationId: "c1", lastMessagePreview: value });
  assert.equal(payload.last_message_preview.length, 1023);
  assert.equal(payload.last_message_preview.isWellFormed(), true);
  assert.equal(payload.last_message_preview.includes("�"), false);
});

test("Agent Activity snapshot preserves idea, result, and task summary", () => {
  const snapshot = {};
  updateAgentActivitySnapshot(snapshot, {
    type: "user.text",
    text: "Could Relay switch automatically?",
  });
  updateAgentActivitySnapshot(snapshot, {
    type: "agent.text",
    text: "Prefer LAN and fall back to cloud Relay.",
  });
  updateAgentActivitySnapshot(snapshot, {
    type: "agent.task.complete",
    summary: "Implemented automatic Relay selection.",
  });

  assert.equal(snapshot.firstPromptPreview, "Could Relay switch automatically?");
  assert.equal(snapshot.lastMessagePreview, "Prefer LAN and fall back to cloud Relay.");
  assert.equal(snapshot.summary, "Implemented automatic Relay selection.");
});

test("Agent Activity sync recognizes Claude SDK completion aliases", () => {
  const snapshot = {};
  const event = {
    type: "agent.task.completed",
    result: "Finished the Relay migration.",
  };

  assert.equal(shouldSyncAgentActivitySnapshot(event), true);
  updateAgentActivitySnapshot(snapshot, event);
  assert.equal(snapshot.summary, "Finished the Relay migration.");
  assert.equal(
    shouldSyncAgentActivitySnapshot({ type: "agent.tool_call.start" }),
    false,
  );
});

test("Agent Activity completion falls back to the last assistant answer", () => {
  const snapshot = {};
  updateAgentActivitySnapshot(snapshot, {
    type: "agent.text",
    text: "The migration and regression tests are complete.",
  });
  updateAgentActivitySnapshot(snapshot, {
    type: "agent.task.complete",
    status: "complete",
  });
  assert.equal(
    snapshot.summary,
    "The migration and regression tests are complete.",
  );
});

test("Agent Activity metadata retries without source times for an old server", async () => {
  const bodies = [];
  const result = await reportAgentConversationMetadata(
    {
      conversationId: "conversation-legacy-server",
      agentType: "claude",
      createdAt: "2026-07-01T02:00:00Z",
      lastActivityAt: "2026-07-01T02:10:00Z",
    },
    {
      stateDir: "/tmp/originrouter-missing-auth",
      ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
      fetchFn: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return bodies.length === 1
          ? { ok: false, status: 422 }
          : { ok: true, status: 200 };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.legacyFallback, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].created_at, "2026-07-01T02:00:00.000Z");
  assert.equal("created_at" in bodies[1], false);
  assert.equal("last_activity_at" in bodies[1], false);
});

test("catalog report exposes the saved cloud row and rejects an unrelated row", async () => {
  const saved = { conversation_id: "session", title: "Cloud rename", title_is_custom: true };
  const options = {
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ data: { conversation: saved } }) }),
  };
  const result = await reportAgentConversationMetadata({ conversationId: "session", title: "Old local title" }, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.conversation, saved);
  const unrelated = await reportAgentConversationMetadata({ conversationId: "other" }, options);
  assert.equal(unrelated.ok, true);
  assert.equal(unrelated.conversation, undefined);
});

test("preview reconciliation redacts both sides and requires a valid server acknowledgment", async () => {
  const requests = [];
  const change = { conversation_id: "c1", field: "last_message_preview",
    previous_value: "api_key=sk-oldsecret12345", next_value: "api_key=sk-newsecret12345 done" };
  const options = { stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async (url, request) => {
      const body = JSON.parse(request.body);
      requests.push({ url, body });
      return { ok: true, status: 200, json: async () => ({ code: 0,
        data: { previews: { last_message_preview: body.last_message_preview.value } } }) };
    },
  };
  assert.equal((await reconcileAgentCatalogPreview(change, options)).applied, true);
  assert.match(requests[0].url, /\/reconcile-previews$/);
  assert.equal(JSON.stringify(requests[0].body).includes("oldsecret"), false);
  assert.equal(JSON.stringify(requests[0].body).includes("newsecret"), false);
  const invalid = await reconcileAgentCatalogPreview(change, { ...options,
    fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }) });
  assert.equal(invalid.ok, false);
  const badField = await reconcileAgentCatalogPreview({ ...change, field: "__proto__" }, options);
  assert.equal(badField.ok, false);
});

test("preview comparison uses exactly the catalog projection at length and newline boundaries", async () => {
  const raw = `${"a".repeat(1019)}\r\nsecret tail`;
  const projected = buildAgentConversationMetadata(agentActivityMetadataFromCatalog({
    conversation_id: "c1", last_message_preview: raw,
  })).last_message_preview;
  let body;
  const result = await reconcileAgentCatalogPreview({ conversation_id: "c1",
    field: "last_message_preview", previous_value: raw, next_value: "new" }, {
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async (_url, request) => {
      body = JSON.parse(request.body);
      return { ok: true, status: 200, json: async () => ({ code: 0,
        data: { previews: { last_message_preview: "new" } } }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(body.last_message_preview.expected, projected);
});

test("preview reconciliation preserves valid Unicode after truncation", async () => {
  const raw = `${"a".repeat(1023)}😀`;
  let body;
  const result = await reconcileAgentCatalogPreview({ conversation_id: "c1",
    field: "last_message_preview", previous_value: raw, next_value: raw }, {
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async (_url, request) => {
      body = JSON.parse(request.body);
      return { ok: true, status: 200, json: async () => ({ code: 0,
        data: { previews: { last_message_preview: body.last_message_preview.value } } }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(body.last_message_preview.expected.isWellFormed(), true);
  assert.equal(body.last_message_preview.value.isWellFormed(), true);
});

test("reconciled previews stay within schema limits after secret replacement", async () => {
  const raw = `${"a".repeat(1011)} sk-abcdefgh`;
  let body;
  const result = await reconcileAgentCatalogPreview({ conversation_id: "c1",
    field: "last_message_preview", previous_value: raw, next_value: raw }, {
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async (_url, request) => {
      body = JSON.parse(request.body);
      return { ok: true, status: 200, json: async () => ({ code: 0,
        data: { previews: { last_message_preview: body.last_message_preview.value } } }) };
    },
  });
  assert.equal(result.ok, true);
  assert.ok(body.last_message_preview.expected.length <= 1024);
  assert.ok(body.last_message_preview.value.length <= 1024);
  assert.equal(JSON.stringify(body).includes("sk-abcdefgh"), false);
});

for (const status of [404, 422]) {
  test(`insert-only backfill never falls back to ordinary writes on ${status}`, async () => {
    const requests = [];
    const result = await reportAgentConversationMetadata(
      { conversationId: "old", sessionId: "session", agentType: "claude",
        createdAt: "2026-07-01T02:00:00Z" },
      {
        insertOnly: true,
        stateDir: "/tmp/originrouter-missing-auth",
        ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
        fetchFn: async (url, options) => {
          requests.push({ url, body: JSON.parse(options.body) });
          return { ok: false, status };
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/catalog\/conversations\/backfill$/);
    assert.equal(requests[0].body.session_id, "session");
    assert.ok(requests[0].body.created_at);
  });
}

test("the report carries the link to the session the run belongs to", () => {
  // The device is the only side that knows both ids: the run was started
  // under a session id, and the conversation is the book that run lives in.
  const payload = buildAgentConversationMetadata({
    conversationId: "agc_7d2Lp0",
    sessionId: "ags_9F3kQ2",
    agentType: "claude",
    title: "Fix the callback",
  });

  assert.equal(payload.session_id, "ags_9F3kQ2");
});

test("a server that does not know the link still gets the report", async () => {
  // The cloud may be older than the device. Its schema forbids fields it
  // does not know, so the report is sent again without the link — and the
  // sync is not told the timestamp protocol is unavailable, because the
  // timestamps were never dropped.
  const bodies = [];
  const result = await reportAgentConversationMetadata(
    {
      conversationId: "agc_7d2Lp0",
      sessionId: "ags_9F3kQ2",
      agentType: "claude",
      createdAt: "2026-07-01T02:00:00Z",
    },
    {
      stateDir: "/tmp/originrouter-missing-auth",
      ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
      fetchFn: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return bodies.length === 1
          ? { ok: false, status: 422 }
          : { ok: true, status: 200 };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.legacyFallback, false);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].session_id, "ags_9F3kQ2");
  assert.equal("session_id" in bodies[1], false);
  assert.equal(bodies[1].created_at, "2026-07-01T02:00:00.000Z");
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
      providers: [
        {
          name: "originrouter-cloud",
          type: "originrouter",
          model: "gpt-5.4",
          models: ["gpt-5.4", "gpt-5-mini"],
          apiKey: "must-not-leak",
          baseUrl: "https://private.example.test",
        },
      ],
      routes: [
        {
          agent: "codex",
          slot: "main",
          provider: "originrouter-cloud",
          model: "gpt-5.4",
        },
      ],
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
    remote_share_e2ee_policy: "off",
    remote_share_e2ee_public_key: "",
    agent_detail_profile: "concise",
    agent_budgets: {},
    providers: [
      {
        name: "originrouter-cloud",
        type: "originrouter",
        litellmProvider: "",
        model: "gpt-5.4",
        models: [
          { id: "gpt-5.4", enabled: true, remoteEnabled: false },
          { id: "gpt-5-mini", enabled: true, remoteEnabled: false },
        ],
        target: "",
        deviceId: "",
      },
    ],
    routes: [
      {
        agent: "codex",
        slot: "main",
        provider: "originrouter-cloud",
        model: "gpt-5.4",
      },
    ],
  });
});

test("device budget reporting preserves excluded usage counts", async () => {
  let reported;
  await reportLocalControlRuntime({ agentBudgets: {
    device: { policy: { currency: "EUR" }, daily: { amount_micros: 500, unpriced_events: 2, other_currency_events: 3 } },
  } }, {
    stateDir: "/tmp/originrouter-missing-auth",
    ensureFreshAccessTokenFn: async () => makeOAuthCredential({ deviceId: "device-1" }),
    fetchFn: async (_url, options) => { reported = JSON.parse(options.body); return { ok: true, status: 200 }; },
  });
  assert.equal(reported.agent_budgets.device.policy.currency, "EUR");
  assert.equal(reported.agent_budgets.device.daily.unpriced_events, 2);
  assert.equal(reported.agent_budgets.device.daily.other_currency_events, 3);
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

test("unified permission interactions remain approval requests", () => {
  const payload = buildRuntimeEventEnvelope({
    sessionId: "session-1",
    agentType: "codex",
    title: "Review auth",
    eventType: "agent.event",
    event: {
      type: "agent.interaction.requested",
      interactionId: "permission-3",
      kind: "permission",
      tool: "Bash",
      payload: { redacted: true },
    },
  });

  assert.equal(payload.event_type, "approval_requested");
  assert.equal(payload.status, "waiting_approval");
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
  assert.equal(exited.event_type, "session_terminated");
  assert.equal(exited.status, "failed");
  assert.equal(stopped.event_type, "session_terminated");
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

test("the session's own model reaches the cloud, and nothing about the device's catalogue", () => {
  // The session states its own model. The models the device serves stay on the
  // device: they go out in the local-control provider snapshot, and the App
  // reads them there. A copy per event would be a stale duplicate.
  const model = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.model.status",
      model: "deepseek-chat",
      modelProvider: "deepseek",
      source: "session",
      modelControl: "supported",
      availableModels: [
        { id: "deepseek-chat", provider: "deepseek", providerName: "DeepSeek" },
        { id: "gpt-5-codex", provider: "openai-codex", providerName: "OpenAI" },
      ],
    },
  });
  assert.equal(model.model, "deepseek-chat");
  assert.equal(model.model_provider, "deepseek");
  assert.equal(model.model_source, "session");
  assert.equal(model.model_control, "supported");
  assert.equal("available_models" in model, false);
});

test("a session on the device route states no model of its own", () => {
  // An empty model is a state — the session follows the device route — and
  // the cloud must be able to tell it from a device that said nothing.
  const model = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.model.status",
      model: null,
      modelProvider: null,
      source: "device",
      modelControl: "supported",
      availableModels: [{ id: "deepseek-chat", provider: "deepseek" }],
    },
  });
  assert.equal(model.model, "");
  assert.equal(model.model_provider, "");
  assert.equal(model.model_source, "device");
  assert.equal("available_models" in model, false);
});

test("a refusal reaches the cloud with the device's reason", () => {
  // The refusal is the only way the App learns that the change it asked for
  // did not happen: the session row says what the session runs on, and the
  // command's own answer says only that the command arrived.
  const refusal = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.model.status",
      model: null,
      modelProvider: null,
      source: "device",
      modelControl: "unsupported",
      accepted: false,
      reason: "model_control_unsupported",
    },
  });
  assert.equal(refusal.model_accepted, false);
  assert.equal(refusal.model_reason, "model_control_unsupported");
});

test("a status that was not asked about says nothing about being accepted", () => {
  // Null is "the device was not asked" — the status only states what the
  // session runs on. False would be a refusal, and the App must not mistake
  // one for the other.
  const status = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.model.status",
      model: "deepseek-chat",
      modelProvider: "deepseek",
      source: "session",
      modelControl: "supported",
    },
  });
  assert.equal(status.model_accepted, null);
  assert.equal(status.model_reason, "");
});

test("another event carries no model's acceptance", () => {
  const other = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.ready",
      accepted: false,
      reason: "not-a-model-event",
    },
  });
  assert.equal(other.model_accepted, null);
  assert.equal(other.model_reason, "");
});

test("interaction delivery failures do not close the long-lived session", () => {
  const approvalFailure = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.permission.resolve.error",
      interactionId: "permission-1",
    },
  });
  const inputFailure = buildRuntimeEventEnvelope({
    sessionId: "session-managed",
    agentType: "claude",
    title: "Managed Claude",
    eventType: "agent.event",
    event: {
      type: "agent.interaction.failed",
      interactionId: "input-1",
      reason: "delivery_timeout",
    },
  });

  assert.equal(approvalFailure.event_type, "approval_failed");
  assert.equal(approvalFailure.status, "running");
  assert.equal(inputFailure.event_type, "interaction_failed");
  assert.equal(inputFailure.status, "running");
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

test("runtime telemetry preserves gateway ids and measurable facts", async () => {
  const queued = [];
  const reporter = createRuntimeEventReporter({
    sessionId: "session-facts",
    agentType: "claude",
    title: "Facts session",
    telemetryQueue: {
      enqueue(input, context) {
        queued.push({ input, context });
        return { inserted: true };
      },
    },
  });

  reporter.report("agent.event", {
    event: {
      type: "agent.task.completed",
      provider: "claude",
      gatewayResponseId: "msg_gateway_1",
      durationMs: 1234,
      amountMicros: 456,
      currency: "USD",
      costSource: "configured",
      verificationPassed: true,
      retryCount: 2,
      metadata: { verification: "passed" },
    },
  });
  await reporter.flush();

  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].input.gatewayResponseIds, ["msg_gateway_1"]);
  assert.equal(queued[0].input.payload.duration_ms, 1234);
  assert.equal(queued[0].input.payload.amount_micros, 456);
  assert.equal(queued[0].input.payload.verification_passed, true);
  assert.equal(queued[0].input.payload.task_completed, true);
  assert.equal(queued[0].input.payload.retry_count, 2);
});

test("runtime reporter does not treat an empty session exit as a task result", async () => {
  const reported = [];
  const reporter = createRuntimeEventReporter({
    sessionId: "session-empty",
    agentType: "claude",
    title: "Empty session",
    reportRuntimeEventFn: async (payload) => {
      reported.push(payload);
      return { ok: true };
    },
  });

  reporter.report("session.started", {});
  reporter.report("session.exited", { code: 0, signal: null });
  await reporter.flush();

  assert.deepEqual(reported.map((item) => item.event_type), [
    "session_started",
    "session_terminated",
  ]);
  assert.equal(reported[1].status, "completed");
  assert.equal(reported.some((item) => item.event_type === "task_result_ready"), false);
});

test("runtime reporter creates one task outcome for an active structured task", async () => {
  const reported = [];
  const reporter = createRuntimeEventReporter({
    sessionId: "session-task",
    agentType: "claude",
    title: "Task session",
    reportRuntimeEventFn: async (payload) => {
      reported.push(payload);
      return { ok: true };
    },
  });

  reporter.report("agent.event", { event: { type: "agent.task.started" } });
  reporter.report("agent.event", { event: { type: "agent.task.completed" } });
  reporter.report("session.exited", { code: 0, signal: null });
  await reporter.flush();

  assert.deepEqual(reported.map((item) => item.event_type), [
    "agent.task.started",
    "task_result_ready",
    "session_terminated",
  ]);

  const failing = [];
  const failureReporter = createRuntimeEventReporter({
    sessionId: "session-failure",
    agentType: "claude",
    title: "Failure session",
    reportRuntimeEventFn: async (payload) => {
      failing.push(payload);
      return { ok: true };
    },
  });
  failureReporter.report("agent.event", { event: { type: "agent.task.started" } });
  failureReporter.report("session.exited", { code: 1, signal: null });
  await failureReporter.flush();

  assert.deepEqual(failing.map((item) => item.event_type), [
    "agent.task.started",
    "task_failed",
  ]);
});

test("disabled runtime reporter keeps collaboration workers out of ordinary server activity", async () => {
  let calls = 0;
  const reporter = createRuntimeEventReporter({
    enabled: false,
    sessionId: "collab-worker-1",
    agentType: "claude",
    reportRuntimeEventFn: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  await reporter.report("agent.event", { event: { type: "agent.text", text: "hidden" } });
  await reporter.flush();
  assert.equal(calls, 0);
});

test("runtime events omit native_session_id until the provider names the conversation", () => {
  const before = buildRuntimeEventEnvelope({
    sessionId: "s1",
    agentType: "claude",
    title: "Claude session",
    eventType: "agent.ready",
  });
  assert.equal("native_session_id" in before, false);

  const after = buildRuntimeEventEnvelope({
    sessionId: "s1",
    agentType: "claude",
    nativeSessionId: "6f1c0e2a9d3b4a778e5f0b2c7d41a8e3",
    title: "Claude session",
    eventType: "agent.ready",
  });
  assert.equal(after.native_session_id, "6f1c0e2a9d3b4a778e5f0b2c7d41a8e3");
});

test("the reporter reads nativeSessionId per report, so a late id still travels", async () => {
  const sent = [];
  let nativeSessionId = "";
  const reporter = createRuntimeEventReporter({
    sessionId: "s1",
    agentType: "claude",
    nativeSessionId: () => nativeSessionId,
    title: "Claude session",
    enabled: true,
    reportRuntimeEventFn: async (payload) => {
      sent.push(payload);
      return { ok: true };
    },
  });

  await reporter.report("agent.ready");
  assert.equal("native_session_id" in sent[0], false);

  // The SDK names the conversation mid-run; later reports must carry it.
  nativeSessionId = "6f1c0e2a9d3b4a778e5f0b2c7d41a8e3";
  await reporter.report("agent.tool_call.start");
  assert.equal(sent[1].native_session_id, "6f1c0e2a9d3b4a778e5f0b2c7d41a8e3");
});
