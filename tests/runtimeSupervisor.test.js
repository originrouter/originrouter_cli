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
import { activateAccount } from "../src/persistence/accounts.js";
import { ScheduledTaskStore } from "../src/runtime/scheduledTaskStore.js";
import { ScheduledTaskScheduler } from "../src/runtime/scheduledTaskScheduler.js";
import {
  classifyTurnError,
  isUserInterrupt,
  judgeBuiltin,
  normalizeRuntimeTaskCard,
} from "../src/runtime/runtimeTaskRules.js";

const SESSION = "claude-runtime-1";

test("existing AI rules do not prevent managing other rules when the judge is unavailable", () => {
  const store = new RuntimeTaskStore({stateDir:mkdtempSync(join(tmpdir(), "or-rt-capability-")), aiJudgeAvailable:true});
  const ai = card({id:"rt_ai", checkpoints:["turn_ended"], judge:{kind:"ai", instruction:"检查"}});
  store.setCards({cards:[ai, card()]});
  store.aiJudgeAvailable = false;
  let snapshot = store.snapshot();
  const ordinary = snapshot.cards.find((item) => item.id === "rt_continue");
  snapshot = store.setCards({baseRevision:snapshot.revision, cards:[snapshot.cards[0], {...ordinary, enabled:false}]});
  assert.equal(snapshot.cards.find((item) => item.id === "rt_continue").enabled, false);
  const existing = snapshot.cards.find((item) => item.id === "rt_ai");
  assert.throws(() => store.setCards({baseRevision:snapshot.revision, cards:[...snapshot.cards, {...existing, id:"rt_new"}]}), {code:"AI_JUDGE_UNAVAILABLE"});
  assert.throws(() => store.setCards({baseRevision:snapshot.revision, cards:snapshot.cards.map((item) => item.id === "rt_ai" ? {...item, name:"changed"} : item)}), {code:"AI_JUDGE_UNAVAILABLE"});
  snapshot = store.setCards({baseRevision:snapshot.revision, cards:snapshot.cards.map((item) => item.id === "rt_ai" ? {...item, enabled:false} : item)});
  assert.throws(() => store.setCards({baseRevision:snapshot.revision, cards:snapshot.cards.map((item) => item.id === "rt_ai" ? {...item, enabled:true} : item)}), {code:"AI_JUDGE_UNAVAILABLE"});
  snapshot = store.setCards({baseRevision:snapshot.revision, cards:snapshot.cards.filter((item) => item.id !== "rt_ai")});
  assert.equal(snapshot.cards.length, 1);
});

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
function fixture(t, cards = [card()], { agent = "claude", cwd = "/srv/app", autoAck = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: SESSION, agent, cwd, runtime:agent === "agy" ? "agy-acp" : agent === "codex" ? "codex-app-server" : "claude-sdk", supportsRuntimeRecovery:true });
  const store = new RuntimeTaskStore({ stateDir: mkdtempSync(join(tmpdir(), "originrouter-rt-")) });
  store.setCards({ cards });
  const supervisor = new RuntimeSupervisor({ registry, store, settleMs: 1000, log: { error() {} } }).start();
  t.after(() => supervisor.stop());
  if (autoAck) registry.subscribe(({type,sessionId,payload}) => {
    if (type === "command" && payload.type === "agent.message" && payload.origin === "supervisor") {
      queueMicrotask(() => registry.appendEvent(sessionId,{type:"agent.message.result",messageId:payload.messageId,accepted:true}));
    }
  });
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

test("agy ACP continues only after matching receipt and keeps user-stop protection", async (t) => {
  const f = fixture(t, [card({scope:{agents:["agy"]}})], {agent:"agy", autoAck:false});
  f.event({type:"agent.task.started",supervisorTurnId:"agy-turn"});
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().length,1);
  assert.equal(f.supervisorEvents().some(item => item.type === "agent.supervisor.acted"),false);
  f.event({type:"agent.message.result",messageId:f.sent()[0].messageId,accepted:true});
  await f.advance(500);
  assert.ok(f.store.log().some(item => item.agent === "agy" && item.type === "agent.supervisor.acted"));
  f.registry.enqueueCommand(SESSION,{type:"terminal.interrupt"});
  f.event(overloaded);
  await f.advance(300_000);
  assert.equal(f.sent().length,1);
});

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
  assert.ok(f.store.log().every((entry) => entry.agent === "claude"));
});

test("an automatic continuation is only reported after its matching acceptance receipt", async (t) => {
  const f = fixture(t, [card({checkpoints:["turn_ended"],judge:{kind:"builtin",rule:"always"}})], {autoAck:false});
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  const message = f.sent()[0];
  assert.ok(message);
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  assert.equal(f.supervisorEvents().some((item) => item.type === "agent.supervisor.acted"),false);
  f.event({type:"agent.message.result",messageId:"wrong",accepted:true});
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  f.event({type:"agent.message.result",messageId:message.messageId,accepted:true});
  await f.advance(500);
  assert.equal(f.store.recoveryFor(SESSION).pending,false);
  assert.equal(f.supervisorEvents().filter((item) => item.type === "agent.supervisor.acted").length,1);
});

