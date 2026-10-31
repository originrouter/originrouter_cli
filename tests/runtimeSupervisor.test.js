import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { mapClaudeHookEvent } from "../src/adapters/claudeAdapter.js";
import { mapCodexAppServerEvent } from "../src/adapters/codex/eventMapper.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";
import { mapClaudeSdkMessage } from "../src/runtime/claudeSdkEvents.js";
import { RuntimeSupervisor } from "../src/runtime/runtimeSupervisor.js";
import { RuntimeTaskStore } from "../src/runtime/runtimeTaskStore.js";
import {
  classifyTurnError,
  isUserInterrupt,
  judgeBuiltin,
  normalizeRuntimeTaskCard,
} from "../src/runtime/runtimeTaskRules.js";

const SESSION = "claude-runtime-1";

function card(overrides = {}) {
  return {
    id: "rt_continue",
    name: "异常自动继续",
    checkpoints: ["abnormal_stop"],
    judge: { kind: "builtin", rule: "retryable_error" },
    action: { kind: "send", message: "继续" },
    limits: { maxFires: 3, cooldownSeconds: 0 },
    ...overrides,
  };
}

// A real registry and store, fake timers. Every assertion reads what a real
// runtime would read: the commands queued for the session and the events on
// it.
function fixture(t, cards = [card()], { agent = "claude", cwd = "/srv/app" } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: SESSION, agent, cwd });
  const store = new RuntimeTaskStore({ stateDir: mkdtempSync(join(tmpdir(), "originrouter-rt-")) });
  store.setCards({ cards });
  const supervisor = new RuntimeSupervisor({ registry, store, settleMs: 1000, log: { error() {} } }).start();
  t.after(() => supervisor.stop());
  const event = (payload) => registry.appendEvent(SESSION, payload);
  const commands = () => registry.commandsAfter(SESSION, 0).commands;
  const sent = () => commands().filter((item) => item.type === "agent.message");
  const supervisorEvents = () => registry.eventsAfter(0).events
    .filter((item) => item.type.startsWith("agent.supervisor."));
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  // Time moves in one-second steps so a timer set by another timer's
  // callback still fires inside the same advance, as it would in real time.
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= 1000) {
      t.mock.timers.tick(Math.min(1000, left));
      await flush();
    }
  };
  return { registry, store, supervisor, event, commands, sent, supervisorEvents, flush, advance };
}

const overloaded = { type: "agent.task.aborted", provider: "claude", status: "error", reason: "overloaded" };

test("an overloaded turn is continued after the backoff, and says so", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(1000);
  assert.equal(f.sent().length, 0, "the first retry waits 30 seconds");
  const waiting = f.supervisorEvents().find((item) => item.type === "agent.supervisor.waiting");
  assert.equal(waiting.waitSeconds, 30);
  assert.equal(waiting.errorClass, "overloaded");
  await f.advance(30_000);
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].message, "继续");
  assert.equal(f.sent()[0].origin, "supervisor");
  assert.ok(f.supervisorEvents().some((item) => item.type === "agent.supervisor.acted" && item.attempt === 1));
  assert.equal(f.store.log().length, 2, "the wait and the action are both in the log");
});

test("an interrupt is never recovered from", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(1000);
  f.registry.enqueueCommand(SESSION, { type: "terminal.interrupt", sessionId: SESSION });
  await f.advance(60_000);
  assert.equal(f.sent().length, 0, "the pending retry died with the interrupt");

  // Still suspended: a later failure in the same stretch is left alone.
  f.event({ type: "agent.task.aborted", provider: "codex", status: "interrupted" });
  f.event(overloaded);
  await f.advance(60_000);
  assert.equal(f.sent().length, 0);
});

test("an SDK result that ended by abort suspends instead of retrying", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.failed", isError: true, error: "API Error: 529 overloaded", terminalReason: "aborted_streaming" });
  await f.advance(120_000);
  assert.equal(f.sent().length, 0);
});

test("a user's own turn lifts the suspension and resets the count", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.registry.enqueueCommand(SESSION, { type: "terminal.interrupt", sessionId: SESSION });
  f.event({ type: "agent.task.aborted", status: "interrupted" });
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().length, 1);
});

test("a new turn before the retry cancels it", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(1000);
  f.event({ type: "agent.task.started" });
  await f.advance(60_000);
  assert.equal(f.sent().length, 0);
});

test("a pending approval blocks every card", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  f.event({ type: "agent.interaction.requested", interactionId: "i1", kind: "permission" });
  await f.advance(60_000);
  assert.equal(f.sent().length, 0);
});

