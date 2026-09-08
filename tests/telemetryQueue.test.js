import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { TelemetryQueue, normalizeTelemetryEvent } from "../src/telemetry/telemetryQueue.js";
import { TelemetryUploader } from "../src/telemetry/telemetryUploader.js";
import { buildRunBundle } from "../src/telemetry/runBundle.js";

test("normalizeTelemetryEvent keeps Cloud gateway ids opaque and drops internal ids", () => {
  const event = normalizeTelemetryEvent({
    event_id: "te_1",
    event_type: "agent.response",
    response_ids: ["resp_abc", "msg_def", "chatcmpl-ghi", "terminal:local"],
    payload: { token_usage: { input_tokens: 10 } },
  }, { providerSource: "originrouter-coding", runId: "acr_test" });
  assert.deepEqual(event.gateway_response_ids, ["resp_abc", "msg_def", "chatcmpl-ghi"]);
  assert.equal(event.cloud_route, true);
});

test("normalizeTelemetryEvent retains execution facts but never transcript-like payload fields", () => {
  const event = normalizeTelemetryEvent({
    event_id: "te_facts_only",
    event_type: "agent.event",
    task_id: "task_1",
    delegation_id: "delegation_1",
    delegation_detected: true,
    payload: {
      text: "user prompt must never be uploaded",
      summary: "agent response must never be uploaded",
      content: "terminal output must never be uploaded",
      tool: "exec",
      duration_ms: 42,
      token_usage: { input_tokens: 12, output_tokens: 8, hidden_prompt: "no" },
      metadata: {
        subagent_type: "research",
        task_subject: "private task text",
        cwd: "/private/path",
      },
    },
  }, { runId: "acr_facts" });
  assert.deepEqual(event.payload, {
    tool: "exec",
    duration_ms: 42,
    token_usage: { input_tokens: 12, output_tokens: 8 },
    metadata: { subagent_type: "research" },
  });
  assert.equal(event.root_task_id, "task_1");
  assert.equal(event.delegation_detected, true);
});

test("normalizeTelemetryEvent preserves retry and rework facts", () => {
  const event = normalizeTelemetryEvent({
    event_type: "task.retry_scheduled",
    payload: { rework_requested: true, retry_scheduled: true },
  }, { runId: "acr_retry" });
  assert.equal(event.payload.rework_requested, true);
  assert.equal(event.payload.retry_scheduled, true);
});

test("only a Run terminal event completes a bundle and queue ownership stays local", () => {
  const childExit = buildRunBundle("acr_terminal", [{
    event_id: "te_child_exit",
    event_type: "session_terminated",
    occurred_at: "2026-09-08T00:00:00.000Z",
    run_id: "acr_terminal",
    bundle_origin: "collaboration_run",
    account_session_id: "session_a",
    payload: {},
  }]);
  assert.equal(childExit.terminal, false);
  assert.equal(childExit.bundle.run_status, "incomplete");
  assert.equal("account_session_id" in childExit.bundle.events[0], false);

  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-owner-"));
  const queue = new TelemetryQueue({ stateDir });
  queue.enqueue({ event_id: "te_a", event_type: "run.completed" }, {
    runId: "acr_a", accountSessionId: "session_a", trainingEligible: true,
  });
  queue.enqueue({ event_id: "te_b", event_type: "run.completed" }, {
    runId: "acr_b", accountSessionId: "session_b", trainingEligible: true,
  });
  assert.deepEqual(queue.pending({ accountSessionId: "session_b" }).map((event) => event.event_id), ["te_b"]);
  assert.equal(queue.dropPendingForAccount("session_a"), 1);
  assert.equal(queue.pending({ accountSessionId: "session_a" }).length, 0);
  queue.close();
});

test("late facts after a sent terminal bundle are retained locally only as a drop reason", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-late-"));
  const queue = new TelemetryQueue({ stateDir });
  const context = { runId: "acr_late", accountSessionId: "session_a", trainingEligible: true };
  queue.enqueue({ event_id: "te_terminal", event_type: "run.completed", event_seq: 4 }, context);
  queue.markSent(["te_terminal"]);
  queue.enqueue({ event_id: "te_late", event_type: "agent.activity", event_seq: 5 }, context);
  assert.equal(queue.dropPostTerminalEvents("session_a"), 1);
  assert.equal(queue.pendingForRun("acr_late", { accountSessionId: "session_a" }).length, 0);
  queue.close();
});

