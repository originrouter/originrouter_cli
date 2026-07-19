import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claudeTranscriptPathForSession,
  readClaudeConversationHistory,
} from "../src/runtime/claudeConversationHistory.js";
import { mapClaudeJsonLine } from "../src/adapters/claude/jsonlScanner.js";

const dir = mkdtempSync(join(tmpdir(), "originrouter-history-"));
const transcript = join(dir, "session.jsonl");
const rows = [
  { type: "user", uuid: "u1", timestamp: "2026-07-17T00:00:00Z", message: { content: "one" } },
  { type: "assistant", uuid: "a1", timestamp: "2026-07-17T00:00:01Z", message: { content: [{ type: "text", text: "two" }] } },
  { type: "assistant", uuid: "tool", message: { content: [{ type: "tool_use", name: "Read" }] } },
  { type: "user", uuid: "u2", timestamp: "2026-07-17T00:00:02Z", message: { content: [{ type: "text", text: "three" }] } },
  { type: "assistant", uuid: "a2", timestamp: "2026-07-17T00:00:03Z", message: { content: [{ type: "text", text: "four" }] } },
  { type: "system", subtype: "local_command_output", uuid: "cmd1", timestamp: "2026-07-17T00:00:04Z", content: "usage: 42%" },
];
writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

const latest = readClaudeConversationHistory(transcript, { limit: 2 });
assert.deepEqual(latest.messages.map((item) => item.text), ["four", "usage: 42%"]);
assert.equal(latest.nextCursor, "4");
assert.equal(latest.hasMore, true);

const older = readClaudeConversationHistory(transcript, {
  beforeCursor: latest.nextCursor,
  limit: 3,
});
assert.deepEqual(older.messages.map((item) => item.text), ["two", undefined, "three"]);
assert.equal(older.messages[1].event.type, "agent.tool_call.start");
assert.equal(older.messages[1].event.tool, "Read");
assert.equal(older.nextCursor, "1");
assert.equal(older.hasMore, true);
assert.ok(older.messages.every((item) => !Object.hasOwn(item, "transcriptPath")));

const oldest = readClaudeConversationHistory(transcript, {
  beforeCursor: older.nextCursor,
  limit: 3,
});
assert.deepEqual(oldest.messages.map((item) => item.text), ["one"]);
assert.equal(oldest.nextCursor, null);
assert.equal(oldest.hasMore, false);

const live = mapClaudeJsonLine(JSON.stringify(rows[0]));
assert.equal(live[0].eventId, oldest.messages[0].messageId);
assert.equal(live[0].createdAt, oldest.messages[0].createdAt);

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-history-test";
assert.equal(
  claudeTranscriptPathForSession("/Users/test/My Project", "session-123"),
  "/tmp/claude-history-test/projects/-Users-test-My-Project/session-123.jsonl",
);
if (originalConfigDir == null) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;

console.log("claude conversation history tests ok");
