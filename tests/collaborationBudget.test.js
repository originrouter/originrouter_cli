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
for (const invalid of [
  { token_limit: "not-a-number" }, { token_limit: 0 }, { token_limit: 1.5 },
  { amount_limit_micros: "Infinity" }, { amount_limit_micros: {} },
  { max_concurrency: 33 }, { max_concurrency: true },
]) {
  const previous = store.getRun(created.run_id).budget;
  assert.throws(() => store.updateBudget(created.run_id, invalid), { code: "COLLABORATION_BUDGET_INVALID" });
  assert.deepEqual(store.getRun(created.run_id).budget, previous);
}
let usage = store.recordUsage(created.run_id, { eventId: "usage-event-0001", sampledTokens: 799 });
assert.equal(usage.warning, null);
usage = store.recordUsage(created.run_id, { eventId: "usage-event-0002", sampledTokens: 1 });
assert.equal(usage.warning, "warning");
assert.equal(usage.exhausted, false);
usage = store.recordUsage(created.run_id, { eventId: "usage-event-0003", sampledTokens: 200 });
assert.equal(usage.warning, "exhausted");
assert.equal(usage.run.state, "budget_exhausted");
assert.equal(store.getSnapshot(created.run_id).capabilities.can_resume, false);
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

const pausedRun = coordinator.create({
  objective: "Preserve a manual pause",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
  budget: { token_limit: 1000 },
});
coordinator.start(pausedRun.run_id);
store.recordUsage(pausedRun.run_id, { eventId: "paused-usage-1", sampledTokens: 500 });
store.pauseRun(pausedRun.run_id);
const loweredPaused = store.updateBudget(pausedRun.run_id, { token_limit: 400 });
assert.equal(loweredPaused.state, "paused");
assert.equal(loweredPaused.resume_state, "researching");
assert.equal(store.getSnapshot(pausedRun.run_id).capabilities.can_resume, false);
assert.throws(() => store.resumeRun(pausedRun.run_id), { code: "COLLABORATION_BUDGET_EXHAUSTED" });
store.setAccountBudgetBlocked(pausedRun.run_id, true);
store.updateBudget(pausedRun.run_id, { token_limit: 1000 });
assert.equal(store.getSnapshot(pausedRun.run_id).capabilities.can_resume, false);
const clearedPaused = store.setAccountBudgetBlocked(pausedRun.run_id, false);
assert.equal(clearedPaused.run.state, "paused");
assert.equal(clearedPaused.run.resume_state, "researching");
assert.equal(store.getSnapshot(pausedRun.run_id).capabilities.can_resume, true);
assert.equal(store.resumeRun(pausedRun.run_id).state, "researching");

const pausedAfterExhaustion = coordinator.create({
  objective: "Preserve the original phase when manually pausing an exhausted Run.",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
  budget: { token_limit: 100 },
});
coordinator.start(pausedAfterExhaustion.run_id);
assert.equal(store.getSnapshot(pausedAfterExhaustion.run_id).capabilities.can_pause, true,
  "the research phase can be paused");
store.recordUsage(pausedAfterExhaustion.run_id, { eventId: "exhausted-before-user-pause", sampledTokens: 100 });
const manualHold = store.pauseRun(pausedAfterExhaustion.run_id);
assert.equal(manualHold.state, "paused");
assert.equal(manualHold.resume_state, "researching");
assert.equal(store.getSnapshot(pausedAfterExhaustion.run_id).capabilities.can_resume, false);
assert.ok(store.getSnapshot(pausedAfterExhaustion.run_id).attention.some((item) => item.kind === "budget"));
assert.ok(store.listRunPage({ category: "attention", pageSize: 50 }).runs.some((item) => item.run_id === pausedAfterExhaustion.run_id));
assert.ok(!store.listRunPage({ category: "active", pageSize: 50 }).runs.some((item) => item.run_id === pausedAfterExhaustion.run_id));
assert.equal(store.updateBudget(pausedAfterExhaustion.run_id, { token_limit: 200 }).state, "paused");
assert.ok(!store.listRunPage({ category: "attention", pageSize: 50 }).runs.some((item) => item.run_id === pausedAfterExhaustion.run_id));
assert.equal(store.resumeRun(pausedAfterExhaustion.run_id).state, "researching");

