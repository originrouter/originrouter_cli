import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";

test("old conversations resolve by either ID beyond the first 200 rows", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-lookup-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({
      sessionId: "old-session", conversationId: "old-conversation", runId: "old-run",
      nativeSessionId: "native-old", agent: "claude", title: "Older work",
      deviceId: "device-1", cwd: stateDir, status: "completed",
      startedAt: "2025-01-01T00:00:00.000Z", archivedAt: "2025-01-02T00:00:00.000Z",
    });
    for (let index = 0; index < 205; index++) {
      catalog.upsertSession({
        sessionId: `recent-session-${index}`, conversationId: `recent-${String(index).padStart(3, "0")}`,
        runId: `recent-run-${index}`, agent: "codex", status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z", deviceId: "device-1",
      });
    }
    assert.equal(catalog.listConversations({ limit: 200, includeArchived: true })
      .some((row) => row.conversation_id === "old-conversation"), false);
    for (const id of ["old-conversation", "old-session"]) {
      const found = catalog.getConversation(id);
      assert.equal(found.conversation_id, "old-conversation");
      assert.equal(found.session_id, "old-session");
      assert.equal(found.native_session_id, "native-old");
      assert.equal(found.runs[0].originrouter_session_id, "old-session");
      assert.ok(found.archived_at);
    }
    assert.equal(catalog.getConversation("missing"), null);
    assert.equal(catalog.getConversation(""), null);
    const page1 = catalog.listConversationPage({ collection: "history", autoArchiveDays: 0, page: 1, pageSize: 2 });
    const page2 = catalog.listConversationPage({ collection: "history", autoArchiveDays: 0, page: 2, pageSize: 2 });
    assert.deepEqual(page1.conversations.map((row) => row.conversation_id), ["recent-204", "recent-203"]);
    assert.deepEqual(page2.conversations.map((row) => row.conversation_id), ["recent-202", "recent-201"]);
    assert.equal(catalog.renameConversation("old-conversation", "Renamed").title, "Renamed");
    assert.equal(catalog.setConversationArchived("old-conversation", false).archived_at, null);
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("paged history excludes a conversation while any selected run is active", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-active-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({ sessionId: "live", conversationId: "shared", runId: "run-live",
      agent: "claude", status: "running", startedAt: "2026-01-01T00:00:00.000Z" });
    catalog.upsertSession({ sessionId: "done", conversationId: "shared", runId: "run-done",
      agent: "claude", status: "completed", startedAt: "2026-02-01T00:00:00.000Z" });
    assert.equal(catalog.getConversation("shared").session_id, "live");
    for (const collection of ["history", "archived"]) {
      assert.equal(catalog.listConversationPage({ collection, autoArchiveDays: 0 }).pagination.total, 0);
    }
    catalog.finishSession("live", { status: "completed" });
    const page = catalog.listConversationPage({ collection: "history", autoArchiveDays: 0 });
    assert.equal(page.pagination.total, 1);
    assert.equal(page.conversations[0].session_id, "done");
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("late events and older session upserts do not move activity backwards", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-activity-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({ sessionId: "new", conversationId: "shared", runId: "new-run",
      agent: "claude", startedAt: "2026-02-01T00:00:00.000Z" });
    catalog.upsertSession({ sessionId: "old", conversationId: "shared", runId: "old-run",
      agent: "claude", startedAt: "2026-01-01T00:00:00.000Z" });
    assert.equal(catalog.getConversation("shared").last_activity_at, "2026-02-01T00:00:00.000Z");
    catalog.recordEvent("old", { type: "agent.text", text: "Late event",
      createdAt: "2026-01-02T00:00:00.000Z" });
    assert.equal(catalog.getConversation("shared").last_activity_at, "2026-02-01T00:00:00.000Z");
    catalog.recordEvent("new", { type: "agent.text", text: "New event",
      createdAt: "2026-03-01T00:00:00.000Z" });
    assert.equal(catalog.getConversation("shared").last_activity_at, "2026-03-01T00:00:00.000Z");
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("renaming with a clock behind recorded activity does not reorder history", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-rename-clock-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const catalog = new AgentCatalog({ stateDir, now: () => now });
  try {
    catalog.upsertSession({ sessionId: "first", conversationId: "first", runId: "first",
      agent: "claude", status: "completed", startedAt: "2026-03-01T00:00:00.000Z" });
    catalog.upsertSession({ sessionId: "second", conversationId: "second", runId: "second",
      agent: "claude", status: "completed", startedAt: "2026-02-01T00:00:00.000Z" });
    const renamed = catalog.renameConversation("first", "Chosen name");
    assert.equal(renamed.title, "Chosen name");
    assert.equal(renamed.last_activity_at, "2026-03-01T00:00:00.000Z");
    assert.deepEqual(catalog.listConversations().map((row) => row.conversation_id), ["first", "second"]);
    now = new Date("2026-04-01T00:00:00.000Z");
    assert.equal(catalog.renameConversation("first", "Later name").last_activity_at,
      "2026-04-01T00:00:00.000Z");
  } finally {
    catalog.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