test("a lost continuation receipt remains uncertain after timeout and daemon restart", async (t) => {
  const f = fixture(t, [card({checkpoints:["turn_ended"],judge:{kind:"builtin",rule:"always"}})], {autoAck:false});
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  const message = f.sent()[0];
  await f.advance(30_000);
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  assert.equal(f.supervisorEvents().some((item) => item.code === "message_timeout"),true);
  f.event({type:"agent.message.result",messageId:message.messageId,accepted:true});
  assert.equal(f.supervisorEvents().some((item) => item.type === "agent.supervisor.acted"),false);
  f.supervisor.forget(SESSION);
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  assert.equal(f.sent().length,1);
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
});

test("an account switch cannot let an old session alter the new account's pending state", async (t) => {
  const f = fixture(t, [card({checkpoints:["turn_ended"],judge:{kind:"builtin",rule:"always"}})], {autoAck:false});
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  const oldMessage = f.sent()[0];
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  activateAccount(f.store.rootStateDir,"second-account");
  f.store.beginDelivery(SESSION);
  f.event({type:"agent.message.result",messageId:oldMessage.messageId,accepted:true});
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  assert.equal(f.sent().length,1);
  assert.equal(f.store.log().length,0);
});

test("a legacy wrapper without receipts cannot receive an automatic continuation", async (t) => {
  const f = fixture(t, [card({checkpoints:["turn_ended"],judge:{kind:"builtin",rule:"always"}})]);
  f.registry.register({sessionId:SESSION,agent:"claude",runtime:"claude-sdk",supportsRuntimeRecovery:false});
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  assert.equal(f.sent().length,0);
  assert.equal(f.supervisorEvents().some((item) => item.reason === "needs_user"),true);
});

test("a changed card cannot execute an earlier retry decision", async (t) => {
  const f = fixture(t);
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(1000);
  f.store.setCards({ cards: [card({ action: { kind: "stop" } })] });
  f.supervisor.cardsChanged();
  await f.advance(30_000);
  assert.equal(f.sent().length, 0);
  assert.equal(f.commands().filter((item) => item.type === "session.stop").length, 0);
});

test("activity cancels a pending idle action even when the turn remains running", async (t) => {
  const idleCard = card({
    checkpoints: ["idle"], idleMinutes: 5,
    judge: { kind: "builtin", rule: "always" },
    action: { kind: "stop" },
    limits: { maxFires: 3, cooldownSeconds: 600 },
  });
  const f = fixture(t, [idleCard]);
  f.event({ type: "agent.task.started" });
  f.supervisor.state(SESSION).fires.set(idleCard.id, {
    count: 1, lastAtMs: Date.now(), exhaustedNotified: false,
  });
  await f.advance(300_000);
  assert.ok(f.supervisorEvents().some((item) => item.type === "agent.supervisor.waiting"));
  await f.advance(1_000);
  f.event({ type: "agent.text", text: "Work has resumed." });
  await f.advance(299_000);
  assert.equal(f.commands().filter((item) => item.type === "session.stop").length, 0);
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
  const resumed = f.registry.enqueueCommand(SESSION, {type:"agent.message", message:"继续"});
  f.event({ type: "agent.task.started", id:resumed.commandId });
  f.event({ type: "agent.message.result", messageId:resumed.commandId, accepted:true });
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 1);
});

test("a late start after user stop cannot revive supervision", async (t) => {
  const f = fixture(t);
  f.event({type:"agent.task.started", id:"old-turn"});
  f.registry.enqueueCommand(SESSION, {type:"terminal.interrupt"});
  f.event({type:"agent.task.started", id:"old-turn"});
  f.event(overloaded);
  await f.advance(120_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 0);
  const resumed = f.registry.enqueueCommand(SESSION, {type:"agent.message", message:"继续"});
  f.event({type:"agent.task.started", id:"late-old-turn"});
  f.event({type:"user.text", eventId:"local-message-old-command", text:"old"});
  f.event(overloaded);
  await f.advance(120_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 0);
  f.event({type:"agent.task.started", id:resumed.commandId});
  f.event({type:"agent.message.result", messageId:resumed.commandId, accepted:true});
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 1);
});

test("an accepted user message resumes supervision even if its start event arrives later", async (t) => {
  const f = fixture(t);
  f.event({type:"agent.task.started", id:"old-turn"});
  f.registry.enqueueCommand(SESSION, {type:"terminal.interrupt"});
  f.event({type:"agent.task.aborted", status:"interrupted"});
  const command = f.registry.enqueueCommand(SESSION, {type:"agent.message", message:"继续"});
  f.event({type:"user.text", eventId:`local-message-${command.commandId}`, text:"继续"});
  f.event({type:"agent.message.result", messageId:command.commandId, accepted:true});
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 1);
});