test("uploader retains non-Cloud collaboration facts and rejects direct sessions", async () => {
  const nonCloudEvents = [{
    event_id: "te_non_cloud_terminal",
    event_type: "run.completed",
    occurred_at: "2026-09-07T00:00:00.000Z",
    bundle_origin: "collaboration_run",
    content_availability: "metadata_only",
    gateway_response_ids: [],
    payload: {},
  }];
  const calls = [];
  const queue = {
    pendingRunIds: () => ["acr_non_cloud"],
    pendingForRun: () => nonCloudEvents,
    markSent: (ids) => calls.push(["sent", ids]),
    markDropped: (ids, reason) => calls.push(["dropped", ids, reason]),
  };
  const uploader = new TelemetryUploader({ queue, fetchFn: async () => { throw new Error("not used"); } });
  uploader.request = async () => ({ ok: true, data: {
    data: { upload_url: "https://storage.invalid/upload", upload_id: "upl_1", grant: "grant_1" },
  } });
  uploader._uploadArchive = async (_grant, archive) => {
    const bundle = JSON.parse(gunzipSync(archive.body).toString("utf8"));
    assert.equal(bundle.content_availability, "metadata_only");
    assert.equal(bundle.bundle_origin, "collaboration_run");
    return { ok: true };
  };
  const result = await uploader._flushCompletedRuns();
  assert.equal(result.sent, 1);
  assert.deepEqual(calls, [["sent", ["te_non_cloud_terminal"]]]);

  const directQueue = {
    pendingRunIds: () => ["session_direct"],
    pendingForRun: () => [{
      event_id: "te_direct_terminal",
      event_type: "session_terminated",
      occurred_at: "2026-09-07T00:00:00.000Z",
      bundle_origin: "direct_wrapper",
      content_availability: "metadata_only",
      delegation_detected: true,
      payload: { status: "completed", activity: "subagent" },
    }],
    markDropped: (ids, reason) => calls.push(["dropped", ids, reason]),
  };
  const directUploader = new TelemetryUploader({ queue: directQueue });
  const directResult = await directUploader._flushCompletedRuns();
  assert.equal(directResult.sent, 0);
  assert.deepEqual(calls.at(-1), [
    "dropped",
    ["te_direct_terminal"],
    "direct_wrapper_excluded",
  ]);
});

test("uploader drains every completed collaboration run in one flush", async () => {
  const sent = [];
  const archives = [];
  const eventsByRun = new Map([
    ["acr_1", [{ event_id: "e1", event_type: "run.completed", occurred_at: "2026-09-07T00:00:00.000Z", bundle_origin: "collaboration_run", payload: {} }]],
    ["acr_2", [{ event_id: "e2", event_type: "run.completed", occurred_at: "2026-09-07T00:00:01.000Z", bundle_origin: "collaboration_run", payload: {} }]],
  ]);
  const queue = {
    pendingRunIds: () => [...eventsByRun.keys()],
    pendingForRun: (runId) => eventsByRun.get(runId) || [],
    markSent: (ids) => sent.push(...ids),
  };
  const uploader = new TelemetryUploader({ queue });
  uploader.request = async (_path, options) => {
    archives.push(JSON.parse(options.body).archive_id);
    return { ok: true, data: { data: { upload_url: "https://storage.invalid/upload", upload_id: "u", grant: "g" } } };
  };
  uploader._uploadArchive = async () => ({ ok: true });
  const result = await uploader._flushCompletedRuns();
  assert.equal(result.bundle_count, 2);
  assert.deepEqual(sent.sort(), ["e1", "e2"]);
  assert.equal(archives.length, 2);
});

test("uploader does not infer Run completion from a long silent period", async () => {
  const queue = {
    pendingRunIds: () => ["acr_long"],
    pendingForRun: () => [{
      event_id: "e-long",
      event_type: "agent.activity",
      occurred_at: "2026-09-06T00:00:00.000Z",
      bundle_origin: "collaboration_run",
      payload: {},
    }],
    markSent: () => assert.fail("silent run must not upload"),
  };
  const uploader = new TelemetryUploader({ queue });
  uploader.request = async () => assert.fail("silent run must not request grant");
  const result = await uploader._flushCompletedRuns();
  assert.equal(result.sent, 0);
});

test("uploader skips incomplete Runs without spinning or blocking a later completed Run", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-terminal-"));
  let now = Date.parse("2026-09-08T00:00:00.000Z");
  const queue = new TelemetryQueue({ stateDir, now: () => now });
  for (let index = 0; index < 50; index += 1) {
    queue.enqueue({ event_id: `te_open_${index}`, event_type: "agent.activity" }, {
      runId: `acr_open_${index}`,
      accountSessionId: "session_test",
    });
  }
  queue.enqueue({ event_id: "te_completed", event_type: "run.completed" }, {
    runId: "acr_completed",
    accountSessionId: "session_test",
  });
  now += 2_001;
  const sent = [];
  const scheduled = [];
  const uploader = new TelemetryUploader({ queue });
  uploader.status = async () => ({ ok: true, data: { data: { enabled: true } } });
  uploader.accountSessionId = "session_test";
  uploader.request = async (_path, options) => {
    assert.equal(options.expectedAccountSessionId, "session_test");
    return { ok: true, data: { data: { upload_url: "https://storage.invalid/upload", upload_id: "u", grant: "g" } } };
  };
  uploader.currentAccountSessionId = async () => "session_test";
  uploader._uploadArchive = async () => ({ ok: true });
  const originalMarkSent = queue.markSent.bind(queue);
  queue.markSent = (ids) => { sent.push(...ids); return originalMarkSent(ids); };
  uploader.schedule = (options) => scheduled.push(options);
  const result = await uploader.flush();
  assert.equal(result.sent, 1);
  assert.deepEqual(sent, ["te_completed"]);
  assert.deepEqual(scheduled, []);
  queue.close();
});

