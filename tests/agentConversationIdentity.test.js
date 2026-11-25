import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";

// A conversation is the provider's own id for it. Our conversation id is
// minted per launch, so a resumed conversation used to get a row of its own
// for every attempt at it — and the App's rail showed the same conversation
// once per attempt.
//
// These tests pin the rule that fixes it: the provider's id decides which
// conversation a run belongs to, and everything else follows it.

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-identity-"));
let clock = Date.parse("2026-11-05T00:00:00Z");
const now = () => new Date(clock += 1000);

const catalog = new AgentCatalog({ stateDir, now });

// The rows written before the provider's id was used to identify a
// conversation: one row per attempt at it.
//
// They cannot be written while the rule is in the database — the index is
// the rule, and it refuses a second row for one provider conversation — so
// the index is taken away for the moment and put back afterwards. That is
// how those rows came to be there in the first place.
const withoutProviderIndex = (target) => {
  target.db.exec("DROP INDEX IF EXISTS idx_agent_conversations_provider");
};

// --- The first attempt at a conversation -------------------------------------

const first = catalog.upsertSession({
  sessionId: "claude-aaaa",
  conversationId: "claude-aaaa",
  runId: "run-aaaa",
  agent: "claude",
  title: "桌面 HelloWorld 程序",
  deviceId: "device-1",
  cwd: stateDir,
  startedAt: new Date(clock).toISOString(),
});
assert.equal(first.conversation_id, "claude-aaaa");
assert.equal(first.native_session_id, "");

// The agent announces the provider's id for the conversation.
catalog.updateSession("claude-aaaa", { nativeSessionId: "cde89751-e680-4f01-843d-8763915e22e7" });
assert.equal(
  catalog.getConversation("claude-aaaa").native_session_id,
  "cde89751-e680-4f01-843d-8763915e22e7",
  "the provider's id must be recorded",
);

// --- The second attempt at the same conversation ------------------------------

// The reader resumes it. The run is new, the label is new, the conversation
// is not.
const second = catalog.upsertSession({
  sessionId: "claude-bbbb",
  conversationId: "claude-bbbb",
  runId: "run-bbbb",
  agent: "claude",
  title: "桌面 HelloWorld 程序",
  deviceId: "device-1",
  cwd: stateDir,
  nativeSessionId: "cde89751-e680-4f01-843d-8763915e22e7",
  startedAt: new Date(clock).toISOString(),
});
assert.equal(
  second.conversation_id,
  "claude-aaaa",
  "a resumed conversation is the row that already holds it, not a row of its own",
);

// The attempt's own label is gone: nothing points at it any more.
assert.equal(
  catalog.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE conversation_id = ?")
    .get("claude-bbbb").count,
  0,
  "the attempt's label must not survive as a conversation of its own",
);
assert.equal(
  catalog.getConversation("claude-aaaa").runs.length,
  2,
  "both runs belong to the one conversation",
);

// --- The lookup is deterministic ---------------------------------------------

assert.equal(
  catalog.conversationIdForNativeSession("claude", "cde89751-e680-4f01-843d-8763915e22e7"),
  "claude-aaaa",
);
assert.equal(
  catalog.conversationIdForNativeSession("claude", "not-a-conversation"),
  "",
  "an unknown provider id names no conversation",
);
assert.equal(
  catalog.conversationIdForNativeSession("", ""),
  "",
  "an empty provider id names no conversation",
);

// The provider's id is scoped to the agent: the same id under another agent
// is another conversation.
assert.equal(
  catalog.conversationIdForNativeSession("codex", "cde89751-e680-4f01-843d-8763915e22e7"),
  "",
  "a provider id is not shared between agents",
);

// --- A deliberate move to another conversation still wins --------------------

const other = catalog.upsertSession({
  sessionId: "claude-cccc",
  conversationId: "claude-cccc",
  runId: "run-cccc",
  agent: "claude",
  title: "Another conversation",
  deviceId: "device-1",
  cwd: stateDir,
  nativeSessionId: "11111111-2222-3333-4444-555555555555",
  startedAt: new Date(clock).toISOString(),
});
assert.equal(other.conversation_id, "claude-cccc");