test("a user stop remains effective across supervisor restart until a new message is confirmed", async (t) => {
  const f = fixture(t);
  f.event({type:"agent.task.started", id:"old-turn"});
  f.registry.enqueueCommand(SESSION, {type:"terminal.interrupt"});
  f.supervisor.stop();
  const restarted = new RuntimeSupervisor({registry:f.registry, store:new RuntimeTaskStore({stateDir:f.store.rootStateDir}),
    settleMs:1000, log:{error(){}}}).start();
  t.after(() => restarted.stop());
  f.event({type:"agent.task.started", id:"old-turn"});
  f.event(overloaded);
  await f.advance(120_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 0);
  const command = f.registry.enqueueCommand(SESSION, {type:"agent.message", message:"继续"});
  assert.equal(f.store.recoveryFor(SESSION).userStopped, true, 'queued input is not confirmation');
  assert.equal(restarted.sessions.get(SESSION).resumeMessageId, command.commandId);
  f.event({type:"agent.task.started", id:command.commandId});
  assert.equal(f.store.recoveryFor(SESSION).userStopped, true, 'start announcement is not acceptance');
  f.event({type:"agent.message.result", messageId:command.commandId, accepted:true});
  assert.equal(f.store.recoveryFor(SESSION), null);
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 1);
});

test("a refused or late user message cannot clear the stop guard", async (t) => {
  const f = fixture(t);
  f.event({type:"agent.task.started", id:"old-turn"});
  f.registry.enqueueCommand(SESSION, {type:"terminal.interrupt"});
  const refused = f.registry.enqueueCommand(SESSION, {type:"agent.message", message:"继续"});
  f.event({type:"agent.task.started", id:refused.commandId});
  f.event({type:"user.text", eventId:`local-message-${refused.commandId}`, text:"继续"});
  f.event({type:"agent.message.result", messageId:refused.commandId, accepted:false});
  assert.equal(f.store.recoveryFor(SESSION).userStopped, true);
  f.event(overloaded);
  await f.advance(60_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 0);
  const newer = f.registry.enqueueCommand(SESSION, {type:"agent.message", message:"再试"});
  f.event({type:"agent.message.result", messageId:refused.commandId, accepted:true});
  assert.equal(f.store.recoveryFor(SESSION).userStopped, true);
  f.registry.enqueueCommand(SESSION, {type:"terminal.interrupt"});
  f.event({type:"agent.message.result", messageId:newer.commandId, accepted:true});
  assert.equal(f.store.recoveryFor(SESSION).userStopped, true);
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
  const f = fixture(t, [card({ limits: { maxFires: 1, cooldownSeconds: 0 } })], {autoAck:false});
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(31_000);
  const [message] = f.sent();
  f.event({ type: "agent.message.result", messageId: message.messageId, accepted: false });
  const manual = f.registry.enqueueCommand(SESSION, {type:"agent.message", message:"continue manually"});
  f.event({ type: "agent.message.result", messageId:manual.commandId, accepted:true });
  f.event({ type: "agent.task.started" });
  f.event(overloaded);
  await f.advance(31_000);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length, 2, "the user's turn reset the count");
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
  refused({ checkpoints: ["loop"], judge: { kind: "builtin", rule: "always" }, action: { kind: "notify" } });
  assert.throws(() => normalizeRuntimeTaskCard(card({
    checkpoints: ["loop"], judge: { kind: "ai", instruction: "detect loops" }, action: { kind: "stop" },
  }), { aiJudgeAvailable: true }), /only notify/);
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
function aiFixture(t, judge, cardOverrides = {}, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: SESSION, agent: "claude", cwd: "/srv/app", runtime:"claude-sdk", supportsRuntimeRecovery:true, ...options });
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
  registry.subscribe(({type,sessionId,payload}) => {
    if (type === "command" && payload.type === "agent.message" && payload.origin === "supervisor"
      && supervisor.sessions.get(sessionId)?.recovery?.action === "send") {
      queueMicrotask(() => registry.appendEvent(sessionId,{type:"agent.message.result",messageId:payload.messageId,accepted:true}));
    }
  });
  const sent = () => registry.commandsAfter(SESSION, 0).commands.filter((item) => item.type === "agent.message");
  const events = () => registry.eventsAfter(0).events.filter((item) => item.type.startsWith("agent.supervisor."));
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= 500) {
      t.mock.timers.tick(Math.min(500, left));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    }
  };
  return { registry, store, supervisor, sent, events, escalations, advance, event: (p) => registry.appendEvent(SESSION, p) };
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

