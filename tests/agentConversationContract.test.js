import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import { looksLikePlaceholderTitle } from "../src/agent/agentTitleSource.js";

// The rules that decide what a conversation is called and which row holds it
// live in one file, and each repository holds a copy of it. The checksum is
// what says the copies are the same file: a case that changed in one place
// and not in the others is exactly the drift the file exists to stop.
//
// The server holds the same file and checks its own implementation against
// it. The App holds it too and checks the rule it reads titles with.

const CONTRACT_PATH = fileURLToPath(
  new URL("../contract/agent_conversation_rules.json", import.meta.url),
);
const CONTRACT_SHA256 = "1f5307659f49d4eeab425343d37fb0671e158d939f90c58818ed7752c3025b6e";

const contractBytes = readFileSync(CONTRACT_PATH);
assert.equal(
  createHash("sha256").update(contractBytes).digest("hex"),
  CONTRACT_SHA256,
  "the copy of the contract is not the one the three repositories agreed on",
);
const contract = JSON.parse(contractBytes.toString("utf8"));

assert.equal(typeof contract.contract_version, "string");
for (const section of ["placeholders", "title_merges", "survivors"]) {
  assert.ok(Array.isArray(contract[section]), `the contract has no ${section}`);
  assert.ok(contract[section].length, `the contract's ${section} are empty`);
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-conversation-contract-"));
let clock = Date.parse("2026-11-06T00:00:00Z");
const now = () => new Date(clock += 1000);
const catalog = new AgentCatalog({ stateDir, now });

// --- Which titles mean "we have no name" -------------------------------------

for (const testCase of contract.placeholders) {
  assert.equal(
    looksLikePlaceholderTitle(testCase.title, testCase.agent_type),
    testCase.is_placeholder,
    `a placeholder for ${testCase.agent_type}: "${testCase.title}"`,
  );
}

// --- Which title a row keeps when a report arrives ---------------------------

// The rule is the SQL the catalog writes with, so the answer comes from the
// database and not from a copy of the rule written beside it.
//
// The row that is already there is written by hand, because a report alone
// cannot produce every shape the rule has to answer: a row with an empty
// title, a row whose name somebody chose, a row under another agent.

const seedConversation = (conversationId, { title, is_custom, agent_type }, offset = 0) => {
  catalog.db.prepare(`
    INSERT INTO agent_conversations(
      conversation_id, agent_type, native_session_id, title, title_is_custom,
      created_at, last_activity_at
    ) VALUES (?, ?, '', ?, ?, ?, ?)
  `).run(
    conversationId,
    agent_type,
    title,
    is_custom ? 1 : 0,
    new Date(clock + offset).toISOString(),
    new Date(clock + offset).toISOString(),
  );
};

contract.title_merges.forEach((testCase, index) => {
  const conversationId = `contract-merge-${index}`;
  seedConversation(conversationId, testCase.existing, index);
  catalog.upsertSession({
    sessionId: `contract-merge-session-${index}`,
    conversationId,
    runId: `contract-merge-run-${index}`,
    agent: testCase.incoming.agent_type,
    title: testCase.incoming.title,
    // The flag says who chose the name. It is passed as it is, because the
    // rule is about what a report carries — not about how the catalog would
    // have judged the same title on its own.
    titleIsCustom: testCase.incoming.is_custom,
    deviceId: "contract-device",
    cwd: stateDir,
    startedAt: new Date(clock).toISOString(),
  });
  const row = catalog.db.prepare(
    "SELECT title, title_is_custom FROM agent_conversations WHERE conversation_id = ?",
  ).get(conversationId);
  assert.equal(
    row.title,
    !testCase.expected.is_custom && looksLikePlaceholderTitle(testCase.expected.title, testCase.incoming.agent_type)
      ? "" : testCase.expected.title,
    `the title a row keeps: ${testCase.name}`,
  );
  assert.equal(
    Boolean(row.title_is_custom),
    testCase.expected.is_custom,
    `the flag a row keeps: ${testCase.name}`,
  );
});

// --- Which row of a group holds the conversation -----------------------------

// The index over (agent, provider id) says one provider conversation is one
// row, so the rows a group is made of cannot be written while it is there.
// They are written the way they were written before the rule was in the
// database, and the rule is put back afterwards.

contract.survivors.forEach((testCase, index) => {
  const nativeSessionId = `contract-native-${index}`;
  // The ids are namespaced per case so that one case's rows do not stand in
  // for another's. The order between them is what the rule reads, and the
  // prefix keeps it.
  const conversationId = (id) => `contract-survivor-${index}-${id}`;
  const expected = conversationId(testCase.expected);
  catalog.db.exec("DROP INDEX IF EXISTS idx_agent_conversations_provider");
  for (const row of testCase.rows) {
    catalog.db.prepare(`
      INSERT INTO agent_conversations(
        conversation_id, agent_type, native_session_id, title, title_is_custom,
        created_at, last_activity_at
      ) VALUES (?, 'claude', ?, 'Contract row', 0, ?, ?)
    `).run(
      conversationId(row.conversation_id),
      nativeSessionId,
      new Date(clock).toISOString(),
      new Date(clock + row.last_activity_at).toISOString(),
    );
  }
  assert.equal(
    catalog.conversationIdForNativeSession("claude", nativeSessionId),
    expected,
    `the row that answers for a provider conversation: ${testCase.name}`,
  );
  const survivor = catalog.mergeConversationsForNativeSession("claude", nativeSessionId);
  assert.equal(
    survivor?.conversation_id,
    expected,
    `the row the fold keeps: ${testCase.name}`,
  );
  assert.equal(
    catalog.db.prepare(
      "SELECT COUNT(*) AS count FROM agent_conversations WHERE native_session_id = ?",
    ).get(nativeSessionId).count,
    1,
    `one provider conversation, one row: ${testCase.name}`,
  );
  assert.equal(
    catalog.ensureProviderConversationIndex(),
    true,
    "the rule is in the database again",
  );
});

// The index is back, and the groups are folded.
assert.ok(
  catalog.db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_agent_conversations_provider'
  `).get(),
  "the rule the database says one provider conversation is one row is in place",
);

catalog.close();
rmSync(stateDir, { recursive: true, force: true });