test("uploader waits for Run quiescence and includes usage arriving after the terminal event", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-quiescence-"));
  let now = Date.parse("2026-09-08T00:00:00.000Z");
  const queue = new TelemetryQueue({ stateDir, now: () => now });
  const context = { runId: "acr_quiet", accountSessionId: "session_test" };
  queue.enqueue({ event_id: "te_quiet_terminal", event_type: "run.completed", event_seq: 1 }, context);
  now += 500;
  queue.enqueue({
    event_id: "te_quiet_usage",
    event_type: "agent.usage",
    event_seq: 2,
    payload: { sampled_tokens: 120 },
  }, context);
  const uploaded = [];
  const scheduled = [];
  const uploader = new TelemetryUploader({ queue });
  uploader.status = async () => ({ ok: true, data: { data: { enabled: true } } });
  uploader.accountSessionId = "session_test";
  uploader.request = async () => ({ ok: true, data: { data: { upload_url: "https://storage.invalid/upload", upload_id: "u", grant: "g" } } });
  uploader.currentAccountSessionId = async () => "session_test";
  uploader._uploadArchive = async (_grant, archive) => { uploaded.push(archive); return { ok: true }; };
  uploader.schedule = (options) => scheduled.push(options);
  const early = await uploader.flush();
  assert.equal(early.sent, 0);
  assert.equal(scheduled.at(-1).delayMs, 2_000);
  now += 2_001;
  const settled = await uploader.flush();
  assert.equal(settled.sent, 2);
  assert.equal(uploaded.length, 1);
  assert.equal(queue.pendingForRun("acr_quiet", { accountSessionId: "session_test" }).length, 0);
  queue.close();
});

test("uploader refuses a grant after the OAuth session changes", async () => {
  const retried = [];
  const events = [{
    event_id: "te_account_switch",
    event_type: "run.completed",
    occurred_at: "2026-09-08T00:00:00.000Z",
    run_id: "acr_account_switch",
    account_session_id: "session_a",
    bundle_origin: "collaboration_run",
    payload: {},
  }];
  const queue = {
    pendingRunIds: () => ["acr_account_switch"],
    pendingForRun: () => events,
    markRetry: (ids, reason) => retried.push({ ids, reason }),
  };
  const uploader = new TelemetryUploader({ queue });
  uploader.request = async (_path, options) => {
    assert.equal(options.expectedAccountSessionId, "session_a");
    return { ok: false, error: "account_session_changed" };
  };
  const result = await uploader._flushCompletedRuns({ accountSessionId: "session_a" });
  assert.equal(result.error, "account_session_changed");
  assert.equal(retried[0].reason, "account_session_changed");
});

test("run bundles retain the authoritative collaboration event sequence", () => {
  const built = buildRunBundle("acr_sequence", [
    { event_id: "late-clock", event_type: "task.completed", occurred_at: "2026-09-08T00:00:02.000Z", event_seq: 1, run_id: "acr_sequence", bundle_origin: "collaboration_run", payload: {} },
    { event_id: "early-clock", event_type: "run.completed", occurred_at: "2026-09-08T00:00:01.000Z", event_seq: 2, run_id: "acr_sequence", bundle_origin: "collaboration_run", payload: {} },
  ]);
  assert.deepEqual(built.bundle.events.map((event) => event.event_seq), [1, 2]);
  assert.deepEqual(built.bundle.events.map((event) => event.event_id), ["late-clock", "early-clock"]);
});

test("uploader blocks an oversize completed Run without requesting an upload grant", async () => {
  const blocked = [];
  const events = [{
    event_id: "te_large",
    event_type: "run.completed",
    occurred_at: "2026-09-08T00:00:00.000Z",
    run_id: "acr_large",
    bundle_origin: "collaboration_run",
    account_session_id: "session_test",
    payload: { activity: "completed" },
  }];
  const queue = {
    prune: () => 0,
    pending: () => events,
    pendingRunIds: () => ["acr_large"],
    pendingForRun: () => events,
    markBlocked: (ids, reason) => blocked.push({ ids, reason }),
  };
  const uploader = new TelemetryUploader({ queue });
  uploader.status = async () => ({
    ok: true,
    data: { data: { enabled: true, max_upload_bytes: 1 } },
  });
  uploader.accountSessionId = "session_test";
  uploader.request = async () => assert.fail("oversize archive must not request grant");
  const result = await uploader.flush();
  assert.equal(result.blocked, true);
  assert.equal(result.error, "archive_too_large");
  assert.equal(result.max_archive_bytes, 1);
  assert.deepEqual(blocked[0].ids, ["te_large"]);
});