test("scheduled execution waits for the real supervisor judgment and records its request for help", async (t) => {
  let release;
  const f = aiFixture(t, () => new Promise((resolve) => { release = resolve; }));
  const store = new ScheduledTaskStore({stateDir:mkdtempSync(join(tmpdir(), "or-supervised-schedule-"))});
  store.save({id:"st_supervised",name:"supervised",schedule:{kind:"once",at:"2099-01-01T00:00:00Z"},
    launch:{agentType:"claude",workspaceId:"w1",initialMessage:"do work",permissionProfile:"manual"}});
  const scheduler = new ScheduledTaskScheduler({store,registry:f.registry,runtimeSupervisor:f.supervisor,
    supervisor:{start:async () => ({accepted:true})},log:{error() {}}});
  scheduler.unsubscribe = f.registry.subscribe((event) => scheduler.onRegistryEvent(event));
  t.after(() => { scheduler.stop(); store.close(); });
  await scheduler.runNow("st_supervised");
  const run = store.executions()[0];
  // Use the scheduled session in the same production registry/supervisor.
  f.registry.register({sessionId:run.sessionId,agent:"claude",runtime:"claude-sdk"});
  f.registry.appendEvent(run.sessionId,{type:"agent.task.started"});
  f.registry.appendEvent(run.sessionId,{type:"agent.task.complete"});
  await f.advance(5000);
  assert.equal(typeof release,"function");
  scheduler.settleFinishedTurns();
  assert.equal(store.executions()[0].status,"settling");
  assert.equal(store.claim("st_supervised",{manual:true}).status,"skipped_busy");
  release({verdict:"needs_user",confidence:0.95,reason:"user must decide"});
  await f.advance(500);
  assert.equal(store.executions().find((item) => item.id === run.id).status,"waiting_input");
  assert.equal(f.registry.commandsAfter(run.sessionId,0).commands.filter((item) => item.type === "agent.message").length,0);
});

test("repeated output asks the AI before notifying", async (t) => {
  const requests = [];
  const f = aiFixture(t, async (request) => {
    requests.push(request);
    return { verdict: "act", confidence: 0.99, reason: "repeated output" };
  }, { checkpoints: ["loop"], action: { kind: "notify" } });
  f.event({ type: "agent.task.started" });
  for (let i = 0; i < 5; i += 1) f.event({ type: "agent.text", text: "Let me check this again. " });
  await f.advance(1000);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].snapshot.checkpoint, "loop");
  assert.equal(f.escalations.length, 1);
  assert.equal(f.sent().length, 0);
});

test("stream observations are turn-bound and never enter session history", async (t) => {
  const requests = [];
  const f = aiFixture(t, async (request) => {
    requests.push(request);
    return { verdict: "act", confidence: 0.99 };
  }, { checkpoints: ["loop"], action: { kind: "notify" } });
  f.event({ type: "agent.task.started", id: "turn-current" });
  const before = f.registry.eventsAfter(0).events.length;
  for (let i = 0; i < 5; i += 1) {
    f.registry.notify("observation", SESSION, { turnId: "turn-old", text: "Let me check this again. " });
  }
  await f.advance(1000);
  assert.equal(requests.length, 0);
  for (let i = 0; i < 5; i += 1) {
    f.registry.notify("observation", SESSION, { turnId: "turn-current", text: "Let me check this again. " });
  }
  assert.equal(f.registry.eventsAfter(0).events.length, before);
  await f.advance(1000);
  assert.equal(requests.length, 1);
  assert.equal(f.escalations.length, 1);
  assert.equal(f.registry.eventsAfter(0).events.some((event) => event.text === "Let me check this again. "), false);
});

test("missing or reordered stream samples cannot be joined into a false repetition", async (t) => {
  let judgments = 0;
  const f = aiFixture(t, async () => { judgments++; return {verdict:"skip",confidence:0.99}; },
    {checkpoints:["loop"],action:{kind:"notify"}});
  f.event({type:"agent.task.started",id:"turn-current"});
  const observe = (sequence, text) => f.registry.notify("observation",SESSION,{turnId:"turn-current",sequence,text});
  const phrase = "Let me check this again. ";
  observe(1,phrase.repeat(3));
  observe(3,phrase); // sequence 2 was dropped; do not join across the gap.
  await f.advance(1000);
  assert.equal(judgments,0);
  observe(2,phrase.repeat(4)); // delayed/out-of-order samples are ignored.
  assert.equal(judgments,0);
  observe(4,phrase.repeat(4));
  await f.advance(1000);
  assert.equal(judgments,1);
});

test("repeated output never notifies when the AI rejects it", async (t) => {
  const f = aiFixture(t, async () => ({ verdict: "skip", confidence: 0.99 }),
    { checkpoints: ["loop"], action: { kind: "notify" } });
  f.event({ type: "agent.task.started" });
  for (let i = 0; i < 5; i += 1) f.event({ type: "agent.text", text: "Let me check this again. " });
  await f.advance(1000);
  assert.equal(f.escalations.length, 0);
});

test("a delayed loop verdict is discarded after new progress breaks the repetition", async (t) => {
  let release;
  const f=aiFixture(t,() => new Promise((resolve) => {release=resolve;}),
    {checkpoints:["loop"],action:{kind:"interrupt_and_continue",message:"continue"}});
  f.event({type:"agent.task.started",id:"turn-1"});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:1,text:"Let me check this again. ".repeat(5)});
  assert.equal(typeof release,"function");
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:2,text:"The issue is fixed; now running the test suite."});
  release({verdict:"act",confidence:0.99});
  await f.advance(1000);
  assert.equal(f.registry.commandsAfter(SESSION,0).commands.some((item) => item.type === "agent.supervisor.interrupt"),false);
});

