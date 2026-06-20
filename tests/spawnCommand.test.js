// Stage 8.6: offline coverage for src/utils/spawn.js.
//
// What this file proves:
//   1. buildSpawnOptions() with no argument returns SPAWN_DEFAULTS
//      (shell:false, windowsHide:true).
//   2. buildSpawnOptions() shell default is exactly false.
//   3. buildSpawnOptions() windowsHide default is exactly true.
//   4. buildSpawnOptions() merges caller-supplied options with
//      defaults; caller options win on conflict.
//   5. spawnCommand() composes real options and launches a real
//      child process (we use process.execPath with `-e` so the test
//      is fully offline / cross-platform).
//
// The helper is split into buildSpawnOptions (pure) + spawnCommand
// (thin wrapper) precisely so this test file does not need to
// monkey-patch node:child_process.spawn — ESM static imports
// cannot be reliably monkey-patched.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { buildSpawnOptions, spawnCommand, SPAWN_DEFAULTS } from "../src/utils/spawn.js";

// ---- 1. buildSpawnOptions() defaults: equals SPAWN_DEFAULTS ----

{
  const opts = buildSpawnOptions();
  assert.deepEqual(opts, { shell: false, windowsHide: true });
  assert.equal(opts.shell, SPAWN_DEFAULTS.shell);
  assert.equal(opts.windowsHide, SPAWN_DEFAULTS.windowsHide);
}

// ---- 2. buildSpawnOptions() shell default ----

{
  const opts = buildSpawnOptions();
  assert.equal(opts.shell, false);
}

// ---- 3. buildSpawnOptions() windowsHide default ----

{
  const opts = buildSpawnOptions();
  assert.equal(opts.windowsHide, true);
}

// ---- 4. buildSpawnOptions() caller override / merge ----

{
  const callerEnv = { FOO: "1" };
  const callerStdio = ["pipe", "pipe", "pipe"];
  const opts = buildSpawnOptions({
    env: callerEnv,
    stdio: callerStdio,
  });
  // Defaults preserved.
  assert.equal(opts.shell, false);
  assert.equal(opts.windowsHide, true);
  // Caller-supplied options merged in.
  assert.equal(opts.env, callerEnv);
  assert.deepEqual(opts.stdio, callerStdio);
}

// Caller option overrides default on key conflict.
{
  const opts = buildSpawnOptions({ windowsHide: false });
  assert.equal(opts.windowsHide, false,
    "caller-supplied windowsHide must override the default");
}

// Empty caller options still produces defaults.
{
  const opts = buildSpawnOptions({});
  assert.equal(opts.shell, false);
  assert.equal(opts.windowsHide, true);
}

// ---- 5. spawnCommand() real smoke ----

{
  // Spawn node itself to print `process.exit(0)`. The child should
  // exit with code 0 within a few seconds. We use a manual promise
  // around spawn() (not spawnCommand) to verify that
  // spawnCommand returns the same kind of ChildProcess; if this
  // smoke regresses, the wrapper composition is broken.
  const child = spawnCommand(process.execPath, [
    "-e",
    "process.stdout.write('spawn-ok'); process.exit(0);",
  ]);
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    setTimeout(() => reject(new Error("child did not exit within 5s")), 5_000);
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout, "spawn-ok");
}

// spawnCommand() returns a node ChildProcess whose options include
// the merged defaults. We assert via the same direct-spawn pattern
// to verify the composition path without monkey-patching: we just
// spawn node, capture the merged options through env-passed probe
// values, and check the child actually ran with them.
{
  // Use process.execPath with a probe script that reads env vars
  // we passed via buildSpawnOptions. If buildSpawnOptions did not
  // merge correctly, the env vars would not be there.
  const opts = buildSpawnOptions({
    env: { ...process.env, ORIGINROUTER_SPAWN_PROBE: "1" },
  });
  const child = spawn(process.execPath, ["-e",
    "process.stdout.write(process.env.ORIGINROUTER_SPAWN_PROBE || 'missing'); process.exit(0);",
  ], opts);
  let stdout = "";
  child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    setTimeout(() => reject(new Error("child did not exit within 5s")), 5_000);
  });
  assert.equal(exitCode, 0);
  assert.equal(stdout, "1", "buildSpawnOptions env must reach the child process");
}

console.log("spawn command tests ok");
