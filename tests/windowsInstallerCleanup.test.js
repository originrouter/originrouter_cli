import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("Windows installer timeout terminates the command and descendants", { skip: process.platform !== "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "originrouter installer O'Brien 中文 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, "fixture.cjs");
  const record = join(root, "pids.json");
  writeFileSync(fixture, `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const installer = fileURLToPath(new URL("../scripts/install.ps1", import.meta.url));
  const script = [
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    `$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(installer)},[ref]$tokens,[ref]$errors)`,
    "if ($errors.Count) { throw ($errors | Out-String) }",
    "$fn=$ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-WithSpinner' },$true)",
    "Invoke-Expression $fn.Extent.Text; function Write-InlineStatus {} function Clear-InlineStatus {}",
    `$timedOut=$false; try { Invoke-WithSpinner -FilePath ${quote(process.execPath)} -ArgumentList @(${quote(fixture)}) -Activity 'Fixture' -TimeoutSeconds 1 } catch { if ($_.Exception.Message -notmatch 'timed out after 1 seconds') { throw }; $timedOut=$true }`,
    "if (-not $timedOut) { throw 'Expected timeout' }",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 15_000, stdio: "pipe" });
  const pids = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("Windows installer stops the old daemon before replacing modules without calling the old CLI", { skip: process.platform !== "win32" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "originrouter preinstall O'Brien 中文 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  const called = join(root, "old-cli-called");
  writeFileSync(join(root, "bin", "originrouter.js"), `require('node:fs').writeFileSync(${JSON.stringify(called)}, 'called'); process.exit(1);`);
  const fixture = join(root, "fixture.cjs");
  const record = join(root, "pids.json");
  writeFileSync(fixture, `if (process.argv[4] === ${JSON.stringify(root)}) { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify([process.pid, child.pid])); } setInterval(() => {}, 1000);`);
  const owned = spawn(process.execPath, [fixture, "daemon", "--originrouter-service-home", root], { windowsHide: true, stdio: "ignore" });
  const other = spawn(process.execPath, [fixture, "daemon", "--originrouter-service-home", `${root} other`], { windowsHide: true, stdio: "ignore" });
  t.after(() => { owned.kill(); other.kill(); });
  for (let attempt = 0; attempt < 50 && !existsSync(record); attempt++) await delay(100);
  const pids = JSON.parse(readFileSync(record, "utf8"));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const installer = fileURLToPath(new URL("../scripts/install.ps1", import.meta.url));
  const script = [
    "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
    `$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(installer)},[ref]$tokens,[ref]$errors)`,
    "if ($errors.Count) { throw ($errors | Out-String) }",
    "$fn=$ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-PreviousOriginRouterService' },$true)",
    "Invoke-Expression $fn.Extent.Text",
    `Stop-PreviousOriginRouterService -PackageRoot ${quote(root)} -StateDir ${quote(root)} -TaskName 'OriginRouterAbsentPreinstall-${process.pid}'`,
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 15_000, stdio: "pipe" });
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.doesNotThrow(() => process.kill(other.pid, 0));
  assert.equal(existsSync(called), false);
});
