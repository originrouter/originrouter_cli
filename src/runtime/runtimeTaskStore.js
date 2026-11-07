import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ensureStateDir } from "../persistence/state.js";
import { activeAccountStateDir } from "../persistence/accounts.js";
import {
  RUNTIME_TASK_ACTIONS,
  RUNTIME_TASK_BUILTIN_RULES,
  RUNTIME_TASK_CHECKPOINTS,
  RUNTIME_TASK_TEMPLATES,
  MAX_RUNTIME_TASK_CARDS,
  normalizeRuntimeTaskCard,
  normalizeRuntimeTaskCards,
} from "./runtimeTaskRules.js";

const CARDS_FILE = "runtime-tasks.json";
const LOG_FILE = "runtime-task-log.json";
const RECOVERY_FILE = "runtime-task-recovery.json";
const MAX_RECOVERY_SESSIONS = 1024;
export const RUNTIME_TASK_LOG_LIMIT = 200;

function writePrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}

function readJsonOr(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`[runtime-tasks] ignoring unreadable ${path}: ${error.message}`);
    return fallback;
  }
}

// The runtime-task cards of the signed-in account on this device, and the
// log of what they did. Cards follow the account like the budget policies
// do, so a second account on the same machine starts with none.
//
// The directory is resolved on every call rather than once: an account
// switch does not restart the daemon, and a supervisor holding the previous
// account's cards would act for someone who is no longer signed in.
export class RuntimeTaskStore {
  constructor({ stateDir = ensureStateDir(), now = () => Date.now(), aiJudgeAvailable = false } = {}) {
    this.rootStateDir = stateDir;
    this.now = now;
    this.aiJudgeAvailable = aiJudgeAvailable;
    this.cache = null;
  }

  dir() {
    return activeAccountStateDir(this.rootStateDir);
  }

  read() {
    const dir = this.dir();
    if (this.cache?.dir === dir) return this.cache.state;
    const raw = readJsonOr(join(dir, CARDS_FILE), null);
    const cards = [];
    for (const item of Array.isArray(raw?.cards) ? raw.cards.slice(0, MAX_RUNTIME_TASK_CARDS) : []) {
      // One card a newer CLI wrote, or a hand edit gone wrong, must not take
      // the others down with it.
      try {
        const card = normalizeRuntimeTaskCard(item, { aiJudgeAvailable: true });
        if (!cards.some((existing) => existing.id === card.id)) cards.push(card);
      } catch (error) {
        console.error(`[runtime-tasks] dropping stored card: ${error.message}`);
      }
    }
    const state = {
      revision: Number.isSafeInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0,
      cards,
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null,
    };
    this.cache = { dir, state };
    return state;
  }

  cards() {
    return this.read().cards;
  }

  snapshot() {
    const state = this.read();
    return {
      revision: state.revision,
      cards: state.cards,
      updatedAt: state.updatedAt,
      capabilities: {
        checkpoints: RUNTIME_TASK_CHECKPOINTS,
        builtinRules: RUNTIME_TASK_BUILTIN_RULES,
        actions: RUNTIME_TASK_ACTIONS,
        templates: RUNTIME_TASK_TEMPLATES,
        aiJudge: this.aiJudgeAvailable,
        maxCards: MAX_RUNTIME_TASK_CARDS,
      },
    };
  }

  // Replaces the whole list. `baseRevision` is the revision the editor read;
  // a write made from an older read is refused instead of erasing a change
  // someone else saved in between.
  setCards(input = {}) {
    const current = this.read();
    if (input.baseRevision != null && Number(input.baseRevision) !== current.revision) {
      throw Object.assign(new Error("the runtime tasks changed since they were read"), {
        code: "RUNTIME_TASKS_CONFLICT",
        revision: current.revision,
      });
    }
    const cards = normalizeRuntimeTaskCards(input.cards, { aiJudgeAvailable: true });
    if (!this.aiJudgeAvailable) {
      for (const card of cards) {
        if (card.judge.kind !== "ai") continue;
        const existing = current.cards.find((item) => item.id === card.id);
        const unchanged = existing && isDeepStrictEqual(
          { ...existing, enabled: card.enabled }, card,
        );
        if (!unchanged || (!existing.enabled && card.enabled)) {
          throw Object.assign(new Error("AI judgement is not available on this device yet"), {
            code: "AI_JUDGE_UNAVAILABLE",
          });
        }
      }
    }
    const dir = this.dir();
    const state = {
      revision: current.revision + 1,
      cards,
      updatedAt: new Date(this.now()).toISOString(),
    };
    writePrivateJson(join(dir, CARDS_FILE), state);
    this.cache = { dir, state };
    return this.snapshot();
  }

