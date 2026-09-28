import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildWindowsStopCommand, buildWindowsTaskXml } from "../src/commands/service.js";

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 15_000, stdio: "pipe" });
}

function runTask(options) {
  const launcherPath = fileURLToPath(new URL("../bin/originrouter-windows-service.js", import.meta.url));
  const xml = buildWindowsTaskXml({ ...options, launcherPath });
  const encoded = xml.match(/--encoded-command ([^<]+)<\/Arguments>/)[1];
  return execFileSync("wscript.exe", ["//B", "//NoLogo", "//E:JScript", launcherPath, "--encoded-command", encoded], { timeout: 15_000, stdio: "pipe" });
}

test("Windows task wrapper logs output and preserves failure exit codes", { skip: process.platform !== "win32" }, (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter task O'Brien 中文 "));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cliPath = join(stateDir, "CLI & test.cjs");
  const stdoutPath = join(stateDir, "out.log");
  const stderrPath = join(stateDir, "err.log");
  writeFileSync(cliPath, 'console.log(JSON.stringify(process.argv.slice(2))); console.error("fixture error"); process.exitCode = 23;');
  assert.throws(() => runTask({ nodePath: process.execPath, cliPath, stdoutPath, stderrPath, stateDir }), (error) => error.status === 23);
  assert.deepEqual(JSON.parse(readFileSync(stdoutPath, "utf8")), ["daemon", "--originrouter-service-home", stateDir]);
  assert.match(readFileSync(stderrPath, "utf8"), /fixture error/);
  assert.throws(() => runTask({ nodePath: join(stateDir, "missing.exe"), cliPath, stdoutPath, stderrPath, stateDir }), (error) => error.status === 1);
  assert.ok(readFileSync(stderrPath, "utf8").length > "fixture error".length);
  writeFileSync(join(stateDir, "service-start-failed"), "failed");
  // A scheduled retry must stop without starting even an invalid executable.
  runTask({ nodePath: join(stateDir, "missing.exe"), cliPath, stdoutPath, stderrPath, stateDir });
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

test("Windows stop waits when the termination command returns before process exit", { skip: process.platform !== "win32" }, async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter delayed stop "));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cliPath = join(stateDir, "daemon.cjs");
  const readyPath = join(stateDir, "ready");
  writeFileSync(cliPath, `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [cliPath, "daemon", "--originrouter-service-home", stateDir], { windowsHide: true, stdio: "ignore" });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 50; attempt++) {
    try { readFileSync(readyPath); break; } catch { await delay(100); }
  }
  const killerPath = join(stateDir, "delayed-kill.ps1");
  writeFileSync(killerPath, `$script = 'Start-Sleep -Milliseconds 600; & taskkill.exe /PID ' + $args[1] + ' /T /F | Out-Null'; $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script)); $info = New-Object Diagnostics.ProcessStartInfo; $info.FileName = 'powershell.exe'; $info.Arguments = '-NoProfile -EncodedCommand ' + $encoded; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; [Diagnostics.Process]::Start($info) | Out-Null; $global:LASTEXITCODE = 128; Write-Error 'fixture: early termination error';`);
  powershell(buildWindowsStopCommand({ cliPath, stateDir, taskName: `OriginRouterDelayedStop-${process.pid}`, taskkillPath: killerPath }));
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
});

test("Windows stop reports a process that cannot be terminated", { skip: process.platform !== "win32" }, async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter denied stop "));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cliPath = join(stateDir, "daemon.cjs");
  const readyPath = join(stateDir, "ready");
  writeFileSync(cliPath, `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready'); setInterval(() => {}, 1000);`);
  const child = spawn(process.execPath, [cliPath, "daemon", "--originrouter-service-home", stateDir], { windowsHide: true, stdio: "ignore" });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 50; attempt++) {
    try { readFileSync(readyPath); break; } catch { await delay(100); }
  }
  const killerPath = join(stateDir, "denied-kill.ps1");
  writeFileSync(killerPath, "$global:LASTEXITCODE = 1; Write-Error 'fixture: termination denied';");
  assert.throws(() => powershell(buildWindowsStopCommand({ cliPath, stateDir, taskName: `OriginRouterDeniedStop-${process.pid}`, taskkillPath: killerPath })), (error) => error.status === 1 && error.stderr.toString().includes("did not exit within 5000ms"));
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});