store.setAccountBudgetBlocked(pausedAfterExhaustion.run_id, true);
assert.equal(store.pauseRun(pausedAfterExhaustion.run_id).resume_state, "researching");
assert.equal(store.setAccountBudgetBlocked(pausedAfterExhaustion.run_id, false).run.state, "paused");
assert.equal(store.resumeRun(pausedAfterExhaustion.run_id).state, "researching");

const legacyBrokenRun = coordinator.create({
  objective: "Avoid guessing an overwritten resume state.",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
});
coordinator.start(legacyBrokenRun.run_id);
store.pauseRun(legacyBrokenRun.run_id);
store.db.prepare("UPDATE collaboration_runs SET resume_state = 'budget_exhausted' WHERE run_id = ?").run(legacyBrokenRun.run_id);
assert.equal(store.getSnapshot(legacyBrokenRun.run_id).capabilities.can_resume, false);
assert.ok(store.getSnapshot(legacyBrokenRun.run_id).attention.some((item) => item.kind === "resume_state_unknown"));
assert.ok(store.listRunPage({ category: "attention", pageSize: 50 }).runs.some((item) => item.run_id === legacyBrokenRun.run_id));
assert.throws(() => store.resumeRun(legacyBrokenRun.run_id), { code: "COLLABORATION_RESUME_STATE_UNKNOWN" });

const notStarted = coordinator.create({
  objective: "Do not start a task merely by resuming it.",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
});
store.setAccountBudgetBlocked(notStarted.run_id, true);
assert.equal(store.pauseRun(notStarted.run_id).resume_state, "created");
store.setAccountBudgetBlocked(notStarted.run_id, false);
const restoredCreated = store.resumeRun(notStarted.run_id);
assert.equal(restoredCreated.state, "created");
assert.equal(restoredCreated.tasks[0].state, "pending");

const planningBudgetRun = coordinator.create({
  objective: "Retain the adaptive planning phase after a budget and manual pause.",
  participants: [{ participant_id: "planner", runtime: "codex", device_id: "local", workspace_id: "w", planner: true }],
  budget: { token_limit: 10 },
});
coordinator.start(planningBudgetRun.run_id);
store.recordUsage(planningBudgetRun.run_id, { eventId: "planning-budget-pause-1", sampledTokens: 10 });
assert.equal(store.pauseRun(planningBudgetRun.run_id).resume_state, "designing");
assert.equal(store.updateBudget(planningBudgetRun.run_id, { token_limit: 20 }).state, "paused");
assert.equal(store.resumeRun(planningBudgetRun.run_id).state, "designing");

// A final usage event can arrive after the user pauses an active agent.
// Exhausting the budget must not silently turn the manual pause into an
// automatically resumable budget pause.
store.pauseRun(pausedRun.run_id);
const lateUsage = store.recordUsage(pausedRun.run_id, {
  eventId: "paused-late-usage-1", sampledTokens: 500,
});
assert.equal(lateUsage.exhausted, true);
assert.equal(lateUsage.run.state, "paused");
assert.equal(lateUsage.run.resume_state, "researching");
assert.equal(store.getSnapshot(pausedRun.run_id).capabilities.can_resume, false);
const raisedAfterLateUsage = store.updateBudget(pausedRun.run_id, { token_limit: 2000 });
assert.equal(raisedAfterLateUsage.state, "paused");
assert.equal(raisedAfterLateUsage.resume_state, "researching");
assert.equal(store.getSnapshot(pausedRun.run_id).capabilities.can_resume, true);
assert.equal(store.resumeRun(pausedRun.run_id).state, "researching");

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

