import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCatalog } from "../src/persistence/agentCatalog.js";

// The database's own word for the rule the code keeps: one provider
// conversation is one row.
//
// The rule used to live only in the code — the code folded the rows that
// named the same conversation, and nothing stopped a second row from being
// written behind its back. The index is what says it in the database, and
// it is partial: a conversation the provider has not named yet is a
// conversation of its own, and the index says so by leaving it out.

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-provider-index-"));
let clock = Date.parse("2026-11-06T00:00:00Z");
const now = () => new Date(clock += 1000);
const catalog = new AgentCatalog({ stateDir, now });

const indexExists = (target) => Boolean(target.db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type = 'index' AND name = 'idx_agent_conversations_provider'
`).get());

assert.ok(indexExists(catalog), "the rule is in the database when the catalog opens");

// A second row for one provider conversation is refused.
catalog.db.prepare(`
  INSERT INTO agent_conversations(
    conversation_id, agent_type, native_session_id, title, title_is_custom,
    created_at, last_activity_at
  ) VALUES ('index-first', 'claude', 'index-native', 'First', 0, ?, ?)
`).run(new Date(clock).toISOString(), new Date(clock).toISOString());
assert.throws(
  () => catalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES ('index-second', 'claude', 'index-native', 'Second', 0, ?, ?)
  `).run(new Date(clock).toISOString(), new Date(clock).toISOString()),
  /UNIQUE constraint failed/,
  "a second row for one provider conversation cannot be written",
);

// A conversation the provider has not named yet is a conversation of its own.
for (const conversationId of ["index-unnamed-1", "index-unnamed-2", "index-unnamed-3"]) {
  catalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, 'claude', '', 'Unnamed', 0, ?, ?)
  `).run(conversationId, new Date(clock).toISOString(), new Date(clock).toISOString());
}
assert.equal(
  catalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ''",
  ).get().count,
  3,
  "rows without a provider's id are not part of the rule",
);

// The provider's id is scoped to an agent: the same id under another agent
// is another conversation.
catalog.db.prepare(`
  INSERT INTO agent_conversations(
    conversation_id, agent_type, native_session_id, title, title_is_custom,
    created_at, last_activity_at
  ) VALUES ('index-other-agent', 'codex', 'index-native', 'Other agent', 0, ?, ?)
`).run(new Date(clock).toISOString(), new Date(clock).toISOString());
assert.equal(
  catalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = 'index-native'",
  ).get().count,
  2,
  "the same provider id under another agent is another conversation",
);

// --- The write paths keep the rule -------------------------------------------

// Two reports for one provider conversation: one row.
catalog.upsertSession({
  sessionId: "index-session-1",
  conversationId: "index-conversation-1",
  runId: "index-run-1",
  agent: "claude",
  title: "One conversation",
  deviceId: "index-device",
  cwd: stateDir,
  nativeSessionId: "index-written",
  startedAt: new Date(clock).toISOString(),
});
catalog.upsertSession({
  sessionId: "index-session-2",
  conversationId: "index-conversation-2",
  runId: "index-run-2",
  agent: "claude",
  title: "One conversation",
  deviceId: "index-device",
  cwd: stateDir,
  nativeSessionId: "index-written",
  startedAt: new Date(clock).toISOString(),
});
assert.equal(
  catalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = 'index-written'",
  ).get().count,
  1,
  "two reports for one provider conversation leave one row",
);
assert.equal(
  catalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runs WHERE conversation_id = ?",
  ).get("index-conversation-1").count,
  2,
  "both runs belong to the one conversation",
);

// The event path: the agent announces the provider's id for a conversation
// that another row already holds. The row that holds it keeps it, and the
// two rows are folded — the write does not fail where a conversation was
// only being recorded.
catalog.upsertSession({
  sessionId: "index-session-3",
  conversationId: "index-conversation-3",
  runId: "index-run-3",
  agent: "claude",
  title: "Announced later",
  deviceId: "index-device",
  cwd: stateDir,
  startedAt: new Date(clock).toISOString(),
});
catalog.upsertSession({
  sessionId: "index-session-4",
  conversationId: "index-conversation-4",
  runId: "index-run-4",
  agent: "claude",
  title: "Announced earlier",
  deviceId: "index-device",
  cwd: stateDir,
  nativeSessionId: "index-announced",
  startedAt: new Date(clock).toISOString(),
});
assert.doesNotThrow(
  () => catalog.recordEvent("index-session-3", {
    type: "agent.session_id",
    sessionId: "index-announced",
  }),
  "the event path folds the rows instead of failing the write",
);
assert.equal(
  catalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = 'index-announced'",
  ).get().count,
  1,
  "one provider conversation, one row, after the event too",
);

catalog.close();

// --- A database that was written before the rule -----------------------------

// The rows written before the provider's id was used to identify a
// conversation: one row per attempt at it. The catalog folds them and puts
// the rule in the database.
const legacyStateDir = mkdtempSync(join(tmpdir(), "originrouter-provider-index-legacy-"));
let legacyClock = Date.parse("2026-11-06T00:00:00Z");
const legacyCatalog = new AgentCatalog({
  stateDir: legacyStateDir,
  now: () => new Date(legacyClock += 1000),
});
legacyCatalog.db.exec("DROP INDEX IF EXISTS idx_agent_conversations_provider");
for (const conversationId of ["legacy-1", "legacy-2"]) {
  legacyCatalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, 'claude', 'legacy-native', 'Legacy', 0, ?, ?)
  `).run(
    conversationId,
    new Date(legacyClock).toISOString(),
    new Date(legacyClock + (conversationId === "legacy-2" ? 5000 : 0)).toISOString(),
  );
}
legacyCatalog.close();

