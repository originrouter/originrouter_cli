import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentHistoryChunks, syncAgentHistoryBodies as syncBodies } from "../src/agent/agentHistorySync.js";

const syncAgentHistoryBodies = (options) => syncBodies({ manifestFn: async () => ({ ok: true }), ...options });


test("buildAgentHistoryChunks redacts secrets and creates stable IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-"));
  const transcript = join(dir, "claude.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-08-12T01:00:00Z",
      message: { content: "use api_key=secret-value" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-08-12T01:01:00Z",
      message: { content: "done" },
    }),
  ].join("\n"));
  const conversation = {
    conversation_id: "conversation-1",
    agent_type: "claude",
    device_id: "device-1",
    workspace_id: "workspace-1",
    created_at: "2026-08-12T01:00:00Z",
  };
  const first = buildAgentHistoryChunks({ conversation, transcriptPath: transcript });
  const second = buildAgentHistoryChunks({ conversation, transcriptPath: transcript });
  assert.equal(first[0].chunk_id, second[0].chunk_id);
  assert.match(first[0].chunk_id, /^ahc_[0-9a-f]{64}$/);
  assert.equal(first[0].entries[0].text, "use api_key=[REDACTED]");
  assert.equal(first[0].entries[1].text, "done");
});

test("chunk hash matches JSON transport semantics for optional event fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-"));
  const transcript = join(dir, "claude.jsonl");
  writeFileSync(transcript, JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-08-12T01:00:00Z",
    message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "README.md" } }] },
  }));
  const chunks = buildAgentHistoryChunks({
    conversation: {
      conversation_id: "conversation-1",
      agent_type: "claude",
      device_id: "device-1",
      workspace_id: "workspace-1",
      created_at: "2026-08-12T01:00:00Z",
    },
    transcriptPath: transcript,
  });
  assert.equal(chunks.length, 1);
  assert.doesNotMatch(JSON.stringify(chunks[0]), /undefined/);
  assert.match(chunks[0].chunk_id, /^ahc_[0-9a-f]{64}$/);
});


test("syncAgentHistoryBodies checkpoints only after all chunks succeed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-"));
  const transcript = join(dir, "claude.jsonl");
  writeFileSync(transcript, JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-08-12T01:00:00Z",
    message: { content: "find callback" },
  }));
  const metadata = new Map();
  const catalog = {
    listConversations: () => [{
      conversation_id: "conversation-1",
      agent_type: "claude",
      device_id: "device-1",
      workspace_id: "workspace-1",
      created_at: "2026-08-12T01:00:00Z",
    }],
    getConversationTranscriptLocator: () => transcript,
    getMeta: (key) => metadata.get(key),
    setMeta: (key, value) => metadata.set(key, value),
  };
  const uploads = [];
  const first = await syncAgentHistoryBodies({
    catalog,
    reportFn: async (chunk) => { uploads.push(chunk); return { ok: true }; },
  });
  assert.equal(first.synced, 1);
  const second = await syncAgentHistoryBodies({
    catalog,
    reportFn: async () => { throw new Error("should not upload unchanged content"); },
  });
  assert.equal(second.synced, 0);
  assert.equal(second.skipped, 1);
  assert.equal(uploads.length, 1);
});

