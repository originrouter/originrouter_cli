import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import { activateAccount } from "../src/persistence/accounts.js";
import { reportAgentConversationMetadata } from "../src/agent/bridgeReporter.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

import {
  agentActivityMetadataFromCatalog,
  syncAgentActivityCatalog,
} from "../src/agent/agentActivityCatalogSync.js";

function fakeCatalog(conversations) {
  const meta = new Map();
  return {
    listConversations({ offset, limit }) {
      return conversations.slice(offset, offset + limit);
    },
    getMeta(key) {
      return meta.get(key) ?? null;
    },
    setMeta(key, value) {
      meta.set(key, value);
    },
  };
}

function conversation(id, activityAt, overrides = {}) {
  return {
    conversation_id: id,
    agent_type: "claude",
    title: "Claude session",
    summary: "",
    first_prompt_preview: `Idea ${id}`,
    last_message_preview: `Result ${id}`,
    status: "completed",
    workspace_id: "workspace-1",
    workspace_name: "originrouter-cli",
    workspace_path: "/private/project",
    workspace_display_path: "~/Desktop/originrouter-cli",
    transcript_locator: "/private/transcript.jsonl",
    runtime: "native-pty",
    created_at: "2026-06-01T00:00:00.000Z",
    last_activity_at: activityAt,
    ...overrides,
  };
}

