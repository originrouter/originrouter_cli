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

for (const invalid of [0, 0.5, 1.5, true, "invalid", Number.MAX_SAFE_INTEGER + 1]) {
  assert.throws(() => store.setPolicies({ device: { daily_token_limit: invalid } }), /positive safe integers/);
}
assert.equal(store.policy("device").daily_token_limit, 1000);

store.setPolicies({
  device: { daily_amount_limit_micros: 1_000_000, currency: "USD" },
  agents: { claude: { daily_amount_limit_micros: 1_000_000, currency: "EUR" } },
});
store.recordUsage({ event_id: "usage-priced-usd-1", agent: "claude", sampled_tokens: 10,
  amount_micros: 500_000, currency: "USD", cost_source: "configured" });
result = store.recordUsage({ event_id: "usage-priced-eur-1", agent: "claude", sampled_tokens: 20,
  amount_micros: 600_000, currency: "EUR", cost_source: "configured" });
assert.equal(result.snapshot.device.daily.amount_micros, 500_000);
assert.equal(result.snapshot.device.daily.other_currency_events, 1);
assert.equal(result.snapshot.agents.claude.daily.amount_micros, 600_000);
assert.equal(result.snapshot.agents.claude.daily.other_currency_events, 1);
assert.equal(result.blocked, false);
result = store.recordUsage({ event_id: "usage-unpriced-event-1", agent: "claude", sampled_tokens: 1,
  amount_micros: 900_000, currency: "USD", cost_source: "unsupported" });
assert.equal(result.snapshot.device.daily.amount_micros, 500_000);
assert.equal(result.snapshot.device.daily.unpriced_events, 3);
assert.equal(result.snapshot.device.daily.sampled_tokens, 681);
assert.equal(result.blocked, false);
result = store.recordUsage({ event_id: "usage-priced-usd-2", agent: "codex",
  amount_micros: 500_000, currency: "USD", cost_source: "configured" });
assert.equal(result.snapshot.device.blocked, true);
assert.equal(result.snapshot.agents.claude.blocked, false);

store.close();
rmSync(stateDir, { recursive: true, force: true });
console.log("agent budget store tests passed");
