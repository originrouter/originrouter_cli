import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
