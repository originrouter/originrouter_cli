import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCatalog } from "../src/persistence/agentCatalog.js";

// Local history stores the device name so a directly connected App can show
// `<device> · <path>` in the session list. Before this the catalog only kept
// `device_id`, so direct-connect history had no device to display at all.
const stateDir = mkdtempSync(join(tmpdir(), "originrouter-device-name-"));
try {
  // Pin the clock: the history view hides runs older than the auto-archive
  // window, which would otherwise filter these fixtures out.
  const now = new Date("2026-07-22T04:00:00Z");
  const catalog = new AgentCatalog({ stateDir, now: () => now });
  catalog.upsertSession({
    sessionId: "session-named",
    conversationId: "conversation-named",
    runId: "run-named",
    agent: "claude",
    title: "Named device session",
    deviceId: "device-1",
    deviceName: "MacBook Pro",
    cwd: stateDir,
    status: "running",
    startedAt: "2026-07-22T02:00:00Z",
  });

  assert.equal(
    catalog.getConversation("conversation-named").device_name,
    "MacBook Pro",
  );
  assert.equal(
    catalog.listConversations()[0].device_name,
    "MacBook Pro",
  );
  // The history view only lists runs that have ended, which is exactly the
  // collection the App's 历史会话 / History section renders.
  catalog.finishSession("session-named", {
    status: "completed",
    exitedAt: "2026-07-22T02:30:00Z",
  });
  assert.equal(
    catalog.listConversationPage({ collection: "history" })
      .conversations[0].device_name,
    "MacBook Pro",
  );

  // An update that does not carry a device name must not erase it.
  catalog.updateSession("session-named", { nativeSessionId: "native-1" });
  assert.equal(
    catalog.getConversation("conversation-named").device_name,
    "MacBook Pro",
  );

  // A session recorded without a name (pre-migration shape) stays blank until
  // its own device reports, and backfill only claims this device's rows.
  catalog.upsertSession({
    sessionId: "session-unnamed",
    conversationId: "conversation-unnamed",
    runId: "run-unnamed",
    agent: "codex",
    title: "Unnamed device session",
    deviceId: "device-2",
    cwd: stateDir,
    status: "running",
    startedAt: "2026-07-22T03:00:00Z",
  });
  assert.equal(
    catalog.getConversation("conversation-unnamed").device_name,
    "",
  );

  const foreign = catalog.backfillDeviceName({
    deviceId: "device-3",
    deviceName: "Someone Else",
  });
  assert.equal(foreign.updated, 0);
  assert.equal(
    catalog.getConversation("conversation-unnamed").device_name,
    "",
    "a backfill must never stamp this device's name onto another device's run",
  );

  const own = catalog.backfillDeviceName({
    deviceId: "device-2",
    deviceName: "Mac mini",
  });
  assert.equal(own.updated, 1);
  assert.equal(
    catalog.getConversation("conversation-unnamed").device_name,
    "Mac mini",
  );

  // Backfill never overwrites a name that is already recorded.
  catalog.backfillDeviceName({ deviceId: "device-1", deviceName: "Renamed" });
  assert.equal(
    catalog.getConversation("conversation-named").device_name,
    "MacBook Pro",
  );

  assert.deepEqual(
    catalog.backfillDeviceName({ deviceId: "", deviceName: "" }),
    { updated: 0, skipped: true },
  );

  // Reopening an existing database must not fail or lose the column.
  const reopened = new AgentCatalog({ stateDir, now: () => now });
  assert.equal(
    reopened.getConversation("conversation-named").device_name,
    "MacBook Pro",
  );

  console.log("agent catalog device name tests ok");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