  log({ limit = 50 } = {}) {
    const entries = readJsonOr(join(this.dir(), LOG_FILE), []);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, RUNTIME_TASK_LOG_LIMIT));
    return Array.isArray(entries) ? entries.filter((entry) => entry?.type !== 'agent.supervisor.receipt').slice(-bounded).reverse() : [];
  }

  // Correlate a confirmed recovery receipt with the native transcript using
  // its timestamp and a digest, without persisting the message contents.
  annotateHistory(sessionId, history) {
    const entries = readJsonOr(join(this.dir(), LOG_FILE), []);
    const receipts = (Array.isArray(entries) ? entries : []).filter((entry) =>
      entry?.sessionId === sessionId && entry.type === 'agent.supervisor.receipt'
      && typeof entry.messageId === 'string' && typeof entry.messageDigest === 'string');
    const acted = (Array.isArray(entries) ? entries : []).filter((entry) =>
      entry?.sessionId === sessionId && entry.type === 'agent.supervisor.acted'
      && entry.action === 'interrupt_and_continue' && typeof entry.messageId === 'string'
      && typeof entry.messageDigest === 'string' && typeof entry.createdAt === 'string');
    const markers = [...receipts, ...acted.filter((entry) => !receipts.some((receipt) => receipt.messageId === entry.messageId))];
    const source = history?.messages || [];
    const candidates = source.map((message) => {
      if (message.role !== 'user') return [];
      const at = Date.parse(message.createdAt || '');
      if (!Number.isFinite(at)) return [];
      const digest = createHash('sha256').update(String(message.text || '').trim()).digest('hex');
      return markers.filter((marker) => {
        const when = Date.parse(marker.createdAt);
        return marker.messageDigest === digest && Number.isFinite(when) && Math.abs(at - when) <= 5_000;
      });
    });
    // A user may independently send the same text at nearly the same time.
    // Mark only a unique match in both directions; ambiguity is preferable to
    // falsely attributing the user's message to the supervisor.
    const messages = source.map((message, index) => {
      const matches = candidates[index];
      if (matches.length !== 1 || candidates.filter((other) => other.includes(matches[0])).length !== 1) return message;
      return {...message, origin:'supervisor'};
    });
    return {...history, messages};
  }

  // The one entry point the local API and the E2EE relay share, so the two
  // transports cannot drift apart. `onChanged` runs after a successful write.
  handle(action, body = {}, { onChanged } = {}) {
    if (action === "get") return this.snapshot();
    if (action === "log") return { entries: this.log({ limit: body.limit }) };
    if (action === "set") {
      const snapshot = this.setCards(body);
      onChanged?.();
      return snapshot;
    }
    throw Object.assign(new Error(`unknown runtime task action ${String(action).slice(0, 32)}`), {
      code: "INVALID_RUNTIME_TASK",
    });
  }

  // A recovery can interrupt and start external work. Persist its intent and
  // budget before interrupting so a daemon crash cannot silently retry it.
  // A corrupt or unwritable file fails closed rather than losing the budget.
  recoveryState() {
    const path = join(this.dir(), RECOVERY_FILE);
    if (!existsSync(path)) return Object.create(null);
    let value;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw Object.assign(new Error("runtime recovery state is unreadable"), { code: "RECOVERY_STATE_UNAVAILABLE" }); }
    const invalid = () => Object.assign(new Error("runtime recovery state is invalid"), { code: "RECOVERY_STATE_UNAVAILABLE" });
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length > MAX_RECOVERY_SESSIONS) throw invalid();
    for (const [session, record] of Object.entries(value)) {
      if (!session || session.length > 64 || !record || typeof record !== "object"
        || typeof record.pending !== "boolean" || !record.counts
        || (record.userStopped != null && typeof record.userStopped !== "boolean")
        || typeof record.counts !== "object" || Array.isArray(record.counts)
        || Object.keys(record.counts).length > MAX_RUNTIME_TASK_CARDS) throw invalid();
      for (const [id, count] of Object.entries(record.counts)) {
        if (!/^rt_[A-Za-z0-9_-]{1,61}$/.test(id) || !Number.isInteger(count) || count < 0 || count > 20) throw invalid();
      }
    }
    return Object.assign(Object.create(null), value);
  }

  recoveryFor(sessionId) {
    return this.recoveryState()[sessionId] || null;
  }

  markUserStopped(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 64) {
      throw Object.assign(new Error('invalid runtime session'), {code:'RECOVERY_INVALID'});
    }
    const states = this.recoveryState();
    if (!states[sessionId] && Object.keys(states).length >= MAX_RECOVERY_SESSIONS) {
      throw Object.assign(new Error('runtime recovery state is full'), {code:'RECOVERY_STATE_FULL'});
    }
    states[sessionId] = {...(states[sessionId] || {pending:false, counts:{}}), userStopped:true};
    writePrivateJson(join(this.dir(), RECOVERY_FILE), states);
  }

  clearFinishedStop(sessionId) {
    const states = this.recoveryState();
    const state = states[sessionId];
    if (!state?.userStopped || state.pending) return;
    delete states[sessionId];
    writePrivateJson(join(this.dir(), RECOVERY_FILE), states);
  }

  // Record a continuation before it enters the command queue. If the daemon
  // exits without its receipt, a later supervisor must not replay it.
  beginDelivery(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 64) {
      throw Object.assign(new Error('invalid runtime session'), {code:'RECOVERY_INVALID'});
    }
    const states = this.recoveryState();
    const prior = states[sessionId] || {pending:false, counts:{}};
    if (prior.pending) throw Object.assign(new Error('an earlier delivery has an uncertain result'), {code:'RECOVERY_PENDING'});
    if (!states[sessionId] && Object.keys(states).length >= MAX_RECOVERY_SESSIONS) {
      throw Object.assign(new Error('runtime recovery state is full'), {code:'RECOVERY_STATE_FULL'});
    }
    states[sessionId] = {...prior, pending:true};
    writePrivateJson(join(this.dir(), RECOVERY_FILE), states);
  }

  beginRecovery(sessionId, cardId, maximum) {
    const states = this.recoveryState();
    const prior = states[sessionId] || { pending: false, counts: {} };
    if (prior.pending) throw Object.assign(new Error("an earlier recovery has an uncertain result"), { code: "RECOVERY_PENDING" });
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 64
      || !/^rt_[A-Za-z0-9_-]{1,61}$/.test(cardId)
      || !Number.isInteger(maximum) || maximum < 1 || maximum > 20) {
      throw Object.assign(new Error("invalid runtime recovery intent"), { code: "RECOVERY_INVALID" });
    }
    if (!Object.hasOwn(prior.counts, cardId) && Object.keys(prior.counts).length >= MAX_RUNTIME_TASK_CARDS) {
      throw Object.assign(new Error("runtime recovery card budget is full"), { code: "RECOVERY_STATE_FULL" });
    }
    const count = prior.counts[cardId] || 0;
    if (count >= maximum) throw Object.assign(new Error("runtime recovery limit reached"), { code: "RECOVERY_LIMIT" });
    if (!states[sessionId] && Object.keys(states).length >= MAX_RECOVERY_SESSIONS) {
      throw Object.assign(new Error("runtime recovery state is full"), { code: "RECOVERY_STATE_FULL" });
    }
    const next = { pending: true, counts: { ...prior.counts, [cardId]: count + 1 } };
    states[sessionId] = next;
    writePrivateJson(join(this.dir(), RECOVERY_FILE), states);
    return next;
  }

  finishRecovery(sessionId) {
    const states = this.recoveryState();
    if (!states[sessionId]?.pending) return;
    states[sessionId] = { ...states[sessionId], pending: false };
    writePrivateJson(join(this.dir(), RECOVERY_FILE), states);
  }

  clearRecovery(sessionId) {
    const states = this.recoveryState();
    if (!states[sessionId]) return;
    delete states[sessionId];
    writePrivateJson(join(this.dir(), RECOVERY_FILE), states);
  }

  appendLog(entry) {
    const path = join(this.dir(), LOG_FILE);
    const entries = readJsonOr(path, []);
    const list = Array.isArray(entries) ? entries : [];
    list.push(entry);
    writePrivateJson(path, list.slice(-RUNTIME_TASK_LOG_LIMIT));
  }
}