test("a verdict for one repeated phrase cannot interrupt a different repeated phrase", async (t) => {
  let release;
  const f=aiFixture(t,() => new Promise((resolve) => {release=resolve;}),
    {checkpoints:["loop"],action:{kind:"interrupt_and_continue",message:"continue"}});
  f.event({type:"agent.task.started",id:"turn-1"});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:1,text:"Let me check this again. ".repeat(5)});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:2,text:"Running the verified checks. ".repeat(6)});
  release({verdict:"act",confidence:0.99});
  await f.advance(1000);
  assert.equal(f.registry.commandsAfter(SESSION,0).commands.some((item) => item.type === "agent.supervisor.interrupt"),false);
});

test("a new repeated pattern is judged after an older in-flight verdict is discarded", async (t) => {
  const requests=[]; let release;
  const f=aiFixture(t,(request) => {
    requests.push(request);
    if (requests.length === 1) return new Promise((resolve) => {release=resolve;});
    return Promise.resolve({verdict:"skip",confidence:0.99});
  },{checkpoints:["loop"],action:{kind:"interrupt_and_continue",message:"continue"}});
  f.event({type:"agent.task.started",id:"turn-1"});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:1,text:"Let me check this again. ".repeat(5)});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:2,text:"Running the verified checks. ".repeat(6)});
  release({verdict:"act",confidence:0.99});
  await f.advance(6000);
  assert.equal(requests.length,2);
  assert.match(requests[1].snapshot.lastReply,/running the verified checks/i);
  assert.equal(f.registry.commandsAfter(SESSION,0).commands.some((item) => item.type === "agent.supervisor.interrupt"),false);
});

test("a queued loop recheck is cancelled by a user stop", async (t) => {
  let release, judgments=0;
  const f=aiFixture(t,() => {judgments++; return new Promise((resolve) => {release=resolve;});},
    {checkpoints:["loop"],action:{kind:"interrupt_and_continue",message:"continue"}});
  f.event({type:"agent.task.started",id:"turn-1"});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:1,text:"Let me check this again. ".repeat(5)});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:2,text:"Running the verified checks. ".repeat(6)});
  release({verdict:"act",confidence:0.99});
  await f.advance(500);
  f.registry.enqueueCommand(SESSION,{type:"session.stop"});
  await f.advance(6000);
  assert.equal(judgments,1);
  assert.equal(f.registry.commandsAfter(SESSION,0).commands.some((item) => item.type === "agent.supervisor.interrupt"),false);
});

test("a delayed loop verdict may act when the same repetition continues", async (t) => {
  let release;
  const f=aiFixture(t,() => new Promise((resolve) => {release=resolve;}),
    {checkpoints:["loop"],action:{kind:"interrupt_and_continue",message:"continue"}});
  f.event({type:"agent.task.started",id:"turn-1"});
  const phrase="Let me check this again. ";
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:1,text:phrase.repeat(5)});
  f.registry.notify("observation",SESSION,{turnId:"turn-1",sequence:2,text:phrase});
  release({verdict:"act",confidence:0.99});
  await f.advance(1000);
  assert.equal(f.registry.commandsAfter(SESSION,0).commands.some((item) => item.type === "agent.supervisor.interrupt"),true);
});

test("a delayed loop verdict cannot act while approval is pending", async (t) => {
  let release;
  const f = aiFixture(t, () => new Promise((resolve) => { release = resolve; }),
    { checkpoints: ["loop"], action: { kind: "notify" } });
  f.event({ type: "agent.task.started" });
  for (let i = 0; i < 5; i += 1) f.event({ type: "agent.text", text: "Let me check this again. " });
  await f.advance(1000);
  assert.ok(release);
  f.event({ type: "agent.interaction.requested", interactionId: "approval-1", kind: "approval" });
  release({ verdict: "act", confidence: 0.99 });
  await f.advance(1000);
  assert.equal(f.registry.commandsAfter(SESSION, 0).commands.filter((item) => item.type === "session.stop").length, 0);
  assert.equal(f.escalations.length, 0);
});

function recoveryFixture(t, judge = async () => ({ verdict: "act", confidence: 0.99 }), runtime = "codex-app-server") {
  return aiFixture(t, judge, {
    checkpoints: ["loop"],
    action: { kind: "interrupt_and_continue", message: "请继续" },
    limits: { maxFires: 2, cooldownSeconds: 0 },
  }, { runtime, agent: runtime === "agy-acp" ? "agy" : "codex", supportsRuntimeRecovery: true });
}

async function triggerRecovery(f) {
  f.event({ type: "agent.task.started", id: "turn-1" });
  for (let i = 0; i < 5; i += 1) f.event({ type: "agent.text", text: "Let me check this again. " });
  await f.advance(1000);
  return f.registry.commandsAfter(SESSION, 0).commands.find((command) => command.type === "agent.supervisor.interrupt");
}