test("TelemetryQueue accepts collaboration facts only and is idempotent", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-"));
  const queue = new TelemetryQueue({ stateDir });
  const direct = queue.enqueue({
    event_id: "te_direct_wrapper",
    event_type: "agent.task.complete",
  }, {
    providerType: "originrouter",
    providerSource: "originrouter-coding",
    runId: "claude-direct-session",
    bundleOrigin: "direct_wrapper",
  });
  assert.equal(direct.inserted, false);
  assert.equal(direct.skipped, "direct_wrapper_excluded");
  assert.equal(direct.event.bundle_origin, "direct_wrapper");
  assert.equal(direct.event.content_availability, "metadata_only");
  assert.equal(queue.enqueue({ event_id: "te_local", event_type: "x" }, { providerSource: "routes" }).inserted, false);
  assert.equal(queue.enqueue({
    event_id: "te_collaboration_context",
    event_type: "plan.created",
  }, {
    providerType: "proxy",
    providerSource: "routes",
    runId: "acr_1",
  }).inserted, true);
  const first = queue.enqueue({
    event_id: "te_cloud",
    idempotency_key: "runtime:1",
    event_type: "agent.task.complete",
    payload: { status: "completed" },
  }, { providerType: "originrouter", providerSource: "originrouter-coding", deviceId: "dev_1", runId: "acr_1" });
  assert.equal(first.inserted, true);
  assert.equal(queue.enqueue({
    event_id: "te_other",
    idempotency_key: "runtime:1",
    event_type: "agent.task.complete",
  }, { providerType: "originrouter", providerSource: "originrouter-coding", runId: "acr_1" }).inserted, false);
  assert.equal(queue.pending().length, 2);
  assert.equal(queue.markSent(["te_cloud"]), 1);
  assert.equal(queue.pending().length, 1);
  queue.close();
});

test("TelemetryQueue assigns a durable sequence to facts without a source sequence", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-sequence-"));
  const queue = new TelemetryQueue({ stateDir });
  queue.enqueue({ event_id: "te_sequence_1", event_type: "plan.created" }, {
    runId: "acr_sequence_queue", accountSessionId: "session_test",
  });
  queue.enqueue({ event_id: "te_sequence_2", event_type: "run.completed" }, {
    runId: "acr_sequence_queue", accountSessionId: "session_test",
  });
  assert.deepEqual(
    queue.pendingForRun("acr_sequence_queue", { accountSessionId: "session_test" })
      .map((event) => event.event_seq),
    [1, 2],
  );
  queue.close();
});

test("privacy disable drops every locally pending collaboration event", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-"));
  const queue = new TelemetryQueue({ stateDir });
  queue.enqueue({ event_id: "te_privacy_1", event_type: "run.completed" }, { runId: "acr_privacy", accountSessionId: "session_test" });
  queue.enqueue({ event_id: "te_privacy_2", event_type: "task.completed" }, { runId: "acr_privacy", accountSessionId: "session_test" });
  const uploader = new TelemetryUploader({ queue });
  uploader.request = async () => ({ ok: true, data: { data: { enabled: false } } });
  uploader.accountSessionId = "session_test";
  const result = await uploader.flush();
  assert.equal(result.reason, "privacy_disabled");
  assert.equal(result.dropped, 2);
  assert.equal(queue.pending().length, 0);
  queue.close();
});

test("TelemetryQueue prunes retained sent and dropped rows during an idle flush", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-telemetry-"));
  const queue = new TelemetryQueue({ stateDir, now: () => Date.parse("2026-09-08T00:00:00.000Z") });
  queue.enqueue({ event_id: "te_sent_old", event_type: "run.completed" }, { runId: "acr_prune_sent" });
  queue.enqueue({ event_id: "te_dropped_old", event_type: "run.completed" }, { runId: "acr_prune_drop" });
  queue.markSent(["te_sent_old"]);
  queue.markDropped(["te_dropped_old"], "privacy_disabled");
  const removed = queue.prune({
    now: Date.parse("2026-09-20T00:00:00.000Z"),
    sentRetentionMs: 7 * 24 * 60 * 60 * 1000,
    droppedRetentionMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(removed, 2);
  assert.equal(queue.db.prepare("SELECT COUNT(*) AS count FROM telemetry_events").get().count, 0);
  queue.close();
});
