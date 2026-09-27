import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWindowsElevationCommand } from "../src/commands/service.js";

test("Windows elevated service wrapper forwards install and uninstall failures", { skip: process.platform !== "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-elevation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliPath = join(root, "CLI 中文 O'Brien & test.cjs");
  const resultPath = join(root, "args.json");
  writeFileSync(cliPath, `require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(process.argv.slice(2))); process.exitCode = 23;`);
  // Exercise real Windows PowerShell process/argument handling without
  // asking CI to approve a UAC prompt. Elevation is tested on the user PC.
  for (const action of ["install", "uninstall"]) {
    const command = buildWindowsElevationCommand({ nodePath: process.execPath, cliPath, action }).replace(" -Verb RunAs", "");
    let status = 0;
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { timeout: 15_000, stdio: "pipe" });
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 23);
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), ["service", action, "--originrouter-elevated"]);
  }
});
