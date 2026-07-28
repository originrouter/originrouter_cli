import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import { DeviceE2eeSession } from "../src/crypto/deviceE2eeEnvelope.js";
import { writeApiToken } from "../src/persistence/authToken.js";
import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import {
  deviceE2eeDirectoryHead,
  storeDeviceE2eeDirectoryCache,
} from "../src/security/deviceE2eeDirectoryCache.js";
import {
  DeviceE2eeLocalGateway,
  localE2eeChallengeProof,
} from "../src/local/deviceE2eeLocalGateway.js";

const root = mkdtempSync(join(tmpdir(), "originrouter-local-e2ee-"));
const app = ensureDeviceE2eeIdentity(join(root, "app"), { deviceId: "app-device" });
const cli = ensureDeviceE2eeIdentity(join(root, "cli"), { deviceId: "cli-device" });
const stateDir = join(root, "state");
const token = "a".repeat(64);
writeApiToken(stateDir, token);
const credential = {
  kind: "oauth",
  clientId: "originrouter_cli",
  source: "originrouter_cli",
  deviceId: "cli-device",
  sessionId: "or_ses_local_e2ee",
  refreshToken: "or_rt_test",
  refreshExpiresAt: Date.now() + 60_000,
  tokenEndpoint: "https://example.invalid/token",
  revocationEndpoint: "https://example.invalid/revoke",
  accessTokens: Object.fromEntries(
    ["control", "ai", "coding", "relay"].map((key) => [key, {
      token: `or_at_${key}`,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    }]),
  ),
};
writeCodingAuth(stateDir, credential);
const cachedDirectory = storeDeviceE2eeDirectoryCache(stateDir, {
  policy: { epoch: 1, new_device_approval_required: false },
  identities: [
    { ...app.public_identity, trust_status: "trusted" },
    { ...cli.public_identity, trust_status: "trusted" },
  ],
}, { namespace: credential.sessionId });

let internalRequest = null;
const gateway = new DeviceE2eeLocalGateway({
  stateDir,
  localIdentity: cli,
  fetchFn: async (url, options) => {
    internalRequest = { url: String(url), options };
    return new Response(JSON.stringify({ sessions: [{ session_id: "secret" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
const bootstrap = gateway.createChallenge({
  appDeviceId: app.public_identity.device_id,
  appKeyId: app.public_identity.key_id,
});
gateway.authorize({
  challengeId: bootstrap.challenge.challenge_id,
  appIdentity: app.public_identity,
  hmacProof: localE2eeChallengeProof(token, bootstrap.challenge),
});

const session = DeviceE2eeSession.initiate({
  local: app,
  peer: cli.public_identity,
  sessionId: "e2s_local_rpc_test",
});
const request = session.seal("local.rpc.request", {
  requestId: "rpc-1",
  method: "GET",
  path: "/agent/local/sessions",
  query: {},
}, { routing: { directory_head: deviceE2eeDirectoryHead(cachedDirectory) } });
assert.equal(JSON.stringify(request).includes("agent/local/sessions"), false);
const responseEnvelope = await gateway.handleEnvelope(request, { localPort: 3000 });
assert.equal(internalRequest.options.headers.Authorization, `Bearer ${token}`);
const opened = session.open(responseEnvelope);
assert.equal(opened.type, "local.rpc.response");
assert.equal(opened.payload.body.sessions[0].session_id, "secret");

let activeRequests = 0;
let maxActiveRequests = 0;
let internalCalls = 0;
let releaseFirst;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
gateway.fetchFn = async (url) => {
  internalCalls += 1;
  activeRequests += 1;
  maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
  if (String(url).includes("request=first")) await firstGate;
  activeRequests -= 1;
  return new Response(JSON.stringify({ call: internalCalls }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const firstConcurrent = session.seal("local.rpc.request", {
  requestId: "rpc-2",
  method: "GET",
  path: "/agent/local/sessions",
  query: { request: "first" },
}, { routing: { directory_head: deviceE2eeDirectoryHead(cachedDirectory) } });
const secondConcurrent = session.seal("local.rpc.request", {
  requestId: "rpc-3",
  method: "GET",
  path: "/agent/local/sessions",
  query: { request: "second" },
}, { routing: { directory_head: deviceE2eeDirectoryHead(cachedDirectory) } });
const firstResponse = gateway.handleEnvelope(firstConcurrent, { localPort: 3000 });
const secondResponse = gateway.handleEnvelope(secondConcurrent, { localPort: 3000 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(internalCalls, 1);
assert.equal(maxActiveRequests, 1);
releaseFirst();
session.open(await firstResponse);
session.open(await secondResponse);
assert.equal(internalCalls, 2);
assert.equal(maxActiveRequests, 1);

console.log("device E2EE local gateway tests ok");