for (const runtime of ["codex-app-server", "agy-acp"]) for (const ackFirst of [true, false]) {
  test(`${runtime} recovery waits for matching acknowledgement and aborted turn (ack first: ${ackFirst})`, async (t) => {
    const f = recoveryFixture(t, undefined, runtime);
    const interrupt = await triggerRecovery(f);
    assert.ok(interrupt);
    assert.equal(f.store.recoveryFor(SESSION).pending, true);
    const ack = () => f.registry.notify("recovery_result", SESSION, {
      requestId: interrupt.requestId, turnId: interrupt.turnId, accepted: true,
    });
    const abort = () => f.event({ type: "agent.task.aborted", id: "turn-1" });
    if (ackFirst) ack(); else abort();
    assert.equal(f.sent().length, 0, "one confirmation is not enough");
    if (ackFirst) abort(); else ack();
    assert.equal(f.sent().length, 1);
    const message = f.sent()[0];
    assert.equal(message.message, "请继续");
    assert.equal(message.origin, "supervisor");
    assert.equal(f.store.recoveryFor(SESSION).pending, true, "delivery still needs acknowledgement");
    f.event({ type: "agent.task.started", id: "turn-2" });
    f.event({ type: "agent.message.result", messageId: message.messageId, accepted: true });
    await f.advance(1000);
    assert.equal(f.store.recoveryFor(SESSION).pending, false);
    assert.equal(f.store.recoveryFor(SESSION).counts.rt_ask, 1);
    assert.ok(f.events().some((event) => event.action === "interrupt_and_continue"));
  });
}

test("an unidentifiable or wrong-turn abort cannot authorize a recovery message", async (t) => {
  for (const event of [{type:"agent.task.aborted"},{type:"agent.task.aborted",id:"old-turn"}]) {
    // Each case uses the same fake clock; run separate supervisor fixtures.
    const registry=new ExternalAgentRegistry();
    registry.register({sessionId:SESSION,agent:"claude",runtime:"claude-sdk",supportsRuntimeRecovery:true});
    const store=new RuntimeTaskStore({stateDir:mkdtempSync(join(tmpdir(),"or-unbound-abort-")),aiJudgeAvailable:true});
    store.setCards({cards:[card({id:"rt_loop",checkpoints:["loop"],judge:{kind:"ai",instruction:"check"},
      action:{kind:"interrupt_and_continue",message:"continue"}})]});
    const supervisor=new RuntimeSupervisor({registry,store,judge:async () => ({verdict:"act",confidence:0.99})}).start();
    try {
      registry.appendEvent(SESSION,{type:"agent.task.started",id:"current-turn"});
      for(let i=0;i<5;i++) registry.notify("observation",SESSION,{turnId:"current-turn",text:"Let me check this again. "});
      await new Promise((resolve) => setImmediate(resolve));
      const interrupt=registry.commandsAfter(SESSION,0).commands.find((item) => item.type==="agent.supervisor.interrupt");
      assert.ok(interrupt);
      registry.notify("recovery_result",SESSION,{requestId:interrupt.requestId,turnId:interrupt.turnId,accepted:true});
      registry.appendEvent(SESSION,event);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(registry.commandsAfter(SESSION,0).commands.some((item) => item.type==="agent.message"),false);
      assert.equal(store.recoveryFor(SESSION).pending,true);
    } finally {supervisor.stop();}
  }
});

test("a user stop cancels recovery even if confirmations arrive later", async (t) => {
  const f = recoveryFixture(t);
  const interrupt = await triggerRecovery(f);
  f.registry.enqueueCommand(SESSION, { type: "session.stop", sessionId: SESSION });
  f.registry.notify("recovery_result", SESSION, { requestId: interrupt.requestId, turnId: interrupt.turnId, accepted: true });
  f.event({ type: "agent.task.aborted", id: "turn-1" });
  await f.advance(1000);
  assert.equal(f.sent().length, 0);
  assert.equal(f.store.recoveryFor(SESSION).pending, true);
});

test("a user taking over an in-flight recovery must be accepted before supervision resumes", async (t) => {
  const f = recoveryFixture(t);
  const interrupt = await triggerRecovery(f);
  const takeover = f.registry.enqueueCommand(SESSION,{type:"agent.message",message:"I will take over"});
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  f.registry.notify("recovery_result", SESSION, {requestId:interrupt.requestId,turnId:interrupt.turnId,accepted:true});
  f.event({type:"agent.task.aborted",id:"turn-1"});
  f.event({type:"agent.message.result",messageId:takeover.commandId,accepted:false});
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  assert.equal(f.sent().filter((item) => item.origin === "supervisor").length,0);
  const retry = f.registry.enqueueCommand(SESSION,{type:"agent.message",message:"I will take over again"});
  f.event({type:"agent.message.result",messageId:retry.commandId,accepted:true});
  assert.equal(f.store.recoveryFor(SESSION),null);
});

