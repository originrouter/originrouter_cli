import { randomUUID } from "node:crypto";

import { canonicalTurnEventType } from "../local/externalAgentRegistry.js";
import {
  cardMatchesSession,
  classifyTurnError,
  isUserInterrupt,
  judgeBuiltin,
} from "./runtimeTaskRules.js";

// How long a turn's end is left to settle before it is judged. The SDK's
// result can land before the turn's last text block, and the PTY transcript
// is scanned after the Stop hook fires; judging at once would read a reply
// that has not arrived yet.
const SETTLE_MS = 1500;
const LAST_REPLY_LIMIT = 4000;
const SUPERVISOR_EVENT_PREFIX = "agent.supervisor.";

function text(value, max) {
  return String(value ?? "").slice(0, max);
}

function hasTurnError(event) {
  return event?.isError === true
    || event?.status === "error"
    || event?.status === "failed"
    || (typeof event?.error === "string" && event.error.trim() !== "");
}

// The runtime supervisor: watches the registry's sessions and applies the
// account's runtime-task cards at three checkpoints — a turn that ended, a
// turn that ended in error, and a turn that has gone quiet.
//
// Rules that hold whatever the cards say:
//   1. An interrupt or a stop suspends the session until a turn starts that
//      the supervisor did not start. It never recovers from an interrupt.
//   2. Nothing happens while the session waits for an approval or an answer.
//   3. Every action is re-checked against the live session right before it
//      runs, after any wait; a new turn in between cancels it.
//   4. Each card fires at most `maxFires` times per session; a user's turn
//      resets the count, and so does a clean end for the retry rule.
//   5. One checkpoint runs at most one card — the first that matches.
//   6. Every action leaves an `agent.supervisor.*` event on the session.
//   7. A message it sends says so (`origin: "supervisor"`).
export class RuntimeSupervisor {
  constructor({
    registry,
    store,
    judge = null,
    onEscalated = null,
    now = () => Date.now(),
    settleMs = SETTLE_MS,
    log = console,
  } = {}) {
    this.registry = registry;
    this.store = store;
    // `judge({ judgeId, runtime, snapshot, instruction })` → { verdict, ... }.
    // Without one, AI cards do not take part.
    this.judge = judge;
    // Told about every escalation, so it can reach the user's phone.
    this.onEscalated = onEscalated;
    this.now = now;
    this.settleMs = settleMs;
    this.log = log;
    this.sessions = new Map();
    this.unsubscribe = null;
  }