// A run that moves to the other conversation is not a second attempt at the
// first one: the label it was given names a different provider conversation,
// so the label wins.
const moved = catalog.upsertSession({
  sessionId: "claude-dddd",
  conversationId: "claude-cccc",
  runId: "run-dddd",
  agent: "claude",
  title: "Another conversation",
  deviceId: "device-1",
  cwd: stateDir,
  nativeSessionId: "11111111-2222-3333-4444-555555555555",
  startedAt: new Date(clock).toISOString(),
});
assert.equal(
  moved.conversation_id,
  "claude-cccc",
  "a move to another conversation is not blocked by the identity rule",
);

// --- Two rows for one conversation fold into one -----------------------------

const folded = catalog.db.prepare(`
  SELECT conversation_id FROM agent_conversations
  WHERE native_session_id = 'cde89751-e680-4f01-843d-8763915e22e7'
`).all();
assert.equal(folded.length, 1, "one provider conversation, one row");

// The rows written before the identity rule existed: one row per attempt.
withoutProviderIndex(catalog);
catalog.db.prepare(`
  INSERT INTO agent_conversations(
    conversation_id, agent_type, native_session_id, title, title_is_custom,
    created_at, last_activity_at
  ) VALUES ('claude-old-1', 'claude', '22222222-3333-4444-5555-666666666666',
            'Old conversation', 1, ?, ?)
`).run(new Date(clock).toISOString(), new Date(clock).toISOString());
catalog.db.prepare(`
  INSERT INTO agent_conversations(
    conversation_id, agent_type, native_session_id, title, title_is_custom,
    created_at, last_activity_at
  ) VALUES ('claude-old-2', 'claude', '22222222-3333-4444-5555-666666666666',
            'Old conversation', 1, ?, ?)
`).run(new Date(clock).toISOString(), new Date(clock + 5000).toISOString());

const survivor = catalog.mergeConversationsForNativeSession(
  "claude", "22222222-3333-4444-5555-666666666666",
);
assert.ok(survivor, "the survivor must be found");
assert.equal(
  catalog.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?")
    .get("22222222-3333-4444-5555-666666666666").count,
  1,
  "the duplicates must be folded into one row",
);
assert.equal(
  survivor.title,
  "Old conversation",
  "the name survives the fold",
);
assert.equal(
  catalog.ensureProviderConversationIndex(),
  true,
  "the rule is in the database again",
);

// A real name between two placeholders must survive the fold.
//
// The fold runs once per loser, and each loser is judged against the
// survivor's row as it stands *now*. Judged against a copy taken before the
// first fold, a placeholder loser read as "the survivor had nothing better"
// and wiped the name a real loser had just contributed.
//
// This is the shape the device's own catalog had: the newest attempt had no
// name yet, an older one had the name the agent produced, and the oldest
// still had the placeholder.
const mixedStateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-names-"));
const mixedCatalog = new AgentCatalog({ stateDir: mixedStateDir, now });
withoutProviderIndex(mixedCatalog);
const writeNamedRow = (id, title, activityOffset) => mixedCatalog.db.prepare(`
  INSERT INTO agent_conversations(
    conversation_id, agent_type, native_session_id, title, title_is_custom,
    created_at, last_activity_at
  ) VALUES (?, 'claude', '44444444-5555-6666-7777-888888888888', ?, 0, ?, ?)
`).run(
  id, title,
  new Date(clock).toISOString(),
  new Date(clock + activityOffset).toISOString(),
);
writeNamedRow("conv-mixed-live", "claude session", 30000);
writeNamedRow("conv-mixed-named", "The name the agent produced", 20000);
writeNamedRow("conv-mixed-old", "claude session", 10000);