const mixedCurrencyRun = coordinator.create({
  objective: "Do not combine amounts in different currencies",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
});
store.recordUsage(mixedCurrencyRun.run_id, {
  eventId: "currency-usd-0001", amountMicros: 1_000_000, currency: "USD", costSource: "configured",
});
const mixedUsage = store.recordUsage(mixedCurrencyRun.run_id, {
  eventId: "currency-eur-0002", amountMicros: 2_000_000, currency: "EUR", costSource: "configured",
});
assert.equal(mixedUsage.run.usage.amount_micros, 1_000_000);
assert.equal(mixedUsage.run.usage.currency, "USD");
assert.equal(mixedUsage.run.usage.unpriced_events, 1);
for (const [index, amount] of [-1, 1.5, "bad", true, Number.MAX_SAFE_INTEGER + 1].entries()) {
  const invalidPrice = store.recordUsage(mixedCurrencyRun.run_id, {
    eventId: `invalid-price-usage-${index}`, amountMicros: amount, currency: "USD", costSource: "configured",
  });
  assert.equal(invalidPrice.run.usage.amount_micros, 1_000_000);
  assert.equal(invalidPrice.run.usage.unpriced_events, index + 2);
}
assert.throws(() => store.updateBudget(mixedCurrencyRun.run_id, { currency: "EUR" }), {
  code: "COLLABORATION_BUDGET_CURRENCY_CONFLICT",
});
assert.throws(() => store.updateBudget(mixedCurrencyRun.run_id, { currency: "USDX" }), {
  code: "COLLABORATION_BUDGET_INVALID",
});
assert.equal(store.updateBudget(mixedCurrencyRun.run_id, { currency: " usd " }).budget.currency, "USD");

const guardedRun = coordinator.create({
  objective: "Reject stale budget edits without treating usage as an edit.",
  agents: {
    lead: { runtime: "codex", device_id: "local", workspace_id: "w", responsibilities: ["research"] },
    worker: { runtime: "claude", device_id: "local", workspace_id: "w", responsibilities: ["implement"] },
  },
  budget: { token_limit: 1000, amount_limit_micros: 2_000_000, currency: "USD" },
});
const budgetRevision = guardedRun.budget_revision;
assert.equal(store.getSnapshot(guardedRun.run_id).capabilities.budget_revision_control, 1);
store.recordUsage(guardedRun.run_id, { eventId: "guarded-budget-usage-1", sampledTokens: 10 });
const guardedEdit = store.updateBudget(guardedRun.run_id, {
  expected_budget_revision: budgetRevision, token_limit: null,
});
assert.equal(guardedEdit.budget.token_limit, null);
assert.equal(guardedEdit.budget.amount_limit_micros, 2_000_000);
assert.equal(guardedEdit.budget_revision, budgetRevision + 1);
assert.throws(() => store.updateBudget(guardedRun.run_id, {
  expected_budget_revision: budgetRevision, amount_limit_micros: null,
}), { code: "COLLABORATION_BUDGET_REVISION_CONFLICT" });
assert.equal(store.getRun(guardedRun.run_id).budget.amount_limit_micros, 2_000_000);
assert.throws(() => store.updateBudget(guardedRun.run_id, {
  expected_budget_revision: null, token_limit: 100,
}), { code: "COLLABORATION_BUDGET_INVALID" });
store.updateBudget(guardedRun.run_id, { token_limit: 100 });
assert.equal(store.updateBudget(guardedRun.run_id, { token_limit: null }).budget.token_limit, 100,
  "legacy clients retain their existing null semantics");

const insertActive = store.db.prepare(`
  INSERT INTO collaboration_runs (
    run_id, conversation_id, template_id, template_version, objective, state,
    gates_json, budget_json, usage_json, counters_json, created_at, updated_at
  ) VALUES (?, ?, 'plan_implement_verify', '1', 'active', 'created', '{}', '{}', '{}', '{}', ?, ?)
`);
store.db.transaction(() => {
  for (let i = 0; i < 501; i++) {
    insertActive.run(`many-active-${i}`, `many-conversation-${i}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  }
})();
assert.ok(store.listAccountBudgetRunIds().length > 500);
store.db.prepare("UPDATE collaboration_runs SET account_budget_blocked=1 WHERE run_id=?").run("many-active-500");
assert.equal(store.hasAccountBudgetBlockedRuns(), true);
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
assert.equal(migratedRun.budget_revision, 0);
migratedStore.close();
console.log("collaboration budget tests passed");
