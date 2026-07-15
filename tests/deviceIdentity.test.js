import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureDevice } from "../src/persistence/state.js";

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), "originrouter-device-id-"));
  const previous = process.env.ORIGINROUTER_HOME;
  process.env.ORIGINROUTER_HOME = home;
  try { return run(home); } finally {
    if (previous === undefined) delete process.env.ORIGINROUTER_HOME;
    else process.env.ORIGINROUTER_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("device ID is random-looking and stable for one installation", () => {
  withHome(() => {
    const first = ensureDevice();
    const second = ensureDevice();
    assert.match(first.deviceId, /^device-[0-9a-f]{32}$/);
    assert.equal(second.deviceId, first.deviceId);
  });
});

test("an existing stable ID is preserved without probing hardware", () => {
  withHome((home) => {
    const existing = "device-0123456789abcdef0123456789abcdef";
    writeFileSync(join(home, "device.json"), JSON.stringify({ deviceId: existing }));
    assert.equal(ensureDevice().deviceId, existing);
  });
});

test("legacy local-dev placeholder is replaced once", () => {
  withHome((home) => {
    writeFileSync(join(home, "device.json"), JSON.stringify({ deviceId: "local-dev" }));
    const device = ensureDevice();
    assert.match(device.deviceId, /^device-[0-9a-f]{32}$/);
    assert.notEqual(device.deviceId, "local-dev");
  });
});
