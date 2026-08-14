import { createHash } from "node:crypto";

import { readCodexConversationHistory } from "../adapters/codex/jsonlScanner.js";
import { readClaudeConversationHistory } from "../runtime/claudeConversationHistory.js";
import { redactDisplayText, redactDisplayValue } from "../security/displayRedaction.js";
import { reportAgentHistoryChunk } from "./bridgeReporter.js";


const SYNC_META_KEY = "agent_history_body_sync_v1";
const MAX_ENTRIES = 100;
const MAX_APPROX_BYTES = 220 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) =>
    item === undefined ? "null" : canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value, fallback) {
  const parsed = new Date(value || fallback || 0);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

function safeSummary(value, maxLength = 16_384) {
  if (typeof value === "string") return redactDisplayText(value, maxLength).trim();
  return redactDisplayText(JSON.stringify(redactDisplayValue(value), null, 0), maxLength).trim();
}

function historyEntry(message, fallbackTimestamp) {
  const occurredAt = iso(message?.createdAt, fallbackTimestamp);
  if (message?.role === "user" || message?.role === "assistant") {
    const text = safeSummary(message.text, 32 * 1024);
    return text ? {
      sequence: Number(message.sequence),
      kind: message.role === "user" ? "user_message" : "assistant_message",
      occurred_at: occurredAt,
      text,
    } : null;
  }
  const event = message?.event || {};
  let kind = "activity_summary";
  if (event.type === "agent.thinking") kind = "thinking_summary";
  else if (String(event.type || "").startsWith("agent.tool_call.")) kind = "tool_summary";
  else if (String(event.type || "").includes("approval") || String(event.type || "").includes("interaction")) {
    kind = "approval_summary";
  }
  const text = safeSummary({
    type: event.type,
    tool: event.tool,
    summary: event.summary,
    detail: event.detail,
    input: event.input,
    content: event.content,
    is_error: event.isError,
  }, 32 * 1024);
  return text ? { sequence: Number(message.sequence), kind, occurred_at: occurredAt, text } : null;
}

function readCompleteHistory(agentType, transcriptPath) {
  const reader = agentType === "claude"
    ? readClaudeConversationHistory
    : agentType === "codex"
      ? readCodexConversationHistory
      : null;
  if (!reader || !transcriptPath) return [];
  const pages = [];
  let cursor = null;
  do {
    const page = reader(transcriptPath, { beforeCursor: cursor, limit: 100 });
    pages.unshift(page.messages || []);
    cursor = page.nextCursor;
  } while (cursor != null);
  // Readers assign stable global sequence numbers before pagination.
  return pages.flat().sort((left, right) => Number(left.sequence) - Number(right.sequence));
}

function splitEntries(entries) {
  const chunks = [];
  let current = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    const approximate = Buffer.byteLength(canonical(candidate), "utf8");
    if (current.length && (candidate.length > MAX_ENTRIES || approximate > MAX_APPROX_BYTES)) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function contentHash(document) {
  const { chunk_id: ignored, ...hashable } = document;
  return sha256(canonical(hashable));
}

function finalizeChunk(document) {
  const hash = contentHash(document);
  const identity = [
    "1", document.conversation_id, document.content_version,
    document.sequence_start, document.sequence_end, hash,
  ].join("\n");
  return { ...document, chunk_id: `ahc_${sha256(identity)}` };
}

function readState(catalog) {
  try { return JSON.parse(catalog.getMeta?.(SYNC_META_KEY) || "{}") || {}; } catch { return {}; }
}

function writeState(catalog, state) {
  catalog.setMeta?.(SYNC_META_KEY, JSON.stringify(state));
}

export function buildAgentHistoryChunks({ conversation, transcriptPath, contentVersion = 1 }) {
  const messages = readCompleteHistory(conversation.agent_type, transcriptPath);
  const fallback = conversation.last_activity_at || conversation.created_at;
  const entries = messages.map((message) => historyEntry(message, fallback)).filter(Boolean);
  return splitEntries(entries).map((group) => finalizeChunk({
    schema_version: 1,
    conversation_id: conversation.conversation_id,
    chunk_id: "",
    content_version: contentVersion,
    agent_type: conversation.agent_type,
    device_id: conversation.device_id,
    workspace_id: conversation.workspace_id || `workspace-${sha256(conversation.conversation_id).slice(0, 24)}`,
    sequence_start: group[0].sequence,
    sequence_end: group[group.length - 1].sequence,
    occurred_at_start: group[0].occurred_at,
    occurred_at_end: group[group.length - 1].occurred_at,
    entries: group,
  }));
}

export async function syncAgentHistoryBodies({
  catalog,
  stateDir,
  reportFn = reportAgentHistoryChunk,
} = {}) {
  if (!catalog?.listConversations || !catalog?.getConversationTranscriptLocator) {
    return { ok: false, error: "catalog_unavailable", scanned: 0, synced: 0 };
  }
  const state = readState(catalog);
  const conversations = catalog.listConversations({ includeArchived: true, limit: 200 });
  let synced = 0;
  let skipped = 0;
  for (const conversation of conversations) {
    const transcriptPath = catalog.getConversationTranscriptLocator(conversation.conversation_id);
    if (!transcriptPath || !conversation.device_id || !["claude", "codex"].includes(conversation.agent_type)) {
      skipped += 1;
      continue;
    }
    const probe = buildAgentHistoryChunks({ conversation, transcriptPath, contentVersion: 1 });
    const fingerprint = sha256(canonical(probe.map((chunk) => ({
      sequence_start: chunk.sequence_start,
      sequence_end: chunk.sequence_end,
      entries: chunk.entries,
    }))));
    const previous = state[conversation.conversation_id];
    if (previous?.fingerprint === fingerprint) {
      skipped += 1;
      continue;
    }
    const version = Math.max(1, Number(previous?.content_version || 0) + 1);
    const chunks = buildAgentHistoryChunks({ conversation, transcriptPath, contentVersion: version });
    for (const chunk of chunks) {
      const result = await reportFn(chunk, { stateDir });
      if (!result?.ok) {
        return { ok: false, error: result?.error || "history_upload_failed", scanned: conversations.length, synced, skipped };
      }
    }
    state[conversation.conversation_id] = {
      fingerprint,
      content_version: version,
      chunk_ids: chunks.map((chunk) => chunk.chunk_id),
      synced_at: new Date().toISOString(),
    };
    writeState(catalog, state);
    synced += 1;
  }
  return { ok: true, scanned: conversations.length, synced, skipped };
}