test("manifest confirmation gates the checkpoint and retries the same chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-manifest-"));
  try {
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello" } }));
    const meta = new Map();
    const catalog = { listConversations: () => [{ conversation_id: "c1", agent_type: "claude", device_id: "d1" }],
      getConversationTranscriptLocator: () => transcript,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const calls = [];
    let fail = true;
    const options = { catalog, reportFn: async (chunk) => { calls.push(["chunk", chunk.chunk_id]); return { ok: true }; },
      manifestFn: async (action, body) => { calls.push([action, body]);
        return action === "complete" && fail ? { ok: false, error: "offline" } : { ok: true }; } };
    const unsupported = await syncAgentHistoryBodies({ ...options,
      manifestFn: async () => ({ ok: false, status: 404, error: "http_404" }) });
    assert.equal(unsupported.error, "http_404");
    assert.deepEqual(calls, []);
    assert.equal((await syncAgentHistoryBodies(options)).ok, false);
    const pending = JSON.parse(meta.get("agent_history_body_sync_v1")).c1;
    assert.equal(pending.pending_version, 1);
    assert.equal(pending.fingerprint, undefined);
    fail = false;
    assert.equal((await syncAgentHistoryBodies(options)).synced, 1);
    assert.deepEqual(calls.map(([kind]) => kind), ["start", "chunk", "complete", "start", "chunk", "complete"]);
    assert.equal(calls[1][1], calls[4][1]);
    assert.deepEqual(calls[5][1].chunk_ids, [calls[4][1]]);
    assert.equal(JSON.parse(meta.get("agent_history_body_sync_v1")).c1.manifest_complete, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("per-conversation manifest conflicts do not block other histories or overwrite newer versions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-manifest-conflict-"));
  try {
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello" } }));
    const meta = new Map();
    const rows = ["stale", "incomplete", "healthy"].map((conversation_id) =>
      ({ conversation_id, agent_type: "claude", device_id: "d1" }));
    const catalog = { listConversations: () => rows, getConversationTranscriptLocator: () => transcript,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const starts = [];
    const uploaded = [];
    const options = { catalog, reportFn: async (chunk) => { uploaded.push(chunk); return { ok: true }; },
      manifestFn: async (action, body) => {
        if (action === "start") starts.push([body.conversation_id, body.content_version]);
        if (body.conversation_id === "stale" && action === "start")
          return { ok: false, status: 409, error: "history_version_stale" };
        if (body.conversation_id === "incomplete" && action === "complete" && body.content_version === 1)
          return { ok: false, status: 409, error: "history_manifest_incomplete" };
        return { ok: true };
      } };
    const first = await syncAgentHistoryBodies(options);
    assert.equal(first.failed, 2);
    assert.equal(first.synced, 1);
    let state = JSON.parse(meta.get("agent_history_body_sync_v1"));
    assert.equal(state.stale.pending_version, 1);
    assert.equal(state.incomplete.pending_version, 1);
    assert.equal(state.healthy.manifest_complete, true);
    const second = await syncAgentHistoryBodies(options);
    assert.equal(second.failed, 1);
    assert.equal(second.synced, 1);
    assert.deepEqual(starts, [["stale", 1], ["incomplete", 1], ["healthy", 1], ["stale", 1], ["incomplete", 2]]);
    state = JSON.parse(meta.get("agent_history_body_sync_v1"));
    assert.equal(state.stale.pending_version, 1);
    assert.equal(state.incomplete.content_version, 2);
    assert.ok(uploaded.every((chunk) => chunk.conversation_id !== "stale"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("changed chunk metadata is resynced even when the transcript is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-metadata-"));
  try {
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello" } }));
    const meta = new Map();
    const row = { conversation_id: "c1", agent_type: "claude", device_id: "d1", workspace_id: "first" };
    const catalog = { listConversations: () => [row], getConversationTranscriptLocator: () => transcript,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const uploaded = [];
    const options = { catalog, reportFn: async (chunk) => { uploaded.push(chunk); return { ok: true }; } };
    assert.equal((await syncAgentHistoryBodies(options)).synced, 1);
    assert.equal((await syncAgentHistoryBodies(options)).skipped, 1);
    row.workspace_id = "second";
    assert.equal((await syncAgentHistoryBodies(options)).synced, 1);
    assert.deepEqual(uploaded.map((chunk) => [chunk.content_version, chunk.workspace_id]), [[1, "first"], [2, "second"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an older completed checkpoint is revalidated for verified index publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-publication-"));
  try {
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello" } }));
    const meta = new Map();
    const catalog = { listConversations: () => [{ conversation_id: "c1", agent_type: "claude", device_id: "d1" }],
      getConversationTranscriptLocator: () => transcript,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const chunks = [];
    const options = { catalog, reportFn: async (chunk) => { chunks.push(chunk); return { ok: true }; } };
    assert.equal((await syncAgentHistoryBodies(options)).synced, 1);
    const state = JSON.parse(meta.get("agent_history_body_sync_v1"));
    delete state.c1.manifest_protocol;
    meta.set("agent_history_body_sync_v1", JSON.stringify(state));
    assert.equal((await syncAgentHistoryBodies(options)).synced, 1);
    assert.deepEqual(chunks.map((chunk) => chunk.content_version), [1, 2]);
    assert.equal(JSON.parse(meta.get("agent_history_body_sync_v1")).c1.manifest_protocol, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unconfirmed indexes are retried with the original chunk and a persistent rate limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-index-retry-"));
  try {
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello" } }));
    const meta = new Map();
    const catalog = { listConversations: () => [{ conversation_id: "c1", agent_type: "claude", device_id: "d1" }],
      getConversationTranscriptLocator: () => transcript,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const chunks = [], calls = [];
    let now = Date.now();
    let pending = true;
    const options = { catalog, nowFn: () => now,
      reportFn: async (chunk) => { chunks.push(chunk); return { ok: true }; },
      manifestFn: async (action, body) => { calls.push(action); return action === "status"
        ? { ok: true, pendingChunkIds: pending ? body.chunk_ids : [], published: !pending } : { ok: true }; } };
    assert.equal((await syncAgentHistoryBodies(options)).synced, 1);
    now += 31 * 60 * 1000;
    assert.equal((await syncAgentHistoryBodies(options)).ok, true);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].chunk_id, chunks[1].chunk_id);
    assert.deepEqual(calls, ["start", "complete", "status"]);
    // The stored timestamp survives a new invocation and prevents repeated sends.
    await syncAgentHistoryBodies(options);
    assert.equal(chunks.length, 2);
    pending = false;
    now += 31 * 60 * 1000;
    await syncAgentHistoryBodies(options);
    assert.equal(chunks.length, 2);
    assert.deepEqual(calls, ["start", "complete", "status", "status"]);
    // A completed set whose published owner changed is finalized again,
    // without re-uploading already verified chunks.
    options.manifestFn = async (action) => { calls.push(action); return action === "status"
      ? { ok: true, pendingChunkIds: [], published: false } : { ok: true }; };
    now += 31 * 60 * 1000;
    await syncAgentHistoryBodies(options);
    assert.deepEqual(calls.slice(-2), ["status", "complete"]);
    assert.equal(chunks.length, 2);
    // A corrected system clock must not suppress recovery indefinitely.
    now -= 60 * 60 * 1000;
    await syncAgentHistoryBodies(options);
    assert.deepEqual(calls.slice(-2), ["status", "complete"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history sync reaches older conversations without starving recent ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-rotation-"));
  try {
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z", message: { content: "old history" } }));
    const rows = Array.from({ length: 205 }, (_, i) => ({
      conversation_id: `row-${String(i).padStart(3, "0")}`,
      agent_type: "claude", device_id: "device-1", created_at: "2026-01-01T00:00:00Z",
    }));
    const meta = new Map();
    const catalog = {
      listConversations: ({ offset = 0, limit }) => rows.slice(offset, offset + limit),
      getConversationTranscriptLocator: (id) => id === "row-204" || id === "row-000" ? transcript : "",
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value),
    };
    const uploads = [];
    const reportFn = async (chunk) => { uploads.push(chunk.conversation_id); return { ok: true }; };
    const first = await syncAgentHistoryBodies({ catalog, reportFn });
    assert.equal(first.scanned, 200);
    assert.deepEqual(uploads, ["row-000"]);
    const second = await syncAgentHistoryBodies({ catalog, reportFn });
    assert.equal(second.scanned, 200);
    assert.deepEqual(uploads, ["row-000", "row-204"]);
    assert.equal(second.skipped, 199);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed old-history upload is retried before advancing its rotation checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-retry-"));
  try {
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z", message: { content: "retry history" } }));
    const rows = Array.from({ length: 102 }, (_, i) => ({
      conversation_id: `row-${String(i).padStart(3, "0")}`,
      agent_type: "claude", device_id: "device-1", created_at: "2026-01-01T00:00:00Z",
    }));
    const meta = new Map();
    const catalog = { listConversations: ({ offset = 0, limit }) => rows.slice(offset, offset + limit),
      getConversationTranscriptLocator: (id) => id === "row-100" ? transcript : "",
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const failed = await syncAgentHistoryBodies({ catalog, reportFn: async () => ({ ok: false, error: "offline" }) });
    assert.equal(failed.ok, false);
    assert.equal(meta.has("agent_history_body_rotation_v1"), false);
    const retried = await syncAgentHistoryBodies({ catalog, reportFn: async () => ({ ok: true }) });
    assert.equal(retried.ok, true);
    assert.equal(retried.synced, 1);
    assert.equal(meta.get("agent_history_body_rotation_v1"), "row-101");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an oversized transcript does not prevent another conversation from syncing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-large-"));
  try {
    const oversized = join(dir, "large.jsonl");
    const fd = openSync(oversized, "w");
    try { ftruncateSync(fd, 32 * 1024 * 1024 + 1); } finally { closeSync(fd); }
    const valid = join(dir, "valid.jsonl");
    writeFileSync(valid, JSON.stringify({ type: "user", uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z", message: { content: "valid history" } }));
    const rows = ["large", "valid"].map((id) => ({ conversation_id: id,
      agent_type: "claude", device_id: "device-1", created_at: "2026-01-01T00:00:00Z" }));
    const meta = new Map();
    const catalog = { listConversations: ({ offset = 0, limit }) => rows.slice(offset, offset + limit),
      getConversationTranscriptLocator: (id) => id === "large" ? oversized : valid,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const uploads = [];
    const result = await syncAgentHistoryBodies({ catalog,
      reportFn: async (chunk) => { uploads.push(chunk.conversation_id); return { ok: true }; } });
    assert.equal(result.ok, false);
    assert.equal(result.error, "TRANSCRIPT_TOO_LARGE");
    assert.equal(result.failed, 1);
    assert.equal(result.synced, 1);
    assert.deepEqual(uploads, ["valid"]);
    const state = JSON.parse(meta.get("agent_history_body_sync_v1"));
    assert.equal(Object.hasOwn(state, "large"), false);
    assert.ok(state.valid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a device-mismatched history does not block other conversations or get checkpointed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-device-"));
  try {
    const transcript = join(dir, "history.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z", message: { content: "history" } }));
    const rows = ["wrong", "right"].map((id) => ({ conversation_id: id,
      agent_type: "claude", device_id: id, created_at: "2026-01-01T00:00:00Z" }));
    for (const error of ["device_mismatch", "history_conversation_not_found"]) {
      const meta = new Map();
      const catalog = { listConversations: ({ offset = 0, limit }) => rows.slice(offset, offset + limit),
        getConversationTranscriptLocator: () => transcript,
        getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
      const attempts = [];
      const reportFn = async (chunk) => { attempts.push(chunk.conversation_id);
        return chunk.conversation_id === "wrong" ? { ok: false, error, status: 404 } : { ok: true }; };
      const result = await syncAgentHistoryBodies({ catalog, reportFn });
      assert.equal(result.ok, false);
      assert.equal(result.error, error);
      assert.equal(result.failed, 1);
      assert.equal(result.synced, 1);
      assert.deepEqual(attempts, ["wrong", "right"]);
      const state = JSON.parse(meta.get("agent_history_body_sync_v1"));
      assert.equal(state.wrong.fingerprint, undefined);
      assert.equal(state.wrong.pending_version, 1);
      assert.ok(state.right);
      await syncAgentHistoryBodies({ catalog, reportFn });
      assert.deepEqual(attempts, ["wrong", "right", "wrong"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partial upload reserves its version when transcript changes before retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-version-"));
  try {
    const transcript = join(dir, "history.jsonl");
    const entries = Array.from({ length: 101 }, (_, index) => JSON.stringify({ type: "user",
      uuid: `u${index}`, timestamp: "2026-01-01T00:00:00Z", message: { content: `message ${index}` } }));
    writeFileSync(transcript, entries.join("\n"));
    const meta = new Map();
    const catalog = { listConversations: () => [{ conversation_id: "c1", agent_type: "claude",
      device_id: "device-1", created_at: "2026-01-01T00:00:00Z" }],
      getConversationTranscriptLocator: () => transcript,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const first = [];
    const failed = await syncAgentHistoryBodies({ catalog, reportFn: async (chunk) => {
      first.push(chunk);
      return first.length === 2 ? { ok: false, error: "offline" } : { ok: true };
    } });
    assert.equal(failed.ok, false);
    assert.equal(first.length, 2);
    assert.ok(first.every((chunk) => chunk.content_version === 1));
    assert.equal(JSON.parse(meta.get("agent_history_body_sync_v1")).c1.pending_version, 1);
    const unchangedRetry = [];
    const failedAgain = await syncAgentHistoryBodies({ catalog, reportFn: async (chunk) => {
      unchangedRetry.push(chunk);
      return unchangedRetry.length === 2 ? { ok: false, error: "offline" } : { ok: true };
    } });
    assert.equal(failedAgain.ok, false);
    assert.deepEqual(unchangedRetry.map((chunk) => chunk.chunk_id), first.map((chunk) => chunk.chunk_id));
    entries.push(JSON.stringify({ type: "user", uuid: "new", timestamp: "2026-01-01T00:01:00Z",
      message: { content: "appended during retry" } }));
    writeFileSync(transcript, entries.join("\n"));
    const retry = [];
    const result = await syncAgentHistoryBodies({ catalog, reportFn: async (chunk) => { retry.push(chunk); return { ok: true }; } });
    assert.equal(result.ok, true);
    assert.ok(retry.length >= 2);
    assert.ok(retry.every((chunk) => chunk.content_version === 2));
    const saved = JSON.parse(meta.get("agent_history_body_sync_v1")).c1;
    assert.equal(saved.content_version, 2);
    assert.equal(saved.pending_version, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing transcript does not create a false successful history version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-missing-"));
  try {
    const meta = new Map();
    const catalog = { listConversations: () => [{ conversation_id: "missing", agent_type: "claude",
      device_id: "device-1", created_at: "2026-01-01T00:00:00Z" }],
      getConversationTranscriptLocator: () => join(dir, "absent.jsonl"),
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const result = await syncAgentHistoryBodies({ catalog, reportFn: async () => assert.fail("nothing to upload") });
    assert.equal(result.synced, 0);
    assert.equal(result.skipped, 1);
    assert.equal(meta.has("agent_history_body_sync_v1"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partial history upload reserves a new version when its workspace metadata changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "originrouter-history-envelope-"));
  try {
    const transcript = join(dir, "history.jsonl");
    writeFileSync(transcript, Array.from({ length: 101 }, (_, index) => JSON.stringify({
      type: "user", uuid: `u${index}`, timestamp: "2026-01-01T00:00:00Z",
      message: { content: `message ${index}` },
    })).join("\n"));
    const row = { conversation_id: "c1", agent_type: "claude", device_id: "device-1",
      workspace_id: "workspace-a", created_at: "2026-01-01T00:00:00Z" };
    const meta = new Map();
    const catalog = { listConversations: () => [row], getConversationTranscriptLocator: () => transcript,
      getMeta: (key) => meta.get(key), setMeta: (key, value) => meta.set(key, value) };
    const first = [];
    await syncAgentHistoryBodies({ catalog, reportFn: async (chunk) => {
      first.push(chunk);
      return first.length === 2 ? { ok: false, error: "offline" } : { ok: true };
    } });
    assert.equal(first.length, 2);
    assert.ok(first.every((chunk) => chunk.content_version === 1 && chunk.workspace_id === "workspace-a"));
    row.workspace_id = "workspace-b";
    const retry = [];
    const result = await syncAgentHistoryBodies({ catalog, reportFn: async (chunk) => {
      retry.push(chunk); return { ok: true };
    } });
    assert.equal(result.ok, true);
    assert.ok(retry.length >= 2);
    assert.ok(retry.every((chunk) => chunk.content_version === 2 && chunk.workspace_id === "workspace-b"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