const mixedSurvivor = mixedCatalog.mergeConversationsForNativeSession(
  "claude", "44444444-5555-6666-7777-888888888888",
);
assert.equal(
  mixedSurvivor.conversation_id,
  "conv-mixed-live",
  "the newest attempt speaks for the conversation",
);
assert.equal(
  mixedSurvivor.title,
  "The name the agent produced",
  "a real name survives the fold, whatever is folded in after it",
);
assert.equal(
  mixedCatalog.ensureProviderConversationIndex(),
  true,
  "the rule is in the database again",
);
mixedCatalog.close();
rmSync(mixedStateDir, { recursive: true, force: true });

// The one-time repair folds the rows that were written before the rule.
const repairStateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-repair-"));
let repairClock = Date.parse("2026-11-05T00:00:00Z");
const repairCatalog = new AgentCatalog({
  stateDir: repairStateDir,
  now: () => new Date(repairClock += 1000),
});
const writeDuplicate = (target, suffix, lastActivityOffset) => {
  for (const label of ["1", "2"]) {
    target.db.prepare(`
      INSERT INTO agent_conversations(
        conversation_id, agent_type, native_session_id, title, title_is_custom,
        created_at, last_activity_at
      ) VALUES (?, 'claude', '33333333-4444-5555-6666-777777777777',
                'Duplicated', 1, ?, ?)
    `).run(
      `conv-dup-${suffix}-${label}`,
      new Date(repairClock).toISOString(),
      new Date(repairClock + lastActivityOffset).toISOString(),
    );
  }
};
withoutProviderIndex(repairCatalog);
writeDuplicate(repairCatalog, "a", 0);
// The marker is what says the repair has been done. Clear it, so the next
// open behaves like the first open after an upgrade.
repairCatalog.db.prepare("DELETE FROM catalog_meta WHERE key LIKE 'conversation_native_merge%'").run();
repairCatalog.close();

const repaired = new AgentCatalog({
  stateDir: repairStateDir,
  now: () => new Date(repairClock += 1000),
});
assert.equal(
  repaired.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?")
    .get("33333333-4444-5555-6666-777777777777").count,
  1,
  "the repair folds the historical duplicates into one row",
);
assert.equal(
  repaired.db.prepare("SELECT COUNT(*) AS count FROM catalog_meta WHERE key LIKE 'conversation_native_merge%'")
    .get().count,
  1,
  "the marker says the repair has been done",
);
repaired.close();

// The repair runs once: the marker is what says it is done.
//
// The rule itself is not a one-time repair. It is in the database, and the
// database refuses a second row for one provider conversation — so a pair
// cannot be written at all while the rule is there.
const repairAgain = new AgentCatalog({
  stateDir: repairStateDir,
  now: () => new Date(repairClock += 1000),
});
assert.throws(
  () => writeDuplicate(repairAgain, "b", 0),
  /UNIQUE constraint failed/,
  "the rule in the database refuses a second row for one provider conversation",
);

// A pair written behind the rule's back — the only way to write one — is
// folded when the rule is made again.
withoutProviderIndex(repairAgain);
writeDuplicate(repairAgain, "b", 0);
const repairedTwice = new AgentCatalog({
  stateDir: repairStateDir,
  now: () => new Date(repairClock += 1000),
});
assert.equal(
  repairedTwice.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?")
    .get("33333333-4444-5555-6666-777777777777").count,
  1,
  "the pair written behind the rule's back is folded when the rule is made",
);
assert.equal(
  repairedTwice.db.prepare("SELECT COUNT(*) AS count FROM catalog_meta WHERE key LIKE 'conversation_native_merge%'")
    .get().count,
  1,
  "the repair is still a one-time repair: its marker is not written again",
);
repairAgain.close();
repairedTwice.close();

// --- The registry adopts the conversation the catalog resolved ----------------

const registryStateDir = mkdtempSync(join(tmpdir(), "originrouter-registry-identity-"));
let registryClock = Date.parse("2026-11-05T00:00:00Z");
const registryCatalog = new AgentCatalog({
  stateDir: registryStateDir,
  now: () => new Date(registryClock += 1000),
});
const registry = new ExternalAgentRegistry({
  catalog: registryCatalog,
  now: () => registryClock,
});

