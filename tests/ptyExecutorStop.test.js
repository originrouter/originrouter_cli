import assert from "node:assert/strict";
import test from "node:test";

import { PtyExecutor } from "../src/executors/ptyExecutor.js";

// Stage: terminate must kill the whole process group, not just SIGHUP the PTY
// leader (node-pty's default). These tests drive a fake terminal + a patched
// process.kill and assert SIGTERM→SIGKILL group escalation.

function makeTerminal(pid) {
  return {
    pid,
    killCalls: [],
    kill(signal) {
      // node-pty forwards to process.kill(this.pid, signal||'SIGHUP'). Our
      // executor calls terminal.kill() with no arg to release the pty fd; the
      // group signaling goes through the patched process.kill below.
      this.killCalls.push(signal || "SIGHUP");
    },
  };
}

function patchProcessKill() {
  const signals = [];
  const realKill = process.kill;
  const targets = [];
  process.kill = (pid, signal) => {
    targets.push(String(pid));
    signals.push(signal);
    if (signal === "SIGKILL") {
      // After the hard kill the group is gone: subsequent SIGTERM would ESRCH.
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }
    return true;
  };
  return {
    signals,
    targets,
    restore() {
      process.kill = realKill;
    },
  };
}

// The real exit (node-pty onExit -> executor._exited = true) is what stops the
// escalation timer. Simulate it directly.
async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("stop() sends SIGTERM to the whole process group, not the single pid", () => {
  const executor = new PtyExecutor();
  executor.terminal = makeTerminal(4242);

  const kill = patchProcessKill();
  try {
    executor.stop();
    assert.deepEqual(kill.targets, ["-4242"], "must signal -pid (process group)");
    assert.deepEqual(kill.signals, ["SIGTERM"]);
  } finally {
    kill.restore();
  }
});

test("stop() escalates to SIGKILL after the window when the child does not exit", async () => {
  const executor = new PtyExecutor({ forceKillMs: 5 });
  executor.terminal = makeTerminal(6060);

  const kill = patchProcessKill();
  try {
    executor.stop();
    assert.equal(kill.signals.length, 1, "immediately after stop(): SIGTERM only");
    await wait(40);
    assert.deepEqual(kill.signals, ["SIGTERM", "SIGKILL"], "SIGKILL must follow SIGTERM");
    assert.deepEqual(kill.targets, ["-6060", "-6060"], "both signals target the group");
  } finally {
    kill.restore();
  }
});

test("stop() does NOT send SIGKILL when the child exits within the window", async () => {
  const executor = new PtyExecutor({ forceKillMs: 5 });
  executor.terminal = makeTerminal(8181);

  const kill = patchProcessKill();
  try {
    executor.stop();
    assert.equal(kill.signals.length, 1);
    // Child terminates before the escalation fires; the exit handler clears
    // the timer and flags exited.
    executor._exited = true;
    if (executor._stopTimer) { clearTimeout(executor._stopTimer); executor._stopTimer = null; }
    await wait(40);
    assert.deepEqual(kill.signals, ["SIGTERM"], "no SIGKILL once the child has exited");
  } finally {
    kill.restore();
  }
});

test("stop() releases node-pty's fd via its own kill() then signals the group", () => {
  const executor = new PtyExecutor();
  const terminal = makeTerminal(9999);
  executor.terminal = terminal;

  const kill = patchProcessKill();
  try {
    executor.stop();
    // node-pty teardown first (SIGHUP for the fd), then the group SIGTERM.
    assert.deepEqual(terminal.killCalls, ["SIGHUP"]);
    assert.deepEqual(kill.signals, ["SIGTERM"]);
    assert.deepEqual(kill.targets, ["-9999"]);
  } finally {
    kill.restore();
  }
});