test("unconfirmed or rejected interrupts never send a recovery message", async (t) => {
  const f = recoveryFixture(t);
  const interrupt = await triggerRecovery(f);
  f.registry.notify("recovery_result", SESSION, { requestId: interrupt.requestId, turnId: interrupt.turnId, accepted: false });
  f.event({ type: "agent.task.aborted", id: "turn-1" });
  await f.advance(1000);
  assert.equal(f.sent().length, 0);
  assert.equal(f.store.recoveryFor(SESSION).pending, true);
  assert.equal(f.escalations.length, 1);
});

test("an approval arriving during interruption cancels recovery even if resolved", async (t) => {
  const f = recoveryFixture(t);
  const interrupt = await triggerRecovery(f);
  f.event({ type: "agent.interaction.requested", interactionId: "approval-2", kind: "permission" });
  f.event({ type: "agent.interaction.applied", interactionId: "approval-2" });
  f.registry.notify("recovery_result", SESSION, { requestId: interrupt.requestId, turnId: interrupt.turnId, accepted: true });
  f.event({ type: "agent.task.aborted", id: "turn-1" });
  await f.advance(1000);
  assert.equal(f.sent().length, 0);
  assert.equal(f.store.recoveryFor(SESSION).pending, true);
});

test("an old wrapper never receives an automatic interrupt", async (t) => {
  const f = aiFixture(t, async () => ({ verdict: "act", confidence: 0.99 }), {
    checkpoints: ["loop"], action: { kind: "interrupt_and_continue", message: "继续" },
  }, { runtime: "codex-app-server", supportsRuntimeRecovery:false });
  const interrupt = await triggerRecovery(f);
  assert.equal(interrupt, undefined);
  assert.equal(f.sent().length, 0);
  assert.equal(f.escalations.length, 1);
});

test("a rejected continuation remains uncertain and is never replayed", async (t) => {
  const f = recoveryFixture(t);
  const interrupt = await triggerRecovery(f);
  f.registry.notify("recovery_result", SESSION, { requestId: interrupt.requestId, turnId: interrupt.turnId, accepted: true });
  f.event({ type: "agent.task.aborted", id: "turn-1" });
  const message = f.sent()[0];
  f.event({ type: "agent.message.result", messageId: message.messageId, accepted: false });
  await f.advance(1000);
  assert.equal(f.store.recoveryFor(SESSION).pending, true);
  assert.equal(f.escalations.length, 1);
  assert.equal(f.events().filter((event) => event.action === "interrupt_and_continue").length, 0);
});

test("an interrupted daemon cannot repeat an uncertain recovery", async (t) => {
  const f = recoveryFixture(t);
  const original = await triggerRecovery(f);
  assert.ok(original);
  f.supervisor.forget(SESSION);
  f.event({ type: "agent.task.started", id: "turn-2" });
  for (let i = 0; i < 5; i += 1) f.event({ type: "agent.text", text: "Let me check this again. " });
  await f.advance(1000);
  const interrupts = f.registry.commandsAfter(SESSION, 0).commands.filter((command) => command.type === "agent.supervisor.interrupt");
  assert.equal(interrupts.length, 1);
  assert.equal(f.store.recoveryFor(SESSION).pending, true);
});

