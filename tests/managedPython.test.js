import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ensureManagedPython,
  managedPythonStatus,
  MANAGED_PYTHON_VERSION,
} from "../src/runtime/managedPython.js";

test("managed Python detection is idempotent", async () => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-managed-python-"));
  try {
    const python = process.platform === "win32"
      ? join(root, "runtimes", "python", "cpython", "python.exe")
      : join(root, "runtimes", "python", "cpython", "bin", "python3.12");
    mkdirSync(dirname(python), { recursive: true });
    if (process.platform === "win32") {
      // The Windows download/install path is covered by platform acceptance
      // tests; a portable executable fixture is not available here.
      return;
    }
    writeFileSync(python, `#!/bin/sh\necho 'Python ${MANAGED_PYTHON_VERSION}'\n`);
    chmodSync(python, 0o755);

    const status = await managedPythonStatus(root);
    assert.equal(status.available, true);
    assert.equal(status.path, python);

    const ensured = await ensureManagedPython(root);
    assert.equal(ensured.alreadyInstalled, true);
    assert.equal(ensured.path, python);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed Python dry run does not download a runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "originrouter-managed-python-dry-"));
  try {
    const result = await ensureManagedPython(root, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.version, MANAGED_PYTHON_VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

