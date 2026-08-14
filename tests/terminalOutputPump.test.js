import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalOutputPump } from "../src/local/terminalOutputPump.js";

test("terminal output pump writes one complete frame for same-turn PTY fragments", () => {
  const writes = [];
  const scheduled = [];
  const delays = [];
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    schedule: (callback, delay) => {
      scheduled.push(callback);
      delays.push(delay);
      return callback;
    },
    cancel: () => {},
  });

  pump.push("\u001b[2J");
  pump.push("first line\r\n");
  pump.push("second line\u001b[0m");

  assert.equal(writes.length, 0);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(delays, [16]);
  scheduled.shift()();
  assert.deepEqual(writes, ["\u001b[2Jfirst line\r\nsecond line\u001b[0m"]);
});

test("terminal output pump follows Claude synchronized frame boundaries", () => {
  const writes = [];
  const scheduled = [];
  const delays = [];
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    schedule: (callback, delay) => {
      scheduled.push(callback);
      delays.push(delay);
      return callback;
    },
    cancel: () => {},
  });

  pump.push("\u001b[?20");
  pump.push("26hframe part one");
  pump.push("frame part two\u001b[?2026l");

  assert.deepEqual(delays, [16, 80, 16]);
  assert.deepEqual(writes, []);
  scheduled.at(-1)();
  assert.deepEqual(writes, [
    "\u001b[?2026hframe part oneframe part two\u001b[?2026l",
  ]);
});

test("terminal output pump bounds continuous synchronized output latency", () => {
  const writes = [];
  const scheduled = [];
  const delays = [];
  let clock = 100;
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    now: () => clock,
    schedule: (callback, delay) => {
      scheduled.push(callback);
      delays.push(delay);
      return callback;
    },
    cancel: () => {},
  });

  pump.push("\u001b[?2026hfirst\u001b[?2026l");
  clock += 70;
  pump.push("\u001b[?2026hsecond\u001b[?2026l");

  assert.deepEqual(delays, [16, 10]);
  scheduled.at(-1)();
  assert.deepEqual(writes, [
    "\u001b[?2026hfirst\u001b[?2026l\u001b[?2026hsecond\u001b[?2026l",
  ]);
});

test("terminal output pump flushes immediately at its memory bound", () => {
  const writes = [];
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    schedule: () => 1,
    cancel: () => {},
    maxBufferedChars: 5,
  });

  pump.push("abc");
  pump.push("def");

  assert.deepEqual(writes, ["abcdef"]);
});

test("terminal output pump stop preserves the final partial frame", () => {
  const writes = [];
  const pump = createTerminalOutputPump({
    write: (data) => writes.push(data),
    schedule: () => 1,
    cancel: () => {},
  });

  pump.push("final output");
  pump.stop();

  assert.deepEqual(writes, ["final output"]);
});
