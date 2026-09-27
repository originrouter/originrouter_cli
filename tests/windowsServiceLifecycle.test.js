import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildWindowsStopCommand, buildWindowsTaskXml } from "../src/commands/service.js";

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 15_000, stdio: "pipe" });
}

function wrapper(options) {
  const xml = buildWindowsTaskXml(options);
  return Buffer.from(xml.match(/-EncodedCommand ([^<]+)<\/Arguments>/)[1], "base64").toString("utf16le");
}

test("Windows task wrapper logs output and preserves failure exit codes", { skip: process.platform !== "win32" }, (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter task O'Brien 中文 "));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cliPath = join(stateDir, "CLI & test.cjs");
  const stdoutPath = join(stateDir, "out.log");
  const stderrPath = join(stateDir, "err.log");
  writeFileSync(cliPath, 'console.log(JSON.stringify(process.argv.slice(2))); console.error("fixture error"); process.exitCode = 23;');
  assert.throws(() => powershell(wrapper({ nodePath: process.execPath, cliPath, stdoutPath, stderrPath, stateDir })), (error) => error.status === 23);
  assert.deepEqual(JSON.parse(readFileSync(stdoutPath, "utf8")), ["daemon", "--originrouter-service-home", stateDir]);
  assert.match(readFileSync(stderrPath, "utf8"), /fixture error/);
  assert.throws(() => powershell(wrapper({ nodePath: join(stateDir, "missing.exe"), cliPath, stdoutPath, stderrPath, stateDir })), (error) => error.status === 1);
  assert.ok(readFileSync(stderrPath, "utf8").length > "fixture error".length);
  writeFileSync(join(stateDir, "service-start-failed"), "failed");
  // A scheduled retry must stop without starting even an invalid executable.
  powershell(wrapper({ nodePath: join(stateDir, "missing.exe"), cliPath, stdoutPath, stderrPath, stateDir }));
});

test("Windows stop finds a daemon without state and kills its descendants, preserving another home", { skip: process.platform !== "win32" }, async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter stop O'Brien 中文 "));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cliPath = join(stateDir, "daemon fixture.cjs");
  const childPath = join(stateDir, "child.pid");
  writeFileSync(cliPath, `if (process.argv[4] === ${JSON.stringify(stateDir)}) { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); require('node:fs').writeFileSync(${JSON.stringify(childPath)}, String(child.pid)); } setInterval(() => {}, 1000);`);
  const owned = spawn(process.execPath, [cliPath, "daemon", "--originrouter-service-home", stateDir], { windowsHide: true, stdio: "ignore" });
  const other = spawn(process.execPath, [cliPath, "daemon", "--originrouter-service-home", `${stateDir} other`], { windowsHide: true, stdio: "ignore" });
  t.after(() => { owned.kill(); other.kill(); });
  let descendant;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { descendant = Number(readFileSync(childPath, "utf8")); break; } catch { await delay(100); }
  }
  assert.ok(descendant > 0, "fixture must start its child");
  powershell(buildWindowsStopCommand({ cliPath, stateDir, taskName: `OriginRouterAbsentTest-${process.pid}` }));
  assert.throws(() => process.kill(owned.pid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(other.pid, 0));
});
