import { createHash, randomUUID } from "node:crypto";

import { RuntimeLoopDetector, detectRepeatedOutput } from "./runtimeLoopDetector.js";

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

function sameRepeatedCycle(left, right) {
  const primitive = (value) => {
    for (let size = 1; size <= value.length; size += 1) {
      if (value.length % size === 0 && value.slice(0, size).repeat(value.length / size) === value) return value.slice(0, size);
    }
    return value;
  };
  const a = primitive(left), b = primitive(right);
  return a.length === b.length && (a + a).includes(b);
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
    // A daemon restart owns account changes. Do not let its old sessions
    // read or mutate a newly activated account during the restart window.
    this.accountDir = store?.dir?.();
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

  accountCurrent() {
    return this.accountDir == null || this.store.dir?.() === this.accountDir;
  }

  // The cards changed: idle timers were sized from the old list.
  cardsChanged() {
    for (const sessionId of this.sessions.keys()) this.scheduleIdle(sessionId);
  }

  state(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      let userStopGuard = false;
      try {
        const durable = this.store.recoveryFor?.(sessionId);
        userStopGuard = durable?.userStopped === true || durable?.pending === true;
      }
      catch (error) {
        // If durable supervision state cannot be read, don't infer that an
        // earlier user stop was cleared.
        userStopGuard = true;
        this.log.error?.(`[runtime-supervisor] stop state: ${error.message}`);
      }
      state = {
        epoch: 0,
        // Whether a turn is open. A turn's end can be reported twice (a hook
        // and the transcript scanner); only the first one is a checkpoint.
        // A session first seen mid-turn counts as open.
        turnOpen: true,
        suspended: userStopGuard,
        userStopGuard,
        resumeMessageId: null,
        resumeStart: null,
        ownTurn: false,
        ownMessageId: null,
        fires: new Map(),
        lastText: "",
        turnToken: null,
        recovery: null,
        streamObserved: false,
        lastObservationSequence: null,
        loopDetector: new RuntimeLoopDetector(),
        loopEvidenceVersion: 0,
        loopEvidenceUnit: null,
        loopLastCheck: 0,
        loopChecking: false,
        loopRetryTimer: null,
        processing: 0,
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
    clearTimeout(state.recovery?.timer);
    clearTimeout(state.loopRetryTimer);
    this.sessions.delete(sessionId);
  }

  cancelPending(state) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = null;
  }

  onNotification({ type, sessionId, payload }) {
    if (!sessionId) return;
    if (!this.accountCurrent()) { this.stop(); return; }
    // A detached session (unregistered, or expired as stale) has no process
    // left to act on; its timers would only fire into a guard that refuses.
    if (type === "unregistered" || (type === "updated" && payload?.attached === false)) {
      if (type === "unregistered" && ["completed", "stopped", "cancelled", "failed", "error"].includes(payload?.status)) {
        try { this.store.clearFinishedStop?.(sessionId); }
        catch (error) { this.log.error?.(`[runtime-supervisor] stop cleanup: ${error.message}`); }
      }
      return this.forget(sessionId);
    }
    if (type === "command") {
      if (payload?.type === "terminal.interrupt" || payload?.type === "session.stop") {
        const state = this.state(sessionId);
        this.cancelRecovery(sessionId, state, "user_stopped", false);
        state.suspended = true;
        state.userStopGuard = true;
        state.resumeMessageId = null;
        state.resumeStart = null;
        try { this.store.markUserStopped?.(sessionId); }
        catch (error) { this.log.error?.(`[runtime-supervisor] stop state: ${error.message}`); }
        state.ownTurn = false;
        this.cancelPending(state);
      } else if (["agent.message", "terminal.input"].includes(payload?.type) && payload.origin !== "supervisor") {
        const state = this.state(sessionId);
        // A user taking over an unconfirmed recovery must itself be accepted
        // before that durable uncertainty can be cleared.
        if (state.recovery) {
          state.userStopGuard = true;
          state.suspended = true;
        }
        if (state.userStopGuard) {
          state.resumeMessageId = String(payload.messageId || payload.commandId || "") || null;
          state.resumeStart = null;
        }
        this.cancelRecovery(sessionId, state, "user_resumed", false);
        if (!state.userStopGuard) {
          try { this.store.clearRecovery?.(sessionId); }
          catch (error) { this.log.error?.(`[runtime-supervisor] recovery reset: ${error.message}`); }
        }
      }
      return;
    }
    if (type === "recovery_result") return this.onRecoveryResult(sessionId, payload || {});
    if (type === "observation") return this.onObservation(sessionId, payload || {});
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
    if (state.recovery && ["agent.interaction.requested", "approval_requested", "interaction_requested"].includes(type)) {
      this.cancelRecovery(sessionId, state, "interaction_requested", true);
    }
    if (type === "agent.adapter.status") {
      if (event.state === "assistant_error") {
        state.hint.assistantError = text(event.metadata?.error, 64);
      } else if (event.state === "rate_limit_rejected") {
        state.hint.rateLimitResetsAt = Number(event.metadata?.resetsAt) || null;
      }
    } else if (type === "agent.message.result") {
      if (state.userStopGuard && state.resumeMessageId && event.messageId === state.resumeMessageId) {
        if (event.accepted === true) this.confirmUserResume(sessionId, state);
        else if (event.accepted === false) {
          state.resumeMessageId = null;
          state.resumeStart = null;
        }
      }
      if (state.recovery?.phase === "sending" && event.messageId === state.recovery.messageId) {
        this.onRecoveryMessageResult(sessionId, state, event);
      }
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
          // A full message may repeat the stream already inspected. Only use
          // it as a fallback when this turn had no streaming observations.
          if (!state.streamObserved) this.observeOutput(sessionId, state, event.text);
        }
      }
    } else if (type === "agent.task.started") {
      this.onTurnStarted(sessionId, state, event);
    } else if (type === "agent.task.complete") {
      if (state.recovery?.phase === "interrupt") this.cancelRecovery(sessionId, state, "turn_ended_before_interrupt", true);
      this.onCheckpoint(sessionId, state, hasTurnError(event) ? "abnormal_stop" : "turn_ended", event);
    } else if (type === "agent.task.failed") {
      // The same type also reports a command the wrapper failed to apply;
      // that is not the end of a turn.
      if (!event.commandType && !this.observeRecoveryAbort(sessionId, state, event, type)) {
        this.onTurnEnded(sessionId, state, event, { failed: true });
      }
    } else if (type === "agent.task.aborted") {
      if (!this.observeRecoveryAbort(sessionId, state, event, type)) {
        this.onTurnEnded(sessionId, state, event, { failed: hasTurnError(event) });
      }
    }
    this.scheduleIdle(sessionId);
  }

  onTurnStarted(sessionId, state, event) {
    if (state.userStopGuard) {
      const turnId = String(event.supervisorTurnId || event.id || "");
      if (state.resumeMessageId && turnId === state.resumeMessageId) state.resumeStart = event;
      return;
    }
    if (state.recovery?.phase === "interrupt") {
      this.cancelRecovery(sessionId, state, "new_turn_before_interrupt", true);
    }
    // The wrapper may say "started" twice for one send (once when it queues
    // the message, once when the runtime opens the turn). Everything until
    // the next checkpoint counts as the turn the supervisor asked for.
    if (!state.ownTurn) {
      state.suspended = false;
      state.fires.clear();
    }
    state.turnOpen = true;
    state.turnToken = String(event.supervisorTurnId || event.id || "");
    state.streamObserved = false;
    state.lastObservationSequence = null;
    state.epoch += 1;
    state.lastText = "";
    state.loopDetector.reset();
    state.loopEvidenceVersion += 1;
    state.loopEvidenceUnit = null;
    state.loopLastCheck = 0;
    state.loopChecking = false;
    clearTimeout(state.loopRetryTimer);
    state.loopRetryTimer = null;
    state.textSeen = false;
    state.hint = {};
    this.cancelPending(state);
  }

  confirmUserResume(sessionId, state) {
    const start = state.resumeStart || {id: state.resumeMessageId};
    try { this.store.clearRecovery?.(sessionId); }
    catch (error) {
      this.log.error?.(`[runtime-supervisor] recovery reset: ${error.message}`);
      return;
    }
    state.userStopGuard = false;
    state.resumeMessageId = null;
    state.resumeStart = null;
    this.onTurnStarted(sessionId, state, start);
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
      endReason: ended.checkpoint === "loop"
        ? "loop"
        : ended.checkpoint === "idle"
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
    return checkpoint === "idle" || checkpoint === "loop" ? facts.turnState === "running" : facts.turnState === "idle";
  }

  matchingCards(facts, checkpoint) {
    return this.store.cards().filter((card) => card.enabled
      && card.checkpoints.includes(checkpoint)
      && cardMatchesSession(card, facts));
  }

  evaluate(sessionId, epoch, ended) {
    if (!this.accountCurrent()) { this.stop(); return; }
    const state = this.sessions.get(sessionId);
    if (!state || state.epoch !== epoch || state.suspended) return;
    const facts = this.registry.sessionFacts(sessionId);
    if (!this.factsAllow(facts, ended.checkpoint)) return;
    const snapshot = this.snapshot(sessionId, state, ended, facts);
    state.processing += 1;
    this.runCards(sessionId, this.matchingCards(facts, ended.checkpoint), snapshot, {
      epoch,
      // Nothing may have moved the session while a judge was thinking.
      current: () => {
        const live = this.sessions.get(sessionId);
        return live === state && live.epoch === epoch && !live.suspended
          && this.factsAllow(this.registry.sessionFacts(sessionId), ended.checkpoint);
      },
    }).catch((error) => this.log.error?.(`[runtime-supervisor] ${error.message}`))
      .finally(() => { state.processing = Math.max(0, state.processing - 1); });
  }

  hasPendingWork(sessionId) {
    const state = this.sessions.get(sessionId);
    return Boolean(state && (state.pendingTimer || state.processing || state.ownTurn || state.recovery));
  }

  // Rule 5: the first card that matches owns the checkpoint, whatever it then
  // does. An AI card is asked in turn, so a later card never runs because an
  // earlier one's judge was slow.
  async runCards(sessionId, cards, snapshot, { epoch, current }) {
    if (!this.accountCurrent()) { this.stop(); return; }
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const accountDir = this.store.dir?.();
    for (const card of cards) {
      // A delayed verdict belongs to the exact card and account that were
      // evaluated. Applying it to an edited card could perform a different
      // action from the one the judge approved.
      const originalCard = JSON.stringify(card);
      const actionCurrent = () => this.accountCurrent() && current()
        && this.store.dir?.() === accountDir
        && JSON.stringify(this.store.cards().find((item) => item.id === card.id)) === originalCard;
      if (!actionCurrent()) return;
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
          if (actionCurrent()) {
            this.emit(sessionId, "agent.supervisor.diagnostic", card, snapshot, {
              code: String(error?.code || "SUPERVISOR_JUDGE_FAILED").slice(0, 64),
              summary: `Runtime task "${card.name}" could not be judged`,
            });
          }
          // An unavailable judgement is not a negative verdict. Do not let a
          // later rule act on the same checkpoint without that decision.
          return;
        }
        if (!actionCurrent()) return;
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
      if (!actionCurrent()) return;
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
          if (actionCurrent()) this.execute(sessionId, epoch, card.id, snapshot, via);
        }, delayMs);
        state.pendingTimer.unref?.();
      } else if (actionCurrent()) {
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

    if (card.action.kind === "interrupt_and_continue") {
      this.startRecovery(sessionId, state, card, snapshot, via, progress, facts);
      return;
    }
    if (card.action.kind === "send") {
      this.startDelivery(sessionId, state, card, snapshot, via, progress, facts);
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
        summary: `Runtime task "${card.name}" requested the session to stop`,
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

  // A queued message is not a delivered message. Persist the intent before
  // enqueueing, then wait for the wrapper's matching acceptance receipt.
  startDelivery(sessionId, state, card, snapshot, via, progress, facts) {
    if (state.recovery || !facts.supportsRuntimeRecovery
      || !["claude-sdk", "codex-app-server", "agy-acp"].includes(facts.runtime)) {
      this.emit(sessionId, "agent.supervisor.escalated", card, snapshot, {
        reason:"needs_user", code:"RUNTIME_CONFIRMATION_UNAVAILABLE", summary:"This runtime cannot confirm an automatic continuation",
      });
      return;
    }
    try { this.store.beginDelivery(sessionId); }
    catch (error) {
      this.emit(sessionId, "agent.supervisor.escalated", card, snapshot, {
        reason:"needs_user", code:String(error.code || "RECOVERY_STATE_UNAVAILABLE"),
        summary:"Automatic continuation is unavailable or needs user attention",
      });
      return;
    }
    const recovery = {phase:"sending", action:"send", epoch:state.epoch,
      accountDir:this.store.dir?.(), card, snapshot, via, progress,
      messageId:`supervisor_${randomUUID()}`, timer:null};
    state.recovery = recovery;
    state.ownTurn = true;
    state.ownMessageId = recovery.messageId;
    recovery.timer = setTimeout(() => {
      if (state.recovery === recovery) this.cancelRecovery(sessionId, state, "message_timeout", true);
    }, 30_000);
    recovery.timer.unref?.();
    try {
      this.registry.enqueueCommand(sessionId, {type:"agent.message", sessionId,
        message:card.action.message, messageId:recovery.messageId, origin:"supervisor"});
    } catch { this.cancelRecovery(sessionId, state, "message_enqueue_failed", true); }
  }

  // Do not start another recovery until the runtime confirms both its
  // interrupt request and the end of the exact turn. The intent is durable
  // before the command is enqueued; an uncertain outcome stays blocked.
  startRecovery(sessionId, state, card, snapshot, via, progress, facts) {
    if (state.recovery || !state.turnToken || !facts.supportsRuntimeRecovery
      || !["claude-sdk", "codex-app-server", "agy-acp"].includes(facts.runtime)) {
      this.emit(sessionId, "agent.supervisor.escalated", card, snapshot, {
        reason: "needs_user", code: "RUNTIME_CONFIRMATION_UNAVAILABLE", summary: "This runtime cannot confirm an automatic recovery",
      });
      return;
    }
    try {
      this.store.beginRecovery(sessionId, card.id, card.limits.maxFires);
    } catch (error) {
      this.emit(sessionId, "agent.supervisor.escalated", card, snapshot, {
        reason: error.code === "RECOVERY_LIMIT" ? "limit_reached" : "needs_user",
        code: String(error.code || "RECOVERY_STATE_UNAVAILABLE"),
        summary: "Automatic recovery is unavailable or needs user attention",
      });
      return;
    }
    const recovery = {
      phase: "interrupt", requestId: `recovery_${randomUUID()}`,
      turnId: state.turnToken, epoch: state.epoch, accountDir: this.store.dir?.(),
      card, cardJson: JSON.stringify(card), snapshot, via, progress,
      acknowledged: false, aborted: false, timer: null, messageId: null,
    };
    state.recovery = recovery;
    recovery.timer = setTimeout(() => {
      if (state.recovery === recovery) this.cancelRecovery(sessionId, state, "interrupt_timeout", true);
    }, 30_000);
    recovery.timer.unref?.();
    try {
      this.registry.enqueueCommand(sessionId, {
        type: "agent.supervisor.interrupt", sessionId,
        requestId: recovery.requestId, turnId: recovery.turnId,
      });
    } catch (error) {
      this.cancelRecovery(sessionId, state, "interrupt_enqueue_failed", true);
    }
  }

  cancelRecovery(sessionId, state, reason, notify) {
    const recovery = state.recovery;
    if (!recovery) return;
    clearTimeout(recovery.timer);
    state.recovery = null;
    state.ownTurn = false;
    state.ownMessageId = null;
    // The durable pending marker deliberately stays set. Only an accepted
    // user message resets it; after a timeout the device cannot know whether
    // the interrupted turn or a queued message actually ran.
    if (notify && this.store.dir?.() === recovery.accountDir) {
      state.suspended = true;
      state.userStopGuard = true;
      this.emit(sessionId, "agent.supervisor.escalated", recovery.card, recovery.snapshot, {
        reason: "needs_user", code: reason,
        summary: "Automatic recovery stopped because its result is uncertain",
      });
    }
  }

  onRecoveryResult(sessionId, result) {
    const state = this.sessions.get(sessionId);
    const recovery = state?.recovery;
    if (!recovery || recovery.phase !== "interrupt" || result.requestId !== recovery.requestId
      || result.turnId !== recovery.turnId) return;
    if (result.accepted !== true) return this.cancelRecovery(sessionId, state, "interrupt_rejected", true);
    recovery.acknowledged = true;
    this.resumeAfterInterrupt(sessionId, state, recovery);
  }

  observeRecoveryAbort(sessionId, state, event, type) {
    const recovery = state.recovery;
    if (!recovery || recovery.phase !== "interrupt") return false;
    if (!(isUserInterrupt(event) || (type === "agent.task.aborted" && !hasTurnError(event)))) return false;
    const endedTurn = String(event.supervisorTurnId || event.id || '');
    if (!endedTurn || endedTurn !== recovery.turnId) return false;
    recovery.aborted = true;
    state.turnOpen = false;
    this.resumeAfterInterrupt(sessionId, state, recovery);
    return true;
  }

  resumeAfterInterrupt(sessionId, state, recovery) {
    if (!recovery.acknowledged || !recovery.aborted || state.recovery !== recovery) return;
    const facts = this.registry.sessionFacts(sessionId);
    const currentCard = this.store.cards().find((card) => card.id === recovery.card.id);
    if (state.suspended || state.epoch !== recovery.epoch || state.turnToken !== recovery.turnId
      || this.store.dir?.() !== recovery.accountDir || JSON.stringify(currentCard) !== recovery.cardJson
      || !facts?.attached || facts.status !== "running" || facts.turnState !== "idle"
      || facts.pendingInteractions > 0) {
      return this.cancelRecovery(sessionId, state, "session_changed", true);
    }
    recovery.phase = "sending";
    recovery.messageId = `supervisor_${randomUUID()}`;
    state.ownTurn = true;
    state.ownMessageId = recovery.messageId;
    clearTimeout(recovery.timer);
    recovery.timer = setTimeout(() => {
      if (state.recovery === recovery) this.cancelRecovery(sessionId, state, "message_timeout", true);
    }, 30_000);
    recovery.timer.unref?.();
    try {
      this.registry.enqueueCommand(sessionId, {
        type: "agent.message", sessionId, message: recovery.card.action.message,
        messageId: recovery.messageId, origin: "supervisor",
      });
    } catch {
      this.cancelRecovery(sessionId, state, "message_enqueue_failed", true);
    }
  }

  onRecoveryMessageResult(sessionId, state, event) {
    const recovery = state.recovery;
    if (!recovery || recovery.phase !== "sending" || event.messageId !== recovery.messageId) return;
    if (event.accepted !== true) return this.cancelRecovery(sessionId, state, "message_rejected", true);
    if (this.store.dir?.() !== recovery.accountDir) return this.cancelRecovery(sessionId, state, "account_changed", false);
    try {
      this.store.finishRecovery(sessionId);
    } catch {
      return this.cancelRecovery(sessionId, state, "recovery_state_unavailable", true);
    }
    clearTimeout(recovery.timer);
    state.recovery = null;
    this.emit(sessionId, "agent.supervisor.acted", recovery.card, recovery.snapshot, {
      action: recovery.action || "interrupt_and_continue", judge: recovery.via.judge,
      messageId: recovery.messageId,
      messageDigest: createHash("sha256").update(recovery.card.action.message.trim()).digest("hex"),
      ...(recovery.via.reason ? { judgeReason: recovery.via.reason } : {}),
      ...recovery.progress, summary: recovery.action === "send"
        ? "Sent the automatic continuation" : "Interrupted the stuck turn and sent the recovery message",
    });
  }

  onObservation(sessionId, observation) {
    const state = this.sessions.get(sessionId);
    if (!state || !state.turnOpen || state.suspended || !state.turnToken
      || observation.turnId !== state.turnToken) return;
    const facts = this.registry.sessionFacts(sessionId);
    if (!this.factsAllow(facts, "loop")) return;
    const sequence = observation.sequence;
    if (Number.isSafeInteger(sequence) && sequence > 0) {
      if (state.lastObservationSequence != null && sequence <= state.lastObservationSequence) return;
      if (state.lastObservationSequence != null && sequence !== state.lastObservationSequence + 1) {
        state.loopDetector.reset();
        state.loopEvidenceVersion += 1;
        state.loopEvidenceUnit = null;
      }
      state.lastObservationSequence = sequence;
    } else {
      // Old wrappers did not include sequence numbers; avoid combining their
      // samples with a later sequenced stream.
      if (state.lastObservationSequence != null) {
        state.loopDetector.reset();
        state.loopEvidenceVersion += 1;
        state.loopEvidenceUnit = null;
      }
      state.lastObservationSequence = null;
    }
    state.lastEventAtMs = this.now();
    state.idleFired.clear();
    state.streamObserved = true;
    this.observeOutput(sessionId, state, observation.text);
    this.scheduleIdle(sessionId);
  }

  observeOutput(sessionId, state, text) {
    const facts = this.registry.sessionFacts(sessionId);
    if (!this.judge || !this.factsAllow(facts, "loop")
      || !this.matchingCards(facts, "loop").some((card) => card.judge.kind === "ai")) return;
    const candidate = state.loopDetector.add(text);
    if (candidate) {
      if (state.loopEvidenceUnit && !sameRepeatedCycle(state.loopEvidenceUnit, candidate.unit)) state.loopEvidenceVersion += 1;
      state.loopEvidenceUnit = candidate.unit;
      this.onLoopCandidate(sessionId, state, candidate);
    } else {
      state.loopEvidenceVersion += 1;
      state.loopEvidenceUnit = null;
    }
  }

  // Repeated text is only a candidate. AI-backed cards must still judge it;
  // the detector itself never authorizes a session action.
  onLoopCandidate(sessionId, state, candidate) {
    const now = this.now();
    if (state.suspended || state.loopChecking || (state.loopLastCheck && now - state.loopLastCheck < 60_000)) return;
    const facts = this.registry.sessionFacts(sessionId);
    if (!this.factsAllow(facts, "loop")) return;
    const cards = this.matchingCards(facts, "loop").filter((card) => card.judge.kind === "ai");
    if (!cards.length || !this.judge) return;
    state.loopLastCheck = now;
    state.loopChecking = true;
    const epoch = state.epoch;
    const evidenceVersion = state.loopEvidenceVersion;
    const snapshot = this.snapshot(sessionId, state, { checkpoint: "loop", result: null, error: null }, facts);
    snapshot.lastReply = candidate.excerpt;
    const current = () => {
      const live = this.sessions.get(sessionId);
      return live === state && live.epoch === epoch && !live.suspended
        && live.loopEvidenceVersion === evidenceVersion
        && this.now() - now <= 30_000
        && this.factsAllow(this.registry.sessionFacts(sessionId), "loop");
    };
    this.runCards(sessionId, cards, snapshot, { epoch, current })
      .catch((error) => this.log.error?.(`[runtime-supervisor] ${error.message}`))
      .finally(() => {
        if (this.sessions.get(sessionId) !== state || state.epoch !== epoch) return;
        state.loopChecking = false;
        if (state.loopEvidenceVersion === evidenceVersion || state.suspended) return;
        // A different pattern arrived during the old judgment. Recheck the
        // latest evidence after a short coalescing delay, even if output has
        // stopped; the old judgment's normal cooldown must not hide it.
        clearTimeout(state.loopRetryTimer);
        const delay = Math.max(0, 5000 - (this.now() - now));
        state.loopRetryTimer = setTimeout(() => {
          state.loopRetryTimer = null;
          if (this.sessions.get(sessionId) !== state || state.epoch !== epoch
            || state.suspended || !this.accountCurrent()) return;
          state.loopLastCheck = 0;
          const latest = detectRepeatedOutput(state.loopDetector.buffer);
          if (latest) this.onLoopCandidate(sessionId, state, latest);
        }, delay);
        state.loopRetryTimer.unref?.();
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
    if (!this.accountCurrent()) { this.stop(); return; }
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
      if (!this.accountCurrent()) return;
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
          ...(["claude", "codex", "agy"].includes(snapshot.agent) ? { agent: snapshot.agent } : {}),
          createdAt: new Date(this.now()).toISOString(),
        });
      } catch (error) {
        this.log.error?.(`[runtime-supervisor] log: ${error.message}`);
      }
    });
  }
}
