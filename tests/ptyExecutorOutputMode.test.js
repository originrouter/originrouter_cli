import assert from "node:assert/strict";
import test from "node:test";

import {
  disableNestedPtyOutputPostprocessing,
  disableOuterTtyOutputPostprocessing,
  restoreOuterTtyOutputPostprocessing,
} from "../src/executors/ptyExecutor.js";

test("nested PTY output postprocessing uses the macOS tty flag", () => {
  const calls = [];
  const changed = disableNestedPtyOutputPostprocessing(
    { _pty: "/dev/ttys010" },
    {
      platform: "darwin",
      exec: (...args) => calls.push(args),
    },
  );

  assert.equal(changed, true);
  assert.deepEqual(calls[0][1], ["-f", "/dev/ttys010", "-opost"]);
});

test("nested PTY output postprocessing uses the Linux tty flag", () => {
  const calls = [];
  const changed = disableNestedPtyOutputPostprocessing(
    { _pty: "/dev/pts/12" },
    {
      platform: "linux",
      exec: (...args) => calls.push(args),
    },
  );

  assert.equal(changed, true);
  assert.deepEqual(calls[0][1], ["-F", "/dev/pts/12", "-opost"]);
});

test("nested PTY output postprocessing rejects non-device paths", () => {
  let called = false;
  const changed = disableNestedPtyOutputPostprocessing(
    { _pty: "/tmp/not-a-tty" },
    { exec: () => { called = true; } },
  );

  assert.equal(changed, false);
  assert.equal(called, false);
});

test("outer TTY output postprocessing disables and restores opost on POSIX TTY", () => {
  const calls = [];
  const fakeInput = { isTTY: true };
  const fakeOutput = { isTTY: true };
  const disabled = disableOuterTtyOutputPostprocessing({
    input: fakeInput,
    output: fakeOutput,
    platform: "darwin",
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === "-a") return "oflags: opost onlcr -oxtabs";
      return "";
    },
  });
  assert.equal(disabled, true);
  assert.deepEqual(calls, [
    ["stty", ["-a"]],
    ["stty", ["-opost"]],
  ]);

  const restored = restoreOuterTtyOutputPostprocessing({
    input: fakeInput,
    platform: "darwin",
    exec: (cmd, args) => { calls.push([cmd, args]); return ""; },
  });
  assert.equal(restored, true);
  assert.deepEqual(calls[2], ["stty", ["opost"]]);
});

test("outer TTY output postprocessing is a no-op when already -opost or on win32", () => {
  const calls = [];
  const alreadyOff = disableOuterTtyOutputPostprocessing({
    input: { isTTY: true },
    output: { isTTY: true },
    platform: "darwin",
    exec: (cmd, args) => {
      calls.push([cmd, args]);
      return "oflags: -opost onlcr";
    },
  });
  assert.equal(alreadyOff, false);
  assert.deepEqual(calls, [["stty", ["-a"]]]);

  assert.equal(disableOuterTtyOutputPostprocessing({
    input: { isTTY: true },
    output: { isTTY: true },
    platform: "win32",
    exec: () => { throw new Error("should not run on win32"); },
  }), false);
});
