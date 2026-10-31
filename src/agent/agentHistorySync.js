import { createHash } from "node:crypto";

import { readCodexConversationHistory } from "../adapters/codex/jsonlScanner.js";
import { readClaudeConversationHistory } from "../runtime/claudeConversationHistory.js";
import { redactDisplayText, redactDisplayValue } from "../security/displayRedaction.js";
import { reportAgentHistoryChunk, reportAgentHistoryManifest } from "./bridgeReporter.js";
import { accountSelectionRoot } from "../persistence/accounts.js";


const SYNC_META_KEY = "agent_history_body_sync_v1";
// Revision 3 also rebuilds Qdrant points with account-scoped IDs. Older
// checkpoints need one safe revalidation after rollout.
const MANIFEST_PROTOCOL = 3;
const INDEX_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const ROTATION_META_KEY = "agent_history_body_rotation_v1";
const RECENT_SCAN_SIZE = 100;
const ROTATING_SCAN_SIZE = 100;
const CATALOG_PAGE_SIZE = 200;
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

function selectConversations(catalog) {
  const read = () => {
    const rows = [];
    for (let offset = 0; ; offset += CATALOG_PAGE_SIZE) {
      const page = catalog.listConversations({ includeArchived: true,
        includeCollaboration: false, limit: CATALOG_PAGE_SIZE, offset });
      rows.push(...page);
      if (page.length < CATALOG_PAGE_SIZE) break;
    }
    return rows;
  };
  const rows = catalog.readCatalogSnapshot ? catalog.readCatalogSnapshot(read) : read();
  const recent = rows.slice(0, RECENT_SCAN_SIZE);
  const older = rows.slice(RECENT_SCAN_SIZE).sort((a, b) =>
    a.conversation_id < b.conversation_id ? -1 : a.conversation_id > b.conversation_id ? 1 : 0);
  const cursor = String(catalog.getMeta?.(ROTATION_META_KEY) || "");
  const start = older.findIndex((row) => row.conversation_id > cursor);
  const rotated = start < 0 ? older : [...older.slice(start), ...older.slice(0, start)];
  return [
    ...recent.map((conversation) => ({ conversation, rotating: false })),
    ...rotated.slice(0, ROTATING_SCAN_SIZE).map((conversation) => ({ conversation, rotating: true })),
  ];
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
  manifestFn = reportAgentHistoryManifest,
  nowFn = Date.now,
} = {}) {
  if (!catalog?.listConversations || !catalog?.getConversationTranscriptLocator) {
    return { ok: false, error: "catalog_unavailable", scanned: 0, synced: 0 };
  }
  stateDir = catalog.stateDir || stateDir;
  const state = readState(catalog);
  const conversations = selectConversations(catalog);
  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let firstError = null;
  for (const { conversation, rotating } of conversations) {
    const checkpointRotation = () => {
      if (rotating) catalog.setMeta?.(ROTATION_META_KEY, conversation.conversation_id);
    };
    const transcriptPath = catalog.getConversationTranscriptLocator(conversation.conversation_id);
    if (!transcriptPath || !conversation.device_id || !["claude", "codex"].includes(conversation.agent_type)) {
      skipped += 1;
      checkpointRotation();
      continue;
    }
    let probe;
    try {
      probe = buildAgentHistoryChunks({ conversation, transcriptPath, contentVersion: 1 });
    } catch (error) {
      // A damaged, missing or oversized local transcript should not prevent
      // unrelated conversations from syncing. Do not checkpoint its content:
      // it remains eligible for retry on the next pass through this row.
      failed += 1;
      firstError ||= error?.code || "history_read_failed";
      checkpointRotation();
      continue;
    }
    const fingerprint = sha256(canonical(probe.map((chunk) => ({
      sequence_start: chunk.sequence_start,
      sequence_end: chunk.sequence_end,
      entries: chunk.entries,
    }))));
    // A chunk's identity also includes its agent, device, workspace and time
    // envelope. During a partial retry, identical text with changed metadata
    // is a different manifest and cannot reuse the reserved version.
    const pendingManifestHash = sha256(canonical(probe.map(({ chunk_id: ignored, ...chunk }) => chunk)));
    const previous = state[conversation.conversation_id] || {};
    if (!probe.length) {
      // No chunks means nothing has been uploaded. In particular, a missing
      // or temporarily empty transcript must not advance a cloud version.
      skipped += 1;
      checkpointRotation();
      continue;
    }
    const pendingVersion = Math.max(0, Number(previous.pending_version) || 0);
    if (previous.fingerprint === fingerprint && previous.manifest_hash === pendingManifestHash
        && previous.manifest_complete === true && previous.manifest_protocol === MANIFEST_PROTOCOL && !pendingVersion) {
      const now = nowFn();
      const lastCheck = Number(previous.index_retry_checked_at) || Date.parse(previous.synced_at || "") || 0;
      if (now < lastCheck || now - lastCheck >= INDEX_RETRY_INTERVAL_MS) {
        const options = { stateDir, expectedAccountStateDir: catalog.stateDir,
          accountSelectionRoot: catalog.stateDir ? accountSelectionRoot(catalog.stateDir) : undefined };
        const chunks = probe.map((chunk) => finalizeChunk({ ...chunk, content_version: previous.content_version }));
        const ids = chunks.map((chunk) => chunk.chunk_id);
        const status = await manifestFn("status", { conversation_id: conversation.conversation_id,
          content_version: previous.content_version, chunk_ids: ids }, options);
        if (!status?.ok) {
          if (["history_manifest_stale", "history_manifest_conflict", "history_conversation_not_found"].includes(status?.error)) {
            failed += 1;
            firstError ||= status.error;
            checkpointRotation();
            continue;
          }
          return { ok: false, error: status?.error || "history_status_failed", scanned: conversations.length, synced, skipped };
        }
        if (!Array.isArray(status.pendingChunkIds) || typeof status.published !== "boolean" || status.pendingChunkIds.some((id) => !ids.includes(id))
            || new Set(status.pendingChunkIds).size !== status.pendingChunkIds.length) {
          return { ok: false, error: "invalid_manifest_response", scanned: conversations.length, synced, skipped };
        }
        // Persist before retrying so repeated daemon cycles cannot flood Memory
        // when indexing or callback delivery remains unavailable.
        previous.index_retry_checked_at = now;
        writeState(catalog, state);
        const pending = new Set(status.pendingChunkIds);
        if (pending.size === 0 && !status.published) {
          const completion = await manifestFn("complete", { conversation_id: conversation.conversation_id,
            content_version: previous.content_version, chunk_ids: ids }, options);
          if (!completion?.ok) {
            failed += 1;
            firstError ||= completion?.error || "manifest_complete_failed";
          }
        }
        for (const chunk of chunks) {
          if (!pending.has(chunk.chunk_id)) continue;
          const result = await reportFn(chunk, options);
          if (!result?.ok) {
            failed += 1;
            firstError ||= result?.error || "history_index_retry_failed";
            break;
          }
        }
      }
      skipped += 1;
      checkpointRotation();
      continue;
    }
    const version = previous.pending_fingerprint === fingerprint
      && previous.pending_manifest_hash === pendingManifestHash && pendingVersion > 0
      ? pendingVersion
      : Math.max(0, Number(previous.content_version) || 0, pendingVersion) + 1;
    // Reserve before sending the first chunk. If the process stops after a
    // partial upload, changed contents must never reuse that version number.
    state[conversation.conversation_id] = { ...previous,
      pending_fingerprint: fingerprint, pending_manifest_hash: pendingManifestHash,
      pending_version: version };
    writeState(catalog, state);
    // Use the exact entries fingerprinted above, even if the transcript grows
    // while this sync runs. A later scan will pick up the new content.
    const chunks = probe.map((chunk) => finalizeChunk({ ...chunk, content_version: version }));
    const options = { stateDir, expectedAccountStateDir: catalog.stateDir,
      accountSelectionRoot: catalog.stateDir ? accountSelectionRoot(catalog.stateDir) : undefined };
    const manifest = { conversation_id: conversation.conversation_id, content_version: version };
    const start = await manifestFn("start", manifest, options);
    if (!start?.ok) {
      if (["history_version_stale", "history_conversation_not_found"].includes(start?.error) || start?.status === 422) {
        failed += 1;
        firstError ||= start?.error || `http_${start.status}`;
        checkpointRotation();
        continue;
      }
      return { ok: false, error: start?.error || "manifest_start_failed", scanned: conversations.length, synced, skipped };
    }
    let rowFailure = null;
    for (const chunk of chunks) {
      const result = await reportFn(chunk, options);
      if (!result?.ok) {
        // These errors identify this document or device rather than an
        // unavailable account/service. Preserve its checkpoint for retry,
        // but continue with unrelated conversations.
        if (["device_mismatch", "history_conversation_not_found"].includes(result?.error)
            || [400, 409, 413, 422].includes(result?.status)) {
          rowFailure = result?.error || `http_${result.status}`;
          break;
        }
        return { ok: false, error: result?.error || "history_upload_failed", scanned: conversations.length, synced, skipped };
      }
    }
    if (rowFailure) {
      failed += 1;
      firstError ||= rowFailure;
      checkpointRotation();
      continue;
    }
    const complete = await manifestFn("complete", { ...manifest, chunk_ids: chunks.map((chunk) => chunk.chunk_id) }, options);
    if (!complete?.ok) {
      if (complete?.error === "history_manifest_incomplete") {
        // A conflicting receipt set cannot safely be reused. Preserve the
        // reserved version so the next attempt allocates a newer one.
        delete state[conversation.conversation_id].pending_manifest_hash;
        writeState(catalog, state);
      }
      if (["history_manifest_incomplete", "history_manifest_stale", "history_conversation_not_found"].includes(complete?.error) || complete?.status === 422) {
        failed += 1;
        firstError ||= complete?.error || `http_${complete.status}`;
        checkpointRotation();
        continue;
      }
      return { ok: false, error: complete?.error || "manifest_complete_failed", scanned: conversations.length, synced, skipped };
    }
    state[conversation.conversation_id] = {
      fingerprint,
      manifest_hash: pendingManifestHash,
      content_version: version,
      chunk_ids: chunks.map((chunk) => chunk.chunk_id),
      manifest_complete: true,
      manifest_protocol: MANIFEST_PROTOCOL,
      synced_at: new Date().toISOString(),
    };
    writeState(catalog, state);
    synced += 1;
    checkpointRotation();
  }
  return { ok: failed === 0, scanned: conversations.length, synced, skipped,
    ...(failed ? { error: firstError, failed } : {}) };
}