const repairedCatalog = new AgentCatalog({
  stateDir: legacyStateDir,
  now: () => new Date(legacyClock += 1000),
});
assert.equal(
  repairedCatalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = 'legacy-native'",
  ).get().count,
  1,
  "the rows written before the rule are folded into one row",
);
assert.ok(indexExists(repairedCatalog), "the rule is in the database after the fold");
repairedCatalog.close();

// --- A fold that fails is not a rule that is in place -------------------------

// The rule cannot be made while the data still breaks it. A catalog that
// could not fold the rows says so and carries on: a rule the database
// cannot state yet is not a reason to stop working.
const failingStateDir = mkdtempSync(join(tmpdir(), "originrouter-provider-index-failing-"));
let failingClock = Date.parse("2026-11-06T00:00:00Z");
const failingCatalog = new AgentCatalog({
  stateDir: failingStateDir,
  now: () => new Date(failingClock += 1000),
});
failingCatalog.db.exec("DROP INDEX IF EXISTS idx_agent_conversations_provider");
failingCatalog.db.prepare(`
  CREATE TRIGGER blocked_artifact_move BEFORE UPDATE ON agent_artifacts
  BEGIN SELECT RAISE(ABORT, 'the artifact may not move'); END;
`).run();
for (const conversationId of ["failing-1", "failing-2"]) {
  failingCatalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, 'claude', 'failing-native', 'Failing', 0, ?, ?)
  `).run(
    conversationId,
    new Date(failingClock).toISOString(),
    new Date(failingClock + (conversationId === "failing-2" ? 5000 : 0)).toISOString(),
  );
}
failingCatalog.db.prepare(`
  INSERT INTO agent_artifacts(
    artifact_id, conversation_id, kind, locator, display_value,
    first_seen_at, last_seen_at
  ) VALUES ('failing-artifact', 'failing-1', 'file', '/tmp/failing.txt',
            'failing.txt', ?, ?)
`).run(new Date(failingClock).toISOString(), new Date(failingClock).toISOString());
failingCatalog.close();

let failedCatalog = null;
assert.doesNotThrow(() => {
  failedCatalog = new AgentCatalog({
    stateDir: failingStateDir,
    now: () => new Date(failingClock += 1000),
  });
}, "a catalog that cannot fold the rows still opens");
assert.equal(
  failedCatalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = 'failing-native'",
  ).get().count,
  2,
  "the rows are still there: the fold failed",
);
assert.equal(
  indexExists(failedCatalog),
  false,
  "the rule is not in the database while the data still breaks it",
);

// The next open tries again — the index is made once the fold can finish.
failedCatalog.db.prepare("DROP TRIGGER blocked_artifact_move").run();
failedCatalog.close();
const retriedCatalog = new AgentCatalog({
  stateDir: failingStateDir,
  now: () => new Date(failingClock += 1000),
});
assert.equal(
  retriedCatalog.db.prepare(
    "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = 'failing-native'",
  ).get().count,
  1,
  "the fold runs again once it can finish",
);
assert.ok(indexExists(retriedCatalog), "the rule is in the database after the fold");
retriedCatalog.close();

rmSync(stateDir, { recursive: true, force: true });
rmSync(legacyStateDir, { recursive: true, force: true });
rmSync(failingStateDir, { recursive: true, force: true });