test("a user takeover clears uncertain recovery only after its own acceptance receipt", async (t) => {
  const f = recoveryFixture(t);
  await triggerRecovery(f);
  f.supervisor.forget(SESSION);
  const first = f.registry.enqueueCommand(SESSION, { type:"agent.message", sessionId:SESSION, message:"I will take over" });
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  f.event({type:"agent.message.result",messageId:first.commandId,accepted:false});
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  const second = f.registry.enqueueCommand(SESSION, {type:"agent.message", sessionId:SESSION, message:"Try again"});
  f.event({type:"agent.message.result",messageId:first.commandId,accepted:true});
  assert.equal(f.store.recoveryFor(SESSION).pending,true);
  f.event({type:"agent.message.result",messageId:second.commandId,accepted:true});
  assert.equal(f.store.recoveryFor(SESSION),null);
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

test("an unavailable AI decision cannot fall through to a later automatic action", async (t) => {
  const f = aiFixture(t, async () => { throw Object.assign(new Error("timeout"), {code:"SUPERVISOR_JUDGE_TIMEOUT"}); });
  f.store.setCards({cards:[f.store.cards()[0], card({id:"rt_fallback", name:"fallback", checkpoints:["turn_ended"],
    judge:{kind:"builtin",rule:"always"}, action:{kind:"send",message:"must not send"}})]});
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  assert.equal(f.sent().length,0);
  assert.equal(f.events()[0].code,"SUPERVISOR_JUDGE_TIMEOUT");
});

test("a rate-limited judge records its reason and never sends a continuation", async (t) => {
  const { SupervisorJudgeClient } = await import("../src/runtime/supervisorJudgeClient.js");
  const client = new SupervisorJudgeClient({ensureFreshAccessTokenFn:async () => ({accessTokens:{ai:{token:"test"}}}),
    fetchFn:async () => ({ok:false,status:429})});
  const f = aiFixture(t, (request) => client.judge(request));
  f.event({type:"agent.task.started"});
  f.event({type:"agent.task.complete"});
  await f.advance(2000);
  assert.equal(f.sent().length, 0);
  assert.equal(f.events()[0].code, "SUPERVISOR_JUDGE_RATE_LIMITED");
  assert.equal(f.store.log()[0].code, "SUPERVISOR_JUDGE_RATE_LIMITED");
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

test("an AI verdict for an edited card cannot execute or notify", async (t) => {
  let release;
  const f = aiFixture(t, () => new Promise((resolve) => { release = resolve; }));
  f.event({ type: "agent.task.started" });
  f.event({ type: "agent.task.complete" });
  await f.advance(2000);
  const existing = f.store.cards()[0];
  f.store.setCards({ cards: [{ ...existing, action: { kind: "stop" } }] });
  release({ verdict: "needs_user", confidence: 0.99, reason: "old rule" });
  await f.advance(2000);
  assert.equal(f.escalations.length, 0);
  assert.equal(f.sent().length, 0);
  assert.equal(f.registry.commandsAfter(SESSION, 0).commands.filter((item) => item.type === "session.stop").length, 0);
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

test("the judge deadline includes token refresh and never starts a late model request", async () => {
  const { SupervisorJudgeClient } = await import("../src/runtime/supervisorJudgeClient.js");
  let release;
  const refresh = new Promise((resolve) => { release = resolve; });
  let fetchCalls = 0;
  const client = new SupervisorJudgeClient({timeoutMs:20, ensureFreshAccessTokenFn:() => refresh,
    fetchFn:async () => { fetchCalls++; throw new Error("must not be called"); }});
  const pending = client.judge({snapshot:{checkpoint:"loop"}});
  await assert.rejects(pending, {code:"SUPERVISOR_JUDGE_TIMEOUT"});
  release({accessTokens:{ai:{token:"test"}}});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls,0);
});

test("a delayed credential lock cannot start token refresh after the deadline", async () => {
  const { SupervisorJudgeClient } = await import("../src/runtime/supervisorJudgeClient.js");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let fetchCalls = 0;
  const client = new SupervisorJudgeClient({timeoutMs:20,
    ensureFreshAccessTokenFn:async ({fetchFn}) => { await gate; await fetchFn("https://auth.test", {}); },
    fetchFn:async () => { fetchCalls++; }});
  await assert.rejects(client.judge({snapshot:{checkpoint:"loop"}}), {code:"SUPERVISOR_JUDGE_TIMEOUT"});
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls,0);
});

test("the judge deadline bounds an unresponsive response body", async () => {
  const { SupervisorJudgeClient } = await import("../src/runtime/supervisorJudgeClient.js");
  let signal;
  const client = new SupervisorJudgeClient({timeoutMs:20,
    ensureFreshAccessTokenFn:async () => ({accessTokens:{ai:{token:"test"}}}),
    fetchFn:async (_url, options) => { signal = options.signal; return {ok:true,json:() => new Promise(() => {})}; }});
  await assert.rejects(client.judge({snapshot:{checkpoint:"loop"}}), {code:"SUPERVISOR_JUDGE_TIMEOUT"});
  assert.equal(signal.aborted,true);
});

test("expired device login is reported as authentication required", async () => {
  const { SupervisorJudgeClient } = await import("../src/runtime/supervisorJudgeClient.js");
  const expired = new SupervisorJudgeClient({ensureFreshAccessTokenFn:async () => {
    throw Object.assign(new Error("expired"), {code:"OAUTH_REFRESH_EXPIRED"});
  }});
  await assert.rejects(expired.judge({snapshot:{checkpoint:"loop"}}), {code:"SUPERVISOR_JUDGE_AUTH_REQUIRED"});
  const rejected = new SupervisorJudgeClient({ensureFreshAccessTokenFn:async () => ({accessTokens:{ai:{token:"test"}}}),
    fetchFn:async () => ({ok:false,status:401})});
  await assert.rejects(rejected.judge({snapshot:{checkpoint:"loop"}}), {code:"SUPERVISOR_JUDGE_AUTH_REQUIRED"});
});

test("the judge client distinguishes rate limiting and temporary unavailability", async () => {
  const { SupervisorJudgeClient } = await import("../src/runtime/supervisorJudgeClient.js");
  for (const [status, code] of [[429, "SUPERVISOR_JUDGE_RATE_LIMITED"], [503, "SUPERVISOR_JUDGE_UNAVAILABLE"]]) {
    const client = new SupervisorJudgeClient({ensureFreshAccessTokenFn:async () => ({accessTokens:{ai:{token:"test"}}}),
      fetchFn:async () => ({ok:false,status})});
    await assert.rejects(client.judge({snapshot:{checkpoint:"loop"}}), {code});
  }
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
