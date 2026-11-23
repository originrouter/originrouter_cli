import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const AGY_NATIVE_MESSAGE_LIMIT = 800000;
export function validAgyQueuedMessage(entry) {
  return entry && typeof entry.text === 'string' && entry.text.length <= AGY_NATIVE_MESSAGE_LIMIT
    && Buffer.byteLength(entry.text) <= AGY_NATIVE_MESSAGE_LIMIT
    && Buffer.byteLength(JSON.stringify(entry.text)) <= AGY_NATIVE_MESSAGE_LIMIT
    && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(entry.text)
    && (entry.id == null || (typeof entry.id === 'string' && entry.id.length <= 191))
    && (entry.attachmentRoot == null || (typeof entry.attachmentRoot === 'string' && entry.attachmentRoot.length <= 8192));
}

// Only unsent intents may be replayed. A possibly submitted message is never retried automatically.
export class AgyNativeQueueStore {
  constructor(stateDir, conversationId) {
    this.file = join(stateDir, 'agy-pending', createHash('sha256').update(conversationId).digest('hex') + '.json');
  }
  read() {
    if (!existsSync(this.file)) return { pending: [], inFlight: null, confirmed: [], uncertain: [] };
    if (statSync(this.file).size > 16000000) throw new Error('Native message queue is too large');
    const saved = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!Array.isArray(saved.pending) || saved.pending.length > 16
        || saved.pending.some(m => !validAgyQueuedMessage(m))) throw new Error('Invalid native message queue');
    if (saved.inFlight && !validAgyQueuedMessage(saved.inFlight)) throw new Error('Invalid native in-flight message');
    for (const key of ['confirmed', 'uncertain']) saved[key] = Array.isArray(saved[key]) ? saved[key].filter(id => typeof id === 'string' && id.length <= 191).slice(-128) : [];
    return saved;
  }
  write(pending, inFlight = null, confirmed = [], uncertain = []) {
    if (pending.length > 16 || pending.some(m => !validAgyQueuedMessage(m))
        || (inFlight && !validAgyQueuedMessage(inFlight))) throw new Error('Invalid native message queue');
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const copy = entry => entry ? { id: entry.id || null, text: entry.text, isCommand: entry.isCommand === true,
      ...(entry.attachmentRoot ? { attachmentRoot: entry.attachmentRoot } : {}) } : null;
    const content = JSON.stringify({ pending: pending.map(copy), inFlight: copy(inFlight), confirmed: confirmed.slice(-128), uncertain: uncertain.slice(-128) });
    if (Buffer.byteLength(content) > 16000000) throw new Error('Native message queue is too large');
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
