import assert from "node:assert/strict";
import test from "node:test";

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

test("Agent Activity catalog projection excludes local-only locators", () => {
  const projected = agentActivityMetadataFromCatalog(
    conversation("safe", "2026-07-01T00:00:00.000Z"),
  );
  assert.equal(projected.workspaceName, "originrouter-cli");
  assert.equal("workspacePath" in projected, false);
  assert.equal("transcriptLocator" in projected, false);
});
