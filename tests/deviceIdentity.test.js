import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cliDeviceDisplayName,
  defaultDeviceDisplayName,
  ensureDevice,
  isStaleDeviceId,
  readDevice,
} from "../src/persistence/state.js";

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
    assert.equal(first.displayName, defaultDeviceDisplayName());
  });
});

test("an existing stable ID is preserved without probing hardware", () => {
  withHome((home) => {
    const existing = "device-0123456789abcdef0123456789abcdef";
    writeFileSync(
      join(home, "device.json"),
      JSON.stringify({ deviceId: existing, host: "192.168.1.4" }),
    );
    const device = ensureDevice();
    assert.equal(device.deviceId, existing);
    assert.equal(device.host, "192.168.1.4");
    assert.equal(device.displayName, defaultDeviceDisplayName());
    const persisted = JSON.parse(readFileSync(join(home, "device.json"), "utf8"));
    assert.equal(persisted.deviceId, existing);
    assert.equal(persisted.host, "192.168.1.4");
    assert.equal(persisted.displayName, defaultDeviceDisplayName());
  });
});

test("an existing custom display name gains the CLI client suffix", () => {
  withHome((home) => {
    const existing = {
      deviceId: "device-0123456789abcdef0123456789abcdef",
      host: "192.168.1.4",
      displayName: "Office Mac",
    };
    writeFileSync(join(home, "device.json"), JSON.stringify(existing));
    assert.deepEqual(ensureDevice(), {
      ...existing,
      displayName: "Office Mac · CLI",
    });
  });
});

test("legacy username-at-IP labels migrate before the next login", () => {
  withHome((home) => {
    writeFileSync(join(home, "device.json"), JSON.stringify({
      deviceId: "device-0123456789abcdef0123456789abcdef",
      host: "192.168.1.5",
      displayName: "alice@192.168.1.5",
    }));
    const migrated = readDevice();
    assert.match(migrated.displayName, / · CLI$/);
    assert.equal(migrated.displayName.includes("192.168.1.5"), false);
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

test("legacy default argument cannot create a new local-dev installation", () => {
  withHome(() => {
    const device = ensureDevice("local-dev");
    assert.match(device.deviceId, /^device-[0-9a-f]{32}$/);
  });
});

test("login can detect legacy placeholder ids without committing a replacement", () => {
  assert.equal(isStaleDeviceId("local-dev"), true);
  assert.equal(isStaleDeviceId("local-dev-old"), true);
  assert.equal(isStaleDeviceId("device-0123456789abcdef0123456789abcdef"), false);
});

test("macOS prefers ComputerName over an IP-shaped hostname", () => {
  const name = defaultDeviceDisplayName({
    platformName: "darwin",
    hostnameValue: "192.168.1.5",
    runCommand(command, args) {
      assert.equal(command, "scutil");
      assert.deepEqual(args, ["--get", "ComputerName"]);
      return "chengaoyan's MacBook Pro\n";
    },
  });
  assert.equal(name, "chengaoyan's MacBook Pro · CLI");
});

test("Windows uses the user-visible computer name", () => {
  assert.equal(defaultDeviceDisplayName({
    platformName: "win32",
    hostnameValue: "10.0.0.8",
    env: { COMPUTERNAME: "OFFICE-SURFACE" },
  }), "OFFICE-SURFACE · CLI");
});

test("Linux prefers PRETTY_HOSTNAME and falls back away from IP addresses", () => {
  assert.equal(defaultDeviceDisplayName({
    platformName: "linux",
    hostnameValue: "172.16.0.2",
    readText: () => 'PRETTY_HOSTNAME="Build workstation"\n',
    runCommand: () => "",
  }), "Build workstation · CLI");
  assert.equal(defaultDeviceDisplayName({
    platformName: "linux",
    hostnameValue: "172.16.0.2",
    readText: () => "",
    runCommand: () => "",
  }), "OriginRouter device · CLI");
});

test("client suffix distinguishes CLI without duplicating it", () => {
  assert.equal(cliDeviceDisplayName("Office Mac"), "Office Mac · CLI");
  assert.equal(cliDeviceDisplayName("Office Mac · CLI"), "Office Mac · CLI");
});