  start() {
    if (this.unsubscribe) return this;
    this.unsubscribe = this.registry.subscribe((notification) => {
      try {
        this.onNotification(notification);
      } catch (error) {
        this.log.error?.(`[runtime-supervisor] ${error.message}`);
      }
    });
    return this;
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const sessionId of [...this.sessions.keys()]) this.forget(sessionId);
  }

  // The cards changed: idle timers were sized from the old list.
  cardsChanged() {
    for (const sessionId of this.sessions.keys()) this.scheduleIdle(sessionId);
  }

  state(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        epoch: 0,
        // Whether a turn is open. A turn's end can be reported twice (a hook
        // and the transcript scanner); only the first one is a checkpoint.
        // A session first seen mid-turn counts as open.
        turnOpen: true,
        suspended: false,
        ownTurn: false,
        ownMessageId: null,
        fires: new Map(),
        lastText: "",
        textSeen: false,
        hint: {},
        lastEventAtMs: this.now(),
        pendingTimer: null,
        idleTimer: null,
        idleFired: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  forget(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    clearTimeout(state.pendingTimer);
    clearTimeout(state.idleTimer);
    this.sessions.delete(sessionId);
  }

  cancelPending(state) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }

  onNotification({ type, sessionId, payload }) {
    if (!sessionId) return;
    // A detached session (unregistered, or expired as stale) has no process
    // left to act on; its timers would only fire into a guard that refuses.
    if (type === "unregistered" || (type === "updated" && payload?.attached === false)) {
      return this.forget(sessionId);
    }
    if (type === "command") {
      if (payload?.type === "terminal.interrupt" || payload?.type === "session.stop") {
        const state = this.state(sessionId);
        state.suspended = true;
        state.ownTurn = false;
        this.cancelPending(state);
      }
      return;
    }
    if (type === "event") this.onEvent(sessionId, payload || {});
  }

  onEvent(sessionId, event) {
    const rawType = String(event.type || "");
    if (rawType.startsWith(SUPERVISOR_EVENT_PREFIX)) return;
    // Collaboration workers belong to their run; its coordinator decides
    // when they continue.
    if (this.registry.isCollaborationSession?.(sessionId)) return;
    const state = this.state(sessionId);
    state.lastEventAtMs = this.now();
    state.idleFired.clear();

    const type = canonicalTurnEventType(rawType);
    if (type === "agent.adapter.status") {
      if (event.state === "assistant_error") {
        state.hint.assistantError = text(event.metadata?.error, 64);
      } else if (event.state === "rate_limit_rejected") {
        state.hint.rateLimitResetsAt = Number(event.metadata?.resetsAt) || null;
      }
    } else if (type === "agent.message.result") {
      // The runtime refused the supervisor's message, so no turn of ours is
      // coming; the next turn to start is someone else's.
      if (event.accepted === false && state.ownMessageId && event.messageId === state.ownMessageId) {
        state.ownTurn = false;
        state.ownMessageId = null;
      }
    } else if (type === "agent.text") {
      if (!event.parentToolUseId && !event.delegationId) {
        const value = String(event.text || "").trim();
        if (value) {
          state.lastText = value.slice(-LAST_REPLY_LIMIT);
          state.textSeen = true;
        }
      }
    } else if (type === "agent.task.started") {
      this.onTurnStarted(sessionId, state);
    } else if (type === "agent.task.complete") {
      this.onCheckpoint(sessionId, state, hasTurnError(event) ? "abnormal_stop" : "turn_ended", event);
    } else if (type === "agent.task.failed") {
      // The same type also reports a command the wrapper failed to apply;
      // that is not the end of a turn.
      if (!event.commandType) this.onTurnEnded(sessionId, state, event, { failed: true });
    } else if (type === "agent.task.aborted") {
      this.onTurnEnded(sessionId, state, event, { failed: hasTurnError(event) });
    }
    this.scheduleIdle(sessionId);
  }

  onTurnStarted(sessionId, state) {
    // The wrapper may say "started" twice for one send (once when it queues
    // the message, once when the runtime opens the turn). Everything until
    // the next checkpoint counts as the turn the supervisor asked for.
    if (!state.ownTurn) {
      state.suspended = false;
      state.fires.clear();
    }
    state.turnOpen = true;
    state.epoch += 1;
    state.lastText = "";
    state.textSeen = false;
    state.hint = {};
    this.cancelPending(state);
  }

  onTurnEnded(sessionId, state, event, { failed }) {
    if (isUserInterrupt(event) || !failed) {
      state.turnOpen = false;
      state.suspended = true;
      state.ownTurn = false;
      state.ownMessageId = null;
      state.epoch += 1;
      this.cancelPending(state);
      return;
    }
    this.onCheckpoint(sessionId, state, "abnormal_stop", event);
  }

  onCheckpoint(sessionId, state, checkpoint, event) {
    if (!state.turnOpen) return;
    state.turnOpen = false;
    state.ownTurn = false;
    state.ownMessageId = null;
    state.epoch += 1;
    this.cancelPending(state);
    if (checkpoint === "turn_ended") {
      // A clean end means the last failure was recovered from; the next one
      // gets the full retry budget again.
      for (const card of this.store.cards()) {
        if (card.judge.kind === "builtin" && card.judge.rule === "retryable_error") state.fires.delete(card.id);
      }
    }
    if (state.suspended) return;
    const epoch = state.epoch;
    const ended = {
      checkpoint,
      stopReason: text(event.stopReason, 64),
      result: typeof event.result === "string" ? event.result : null,
      error: checkpoint === "abnormal_stop" ? classifyTurnError(event, state.hint, this.now()) : null,
    };
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      this.evaluate(sessionId, epoch, ended);
    }, this.settleMs);
    state.pendingTimer.unref?.();
  }

  snapshot(sessionId, state, ended, facts) {
    const reply = ended.result && ended.result.trim() ? ended.result.trim() : state.lastText;
    return {
      sessionId,
      agent: facts.agent,
      checkpoint: ended.checkpoint,
      endReason: ended.checkpoint === "idle"
        ? "idle"
        : ended.checkpoint === "abnormal_stop"
          ? "error"
          : ended.stopReason === "max_tokens" ? "max_tokens" : "completed",
      error: ended.error,
      lastReply: reply.slice(-LAST_REPLY_LIMIT),
      // Only a runtime that states its final text can say a reply was empty;
      // for the others an absent text is unknown, not empty.
      lastReplyEmpty: ended.checkpoint === "turn_ended" && ended.result !== null
        && !ended.result.trim() && !state.textSeen,
      idleSeconds: Math.floor((this.now() - state.lastEventAtMs) / 1000),
    };
  }

  // Whether the live session still allows acting at this checkpoint.
  factsAllow(facts, checkpoint) {
    if (!facts || facts.sessionKind === "collaboration" || !facts.attached) return false;
    if (facts.status !== "running" || facts.pendingInteractions > 0) return false;
    return checkpoint === "idle" ? facts.turnState === "running" : facts.turnState === "idle";
  }

  matchingCards(facts, checkpoint) {
    return this.store.cards().filter((card) => card.enabled
      && card.checkpoints.includes(checkpoint)
      && cardMatchesSession(card, facts));
  }

  evaluate(sessionId, epoch, ended) {
    const state = this.sessions.get(sessionId);
    if (!state || state.epoch !== epoch || state.suspended) return;
    const facts = this.registry.sessionFacts(sessionId);
    if (!this.factsAllow(facts, ended.checkpoint)) return;
    const snapshot = this.snapshot(sessionId, state, ended, facts);
    this.runCards(sessionId, this.matchingCards(facts, ended.checkpoint), snapshot, {
      epoch,
      // Nothing may have moved the session while a judge was thinking.
      current: () => {
        const live = this.sessions.get(sessionId);
        return live === state && live.epoch === epoch && !live.suspended
          && this.factsAllow(this.registry.sessionFacts(sessionId), ended.checkpoint);
      },
    }).catch((error) => this.log.error?.(`[runtime-supervisor] ${error.message}`));
  }

  // Rule 5: the first card that matches owns the checkpoint, whatever it then
  // does. An AI card is asked in turn, so a later card never runs because an
  // earlier one's judge was slow.
  async runCards(sessionId, cards, snapshot, { epoch, current }) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const card of cards) {
      const fire = state.fires.get(card.id) || { count: 0, lastAtMs: 0, exhaustedNotified: false };
      const exhausted = fire.count >= card.limits.maxFires;
      let verdict;
      if (card.judge.kind === "builtin") {
        verdict = judgeBuiltin(card.judge.rule, snapshot, { attempt: fire.count });
      } else {
        // An exhausted card is not worth a judgement unless the user still
        // has to hear that it gave up.
        if (!this.judge || (exhausted && (card.limits.onExhausted !== "notify" || fire.exhaustedNotified))) continue;
        let judgement;
        try {
          judgement = await this.judge({
            judgeId: `sj_${sessionId}_${epoch}_${card.id}`,
            runtime: snapshot.agent,
            snapshot,
            instruction: card.judge.instruction,
          });
        } catch (error) {
          if (current()) {
            this.emit(sessionId, "agent.supervisor.diagnostic", card, snapshot, {
              code: String(error?.code || "SUPERVISOR_JUDGE_FAILED").slice(0, 64),
              summary: `Runtime task "${card.name}" could not be judged`,
            });
          }
          continue;
        }
        if (!current()) return;
        if (judgement.verdict === "needs_user") {
          // Counted, so a session that keeps asking the same thing does not
          // turn into one notification per turn.
          if (exhausted) continue;
          fire.count += 1;
          fire.lastAtMs = this.now();
          state.fires.set(card.id, fire);
          this.emit(sessionId, "agent.supervisor.escalated", card, snapshot, {
            reason: "needs_user",
            judge: "ai",
            judgeReason: judgement.reason,
            attempt: fire.count,
            maxFires: card.limits.maxFires,
            summary: `Runtime task "${card.name}" needs your decision`,
          });
          return;
        }
        verdict = { match: judgement.verdict === "act", waitSeconds: 0, reason: judgement.reason };
      }
      if (!verdict.match) continue;
      if (exhausted) {
        if (card.limits.onExhausted === "notify" && !fire.exhaustedNotified) {
          fire.exhaustedNotified = true;
          state.fires.set(card.id, fire);
          this.emit(sessionId, "agent.supervisor.escalated", card, snapshot, {
            reason: "limit_reached",
            summary: `Runtime task "${card.name}" stopped after ${fire.count} attempts`,
          });
        }
        return;
      }
      const via = { judge: card.judge.kind, reason: verdict.reason };
      const cooldownLeft = fire.lastAtMs
        ? Math.max(0, card.limits.cooldownSeconds * 1000 - (this.now() - fire.lastAtMs))
        : 0;
      const delayMs = Math.max((verdict.waitSeconds || 0) * 1000, cooldownLeft);
      if (delayMs > 0) {
        this.emit(sessionId, "agent.supervisor.waiting", card, snapshot, {
          waitSeconds: Math.ceil(delayMs / 1000),
          attempt: fire.count + 1,
          maxFires: card.limits.maxFires,
          summary: `Runtime task "${card.name}" will act in ${Math.ceil(delayMs / 1000)}s`,
        });
        clearTimeout(state.pendingTimer);
        state.pendingTimer = setTimeout(() => {
          state.pendingTimer = null;
          this.execute(sessionId, epoch, card.id, snapshot, via);
        }, delayMs);
        state.pendingTimer.unref?.();
      } else {
        this.execute(sessionId, epoch, card.id, snapshot, via);
      }
      return;
    }
  }

  // Rule 3: everything is checked again, because a wait may have passed and
  // the user, the runtime or another card may have moved the session on.
  execute(sessionId, epoch, cardId, snapshot, via = { judge: "builtin" }) {
    const state = this.sessions.get(sessionId);
    if (!state || state.epoch !== epoch || state.suspended) return;
    const facts = this.registry.sessionFacts(sessionId);
    if (!this.factsAllow(facts, snapshot.checkpoint)) return;
    const card = this.store.cards().find((item) => item.id === cardId);
    if (!card || !card.enabled || !card.checkpoints.includes(snapshot.checkpoint)
      || !cardMatchesSession(card, facts)) return;
    const fire = state.fires.get(card.id) || { count: 0, lastAtMs: 0, exhaustedNotified: false };
    if (fire.count >= card.limits.maxFires) return;
    fire.count += 1;
    fire.lastAtMs = this.now();
    state.fires.set(card.id, fire);
    const progress = { attempt: fire.count, maxFires: card.limits.maxFires };

    if (card.action.kind === "send") {
      const messageId = `supervisor_${randomUUID()}`;
      try {
        this.registry.enqueueCommand(sessionId, {
          type: "agent.message",
          sessionId,
          message: card.action.message,
          messageId,
          origin: "supervisor",
        });
      } catch (error) {
        this.log.error?.(`[runtime-supervisor] send to ${sessionId}: ${error.message}`);
        return;
      }
      state.ownTurn = true;
      state.ownMessageId = messageId;
      this.emit(sessionId, "agent.supervisor.acted", card, snapshot, {
        action: "send",
        judge: via.judge,
        ...(via.reason ? { judgeReason: via.reason } : {}),
        ...progress,
        summary: `Runtime task "${card.name}" sent a message`,
      });
      return;
    }
    if (card.action.kind === "stop") {
      try {
        this.registry.enqueueCommand(sessionId, { type: "session.stop", sessionId, reason: "runtime_task" });
      } catch (error) {
        this.log.error?.(`[runtime-supervisor] stop ${sessionId}: ${error.message}`);
        return;
      }
      this.emit(sessionId, "agent.supervisor.acted", card, snapshot, {
        action: "stop",
        judge: via.judge,
        ...(via.reason ? { judgeReason: via.reason } : {}),
        ...progress,
        summary: `Runtime task "${card.name}" stopped the session`,
      });
      return;
    }
    this.emit(sessionId, "agent.supervisor.escalated", card, snapshot, {
      reason: "card_action",
      judge: via.judge,
      ...(via.reason ? { judgeReason: via.reason } : {}),
      ...progress,
      summary: `Runtime task "${card.name}" needs your attention`,
    });
  }

  // One timer per session, for the nearest idle threshold not yet passed in
  // this quiet stretch. Any event clears `idleFired` and re-arms it.
  scheduleIdle(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
    if (state.suspended) return;
    const facts = this.registry.sessionFacts(sessionId);
    if (!facts || facts.sessionKind === "collaboration") return;
    const thresholds = this.matchingCards(facts, "idle")
      .filter((card) => !state.idleFired.has(card.id))
      .map((card) => card.idleMinutes * 60_000);
    if (thresholds.length === 0) return;
    const dueMs = Math.max(0, state.lastEventAtMs + Math.min(...thresholds) - this.now());
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
      this.onIdle(sessionId);
    }, dueMs);
    state.idleTimer.unref?.();
  }

  onIdle(sessionId) {
    const state = this.sessions.get(sessionId);
    if (!state || state.suspended) return;
    const facts = this.registry.sessionFacts(sessionId);
    // Not running a turn (or waiting on the user): quiet is expected. The
    // next event re-arms the timer; re-arming here would spin, since the
    // threshold has already passed.
    if (!this.factsAllow(facts, "idle")) return;
    const quietMs = this.now() - state.lastEventAtMs;
    const due = this.matchingCards(facts, "idle")
      .filter((card) => !state.idleFired.has(card.id) && quietMs >= card.idleMinutes * 60_000);
    for (const card of due) state.idleFired.add(card.id);
    if (due.length > 0) this.evaluateIdle(sessionId, state, due, facts);
    this.scheduleIdle(sessionId);
  }

  evaluateIdle(sessionId, state, due, facts) {
    const snapshot = this.snapshot(sessionId, state, { checkpoint: "idle", result: null, error: null }, facts);
    const quietSince = state.lastEventAtMs;
    this.runCards(sessionId, due, snapshot, {
      epoch: state.epoch,
      current: () => {
        const live = this.sessions.get(sessionId);
        return live === state && !live.suspended && live.lastEventAtMs === quietSince
          && this.factsAllow(this.registry.sessionFacts(sessionId), "idle");
      },
    }).catch((error) => this.log.error?.(`[runtime-supervisor] ${error.message}`));
  }

  // Rule 6. Appended on the next tick: this runs inside a registry
  // notification, and the registry's listeners should not see a second event
  // before every one of them has seen the first.
  emit(sessionId, type, card, snapshot, fields) {
    const event = {
      type,
      provider: "originrouter",
      eventId: `${type}_${randomUUID()}`,
      cardId: card.id,
      cardName: card.name,
      checkpoint: snapshot.checkpoint,
      ...(snapshot.error ? { errorClass: snapshot.error.class } : {}),
      ...fields,
    };
    queueMicrotask(() => {
      try {
        this.registry.appendEvent(sessionId, event);
      } catch {
        // The session left in the meantime; the log below still records it.
      }
      if (type === "agent.supervisor.escalated") {
        Promise.resolve(this.onEscalated?.({ sessionId, eventId: event.eventId, reason: event.reason }))
          .catch((error) => this.log.error?.(`[runtime-supervisor] escalation: ${error.message}`));
      }
      try {
        this.store.appendLog({
          ...event,
          sessionId,
          createdAt: new Date(this.now()).toISOString(),
        });
      } catch (error) {
        this.log.error?.(`[runtime-supervisor] log: ${error.message}`);
      }
    });
  }
}
