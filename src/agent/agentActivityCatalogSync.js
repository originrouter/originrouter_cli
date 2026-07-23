import { reportAgentConversationMetadata } from "./bridgeReporter.js";

const SYNC_META_KEY = "agent_activity_cloud_sync_v1";
const PAGE_SIZE = 200;

function safeText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function conversationCursor(conversation) {
  const activityAt = safeText(
    conversation?.last_activity_at || conversation?.created_at,
    64,
  );
  const conversationId = safeText(conversation?.conversation_id, 96);
  return `${activityAt}\u0000${conversationId}`;
}

function readCursor(catalog) {
  try {
    const raw = catalog?.getMeta?.(SYNC_META_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw);
    return safeText(parsed?.cursor, 256);
  } catch {
    return "";
  }
}

function writeCursor(catalog, cursor) {
  catalog?.setMeta?.(
    SYNC_META_KEY,
    JSON.stringify({ cursor, synced_at: new Date().toISOString() }),
  );
}

function hasRecallContent(conversation) {
  return Boolean(
    safeText(conversation?.summary)
    || safeText(conversation?.first_prompt_preview)
    || safeText(conversation?.last_message_preview),
  );
}

export function agentActivityMetadataFromCatalog(conversation = {}) {
  return {
    conversationId: safeText(conversation.conversation_id, 96),
    agentType: safeText(conversation.agent_type, 32) || "unknown",
    nativeSessionId: safeText(conversation.native_session_id, 191),
    title: safeText(conversation.title, 191) || "Agent session",
    summary: safeText(conversation.summary, 4096),
    firstPromptPreview: safeText(conversation.first_prompt_preview, 1024),
    lastMessagePreview: safeText(conversation.last_message_preview, 1024),
    status: safeText(conversation.status, 32) || "stopped",
    workspaceId: safeText(conversation.workspace_id, 96),
    workspaceName: safeText(conversation.workspace_name, 191),
    runtime: safeText(conversation.runtime, 64),
    provider: safeText(conversation.provider, 191),
    model: safeText(conversation.model, 191),
    permissionProfile: safeText(conversation.permission_profile, 64),
    artifactCount: Math.max(
      0,
      Number.parseInt(String(conversation.artifact_count || 0), 10) || 0,
    ),
    createdAt: conversation.created_at,
    lastActivityAt: conversation.last_activity_at,
    archivedAt: conversation.archived_at,
  };
}

function readAllConversations(catalog) {
  const conversations = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = catalog.listConversations({
      includeArchived: true,
      limit: PAGE_SIZE,
      offset,
    });
    conversations.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return conversations.sort((left, right) =>
    conversationCursor(left).localeCompare(conversationCursor(right))
  );
}

export async function syncAgentActivityCatalog({
  catalog,
  stateDir,
  reportFn = reportAgentConversationMetadata,
} = {}) {
  if (!catalog?.listConversations) {
    return { ok: false, error: "catalog_unavailable", scanned: 0, synced: 0 };
  }
  const previousCursor = readCursor(catalog);
  const pending = readAllConversations(catalog).filter(
    (conversation) => conversationCursor(conversation) > previousCursor,
  );
  let synced = 0;
  let skipped = 0;
  for (const conversation of pending) {
    const cursor = conversationCursor(conversation);
    if (!hasRecallContent(conversation)) {
      skipped += 1;
      writeCursor(catalog, cursor);
      continue;
    }
    const result = await reportFn(
      agentActivityMetadataFromCatalog(conversation),
      { stateDir },
    );
    if (!result?.ok) {
      return {
        ok: false,
        error: result?.error || `http_${result?.status || "unknown"}`,
        scanned: pending.length,
        synced,
        skipped,
      };
    }
    if (result.legacyFallback) {
      return {
        ok: false,
        error: "server_timestamp_protocol_unavailable",
        scanned: pending.length,
        synced,
        skipped,
      };
    }
    synced += 1;
    writeCursor(catalog, cursor);
  }
  return {
    ok: true,
    scanned: pending.length,
    synced,
    skipped,
    cursor: pending.length
      ? conversationCursor(pending[pending.length - 1])
      : previousCursor,
  };
}