test("an approval that arrives during the wait cancels the action", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(5000);
  f.event({ type: "agent.interaction.requested", interactionId: "i2", kind: "permission" });
  await f.advance(60_000);
  assert.equal(f.sent().length, 0);
});

test("the limit ends in one notification, not more messages", async (t) => {
  const f = fixture(t, [card({ limits: { maxFires: 2, cooldownSeconds: 0 } })]);
  // Rounds 2 and 3 open the turns the supervisor's own messages asked for.
  for (let round = 0; round < 3; round += 1) {
    f.event({ type: "agent.task.started" });
    f.event(overloaded);
    await f.advance(500_000);
  }
  await f.advance(3_600_000);
  assert.equal(f.sent().length, 2);
  const escalations = f.supervisorEvents().filter((item) => item.type === "agent.supervisor.escalated");
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reason, "limit_reached");
});

test("a clean end gives the retry rule its full budget back", async (t) => {
  const f = fixture(t, [card({ limits: { maxFires: 1, cooldownSeconds: 0 } })]);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(31_000);
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete", status: "complete" });
  await f.advance(2000);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().length, 2);
});

test("a turn's end reported twice is one checkpoint", async (t) => {
  const f = fixture(t, [card({
    checkpoints: ["turn_ended"],
    judge: { kind: "builtin", rule: "always" },
    action: { kind: "send", message: "继续，不用问我" },
  })]);
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete", status: "complete" });
  f.event({ type: "agent.task.complete", status: "complete" });
  await f.advance(2000);
  assert.equal(f.sent().length, 1);
  // The transcript scanner's copy can land after the message went out and
  // before the runtime opens the next turn. It must not send a second one.
  f.event({ type: "agent.task.complete", status: "complete" });
  await f.advance(2000);
  assert.equal(f.sent().length, 1);
});

test("an auth failure is not retried", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.aborted", status: "error", reason: "authentication_failed" });
  await f.advance(600_000);
  assert.equal(f.sent().length, 0);
});

test("cards outside the session's scope, or disabled, do nothing", async (t) => {
  const f = fixture(t, [
    card({ id: "rt_codex", scope: { agents: ["codex"] } }),
    card({ id: "rt_other", scope: { workspaces: ["/srv/other"] } }),
    card({ id: "rt_off", enabled: false }),
  ]);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(60_000);
  assert.equal(f.sent().length, 0);
});

test("an idle card notifies once per quiet stretch, only while running", async (t) => {
  const f = fixture(t, [card({
    id: "rt_idle",
    checkpoints: ["idle"],
    idleMinutes: 30,
    judge: { kind: "builtin", rule: "always" },
    action: { kind: "notify" },
    limits: { maxFires: 5, cooldownSeconds: 0 },
  })]);
  f.event({ type: "agent.task.started" });
  await f.advance(31 * 60_000);
  await f.advance(31 * 60_000);
  let escalations = f.supervisorEvents().filter((item) => item.type === "agent.supervisor.escalated");
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].checkpoint, "idle");
  f.event({ type: "agent.task.complete", status: "complete" });
  await f.advance(60 * 60_000);
  escalations = f.supervisorEvents().filter((item) => item.type === "agent.supervisor.escalated");
  assert.equal(escalations.length, 1, "an idle session is not a stuck one");
});

test("the empty-reply rule needs the runtime to have stated an empty result", async (t) => {
  const f = fixture(t, [card({
    id: "rt_empty",
    checkpoints: ["turn_ended"],
    judge: { kind: "builtin", rule: "empty_reply" },
    action: { kind: "send", message: "继续，把刚才的回复写完" },
  })]);
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  assert.equal(f.sent().length, 0, "no stated result is unknown, not empty");
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.text", text: "done" });
  f.event({ type: "agent.task.completed", result: "" });
  await f.advance(2000);
  assert.equal(f.sent().length, 0, "text arrived in the turn");
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.completed", result: "" });
  await f.advance(2000);
  assert.equal(f.sent().length, 1);
});

test("a refused supervisor message does not swallow the user's next turn", async (t) => {
  const f = fixture(t, [card({ limits: { maxFires: 1, cooldownSeconds: 0 } })]);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(31_000);
  const [message] = f.sent();
  f.event({ type: "agent.message.result", messageId: message.messageId, accepted: false });
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().length, 2, "the user's turn reset the count");
});

