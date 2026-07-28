import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeviceE2eeSession } from "../src/crypto/deviceE2eeEnvelope.js";
import { ensureDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";

const appDir = mkdtempSync(join(tmpdir(), "originrouter-e2ee-app-"));
const cliDir = mkdtempSync(join(tmpdir(), "originrouter-e2ee-cli-"));
try {
  const app = ensureDeviceE2eeIdentity(appDir, { deviceId: "app-device" });
  const cli = ensureDeviceE2eeIdentity(cliDir, { deviceId: "cli-device" });

  const initiator = DeviceE2eeSession.initiate({
    local: app,
    peer: cli.public_identity,
    sessionId: "e2s_test",
  });
  const first = initiator.seal("agent.message", {
    message: "server must not read this",
  });
  assert.equal(JSON.stringify(first).includes("server must not read"), false);

  const accepted = DeviceE2eeSession.accept({
    local: cli,
    peer: app.public_identity,
    firstEnvelope: first,
  });
  assert.equal(accepted.firstPayload.payload.message, "server must not read this");

  const response = accepted.session.seal("agent.stream.event", {
    text: "encrypted response",
  });
  assert.equal(initiator.open(response).payload.text, "encrypted response");
  assert.throws(() => initiator.open(response), /sequence mismatch/);

  const tampered = { ...first, type: "agent.interaction.resolve" };
  assert.throws(
    () => DeviceE2eeSession.accept({
      local: cli,
      peer: app.public_identity,
      firstEnvelope: tampered,
    }),
    /signature/,
  );
} finally {
  rmSync(appDir, { recursive: true, force: true });
  rmSync(cliDir, { recursive: true, force: true });
}

console.log("device e2ee envelope tests ok");
