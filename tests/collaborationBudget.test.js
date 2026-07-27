import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";

const store = new CollaborationStore({ stateDir: mkdtempSync(join(tmpdir(), "or-budget-")) });
const coordinator = new PlanImplementVerifyCoordinator({ store });
const created = coordinator.create({
  objective: "Budgeted task",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
  budget: { token_limit: 1000, amount_limit_micros: 5000000, currency: "USD" },
});
coordinator.start(created.run_id);
let usage = store.recordUsage(created.run_id, { eventId: "usage-event-0001", sampledTokens: 799 });
assert.equal(usage.warning, null);
usage = store.recordUsage(created.run_id, { eventId: "usage-event-0002", sampledTokens: 1 });
assert.equal(usage.warning, "warning");
assert.equal(usage.exhausted, false);
usage = store.recordUsage(created.run_id, { eventId: "usage-event-0003", sampledTokens: 200 });
assert.equal(usage.warning, "exhausted");
assert.equal(usage.run.state, "budget_exhausted");
assert.equal(usage.run.tasks[0].state, "paused");
const duplicate = store.recordUsage(created.run_id, { eventId: "usage-event-0003", sampledTokens: 200 });
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.run.usage.sampled_tokens, 1000);
const resumed = store.updateBudget(created.run_id, { token_limit: 2000 });
assert.equal(resumed.state, "researching");
assert.equal(resumed.tasks[0].state, "active");

const accountBlocked = store.setAccountBudgetBlocked(created.run_id, true);
assert.equal(accountBlocked.changed, true);
assert.equal(accountBlocked.run.state, "budget_exhausted");
assert.equal(accountBlocked.run.account_budget_blocked, true);
assert.equal(accountBlocked.run.resume_state, "researching");

const raisedWhileAccountBlocked = store.updateBudget(created.run_id, { token_limit: 3000 });
assert.equal(raisedWhileAccountBlocked.state, "budget_exhausted");
assert.equal(raisedWhileAccountBlocked.account_budget_blocked, true);

const accountAvailable = store.setAccountBudgetBlocked(created.run_id, false);
assert.equal(accountAvailable.changed, true);
assert.equal(accountAvailable.restored, true);
assert.equal(accountAvailable.run.state, "researching");
assert.equal(accountAvailable.run.account_budget_blocked, false);
assert.equal(accountAvailable.run.resume_state, null);
assert.equal(store.setAccountBudgetBlocked(created.run_id, false).changed, false);

store.setAccountBudgetBlocked(created.run_id, true);
const loweredWhileAccountBlocked = store.updateBudget(created.run_id, { token_limit: 500 });
assert.equal(loweredWhileAccountBlocked.state, "budget_exhausted");
const accountAvailableButTaskBlocked = store.setAccountBudgetBlocked(created.run_id, false);
assert.equal(accountAvailableButTaskBlocked.restored, false);
assert.equal(accountAvailableButTaskBlocked.run.state, "budget_exhausted");
assert.equal(accountAvailableButTaskBlocked.run.account_budget_blocked, false);
const taskBudgetRaised = store.updateBudget(created.run_id, { token_limit: 3000 });
assert.equal(taskBudgetRaised.state, "researching");
assert.equal(taskBudgetRaised.tasks[0].state, "active");

const loweredActiveBudget = store.updateBudget(created.run_id, { token_limit: 500 });
assert.equal(loweredActiveBudget.state, "budget_exhausted");
assert.equal(loweredActiveBudget.resume_state, "researching");

const amountRun = coordinator.create({
  objective: "Configured-price budget",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
  budget: { amount_limit_micros: 2_000_000, currency: "USD" },
});
coordinator.start(amountRun.run_id);
let amountUsage = store.recordUsage(amountRun.run_id, {
  eventId: "amount-priced-0001",
  amountMicros: 1_600_000,
  currency: "USD",
  costSource: "configured",
});
assert.equal(amountUsage.warning, "warning");
amountUsage = store.recordUsage(amountRun.run_id, {
  eventId: "amount-unsupported-0002",
  amountMicros: 9_000_000,
  currency: "USD",
  costSource: "unsupported",
});
assert.equal(amountUsage.exhausted, false);
assert.equal(amountUsage.run.usage.amount_micros, 1_600_000);
assert.equal(amountUsage.run.usage.unpriced_events, 1);
amountUsage = store.recordUsage(amountRun.run_id, {
  eventId: "amount-priced-0003",
  amountMicros: 400_000,
  currency: "USD",
  costSource: "configured",
});
assert.equal(amountUsage.exhausted, true);
store.close();

const legacyStateDir = mkdtempSync(join(tmpdir(), "or-budget-legacy-"));
const legacyDbPath = join(legacyStateDir, "collaboration.sqlite3");
const legacyDb = new Database(legacyDbPath);
legacyDb.exec(`
  CREATE TABLE collaboration_runs (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    template_id TEXT NOT NULL,
    template_version TEXT NOT NULL,
    objective TEXT NOT NULL,
    state TEXT NOT NULL,
    gates_json TEXT NOT NULL,
    budget_json TEXT NOT NULL,
    usage_json TEXT NOT NULL,
    counters_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  ) STRICT;
`);
legacyDb.close();
const migratedStore = new CollaborationStore({ stateDir: legacyStateDir });
const migratedCoordinator = new PlanImplementVerifyCoordinator({ store: migratedStore });
const migratedRun = migratedCoordinator.create({
  objective: "Verify the legacy collaboration database upgrades in place.",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
});
assert.equal(migratedRun.account_budget_blocked, false);
assert.equal(migratedRun.resume_state, null);
migratedStore.close();
console.log("collaboration budget tests passed");
