import { reportAgentConversationMetadata, reconcileAgentCatalogPreview } from "./bridgeReporter.js";
import { accountSelectionRoot } from "../persistence/accounts.js";

// Bump the cursor namespace when the projected metadata contract changes so
// existing conversations are replayed once and receive workspace_display_path
// and the link to the session their current run belongs to.
const SYNC_META_KEY = "agent_activity_cloud_sync_v5";
const REPAIR_META_KEY = "agent_activity_missing_backfill_v1";
const PREVIEW_SCHEDULER_KEY = "agent_activity_preview_scheduler_v1";
const PAGE_SIZE = 200;
const REPAIR_BATCH_SIZE = 50;

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

function readRepairState(catalog) {
  try {
    const state = JSON.parse(catalog?.getMeta?.(REPAIR_META_KEY) || "{}");
    return { done: state.done === true, cursor: safeText(state.cursor, 256) };
  } catch {
    return { done: false, cursor: "" };
  }
}

function writeRepairState(catalog, state) {
  catalog?.setMeta?.(REPAIR_META_KEY, JSON.stringify(state));
}

async function backfillMissingRows({ catalog, stateDir, reportFn }) {
  const state = readRepairState(catalog);
  if (state.done) return;
  // Activity timestamps can change while the repair is in progress. Use
  // the stable conversation ID so moving a row cannot move it behind the
  // checkpoint between batches.
  const repairId = (conversation) => safeText(conversation.conversation_id, 96);
  const remaining = readAllConversations(catalog)
    .filter((conversation) => repairId(conversation) > state.cursor)
    .sort((left, right) => {
      const a = repairId(left);
      const b = repairId(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const batch = remaining.slice(0, REPAIR_BATCH_SIZE);
  for (const conversation of batch) {
    if (hasRecallContent(conversation)) {
      // This is a distinct server route, never an ordinary upsert. If the
      // server does not support it or the request fails, leave the cursor
      // where it is and retry later; normal sync remains independent.
      let result;
      try {
        result = await reportFn(agentActivityMetadataFromCatalog(conversation), {
          stateDir, expectedAccountStateDir: catalog.stateDir,
          accountSelectionRoot: catalog.stateDir ? accountSelectionRoot(catalog.stateDir) : undefined, insertOnly: true,
        });
      } catch {
        return;
      }
      if (!result?.ok) return;
    }
    state.cursor = repairId(conversation);
    writeRepairState(catalog, state);
  }
  if (remaining.length <= batch.length) {
    state.done = true;
    writeRepairState(catalog, state);
  }
}

// Inserts made after the one-time repair can have an activity timestamp before
// its checkpoint. Persist their identities at insertion time and only try the
// insert-only endpoint, so an old local title cannot replace a cloud rename.
async function syncPendingInserts({ catalog, stateDir, reportFn }) {
  if (!catalog.listPendingCatalogInserts || !catalog.acknowledgeCatalogInsert) return;
  for (const entry of catalog.listPendingCatalogInserts(REPAIR_BATCH_SIZE)) {
    const row = catalog.listConversations({
      conversationId: entry.conversation_id, includeArchived: true,
      includeCollaboration: false, limit: 1,
    })[0];
    if (row && hasRecallContent(row)) {
      let result;
      try {
        result = await reportFn(agentActivityMetadataFromCatalog(row), {
          stateDir, expectedAccountStateDir: catalog.stateDir,
          accountSelectionRoot: catalog.stateDir ? accountSelectionRoot(catalog.stateDir) : undefined, insertOnly: true,
        });
      } catch {
        return;
      }
      if (!result?.ok) return;
    }
    catalog.acknowledgeCatalogInsert(entry.sequence);
  }
}

async function syncPendingPreviews({ catalog, stateDir, reconcileFn }) {
  if (!catalog.listPendingCatalogPreviews || !catalog.acknowledgeCatalogPreview) return;
  let after = Math.max(0, Number(catalog.getMeta?.(PREVIEW_SCHEDULER_KEY)) || 0);
  const attempted = new Set();
  for (let count = 0; count < REPAIR_BATCH_SIZE; count++) {
    let [change] = catalog.listPendingCatalogPreviews(1, after);
    if (!change && after) [change] = catalog.listPendingCatalogPreviews(1, 0);
    if (!change || attempted.has(change.sequence)) break;
    attempted.add(change.sequence);
    after = change.sequence;
    catalog.setMeta?.(PREVIEW_SCHEDULER_KEY, String(after));
    const row = catalog.listConversations({ conversationId: change.conversation_id,
      includeArchived: true, includeCollaboration: false, limit: 1 })[0];
    if (row) {
      let result;
      try {
        result = await reconcileFn(change, { stateDir, expectedAccountStateDir: catalog.stateDir,
          accountSelectionRoot: catalog.stateDir ? accountSelectionRoot(catalog.stateDir) : undefined });
      } catch {
        return;
      }
      // A conflict is a successful, deliberate preservation of the server's
      // newer value. Only an actual transport/protocol failure stays queued.
      if (!result?.ok) {
        // A missing row or an unsupported endpoint must not starve unrelated
        // conversations. Leave it queued and try another conversation; all
        // later changes to this one stay behind its earliest pending change.
        if ([404, 409, 422].includes(result?.status)) continue;
        return;
      }
    }
    catalog.acknowledgeCatalogPreview(change.sequence);
  }
}

function hasRecallContent(conversation) {
  return Boolean(
    safeText(conversation?.summary)
    || safeText(conversation?.first_prompt_preview)
    || safeText(conversation?.last_message_preview)
    // Workspace display paths are also user-visible catalog metadata. They
    // must backfill even for sessions that have no safe prompt/summary text.
    || safeText(conversation?.workspace_display_path)
    // The link to the session this conversation's current run belongs to.
    // Without it the cloud cannot tell which run a conversation belongs to,
    // and the App cannot find a conversation by the session id it was given.
    || safeText(conversation?.session_id, 64),
  );
}

export function agentActivityMetadataFromCatalog(conversation = {}) {
  return {
    conversationId: safeText(conversation.conversation_id, 96),
    // The session this conversation's current run belongs to. The device is
    // the only side that knows both ids: the run was started under a
    // session id, and the conversation is the book that run lives in.
    sessionId: safeText(conversation.session_id, 64),
    agentType: safeText(conversation.agent_type, 32) || "unknown",
    nativeSessionId: safeText(conversation.native_session_id, 191),
    title: safeText(conversation.title, 191) || "Agent session",
    // Whether a person chose this title. A title the agent produced is not
    // one, and must never displace a rename on the server either.
    titleIsCustom: conversation.title_is_custom === true,
    summary: safeText(conversation.summary, 4096),
    firstPromptPreview: safeText(conversation.first_prompt_preview, 1024),
    lastMessagePreview: safeText(conversation.last_message_preview, 1024),
    status: safeText(conversation.status, 32) || "stopped",
    workspaceId: safeText(conversation.workspace_id, 96),
    workspaceName: safeText(conversation.workspace_name, 191),
    // This is the CLI-computed presentation path (home shortened only on the
    // source device). Keep it separate from workspaceName so the App never
    // has to guess whether a basename is a path.
    workspaceDisplayPath: safeText(conversation.workspace_display_path, 4096),
    runtime: safeText(conversation.runtime, 64),
    provider: safeText(conversation.provider, 191),
    model: safeText(conversation.model, 191),
    permissionProfile: safeText(conversation.permission_profile, 64),
    permissionRevision: Number(conversation.permission_revision) || 0,
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
  const read = () => readConversationPages(catalog);
  return catalog.readCatalogSnapshot ? catalog.readCatalogSnapshot(read) : read();
}

function readConversationPages(catalog) {
  const conversations = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = catalog.listConversations({
      includeArchived: true,
      includeCollaboration: false,
      limit: PAGE_SIZE,
      offset,
    });
    conversations.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return conversations.sort((left, right) => {
    const leftCursor = conversationCursor(left);
    const rightCursor = conversationCursor(right);
    return leftCursor < rightCursor ? -1 : leftCursor > rightCursor ? 1 : 0;
  });
}

export async function syncAgentActivityCatalog({
  catalog,
  stateDir,
  reportFn = reportAgentConversationMetadata,
  reconcileFn = reconcileAgentCatalogPreview,
} = {}) {
  if (!catalog?.listConversations) {
    return { ok: false, error: "catalog_unavailable", scanned: 0, synced: 0 };
  }
  // Bind credentials to the catalog selected at construction, not a new
  // active account that may appear before the daemon's restart timer fires.
  stateDir = catalog.stateDir || stateDir;
  const previousCursor = readCursor(catalog);
  if (!previousCursor && !catalog?.getMeta?.(REPAIR_META_KEY)) {
    // Even if the first normal sync is interrupted, the corrected cursor
    // resumes that full scan; it does not need a second backfill pass.
    writeRepairState(catalog, { done: true, cursor: "" });
  }
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
      { stateDir, expectedAccountStateDir: catalog.stateDir,
        accountSelectionRoot: catalog.stateDir ? accountSelectionRoot(catalog.stateDir) : undefined },
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
  if (previousCursor) {
    await backfillMissingRows({ catalog, stateDir, reportFn });
  }
  await syncPendingInserts({ catalog, stateDir, reportFn });
  await syncPendingPreviews({ catalog, stateDir, reconcileFn });
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