// The conversation already has a row, from an earlier attempt.
registryCatalog.upsertSession({
  sessionId: "claude-first",
  conversationId: "claude-first",
  runId: "run-first",
  agent: "claude",
  title: "Resumed conversation",
  deviceId: "device-1",
  cwd: registryStateDir,
  nativeSessionId: "44444444-5555-6666-7777-888888888888",
  startedAt: new Date(registryClock).toISOString(),
});

const registered = registry.register({
  sessionId: "claude-second",
  conversationId: "claude-second",
  runId: "run-second",
  agent: "claude",
  title: "Resumed conversation",
  deviceId: "device-1",
  cwd: registryStateDir,
  nativeSessionId: "44444444-5555-6666-7777-888888888888",
});
assert.equal(
  registered.conversation_id,
  "claude-first",
  "the registry names the conversation the catalog resolved",
);

// The label the attempt was launched under is not a switch: the provider's
// id is what says which conversation this is.
const updated = registry.update("claude-second", {
  conversationId: "claude-second",
  nativeSessionId: "44444444-5555-6666-7777-888888888888",
  status: "running",
});
assert.equal(
  updated.conversation_id,
  "claude-first",
  "a label that disagrees with the provider's id is not a switch",
);

// A different provider id is a different conversation: the run follows it.
const switched = registry.update("claude-second", {
  conversationId: "claude-third",
  nativeSessionId: "99999999-8888-7777-6666-555555555555",
  status: "running",
});
assert.equal(
  switched.conversation_id,
  "claude-third",
  "a different provider conversation is a different conversation",
);

registryCatalog.close();
catalog.close();
rmSync(stateDir, { recursive: true, force: true });
rmSync(repairStateDir, { recursive: true, force: true });
rmSync(registryStateDir, { recursive: true, force: true });

// --- A resumed run takes the conversation's name ----------------------------

// A run that resumes a conversation does not have a name of its own until
// the agent produces one — until then the runtime reports the placeholder we
// wrote. The conversation it resumes does have a name: the catalog holds it,
// from the attempt before.
//
// Without this the App's rail showed the default name for a conversation the
// reader had named weeks ago, because the newest run carried the placeholder
// and the newest run is the one that speaks for the conversation.
const nameStateDir = mkdtempSync(join(tmpdir(), "originrouter-registry-title-"));
let nameClock = Date.parse("2026-11-05T00:00:00Z");
const nameCatalog = new AgentCatalog({
  stateDir: nameStateDir,
  now: () => new Date(nameClock += 1000),
});
const nameRegistry = new ExternalAgentRegistry({
  catalog: nameCatalog,
  now: () => nameClock,
});
nameCatalog.upsertSession({
  sessionId: "claude-named",
  conversationId: "claude-named",
  runId: "run-named",
  agent: "claude",
  title: "桌面 HelloWorld 程序",
  // A name the agent produced is not a name somebody chose. The flag says who
  // chose it, and a name somebody chose is never taken back by a report — so
  // the flag has to be told apart, or the catalog latches the first name it
  // is given and no later one can replace it.
  titleIsCustom: false,
  deviceId: "device-1",
  cwd: nameStateDir,
  nativeSessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  startedAt: new Date(nameClock).toISOString(),
});

// The reader resumes it. The runtime has no name yet and reports the
// placeholder.
const resumed = nameRegistry.register({
  sessionId: "claude-resumed",
  conversationId: "claude-resumed",
  runId: "run-resumed",
  agent: "claude",
  title: "claude session",
  deviceId: "device-1",
  cwd: nameStateDir,
  nativeSessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
});
assert.equal(
  resumed.title,
  "桌面 HelloWorld 程序",
  "a resumed run takes the name the conversation already had",
);
assert.equal(
  resumed.conversation_id,
  "claude-named",
  "and it is filed under the conversation that holds it",
);

// The placeholder keeps coming — every report of the runtime carries it —
// and it must not wipe the name the run already has.
const reported = nameRegistry.update("claude-resumed", {
  conversationId: "claude-resumed",
  nativeSessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  title: "claude session",
  status: "running",
});
assert.equal(
  reported.title,
  "桌面 HelloWorld 程序",
  "a placeholder never displaces a real name",
);

