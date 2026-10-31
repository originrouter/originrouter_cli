import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    const cards = normalizeRuntimeTaskCards(input.cards, { aiJudgeAvailable: this.aiJudgeAvailable });
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
    return Array.isArray(entries) ? entries.slice(-bounded).reverse() : [];
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

  appendLog(entry) {
    const path = join(this.dir(), LOG_FILE);
    const entries = readJsonOr(path, []);
    const list = Array.isArray(entries) ? entries : [];
    list.push(entry);
    writePrivateJson(path, list.slice(-RUNTIME_TASK_LOG_LIMIT));
  }
}
