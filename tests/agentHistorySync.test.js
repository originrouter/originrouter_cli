import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentHistoryChunks, syncAgentHistoryBodies } from "../src/agent/agentHistorySync.js";


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