// A name the agent produces is a name, and it wins.
const produced = nameRegistry.update("claude-resumed", {
  conversationId: "claude-resumed",
  nativeSessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  title: "A name the agent gave",
  status: "running",
});
assert.equal(
  produced.title,
  "A name the agent gave",
  "the name the agent produces replaces the one before it",
);

nameCatalog.close();
rmSync(nameStateDir, { recursive: true, force: true });

// --- Two rows active at the same moment pick the smallest id ----------------

// The server and the fold in `sql/054` answer "which row speaks for this
// conversation" the same way: the most recently active row, and the smallest
// id among the ones that tie. The device has to answer it the same way too,
// because the row it names is the row it reports — and a different row would
// be one the fold had already removed.
const tieStateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-tie-"));
let tieClock = Date.parse("2026-11-05T00:00:00Z");
const tieCatalog = new AgentCatalog({
  stateDir: tieStateDir,
  now: () => new Date(tieClock += 1000),
});
for (const [conversationId, createdOffset] of [["conv-b", 60000], ["conv-a", 0]]) {
  withoutProviderIndex(tieCatalog);
  tieCatalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, 'claude', '55555555-6666-7777-8888-999999999999',
              'Tied conversation', 1, ?, ?)
  `).run(
    conversationId,
    new Date(Date.parse("2026-11-05T00:00:00Z") + createdOffset).toISOString(),
    new Date(Date.parse("2026-11-05T00:00:00Z")).toISOString(),
  );
}
assert.equal(
  tieCatalog.conversationIdForNativeSession("claude", "55555555-6666-7777-8888-999999999999"),
  "conv-a",
  "the smallest id wins when the rows were last active at the same moment",
);
const tied = tieCatalog.mergeConversationsForNativeSession(
  "claude", "55555555-6666-7777-8888-999999999999",
);
assert.equal(tied.conversation_id, "conv-a", "the fold keeps the smallest id");
assert.equal(
  tieCatalog.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?")
    .get("55555555-6666-7777-8888-999999999999").count,
  1,
  "the tie is folded into one row",
);
assert.equal(
  tieCatalog.ensureProviderConversationIndex(),
  true,
  "the rule is in the database again",
);
tieCatalog.close();
rmSync(tieStateDir, { recursive: true, force: true });

// --- The fold carries the artifacts with it ---------------------------------

// The artifacts belong to the conversation, not to the row that happened to
// write them down.
//
// They are moved, not copied: the artifact id is the primary key, so copying
// a row while the original is still on the table was a constraint violation
// — and the fold is the one place that cannot afford to fail, because it is
// what keeps one conversation in one row. A fold that failed left the
// duplicates exactly where they were.
const artifactStateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-artifacts-"));
let artifactClock = Date.parse("2026-11-05T00:00:00Z");
const artifactCatalog = new AgentCatalog({
  stateDir: artifactStateDir,
  now: () => new Date(artifactClock += 1000),
});
const artifactNative = "66666666-7777-8888-9999-aaaaaaaaaaaa";
for (const [conversationId, offset] of [["conv-art-old", 0], ["conv-art-new", 5000]]) {
  withoutProviderIndex(artifactCatalog);
  artifactCatalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, 'claude', ?, 'Articulated', 1, ?, ?)
  `).run(
    conversationId,
    artifactNative,
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset).toISOString(),
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset).toISOString(),
  );
}
artifactCatalog.db.prepare(`
  INSERT INTO agent_artifacts(
    artifact_id, conversation_id, kind, locator, display_value,
    first_seen_at, last_seen_at
  ) VALUES ('artifact-old', 'conv-art-old', 'file', '/tmp/a.txt', 'a.txt', ?, ?)
`).run("2026-11-05T00:00:00Z", "2026-11-05T00:00:01Z");
artifactCatalog.db.prepare(`
  INSERT INTO agent_artifacts(
    artifact_id, conversation_id, kind, locator, display_value,
    first_seen_at, last_seen_at
  ) VALUES ('artifact-new', 'conv-art-new', 'file', '/tmp/b.txt', 'b.txt', ?, ?)
`).run("2026-11-05T00:00:05Z", "2026-11-05T00:00:06Z");