test("collaboration workers are left to their run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: "acr_worker", agent: "claude", sessionKind: "collaboration" });
  const store = new RuntimeTaskStore({ stateDir: mkdtempSync(join(tmpdir(), "originrouter-rt-")) });
  store.setCards({ cards: [card()] });
  const supervisor = new RuntimeSupervisor({ registry, store, settleMs: 0 }).start();
  t.after(() => supervisor.stop());
  registry.appendEvent("acr_worker", { type: "agent.task.started" });
  registry.appendEvent("acr_worker", overloaded);
  t.mock.timers.tick(600_000);
  await Promise.resolve();
  assert.equal(registry.commandsAfter("acr_worker", 0).commands.length, 0);
});

test("errors are classified from what each runtime says", () => {
  const now = 1_800_000_000_000;
  // Claude PTY StopFailure / SDK assistant error enum.
  assert.equal(classifyTurnError({ reason: "overloaded" }).class, "overloaded");
  assert.equal(classifyTurnError({ reason: "rate_limit" }).class, "rate_limited");
  assert.equal(classifyTurnError({ reason: "authentication_failed" }).class, "auth");
  assert.equal(classifyTurnError({ reason: "max_output_tokens" }).class, "max_tokens");
  // An enum that names no cause leaves the details to speak.
  assert.equal(classifyTurnError({ reason: "unknown", errorDetails: "socket hang up" }).class, "network");
  // SDK result text.
  const sdk = classifyTurnError({ error: "API Error: 529 {\"type\":\"overloaded_error\"}" });
  assert.equal(sdk.class, "overloaded");
  assert.equal(sdk.status, 529);
  assert.equal(classifyTurnError({ error: "API Error: 500 Internal server error" }).class, "server_error");
  assert.equal(classifyTurnError({ error: "anything" }, { assistantError: "server_error" }).class, "server_error");
  // Codex.
  assert.equal(classifyTurnError({ error: "usage limit reached" }).class, "rate_limited");
  assert.equal(classifyTurnError({ error: "stream disconnected before completion" }).class, "network");
  assert.equal(classifyTurnError({ error: "Something else" }).class, "other");
  // A number in a message is not a status code.
  assert.equal(classifyTurnError({ error: "Edited 503 lines" }).status, null);
  // A named reset is waited for.
  const limited = classifyTurnError({ reason: "rate_limit" }, { rateLimitResetsAt: now / 1000 + 3600 }, now);
  assert.equal(limited.retryAfterSeconds, 3600);
  assert.equal(judgeBuiltin("retryable_error", { checkpoint: "abnormal_stop", error: limited }).waitSeconds, 3615);
  // Backoff grows and stops growing.
  const plain = { checkpoint: "abnormal_stop", error: { class: "network" } };
  assert.deepEqual([0, 1, 4, 9].map((attempt) => judgeBuiltin("retryable_error", plain, { attempt }).waitSeconds),
    [30, 60, 480, 480]);
});

test("interrupts are recognised before anything is classified", () => {
  assert.equal(isUserInterrupt({ terminalReason: "aborted_tools" }), true);
  assert.equal(isUserInterrupt({ error: "[Request interrupted by user]" }), true);
  assert.equal(isUserInterrupt({ terminalReason: "model_error", error: "API Error: 529" }), false);
});

test("a card that can never fire, or could misfire, is refused", () => {
  const refused = (overrides, code = "INVALID_RUNTIME_TASK") => assert.throws(
    () => normalizeRuntimeTaskCard(card(overrides)),
    (error) => error.code === code,
  );
  refused({ id: "continue" });
  refused({ checkpoints: [] });
  refused({ checkpoints: ["turn_ended"] }, "INVALID_RUNTIME_TASK"); // retry rule cannot hold there
  refused({ checkpoints: ["idle"], judge: { kind: "builtin", rule: "always" } }); // idle cannot send
  refused({ action: { kind: "send", message: "  " } });
  refused({ limits: { maxFires: 0 } });
  refused({ scope: { agents: ["gemini"] } });
  refused({ judge: { kind: "ai", instruction: "x" } }, "AI_JUDGE_UNAVAILABLE");
  const normalized = normalizeRuntimeTaskCard(card({ limits: {} }));
  assert.deepEqual(normalized.limits, { maxFires: 5, cooldownSeconds: 30, onExhausted: "notify" });
  assert.equal(normalized.enabled, true);
});

