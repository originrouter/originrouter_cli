import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { claudeConversationTimelineItemsFromRaw } from "./claudeTranscriptMessages.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_PAGE_BYTES = 96 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;

function parseMessages(text) {
  const messages = [];
  let lineIndex = 0;
  for (const line of text.split("\n")) {
    lineIndex += 1;
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    for (const message of claudeConversationTimelineItemsFromRaw(raw, { lineIndex })) {
      messages.push(message.event
        ? { ...message, sequence: messages.length }
        : {
            ...message,
            text: Buffer.from(message.text, "utf8")
              .subarray(0, MAX_MESSAGE_BYTES)
              .toString("utf8"),
            sequence: messages.length,
          });
    }
  }
  return messages;
}

function cursorIndex(cursor, length) {
  if (cursor == null || cursor === "") return length;
  const parsed = Number.parseInt(String(cursor), 10);
  if (!Number.isFinite(parsed)) return length;
  return Math.max(0, Math.min(length, parsed));
}

export function claudeTranscriptPathForSession(cwd, sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return null;
  const projectId = String(cwd || "").replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(claudeConfigDir, "projects", projectId, `${normalizedSessionId}.jsonl`);
}

export function readClaudeConversationHistory(
  transcriptPath,
  { beforeCursor = null, limit = DEFAULT_LIMIT } = {},
) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { messages: [], nextCursor: null, hasMore: false };
  }
  const size = statSync(transcriptPath).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    const error = new Error("Claude transcript exceeds the local history size limit");
    error.code = "TRANSCRIPT_TOO_LARGE";
    throw error;
  }
  const all = parseMessages(readFileSync(transcriptPath, "utf8"));
  const end = cursorIndex(beforeCursor, all.length);
  const pageSize = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  const minimumStart = Math.max(0, end - pageSize);
  const messages = [];
  let start = end;
  let encodedBytes = 0;
  for (let index = end - 1; index >= minimumStart; index -= 1) {
    const item = all[index];
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (messages.length > 0 && encodedBytes + itemBytes > MAX_PAGE_BYTES) break;
    messages.unshift(item);
    encodedBytes += itemBytes;
    start = index;
  }
  return {
    messages,
    nextCursor: start > 0 ? String(start) : null,
    hasMore: start > 0,
  };
}
