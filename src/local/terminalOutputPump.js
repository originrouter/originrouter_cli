// Coalesce PTY fragments that belong to the same event-loop turn before
// writing them to the real terminal. Full-screen TUIs frequently emit one
// visual frame as many small writes. Forwarding each fragment separately
// makes Terminal render incomplete intermediate frames and becomes visibly
// expensive when scrolling a long transcript.
const SYNC_OUTPUT_START = "\u001b[?2026h";
const SYNC_OUTPUT_END = "\u001b[?2026l";

export function createTerminalOutputPump({
  write,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
  flushDelayMs = 16,
  maxSynchronizedFrameDelayMs = 80,
  maxBufferedChars = 256 * 1024,
} = {}) {
  if (typeof write !== "function") {
    throw new TypeError("terminal output pump requires a write function");
  }

  let chunks = [];
  let bufferedChars = 0;
  let scheduled = null;
  let scheduledDelay = null;
  let synchronizedDepth = 0;
  let controlTail = "";
  let bufferedAt = null;

  const flush = () => {
    if (scheduled !== null) {
      cancel(scheduled);
      scheduled = null;
      scheduledDelay = null;
    }
    if (chunks.length === 0) return false;
    const output = chunks.length === 1 ? chunks[0] : chunks.join("");
    chunks = [];
    bufferedChars = 0;
    bufferedAt = null;
    write(output);
    return true;
  };

  const scheduleFlush = (delay) => {
    const normalizedDelay = Math.max(0, delay);
    if (scheduled !== null) {
      if (scheduledDelay === normalizedDelay) return;
      cancel(scheduled);
    }
    scheduledDelay = normalizedDelay;
    scheduled = schedule(() => {
      scheduled = null;
      scheduledDelay = null;
      flush();
    }, normalizedDelay);
  };

  const inspectFrameBoundaries = (chunk) => {
    const text = `${controlTail}${chunk}`;
    let sawEnd = false;
    for (let index = 0; index < text.length;) {
      const startAt = text.indexOf(SYNC_OUTPUT_START, index);
      const endAt = text.indexOf(SYNC_OUTPUT_END, index);
      if (startAt < 0 && endAt < 0) break;
      if (startAt >= 0 && (endAt < 0 || startAt < endAt)) {
        synchronizedDepth += 1;
        index = startAt + SYNC_OUTPUT_START.length;
      } else {
        synchronizedDepth = Math.max(0, synchronizedDepth - 1);
        sawEnd = true;
        index = endAt + SYNC_OUTPUT_END.length;
      }
    }
    const tailLength = Math.max(
      SYNC_OUTPUT_START.length,
      SYNC_OUTPUT_END.length,
    ) - 1;
    controlTail = text.slice(-tailLength);
    return sawEnd;
  };

  return {
    push(data) {
      const chunk = String(data || "");
      if (!chunk) return;
      chunks.push(chunk);
      bufferedChars += chunk.length;
      if (bufferedAt === null) bufferedAt = now();
      const sawSynchronizedEnd = inspectFrameBoundaries(chunk);
      if (bufferedChars >= maxBufferedChars) {
        flush();
        return;
      }
      if (sawSynchronizedEnd && synchronizedDepth === 0) {
        // A completed synchronized frame is safe to display, but Claude can
        // emit several small complete frames back-to-back. Writing every one
        // immediately defeats coalescing and makes Terminal render transient
        // states that are never meaningfully visible. Keep a short frame
        // window while enforcing a hard latency bound for continuous output.
        const age = Math.max(0, now() - bufferedAt);
        scheduleFlush(Math.min(
          flushDelayMs,
          Math.max(0, maxSynchronizedFrameDelayMs - age),
        ));
        return;
      }
      const age = Math.max(0, now() - bufferedAt);
      const remainingMaxDelay = Math.max(
        0,
        maxSynchronizedFrameDelayMs - age,
      );
      scheduleFlush(synchronizedDepth > 0
        ? remainingMaxDelay
        : Math.min(flushDelayMs, remainingMaxDelay));
    },
    flush,
    stop() {
      flush();
    },
  };
}
