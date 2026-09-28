// Offline coverage for the Windows spawn-target resolution in PtyExecutor.
//
// What this file proves:
//   1. Off Windows, the spawn target passes through unchanged.
//   2. On Windows, a bare name that resolves to a .cmd shim is routed
//      through cmd.exe /d /s /c with a pre-quoted command line (the same
//      shape spawnCommand uses) — ConPTY's CreateProcess cannot run .cmd
//      shims and fails with "File not found: <name>" otherwise.
//   3. On Windows, a bare name that resolves to a real non-shim file is
//      replaced with its absolute path.
//   4. On Windows, a name that resolves to nothing passes through
//      unchanged (the spawn fails as before).
//
// The fake "install directory" is a real temp dir so resolveWindowsCommand's
// fs.statSync checks succeed on any development platform.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePtySpawnTarget } from "../src/executors/ptyExecutor.js";

const WIN = { platform: "win32" };

function withFakeInstallDir(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "or-pty-win-"));
  try {
    for (const name of files) {
      fs.writeFileSync(path.join(dir, name), "");
    }
    const previousPath = process.env.PATH;
    const previousExt = process.env.PATHEXT;
    process.env.PATH = dir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    try {
      run(dir);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previousExt;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("non-Windows platforms pass the spawn target through unchanged", () => {
  for (const platform of ["darwin", "linux", "freebsd"]) {
    assert.deepEqual(
      resolvePtySpawnTarget("claude", ["--settings", "x.json"], { platform }),
      { command: "claude", args: ["--settings", "x.json"] },
    );
  }
});

test("Windows routes a bare name resolving to a .cmd shim through cmd.exe", () => {
  withFakeInstallDir(["claude.cmd"], (dir) => {
    const target = resolvePtySpawnTarget("claude", ["--settings", "x.json"], WIN);
    assert.equal(target.command, "cmd.exe");
    assert.deepEqual(target.args, [
      "/d", "/s", "/c",
      `"${path.join(dir, "claude.cmd")} --settings x.json"`,
    ]);
  });
});

test("Windows replaces a bare name resolving to a real executable with its path", () => {
  withFakeInstallDir(["claude.exe"], (dir) => {
    const target = resolvePtySpawnTarget("claude", [], WIN);
    assert.equal(target.command, path.join(dir, "claude.exe"));
    assert.deepEqual(target.args, []);
  });
});

test("Windows passes an unresolved bare name through unchanged", () => {
  withFakeInstallDir([], () => {
    assert.deepEqual(
      resolvePtySpawnTarget("missing-agent", [], WIN),
      { command: "missing-agent", args: [] },
    );
  });
});

test("Windows routes an explicit .cmd path through cmd.exe", () => {
  withFakeInstallDir([], (dir) => {
    const shimPath = path.join(dir, "claude.cmd");
    const target = resolvePtySpawnTarget(shimPath, [], WIN);
    assert.equal(target.command, "cmd.exe");
    assert.deepEqual(target.args, ["/d", "/s", "/c", `"${shimPath}"`]);
  });
});