const artifactSurvivor = artifactCatalog.mergeConversationsForNativeSession("claude", artifactNative);
assert.ok(artifactSurvivor, "the fold completes even when the rows carry artifacts");
assert.equal(
  artifactCatalog.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?")
    .get(artifactNative).count,
  1,
  "one provider conversation, one row",
);
const movedArtifacts = artifactCatalog.db.prepare(
  "SELECT * FROM agent_artifacts ORDER BY artifact_id",
).all();
assert.equal(movedArtifacts.length, 2, "both artifacts move with the conversation");
assert.deepEqual(
  movedArtifacts.map((row) => row.artifact_id),
  ["artifact-new", "artifact-old"],
  "the artifacts keep their own ids",
);
for (const artifact of movedArtifacts) {
  assert.equal(
    artifact.conversation_id,
    artifactSurvivor.conversation_id,
    "the artifact belongs to the conversation that survived",
  );
}
artifactCatalog.close();
rmSync(artifactStateDir, { recursive: true, force: true });

// --- An artifact both rows know becomes one ---------------------------------

// The same file, seen from two attempts at one conversation. The survivor
// keeps its own row for it and takes the earlier sighting and the later
// sighting of the two.
const twinStateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-artifact-twin-"));
let twinClock = Date.parse("2026-11-05T00:00:00Z");
const twinCatalog = new AgentCatalog({
  stateDir: twinStateDir,
  now: () => new Date(twinClock += 1000),
});
for (const [conversationId, offset] of [["conv-twin-old", 0], ["conv-twin-new", 5000]]) {
  withoutProviderIndex(twinCatalog);
  twinCatalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, 'claude', '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
              'Twinned', 1, ?, ?)
  `).run(
    conversationId,
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset).toISOString(),
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset).toISOString(),
  );
  twinCatalog.db.prepare(`
    INSERT INTO agent_artifacts(
      artifact_id, conversation_id, kind, locator, display_value,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, 'file', '/tmp/same.txt', 'same.txt', ?, ?)
  `).run(
    `artifact-twin-${offset}`,
    conversationId,
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset).toISOString(),
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset + 1000).toISOString(),
  );
}
const twinSurvivor = twinCatalog.mergeConversationsForNativeSession(
  "claude", "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
);
assert.ok(twinSurvivor, "the fold completes when both rows know the artifact");
const twinArtifacts = twinCatalog.db.prepare("SELECT * FROM agent_artifacts").all();
assert.equal(twinArtifacts.length, 1, "one artifact, not two");
assert.equal(
  twinArtifacts[0].conversation_id,
  twinSurvivor.conversation_id,
  "the artifact belongs to the conversation that survived",
);
assert.equal(
  twinArtifacts[0].first_seen_at,
  "2026-11-05T00:00:00.000Z",
  "the earlier sighting is kept",
);
assert.equal(
  twinArtifacts[0].last_seen_at,
  "2026-11-05T00:00:06.000Z",
  "the later sighting is kept",
);
twinCatalog.close();
rmSync(twinStateDir, { recursive: true, force: true });

// --- A repair that failed is not a repair that is done ----------------------

// The marker says the repair has been done. A fold that failed leaves the
// duplicates exactly where they were, so a marker that says "done" would
// keep them there for good — the one failure nobody is told about is the
// one that cannot be repaired later.
const failingStateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-repair-fails-"));
let failingClock = Date.parse("2026-11-05T00:00:00Z");
const failingCatalog = new AgentCatalog({
  stateDir: failingStateDir,
  now: () => new Date(failingClock += 1000),
});
failingCatalog.db.prepare(`
  CREATE TRIGGER blocked_artifact_move BEFORE UPDATE ON agent_artifacts
  BEGIN SELECT RAISE(ABORT, 'the artifact may not move'); END;