test("Agent Activity catalog sync backfills display-safe records once", async () => {
  const catalog = fakeCatalog([
    conversation("newer", "2026-07-02T00:00:00.000Z"),
    conversation("older", "2026-07-01T00:00:00.000Z"),
    conversation("empty", "2026-06-30T00:00:00.000Z", {
      first_prompt_preview: "",
      last_message_preview: "",
      workspace_display_path: "",
    }),
  ]);
  const reported = [];
  const first = await syncAgentActivityCatalog({
    catalog,
    stateDir: "/tmp/originrouter-test",
    reportFn: async (payload) => {
      reported.push(payload);
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(first, {
    ok: true,
    scanned: 3,
    synced: 2,
    skipped: 1,
    cursor: "2026-07-02T00:00:00.000Z\u0000newer",
  });
  assert.deepEqual(reported.map((item) => item.conversationId), ["older", "newer"]);
  assert.equal("workspacePath" in reported[0], false);
  assert.equal(reported[0].workspaceDisplayPath, "~/Desktop/originrouter-cli");
  assert.equal("transcriptPath" in reported[0], false);

  const second = await syncAgentActivityCatalog({
    catalog,
    reportFn: async () => {
      throw new Error("must not upload twice");
    },
  });
  assert.equal(second.ok, true);
  assert.equal(second.scanned, 0);
});

test("Agent Activity catalog sync stops at failure and resumes safely", async () => {
  const catalog = fakeCatalog([
    conversation("second", "2026-07-02T00:00:00.000Z"),
    conversation("first", "2026-07-01T00:00:00.000Z"),
  ]);
  const firstPass = [];
  const failed = await syncAgentActivityCatalog({
    catalog,
    reportFn: async (payload) => {
      firstPass.push(payload.conversationId);
      return payload.conversationId === "second"
        ? { ok: false, status: 503 }
        : { ok: true, status: 200 };
    },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.synced, 1);
  assert.deepEqual(firstPass, ["first", "second"]);

  const resumed = [];
  const retry = await syncAgentActivityCatalog({
    catalog,
    reportFn: async (payload) => {
      resumed.push(payload.conversationId);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(retry.ok, true);
  assert.deepEqual(resumed, ["second"]);
});

test("catalog sync remains bound to its original account after account switch", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-catalog-switch-"));
  activateAccount(stateDir, "sha256:account-a");
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({ sessionId: "session-a", conversationId: "a", runId: "run-a",
      agent: "claude", startedAt: "2025-01-01T00:00:00.000Z" });
    activateAccount(stateDir, "sha256:account-b");
    let sent = 0;
    let seenStateDir;
    const result = await syncAgentActivityCatalog({ catalog, stateDir,
      reportFn: (payload, options) => {
        seenStateDir = options.stateDir;
        return reportAgentConversationMetadata(payload, { ...options,
          ensureFreshAccessTokenFn: async () => makeOAuthCredential({ accountScope: "sha256:account-b" }),
          fetchFn: async () => { sent++; return { ok: true, status: 200 }; },
        });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "account_context_changed");
    assert.equal(seenStateDir, catalog.stateDir);
    assert.equal(sent, 0);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("same-time mixed-case IDs resume with the same order as the cursor", async () => {
  const stamp = "2026-07-01T00:00:00.000Z";
  const catalog = fakeCatalog([conversation("a", stamp), conversation("B", stamp)]);
  const firstPass = [];
  const failed = await syncAgentActivityCatalog({
    catalog,
    reportFn: async ({ conversationId }) => {
      firstPass.push(conversationId);
      return conversationId === "B" ? { ok: false, status: 503 } : { ok: true };
    },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(firstPass, ["B"]);

  const resumed = [];
  const retry = await syncAgentActivityCatalog({
    catalog,
    reportFn: async ({ conversationId }) => {
      resumed.push(conversationId);
      return { ok: true };
    },
  });
  assert.equal(retry.ok, true);
  assert.deepEqual(resumed, ["B", "a"]);
});

test("the corrected ordering preserves an existing sync cursor", async () => {
  const catalog = fakeCatalog([conversation("earlier", "2026-07-01T00:00:00.000Z")]);
  catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2026-07-02T00:00:00.000Z\u0000later" }));
  const reported = [];
  const repaired = [];
  const result = await syncAgentActivityCatalog({
    catalog,
    reportFn: async ({ conversationId }, { insertOnly }) => {
      (insertOnly ? repaired : reported).push(conversationId);
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(reported, []);
  assert.deepEqual(repaired, ["earlier"]);
});

test("missing-row backfill preserves cloud rows and resumes after failure", async () => {
  const stamp = "2026-07-01T00:00:00.000Z";
  const catalog = fakeCatalog([
    conversation("a", stamp, { title: "Old device name", title_is_custom: true }),
    conversation("B", stamp),
    conversation("c", stamp),
  ]);
  catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2026-07-02T00:00:00.000Z\u0000z" }));
  const cloud = new Map([["a", "Cloud name"]]);
  const sent = [];
  let fail = true;
  const reportFn = async (payload, options) => {
    assert.equal(options.insertOnly, true);
    sent.push(payload.conversationId);
    if (fail && payload.conversationId === "a") return { ok: false, status: 503 };
    if (!cloud.has(payload.conversationId)) cloud.set(payload.conversationId, payload.title);
    return { ok: true };
  };
  assert.equal((await syncAgentActivityCatalog({ catalog, reportFn })).ok, true);
  assert.deepEqual(sent, ["B", "a"]);
  assert.equal(cloud.get("a"), "Cloud name");
  fail = false;
  sent.length = 0;
  assert.equal((await syncAgentActivityCatalog({ catalog, reportFn })).ok, true);
  assert.deepEqual(sent, ["a", "c"]);
  assert.equal(cloud.get("a"), "Cloud name");
  assert.equal(cloud.has("B"), true);
  assert.equal(cloud.has("c"), true);
  sent.length = 0;
  await syncAgentActivityCatalog({ catalog, reportFn });
  assert.deepEqual(sent, []);
});

test("backfill reads real persisted catalog records with a pre-existing cursor", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-repair-test-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({
      sessionId: "session-1", conversationId: "conversation-1", runId: "run-1",
      agent: "claude", title: "Real conversation", deviceId: "device-1",
      cwd: stateDir, startedAt: "2026-07-01T00:00:00.000Z",
    });
    catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2099-01-01T00:00:00.000Z\u0000z" }));
    const reports = [];
    const result = await syncAgentActivityCatalog({
      catalog, stateDir,
      reportFn: async (payload, options) => {
        reports.push({ payload, options });
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    // The one-time scan and the durable insert queue both use the safe
    // insert-only route; overlapping work cannot alter an existing cloud row.
    assert.equal(reports.length, 2);
    assert.equal(reports[0].payload.conversationId, "conversation-1");
    assert.equal(reports[0].payload.sessionId, "session-1");
    assert.equal(reports[0].options.insertOnly, true);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("catalog scan keeps a stable snapshot while another process inserts a newer row", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-scan-snapshot-"));
  const catalog = new AgentCatalog({ stateDir });
  const writer = new AgentCatalog({ stateDir });
  try {
    for (let index = 0; index < 201; index++) {
      const id = `row-${String(index).padStart(3, "0")}`;
      writer.upsertSession({ sessionId: id, conversationId: id, runId: id,
        agent: "claude", startedAt: "2025-01-01T00:00:00.000Z" });
    }
    const originalList = catalog.listConversations.bind(catalog);
    let inserted = false;
    catalog.listConversations = (options) => {
      const page = originalList(options);
      if (!inserted && options.offset === 0) {
        inserted = true;
        writer.upsertSession({ sessionId: "new", conversationId: "new", runId: "new",
          agent: "claude", startedAt: "2026-01-01T00:00:00.000Z" });
      }
      return page;
    };
    const ordinary = [];
    const result = await syncAgentActivityCatalog({ catalog, stateDir,
      reportFn: async (payload, options) => {
        if (!options.insertOnly) ordinary.push(payload.conversationId);
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(ordinary.length, 201);
    assert.equal(new Set(ordinary).size, 201);
    assert.equal(ordinary.includes("row-000"), true);
    assert.equal(ordinary.includes("new"), false);
  } finally {
    catalog.close();
    writer.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("older activity changes survive retry and concurrent edits without overwriting conflicts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-preview-queue-"));
  let catalog = new AgentCatalog({ stateDir });
  try {
    for (const [id, at] of [["old", "2025-01-01T00:00:00.000Z"], ["new", "2025-03-01T00:00:00.000Z"]]) {
      catalog.upsertSession({ sessionId: id, conversationId: id, runId: id,
        agent: "claude", startedAt: at, status: "completed" });
    }
    const cloud = { old: { last_message_preview: "", title: "Cloud rename" } };
    const reportFn = async () => ({ ok: true });
    const firstSync = await syncAgentActivityCatalog({ catalog, stateDir, reportFn });
    assert.equal(firstSync.ok, true);
    catalog.recordEvent("old", { type: "agent.text", text: "first", createdAt: "2025-02-01T00:00:00.000Z" });
    assert.equal(catalog.listPendingCatalogPreviews().length, 1);
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn, reconcileFn: async () => ({ ok: false, status: 503 }) });
    catalog.close();
    catalog = new AgentCatalog({ stateDir });
    let calls = 0;
    const reconcileFn = async (change) => {
      calls++;
      if (calls === 1) {
        catalog.recordEvent("old", { type: "agent.text", text: "second", createdAt: "2025-02-01T00:00:00.000Z" });
      }
      const current = cloud.old[change.field];
      if (current === change.previous_value) cloud.old[change.field] = change.next_value;
      return { ok: true, current: cloud.old[change.field] };
    };
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn, reconcileFn });
    assert.equal(cloud.old.last_message_preview, "second");
    assert.equal(catalog.listPendingCatalogPreviews().length, 0);
    cloud.old.last_message_preview = "newer cloud edit";
    catalog.recordEvent("old", { type: "agent.text", text: "third", createdAt: "2025-02-01T00:00:00.000Z" });
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn, reconcileFn });
    assert.equal(cloud.old.last_message_preview, "newer cloud edit");
    assert.equal(cloud.old.title, "Cloud rename");
    assert.equal(catalog.listPendingCatalogPreviews().length, 0);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an unavailable preview row does not starve another conversation or reorder its changes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-preview-fair-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2099-01-01T00:00:00.000Z\u0000z" }));
    catalog.setMeta("agent_activity_missing_backfill_v1", JSON.stringify({ done: true, cursor: "" }));
    for (const id of ["blocked", "ready"]) {
      catalog.upsertSession({ sessionId: id, conversationId: id, runId: id, agent: "claude", startedAt: "2025-01-01T00:00:00.000Z" });
    }
    for (const [id, text] of [["blocked", "one"], ["blocked", "two"], ["ready", "done"]]) {
      catalog.recordEvent(id, { type: "agent.text", text, createdAt: "2025-01-02T00:00:00.000Z" });
    }
    const attempts = [];
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn: async () => ({ ok: true }),
      reconcileFn: async (change) => { attempts.push([change.conversation_id, change.next_value]);
        return change.conversation_id === "blocked" ? { ok: false, status: 404 } : { ok: true }; } });
    assert.deepEqual(attempts, [["blocked", "one"], ["ready", "done"]]);
    const remaining = catalog.db.prepare("SELECT next_value FROM agent_catalog_preview_queue ORDER BY sequence").all();
    assert.deepEqual(remaining.map((row) => row.next_value), ["one", "two"]);
    const retried = [];
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn: async () => ({ ok: true }),
      reconcileFn: async (change) => { retried.push(change.next_value); return { ok: true }; } });
    assert.deepEqual(retried, ["one", "two"]);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("preview scheduler advances across batches of unavailable conversations", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-preview-cursor-"));
  let catalog = new AgentCatalog({ stateDir });
  try {
    catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2099-01-01T00:00:00.000Z\u0000z" }));
    catalog.setMeta("agent_activity_missing_backfill_v1", JSON.stringify({ done: true, cursor: "" }));
    for (let index = 0; index < 56; index++) {
      const id = `row-${String(index).padStart(2, "0")}`;
      catalog.upsertSession({ sessionId: id, conversationId: id, runId: id,
        agent: "claude", startedAt: "2025-01-01T00:00:00.000Z" });
      catalog.recordEvent(id, { type: "agent.text", text: id, createdAt: "2025-01-02T00:00:00.000Z" });
    }
    const attempts = [];
    const sync = () => syncAgentActivityCatalog({ catalog, stateDir, reportFn: async () => ({ ok: true }),
      reconcileFn: async (change) => { attempts.push(change.conversation_id);
        return change.conversation_id === "row-55" ? { ok: true } : { ok: false, status: 404 }; } });
    await sync();
    assert.equal(attempts.length, 50);
    assert.equal(attempts.includes("row-55"), false);
    catalog.close();
    catalog = new AgentCatalog({ stateDir });
    await sync();
    assert.equal(attempts.includes("row-55"), true);
    assert.equal(catalog.db.prepare("SELECT COUNT(*) AS n FROM agent_catalog_preview_queue WHERE conversation_id = 'row-55'").get().n, 0);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("late old inserts are durably backfilled without changing existing cloud rows", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-late-insert-"));
  let catalog = new AgentCatalog({ stateDir });
  try {
    catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2099-01-01T00:00:00.000Z\u0000z" }));
    catalog.setMeta("agent_activity_missing_backfill_v1", JSON.stringify({ done: true, cursor: "" }));
    catalog.upsertSession({ sessionId: "old-session", conversationId: "old", runId: "old-run",
      agent: "claude", title: "Old local title", startedAt: "2020-01-01T00:00:00Z" });
    catalog.close();
    catalog = new AgentCatalog({ stateDir });
    const cloud = new Map([["old", "Cloud rename"]]);
    let attempts = 0;
    const reportFn = async (payload, options) => {
      assert.equal(options.insertOnly, true);
      if (++attempts === 1) return { ok: false, status: 503 };
      if (!cloud.has(payload.conversationId)) cloud.set(payload.conversationId, payload.title);
      return { ok: true };
    };
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn });
    assert.equal(catalog.listPendingCatalogInserts().length, 1);
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn });
    assert.equal(catalog.listPendingCatalogInserts().length, 0);
    assert.equal(cloud.get("old"), "Cloud rename");
    catalog.upsertSession({ sessionId: "another-session", conversationId: "another", runId: "another-run",
      agent: "claude", title: "Recovered", startedAt: "2020-01-01T00:00:00Z" });
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn });
    assert.equal(cloud.get("another"), "Recovered");
    assert.equal(attempts, 3);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the durable insert queue is bounded and excludes collaboration workers", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-insert-batch-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2099-01-01T00:00:00.000Z\u0000z" }));
    catalog.setMeta("agent_activity_missing_backfill_v1", JSON.stringify({ done: true, cursor: "" }));
    catalog.upsertSession({ sessionId: "collab-worker", conversationId: "worker", runId: "acr_worker",
      agent: "claude", startedBy: "collaboration-runtime", startedAt: "2020-01-01T00:00:00Z" });
    for (let i = 0; i < 51; i++) {
      catalog.upsertSession({ sessionId: `session-${i}`, conversationId: `conversation-${i}`,
        runId: `run-${i}`, agent: "claude", startedAt: "2020-01-01T00:00:00Z" });
    }
    const sent = [];
    const reportFn = async (payload, options) => {
      assert.equal(options.insertOnly, true);
      sent.push(payload.conversationId);
      return { ok: true };
    };
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn });
    assert.equal(sent.length, 49);
    assert.equal(catalog.listPendingCatalogInserts().length, 2);
    await syncAgentActivityCatalog({ catalog, stateDir, reportFn });
    assert.equal(sent.length, 51);
    assert.equal(sent.includes("worker"), false);
    assert.equal(catalog.listPendingCatalogInserts().length, 0);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("unsupported or failing backfill does not block ordinary new sync", async () => {
  const rows = [conversation("old", "2026-07-01T00:00:00.000Z")];
  const catalog = fakeCatalog(rows);
  catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2026-07-02T00:00:00.000Z\u0000z" }));
  const sent = [];
  const reportFn = async (payload, options) => {
    sent.push([payload.conversationId, options.insertOnly === true]);
    if (options.insertOnly) throw new Error("backfill unavailable");
    return { ok: true };
  };
  assert.equal((await syncAgentActivityCatalog({ catalog, reportFn })).ok, true);
  rows.push(conversation("new", "2026-07-03T00:00:00.000Z"));
  sent.length = 0;
  assert.equal((await syncAgentActivityCatalog({ catalog, reportFn })).ok, true);
  assert.deepEqual(sent, [["new", false], ["new", true]]);
});

test("missing-row backfill is bounded and resumes on the next cycle", async () => {
  const rows = Array.from({ length: 55 }, (_, index) =>
    conversation(`id-${String(index).padStart(2, "0")}`, "2026-07-01T00:00:00.000Z"));
  const catalog = fakeCatalog(rows);
  catalog.setMeta("agent_activity_cloud_sync_v5", JSON.stringify({ cursor: "2026-07-02T00:00:00.000Z\u0000z" }));
  const sent = [];
  const reportFn = async (payload, options) => {
    assert.equal(options.insertOnly, true);
    sent.push(payload.conversationId);
    return { ok: true };
  };
  await syncAgentActivityCatalog({ catalog, reportFn });
  assert.equal(sent.length, 50);
  // An unsent conversation can move in the activity ordering between
  // cycles. The repair checkpoint is its stable ID, not that changing time.
  rows[54].last_activity_at = "2026-06-01T00:00:00.000Z";
  await syncAgentActivityCatalog({ catalog, reportFn });
  assert.equal(sent.length, 55);
  assert.equal(new Set(sent).size, 55);
  await syncAgentActivityCatalog({ catalog, reportFn });
  assert.equal(sent.length, 55);
});

test("Agent Activity catalog projection excludes local-only locators", () => {
  const projected = agentActivityMetadataFromCatalog(
    conversation("safe", "2026-07-01T00:00:00.000Z"),
  );
  assert.equal(projected.workspaceName, "originrouter-cli");
  assert.equal(projected.workspaceDisplayPath, "~/Desktop/originrouter-cli");
  assert.equal("workspacePath" in projected, false);
  assert.equal("transcriptLocator" in projected, false);
});

test("the projection carries the link to the session the run belongs to", () => {
  // The device is the only side that knows both ids, so the link travels
  // with the report. Without it the cloud can only guess which run a
  // conversation belongs to.
  const projected = agentActivityMetadataFromCatalog(
    conversation("linked", "2026-07-01T00:00:00.000Z", {
      session_id: "ags_9F3kQ2",
    }),
  );
  assert.equal(projected.sessionId, "ags_9F3kQ2");
});

test("a conversation with a link and no text is still reported", async () => {
  // The link is user-visible catalog metadata, like the display path: a
  // conversation with nothing to say about itself still has to say which
  // session it belongs to.
  const catalog = fakeCatalog([
    conversation("linked-only", "2026-07-01T00:00:00.000Z", {
      summary: "",
      first_prompt_preview: "",
      last_message_preview: "",
      workspace_display_path: "",
      session_id: "ags_9F3kQ2",
    }),
  ]);
  const reported = [];
  const result = await syncAgentActivityCatalog({
    catalog,
    stateDir: "/tmp/originrouter-test",
    reportFn: async (payload) => {
      reported.push(payload);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.synced, 1);
  assert.equal(result.skipped, 0);
  assert.equal(reported[0].sessionId, "ags_9F3kQ2");
});
