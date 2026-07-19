import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexJsonlScanner,
  findCodexTranscript,
  mapCodexJsonLine,
  readCodexConversationHistory,
} from "../src/adapters/codex/jsonlScanner.js";

const lines = [
  {
    timestamp: "2026-07-16T23:59:59Z",
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: {
        model: "gpt-5.5",
        model_provider_id: "originrouter",
        approval_policy: "on-request",
        reasoning_effort: "high",
        collaboration_mode: { mode: "default", settings: { developer_instructions: "do not forward" } },
        permission_profile: { type: "managed", file_system: { secret: "do not forward" } },
        cwd: "/repo",
      },
    },
  },
  { timestamp: "2026-07-17T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
  { timestamp: "2026-07-17T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
  { timestamp: "2026-07-17T00:00:02Z", type: "event_msg", payload: { type: "agent_message", message: "hi" } },
  { timestamp: "2026-07-17T00:00:03Z", type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "exec", arguments: { cmd: "pwd" } } },
  { timestamp: "2026-07-17T00:00:04Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "ok" } },
  { timestamp: "2026-07-17T00:00:05Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  { timestamp: "2026-07-17T00:00:06Z", type: "event_msg", payload: { type: "context_compacted" } },
  { timestamp: "2026-07-17T00:00:07Z", type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 2 } },
  { timestamp: "2026-07-17T00:00:08Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Compared both routes" }], encrypted_content: "private" } },
  { timestamp: "2026-07-17T00:00:09Z", type: "response_item", payload: { type: "web_search_call", status: "completed", action: { type: "search", query: "OriginRouter docs" } } },
];

assert.deepEqual(
  lines.flatMap((line, index) => mapCodexJsonLine(JSON.stringify(line), index)).map((event) => event.type),
  [
    "agent.activity",
    "agent.task.started",
    "user.text",
    "agent.text",
    "agent.tool_call.start",
    "agent.tool_call.end",
    "agent.task.complete",
    "agent.activity",
    "agent.activity",
    "agent.thinking",
    "agent.activity",
  ],
);

const settingsEvent = mapCodexJsonLine(JSON.stringify(lines[0]), 0)[0];
assert.equal(settingsEvent.activity, "settings_applied");
assert.equal(settingsEvent.metadata.model, "gpt-5.5");
assert.equal(settingsEvent.metadata.permission_profile, "managed");
assert.equal(JSON.stringify(settingsEvent).includes("developer_instructions"), false);
assert.equal(JSON.stringify(settingsEvent).includes("do not forward"), false);

const privateThinkingEvents = mapCodexJsonLine(JSON.stringify({
  timestamp: "2026-07-17T00:00:10Z",
  type: "event_msg",
  payload: {
    type: "agent_message",
    message: "<think>private chain of thought</think>\nVisible answer",
  },
}), 99);
assert.deepEqual(privateThinkingEvents.map((event) => event.type), [
  "agent.thinking",
  "agent.text",
]);
assert.equal(privateThinkingEvents[0].text, "");
assert.equal(privateThinkingEvents[1].text, "Visible answer");
assert.equal(JSON.stringify(privateThinkingEvents).includes("private chain of thought"), false);

const dir = mkdtempSync(join(tmpdir(), "originrouter-codex-jsonl-"));
const path = join(dir, "rollout.jsonl");
writeFileSync(path, lines.map(JSON.stringify).join("\n"));
const history = readCodexConversationHistory(path, { limit: 20 });
const historyText = history.messages.filter((item) => item.role !== "event");
assert.deepEqual(historyText.map((item) => `${item.role}:${item.text}`), [
  "user:hello",
  "assistant:hi",
]);
const nullCursorHistory = readCodexConversationHistory(path, {
  beforeCursor: null,
  limit: 20,
});
assert.deepEqual(
  nullCursorHistory.messages.map((item) => item.messageId),
  history.messages.map((item) => item.messageId),
  "a null cursor must load the latest history page",
);
assert.deepEqual(
  history.messages.filter((item) => item.role === "event").map((item) => item.event.type),
  [
    "agent.activity",
    "agent.task.started",
    "agent.tool_call.start",
    "agent.tool_call.end",
    "agent.task.complete",
    "agent.activity",
    "agent.activity",
    "agent.thinking",
    "agent.activity",
  ],
);
const liveAssistant = mapCodexJsonLine(JSON.stringify(lines[3]), 3)[0];
assert.equal(liveAssistant.eventId, historyText[1].messageId);

const scanner = new CodexJsonlScanner({ cwd: dir, startedAt: Date.parse("2026-07-16T00:00:00Z") });
scanner.transcriptPath = path;
assert.equal(scanner.scan().length, 11);
assert.equal(scanner.scan().length, 0);

const originalCodexHome = process.env.CODEX_HOME;
const codexHome = mkdtempSync(join(tmpdir(), "originrouter-codex-home-"));
process.env.CODEX_HOME = codexHome;
const now = new Date();
const sessionDir = join(
  codexHome,
  "sessions",
  String(now.getFullYear()),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
);
mkdirSync(sessionDir, { recursive: true });
const managedPath = join(sessionDir, "managed.jsonl");
writeFileSync(managedPath, JSON.stringify({
  type: "session_meta",
  payload: {
    session_id: "managed-thread-1",
    cwd: "/managed/repo",
    originator: "originrouter-managed",
  },
}));
assert.equal(findCodexTranscript({
  cwd: "/managed/repo",
  startedAt: Date.now() - 5000,
  sessionId: "managed-thread-1",
  originators: null,
}), managedPath);
if (originalCodexHome == null) delete process.env.CODEX_HOME;
else process.env.CODEX_HOME = originalCodexHome;

console.log("codex jsonl scanner tests ok");
