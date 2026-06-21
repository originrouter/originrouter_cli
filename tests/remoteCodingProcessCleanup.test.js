// Stage 9.2.1 — Process cleanup audit.
//
// Spawns a real `node` child that runs the same lifecycle the local
// `originrouter claude` / `originrouter codex` wrapper does for a
// remote route: start a `RemoteCodingProxyManager`, capture the bound
// port, then exit. After the child exits, we assert:
//
//   1. The port the manager bound is no longer listening
//      (EADDRINUSE on a fresh bind).
//   2. No child process with that pid is alive (process.kill(pid, 0)
//      returns ESRCH).
//   3. The same audit passes when the child exits via SIGINT,
//      SIGTERM, and a thrown uncaught exception.

import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The script the child runs. It does exactly what localAgentSession.js
// does in the remote path, then exits.
const SCRIPT = `
import { RemoteCodingProxyManager } from "./src/proxy/remoteCodingProxyManager.js";
import { writeFileSync } from "node:fs";

const statusPath = process.env.STATUS_PATH;
const exitMode = process.env.EXIT_MODE || "normal";

const mgr = new RemoteCodingProxyManager({
  stateDir: process.env.HOME,
  relayUrl: "http://127.0.0.1:0", // no real relay needed; we only need a bound port
  deviceId: "caller-cleanup",
});
const r = await mgr.start();
if (!r.ok) {
  writeFileSync(statusPath, JSON.stringify({ ok: false, error: r.error }));
  process.exit(1);
}
writeFileSync(statusPath, JSON.stringify({ ok: true, port: r.port, pid: process.pid }));

if (exitMode === "normal") {
  await mgr.stop();
  process.exit(0);
}
if (exitMode === "sigint") {
  process.kill(process.pid, "SIGINT");
}
if (exitMode === "sigterm") {
  process.kill(process.pid, "SIGTERM");
}
if (exitMode === "throw") {
  // Simulate an uncaught exception in the local wrapper. This is
  // the path the user wants verified: does the manager get cleaned
  // up when the wrapper crashes?
  setTimeout(() => { throw new Error("simulated uncaught exception"); }, 50);
}
`;

const TMP = mkdtempSync(join(tmpdir(), "or-codeprocess-"));

function isPortListening(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));   // port in use
    s.once("listening", () => { s.close(() => resolve(false)); });
    s.listen(port, "127.0.0.1");
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function runChild(mode) {
  const statusPath = join(TMP, `status-${mode}.json`);
  const child = spawn("node", ["--input-type=module", "-e", SCRIPT], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      STATUS_PATH: statusPath,
      EXIT_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false;
  child.on("exit", () => { exited = true; });
  // Wait for status file to be written (max 2s).
  for (let i = 0; i < 40; i++) {
    if (exited) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Wait for child to actually exit.
  if (!exited) {
    await once(child, "exit");
  }
  const status = JSON.parse(readFileSync(statusPath, "utf8"));
  return { status, child };
}

try {
  for (const mode of ["normal", "sigint", "sigterm", "throw"]) {
    const { status, child } = await runChild(mode);
    assert.equal(status.ok, true, `[${mode}] manager failed to start: ${JSON.stringify(status)}`);
    const { port, pid } = status;

    // Brief grace period for kernel to reap / sockets to close.
    await new Promise((r) => setTimeout(r, 100));

    // 1. Port is free.
    const inUse = await isPortListening(port);
    assert.equal(inUse, false, `[${mode}] port ${port} still listening after exit; pid=${pid} childExitCode=${child.exitCode}`);

    // 2. Pid is dead.
    const alive = isPidAlive(pid);
    assert.equal(alive, false, `[${mode}] pid ${pid} still alive after exit`);

    console.log(`[cleanup] ${mode}: port=${port} pid=${pid} exit=${child.exitCode} → ok`);
  }
  console.log("remote coding process cleanup ok");
} catch (err) {
  console.error("remote coding process cleanup FAILED:", err.message);
  process.exitCode = 1;
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
