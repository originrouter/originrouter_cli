// Batch only visible assistant output for the local supervisor. Samples are
// best-effort and tied to one turn; they must never be replayed after a turn.
export class RuntimeOutputSampler {
  constructor({ chunkSize = 512, maxBuffer = 4096, onChunk = null, onGap = null, flushIntervalMs = 1000 } = {}) {
    this.chunkSize = chunkSize;
    this.maxBuffer = maxBuffer;
    this.onChunk = onChunk;
    this.onGap = onGap;
    this.flushIntervalMs = flushIntervalMs;
    this.turnId = '';
    this.buffer = '';
    this.timer = null;
  }

  reset(turnId = '') {
    clearTimeout(this.timer);
    this.timer = null;
    this.turnId = String(turnId || '');
    this.buffer = '';
  }

  add(turnId, text) {
    if (!turnId || turnId !== this.turnId || typeof text !== 'string' || !text) return [];
    const combined = this.buffer + text;
    if (combined.length > this.maxBuffer) this.onGap?.();
    this.buffer = combined.slice(-this.maxBuffer);
    const chunks = [];
    while (this.buffer.length >= this.chunkSize) {
      chunks.push(this.buffer.slice(0, this.chunkSize));
      this.buffer = this.buffer.slice(this.chunkSize);
    }
    // A stalled model may have emitted less than one batch. Send that partial
    // output after a short delay while the turn is still running.
    if (this.buffer && this.onChunk && !this.timer) {
      const capturedTurn = this.turnId;
      this.timer = setTimeout(() => {
        this.timer = null;
        const chunk = this.flush(capturedTurn);
        if (chunk) this.onChunk(capturedTurn, chunk);
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
    return chunks;
  }

  flush(turnId) {
    if (!turnId || turnId !== this.turnId) return null;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer) return null;
    const chunk = this.buffer;
    this.buffer = '';
    return chunk;
  }
}

// Only visible top-level output is eligible. Reasoning/tool deltas and
// subagent text are deliberately not sent to the supervisor.
export function claudeStreamPart(message) {
  if (message?.type !== 'stream_event' || message.parent_tool_use_id) return null;
  const event = message.event;
  if (event?.type === 'message_start') return { kind: 'start' };
  if (event?.type === 'message_stop') return { kind: 'end' };
  if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta'
    && typeof event.delta.text === 'string') return { kind: 'delta', text: event.delta.text };
  return null;
}

export function codexStreamDelta(event, turnId, threadId) {
  if (event?.type !== 'codex.notification' || event.method !== 'item/agentMessage/delta') return null;
  const params = event.params || {};
  if (!turnId || params.turnId !== turnId || (params.threadId && params.threadId !== threadId)) return null;
  return typeof params.delta === 'string' ? params.delta : null;
}
