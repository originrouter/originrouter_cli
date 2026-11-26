import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import { createNativeTitleSync } from "../src/agent/nativeTitleSync.js";

test("an agy command receipt cannot settle a rename; restart confirms only native readback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "title-sync-"));
  let catalog = new AgentCatalog({ stateDir: dir });
  const identity = { agent_type: "agy", native_session_id: "native" };
  const hint = { ...identity, conversation_id: "cloud-book" };
  let state = { ...identity, revision: 2, pending: true, explicit: true, title: "Last offline name" };
  let readback = "Old name";
  const commands = [];
  function sync() {
    return createNativeTitleSync({
      catalog, isCurrent: () => true,
      providerFactory: () => ({ async read() { return { title: readback }; }, close() {} }),
      registry: {
        sessionFacts: () => ({ attached: true, runtime: "agy-pty" }),
        enqueueCommand(id, cmd) { commands.push([id, cmd]); },
      },
      exchange: async ({ observations }) => {
        for (const item of observations) {
          if (item.confirmed && item.revision === state.revision && item.title === state.title) {
            state = { ...state, revision: state.revision + 1, pending: false };
          }
        }
        return { states: observations.map(() => state), pending: state.pending ? [hint] : [] };
      },
    })();
  }
  try {
    catalog.upsertSession({ agent: "agy", sessionId: "run", conversationId: "local-book",
      nativeSessionId: "native", title: "Old name", titleIsCustom: false, cwd: dir });
    await sync();
    assert.equal(state.pending, true);
    assert.equal(commands.length, 1);
    assert.equal(commands[0][1].targetNativeSessionId, "native");
    assert.equal(catalog.getConversation("local-book").title_sync_pending, true);
    catalog.close();
    catalog = new AgentCatalog({ stateDir: dir });
    readback = state.title;
    await sync();
    assert.equal(commands.length, 1);
    assert.equal(state.pending, false);
    assert.equal(catalog.getConversation("local-book").title_revision, 3);
  } finally {
    catalog.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
