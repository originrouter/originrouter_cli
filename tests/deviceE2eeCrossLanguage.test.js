import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DeviceE2eeSession } from "../src/crypto/deviceE2eeEnvelope.js";
import { verifyDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import { deviceE2eeDirectoryHead } from "../src/security/deviceE2eeDirectoryCache.js";

const vector = JSON.parse(readFileSync(
  new URL("./fixtures/e2ee_v2_dart_vector.json", import.meta.url),
  "utf8",
));
const cliPublic = vector.cli.public_identity;
const local = {
  public_identity: cliPublic,
  signing_private_jwk: {
    kty: "OKP",
    crv: "Ed25519",
    d: vector.cli.signing_private_key,
    x: cliPublic.signing_public_key,
  },
  agreement_private_jwk: {
    kty: "OKP",
    crv: "X25519",
    d: vector.cli.agreement_private_key,
    x: cliPublic.agreement_public_key,
  },
};

assert.equal(verifyDeviceE2eeIdentity(vector.app.public_identity), true);
assert.equal(verifyDeviceE2eeIdentity(cliPublic), true);
assert.equal(deviceE2eeDirectoryHead({
  policy: { epoch: 1, new_device_approval_required: false },
  identities: [
    { ...vector.app.public_identity, trust_status: "trusted" },
    { ...cliPublic, trust_status: "trusted" },
  ],
}), "sha256:puaf9ceUlbwd3Gops_83GsKHaUUZLd4zq30_56J4h_0");
const accepted = DeviceE2eeSession.accept({
  local,
  peer: vector.app.public_identity,
  firstEnvelope: vector.envelope,
});
assert.equal(accepted.firstPayload.type, "agent.interaction.resolve");
assert.deepEqual(accepted.firstPayload.payload, {
  action: "allow",
  interactionId: "interaction-vector",
  sessionId: "agent-session-vector",
});

console.log("Dart to Node E2EE v2 vector ok");
