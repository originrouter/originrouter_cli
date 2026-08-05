import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBudgetStore } from "../src/agent/agentBudgetStore.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-agent-budget-"));
const now = new Date("2026-08-05T10:00:00.000Z");
const store = new AgentBudgetStore({ stateDir, now: () => now });

store.setPolicies({
  device: { daily_token_limit: 1000, weekly_token_limit: 5000 },
  agents: {
    claude: { daily_token_limit: 600 },
    codex: { daily_token_limit: 800 },
  },
});

let result = store.recordUsage({
  event_id: "usage-claude-0001",
  agent: "claude",
  sampled_tokens: 500,
});
assert.equal(result.blocked, false);
assert.equal(result.snapshot.agents.claude.warning, true);

result = store.recordUsage({
  event_id: "usage-claude-0002",
  agent: "claude",
  sampled_tokens: 150,
});
assert.equal(result.blocked, true);
assert.equal(result.snapshot.agents.claude.blocked, true);
assert.equal(result.snapshot.device.blocked, false);

const duplicate = store.recordUsage({
  event_id: "usage-claude-0002",
  agent: "claude",
  sampled_tokens: 150,
});
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.snapshot.device.daily.sampled_tokens, 650);

store.close();
rmSync(stateDir, { recursive: true, force: true });
console.log("agent budget store tests passed");
