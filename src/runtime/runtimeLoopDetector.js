// Bounded, conservative candidate detection for a supervisor. This only finds
// repeated output; it is not an AI verdict and must not interrupt a session.
const MAX_WINDOW = 12_000;
const MIN_UNIT = 12;
const MAX_UNIT = 240;
const MIN_REPEATS = 4;

export class RuntimeLoopDetector {
  constructor({ maxWindow = MAX_WINDOW } = {}) {
    this.maxWindow = Math.max(1024, Math.min(MAX_WINDOW, maxWindow));
    this.buffer = '';
    this.lastInput = '';
  }

  reset() {
    this.buffer = '';
    this.lastInput = '';
  }

  add(value, { cumulative = false } = {}) {
    const text = String(value ?? '');
    if (!text) return null;
    // The caller must name snapshot semantics explicitly: identical chunks
    // can also be genuine repeated output from a streaming runtime.
    const delta = cumulative && this.lastInput && text.startsWith(this.lastInput)
      ? text.slice(this.lastInput.length)
      : text;
    if (cumulative && text === this.lastInput) return null;
    this.lastInput = cumulative ? text.slice(-this.maxWindow) : '';
    this.buffer = (this.buffer + delta).slice(-this.maxWindow);
    return detectRepeatedOutput(this.buffer);
  }
}

export function detectRepeatedOutput(input) {
  const text = String(input ?? '').slice(-MAX_WINDOW).replace(/\s+/gu, ' ').trim().toLowerCase();
  for (let size = MIN_UNIT; size <= Math.min(MAX_UNIT, Math.floor(text.length / MIN_REPEATS)); size += 1) {
    const unit = text.slice(-size);
    // Ignore long runs of whitespace, punctuation or a single character.
    if ((unit.match(/[\p{L}\p{N}]/gu) || []).length < 8 || new Set(unit).size < 4) continue;
    let count = 1;
    while (count < 20 && text.slice(-size * (count + 1), -size * count) === unit) count += 1;
    if (count >= MIN_REPEATS) return { unit: unit.slice(0, 240), repeats: count, excerpt: text.slice(-2000) };
  }
  return null;
}