test("the store refuses a write made from an old read, and survives a bad file", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-rt-store-"));
  const store = new RuntimeTaskStore({ stateDir });
  assert.equal(store.snapshot().revision, 0);
  const first = store.handle("set", { baseRevision: 0, cards: [card()] });
  assert.equal(first.revision, 1);
  assert.throws(() => store.handle("set", { baseRevision: 0, cards: [] }),
    (error) => error.code === "RUNTIME_TASKS_CONFLICT" && error.revision === 1);
  assert.throws(() => store.handle("set", { cards: [card(), card()] }), /duplicate card id/);
  assert.equal(store.cards().length, 1, "a refused write changes nothing");

  // A card this CLI cannot read is dropped; the rest load.
  const dir = store.dir();
  writeFileSync(join(dir, "runtime-tasks.json"), JSON.stringify({
    revision: 7,
    cards: [card(), { id: "rt_broken", name: "x" }],
  }));
  const reread = new RuntimeTaskStore({ stateDir });
  assert.equal(reread.snapshot().revision, 7);
  assert.deepEqual(reread.cards().map((item) => item.id), ["rt_continue"]);
  writeFileSync(join(dir, "runtime-tasks.json"), "{not json");
  assert.deepEqual(new RuntimeTaskStore({ stateDir }).cards(), []);

  for (let i = 0; i < 205; i += 1) store.appendLog({ type: "agent.supervisor.acted", n: i });
  const entries = store.handle("log", { limit: 500 }).entries;
  assert.equal(entries.length, 200);
  assert.equal(entries[0].n, 204, "newest first");
});

// The supervisor reads what the three runtimes' own mappers produce. These
// drive those mappers, so a change in an event's shape shows up here.
test("each runtime's failure and interrupt reach the supervisor as intended", async (t) => {
  const f = fixture(t, [card({ limits: { maxFires: 20, cooldownSeconds: 0 } })]);
  const run = async (events) => {
    f.event({ type: "agent.task.started" });
    for (const event of events) f.event(event);
    await f.advance(500_000);
  };
  // Claude terminal: StopFailure carries the SDK's error enum.
  await run([mapClaudeHookEvent({ hook_event_name: "StopFailure", error: "overloaded", error_details: "529" })]);
  assert.equal(f.sent().length, 1, "Claude terminal overload is retried");
  // Claude SDK: assistant error, then an error result.
  await run(mapClaudeSdkMessage({
    type: "result", subtype: "success", is_error: true, uuid: "r1",
    result: "API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}",
    terminal_reason: "model_error",
  }));
  assert.equal(f.sent().length, 2, "Claude SDK overload is retried");
  // Codex app-server: a failed turn.
  await run(mapCodexAppServerEvent({ type: "task_complete", turn_id: "c1", error: { message: "stream disconnected before completion" } }));
  assert.equal(f.sent().length, 3, "Codex disconnect is retried");
  // Claude SDK interrupt: the turn had hit an overload, then the user
  // stopped it. Only the result's terminal reason says it was an interrupt.
  await run([...mapClaudeSdkMessage({
    type: "assistant", error: "overloaded", uuid: "a2", message: { content: [] },
  }), ...mapClaudeSdkMessage({
    type: "result", subtype: "error_during_execution", is_error: true, uuid: "r2",
    errors: ["Request was aborted."], terminal_reason: "aborted_streaming",
  })]);
  assert.equal(f.sent().length, 3, "an SDK interrupt is not retried");
  // Codex interrupt.
  f.event({ type: "agent.task.started" });
  await run(mapCodexAppServerEvent({ type: "turn_aborted", turn_id: "c2", status: "interrupted" }));
  assert.equal(f.sent().length, 3, "a Codex interrupt is not retried");
});

// The AI judge path. The judge is a stand-in; what is tested is what the
// supervisor does with each verdict, and that a slow judge cannot act on a
// session that moved on.
function aiFixture(t, judge, cardOverrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: SESSION, agent: "claude", cwd: "/srv/app" });
  const store = new RuntimeTaskStore({ stateDir: mkdtempSync(join(tmpdir(), "originrouter-rt-ai-")), aiJudgeAvailable: true });
  store.setCards({ cards: [card({
    id: "rt_ask",
    name: "别停下来问我",
    checkpoints: ["turn_ended"],
    judge: { kind: "ai", instruction: "它在问是否继续" },
    action: { kind: "send", message: "继续，不用问我" },
    ...cardOverrides,
  })] });
  const escalations = [];
  const supervisor = new RuntimeSupervisor({
    registry, store, judge, settleMs: 1000, log: { error() {} },
    onEscalated: (item) => { escalations.push(item); },
  }).start();
  t.after(() => supervisor.stop());
  const sent = () => registry.commandsAfter(SESSION, 0).commands.filter((item) => item.type === "agent.message");
  const events = () => registry.eventsAfter(0).events.filter((item) => item.type.startsWith("agent.supervisor."));
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= 500) {
      t.mock.timers.tick(Math.min(500, left));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    }
  };
  return { registry, store, sent, events, escalations, advance, event: (p) => registry.appendEvent(SESSION, p) };
}

