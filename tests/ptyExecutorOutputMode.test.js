import assert from "node:assert/strict";
import test from "node:test";

import {
  disableNestedPtyOutputPostprocessing,
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