`).run();
for (const [label, offset] of [["1", 0], ["2", 5000]]) {
  withoutProviderIndex(failingCatalog);
  failingCatalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, 'claude', '88888888-9999-aaaa-bbbb-cccccccccccc',
              'Blocked', 1, ?, ?)
  `).run(
    `conv-blocked-${label}`,
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset).toISOString(),
    new Date(Date.parse("2026-11-05T00:00:00Z") + offset).toISOString(),
  );
}
failingCatalog.db.prepare(`
  INSERT INTO agent_artifacts(
    artifact_id, conversation_id, kind, locator, display_value,
    first_seen_at, last_seen_at
  ) VALUES ('artifact-blocked', 'conv-blocked-1', 'file', '/tmp/blocked.txt',
            'blocked.txt', ?, ?)
`).run("2026-11-05T00:00:00Z", "2026-11-05T00:00:01Z");
failingCatalog.db.prepare("DELETE FROM catalog_meta WHERE key LIKE 'conversation_native_merge%'").run();
failingCatalog.close();

const failedRepair = new AgentCatalog({
  stateDir: failingStateDir,
  now: () => new Date(failingClock += 1000),
});
assert.equal(
  failedRepair.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?")
    .get("88888888-9999-aaaa-bbbb-cccccccccccc").count,
  2,
  "the duplicates are still there: the fold failed",
);
assert.equal(
  failedRepair.db.prepare(
    "SELECT COUNT(*) AS count FROM catalog_meta WHERE key LIKE 'conversation_native_merge%'",
  ).get().count,
  0,
  "no marker is written when the repair did not finish",
);

// The next open tries again — the marker is what says it is done, and it was
// not written.
failedRepair.db.prepare("DROP TRIGGER blocked_artifact_move").run();
failedRepair.db.prepare("DELETE FROM catalog_meta WHERE key LIKE 'conversation_native_merge%'").run();
failedRepair.close();
const retried = new AgentCatalog({
  stateDir: failingStateDir,
  now: () => new Date(failingClock += 1000),
});
assert.equal(
  retried.db.prepare("SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?")
    .get("88888888-9999-aaaa-bbbb-cccccccccccc").count,
  1,
  "the repair runs again once the fold can finish",
);
assert.equal(
  retried.db.prepare(
    "SELECT COUNT(*) AS count FROM catalog_meta WHERE key LIKE 'conversation_native_merge%'",
  ).get().count,
  1,
  "the marker is written once the repair has finished",
);
retried.close();
rmSync(failingStateDir, { recursive: true, force: true });


const atomicDir = mkdtempSync(join(tmpdir(), 'or-run-owner-'));
const atomic = new AgentCatalog({ stateDir: atomicDir });
try {
  for (const agent of ['claude', 'codex', 'agy']) {
    const owner = agent + '-owner', label = agent + '-launch', sessionId = agent + '-new';
    atomic.upsertSession({ agent, sessionId: owner, conversationId: owner, nativeSessionId: 'native',
      title: 'Original title', titleIsCustom: true });
    atomic.updateSession(owner, { title: 'Renamed by user', titleIsCustom: true });
    assert.equal(atomic.getConversation(owner).title, 'Renamed by user');
    atomic.upsertSession({ agent, sessionId, conversationId: label, title: 'Launch title', titleIsCustom: true });
    atomic.recordEvent(sessionId, { type: 'agent.tool_call.start', input: { file_path: '/example/file' } });
    atomic.updateSession(sessionId, { nativeSessionId: 'native' });
    atomic.ensureSessionForPermissionState({ agent, sessionId, conversationId: label });
    atomic.upsertSession({ agent, sessionId, conversationId: label, title: 'Stale launch title', titleIsCustom: true });
    const result = atomic.getConversation(owner);
    assert.equal(result.runs.length, 2);
    assert.equal(result.title, 'Renamed by user');
    assert.equal(result.artifacts.length, 1);
    assert.equal(atomic.getConversation(label), null);
  }
} finally { atomic.close(); rmSync(atomicDir, { recursive: true, force: true }); }