test("an AI act sends the card's own words, and says the AI decided", async (t) => {
  const asked = [];
  const f = aiFixture(t, async (request) => { asked.push(request); return { verdict: "act", confidence: 0.9, reason: "it asked" }; });
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.text", text: "Step one is done. Shall I continue?" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].instruction, "它在问是否继续");
  assert.equal(asked[0].snapshot.lastReply, "Step one is done. Shall I continue?");
  assert.equal(f.sent().length, 1);
  assert.equal(f.sent()[0].message, "继续，不用问我");
  const acted = f.events().find((item) => item.type === "agent.supervisor.acted");
  assert.equal(acted.judge, "ai");
  assert.equal(acted.judgeReason, "it asked");
});

test("needs_user notifies and reaches the push, and does not send", async (t) => {
  const f = aiFixture(t, async () => ({ verdict: "needs_user", confidence: 0.9, reason: "which DB" }));
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  assert.equal(f.sent().length, 0);
  assert.equal(f.escalations.length, 1);
  assert.equal(f.escalations[0].sessionId, SESSION);
  assert.equal(f.escalations[0].reason, "needs_user");
  assert.match(f.escalations[0].eventId, /^agent\.supervisor\.escalated_/);
});

test("a skip does nothing, and a judge failure is a diagnostic, not an action", async (t) => {
  let mode = "skip";
  const f = aiFixture(t, async () => {
    if (mode === "fail") throw Object.assign(new Error("down"), { code: "SUPERVISOR_JUDGE_FAILED" });
    return { verdict: "skip", confidence: 0.9, reason: "" };
  });
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  mode = "fail";
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  assert.equal(f.sent().length, 0);
  assert.deepEqual(f.events().map((item) => item.type), ["agent.supervisor.diagnostic"]);
});

test("a verdict that lands after the user moved on is dropped", async (t) => {
  let release;
  const f = aiFixture(t, () => new Promise((resolve) => { release = resolve; }));
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  assert.ok(release, "the judge was asked");
  f.event({ type: "agent.task.started" });
  release({ verdict: "act", confidence: 0.99, reason: "late" });
  await f.advance(2000);
  assert.equal(f.sent().length, 0);
});

test("the judge client sends the fixed policy and holds the confidence floor", async () => {
  const { SupervisorJudgeClient } = await import("../src/runtime/supervisorJudgeClient.js");
  const bodies = [];
  const headers = [];
  let reply = { verdict: "act", confidence: 0.6, reason: "unsure" };
  const client = new SupervisorJudgeClient({
    endpoint: "https://judge.test/ai/v1/supervisor/judge",
    // The credential shape accessTokenFor reads: one token per resource.
    ensureFreshAccessTokenFn: async ({ resource }) => {
      assert.equal(resource, "originrouter.ai");
      return { accessTokens: { ai: { token: "ai-token" } } };
    },
    fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      headers.push(init.headers);
      return { ok: true, json: async () => ({ data: { judgement: reply } }) };
    },
  });
  const snapshot = { checkpoint: "turn_ended", endReason: "completed", lastReply: "api_key=sk-abcdefghijklmnop done" };
  const run = () => client.judge({ judgeId: "sj_x y", runtime: "claude", snapshot, instruction: "i" })
    .catch((error) => error);
  const first = await run();
  assert.equal(first.verdict, "skip", "an unsure act is a skip");
  assert.equal(headers[0].Authorization, "Bearer ai-token");
  assert.deepEqual(bodies[0].policy, { verdict_only: true, untrusted_snapshot: true, fallback_to_skip_on_error: true });
  assert.equal(bodies[0].judge_id, "sj_x_y");
  assert.doesNotMatch(bodies[0].snapshot.last_reply, /sk-abcdefghijklmnop/, "secrets do not leave the device");
  reply = { verdict: "act", confidence: 0.95, reason: "clear" };
  assert.equal((await run()).verdict, "act");
  reply = { verdict: "launch_missiles", confidence: 1 };
  assert.equal((await run()).code, "SUPERVISOR_JUDGE_INVALID");
});

test("a late needs_user does not ring the phone for a session that moved on", async (t) => {
  let release;
  const f = aiFixture(t, () => new Promise((resolve) => { release = resolve; }));
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  f.event({ type: "agent.task.started" });
  release({ verdict: "needs_user", confidence: 0.99, reason: "late" });
  await f.advance(2000);
  assert.equal(f.escalations.length, 0);
});
