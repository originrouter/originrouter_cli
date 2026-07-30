import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
  signDeviceE2eeLocalChallenge,
} from "../src/crypto/deviceE2eeIdentity.js";
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
assert.deepEqual(bootstrap.auth_methods, [
  "device_signature_v1",
  "local_access_key_v1",
]);
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

const signedBootstrap = gateway.createChallenge({
  appDeviceId: app.public_identity.device_id,
  appKeyId: app.public_identity.key_id,
});
const signedAuthorization = gateway.authorize({
  challengeId: signedBootstrap.challenge.challenge_id,
  appIdentity: app.public_identity,
  authMethod: "device_signature_v1",
  deviceProof: signDeviceE2eeLocalChallenge(app, signedBootstrap.challenge),
});
assert.equal(signedAuthorization.auth_method, "device_signature_v1");
assert.equal(signedAuthorization.trust_context, deviceE2eeDirectoryHead(cachedDirectory));
const signedSession = DeviceE2eeSession.initiate({
  local: app,
  peer: cli.public_identity,
  sessionId: "e2s_local_signed_test",
});
writeApiToken(stateDir, "d".repeat(64));
const signedRequestAfterAccessKeyRotation = signedSession.seal(
  "local.rpc.request",
  {
    requestId: "rpc-signed-after-key-rotation",
    method: "GET",
    path: "/local/status",
    query: {},
  },
  { routing: { directory_head: signedAuthorization.trust_context } },
);
const signedResponseAfterAccessKeyRotation = await gateway.handleEnvelope(
  signedRequestAfterAccessKeyRotation,
  { localPort: 3000 },
);
assert.equal(
  signedSession.open(signedResponseAfterAccessKeyRotation).type,
  "local.rpc.response",
);
writeApiToken(stateDir, token);

// A fully local deployment has no coding-key.json and no account directory.
// Possession of the explicitly entered access key authenticates the App's
// self-signed device identity without granting any account/Relay trust.
const offlineStateDir = join(root, "offline-state");
const offlineToken = "b".repeat(64);
writeApiToken(offlineStateDir, offlineToken);
let offlineInternalRequest = null;
const offlineGateway = new DeviceE2eeLocalGateway({
  stateDir: offlineStateDir,
  localIdentity: cli,
  fetchFn: async (url, options) => {
    offlineInternalRequest = { url: String(url), options };
    return new Response(JSON.stringify({ ok: true, mode: "offline" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
});
const offlineBootstrap = offlineGateway.createChallenge({
  appDeviceId: app.public_identity.device_id,
  appKeyId: app.public_identity.key_id,
});
const offlineAuthorization = offlineGateway.authorize({
  challengeId: offlineBootstrap.challenge.challenge_id,
  appIdentity: app.public_identity,
  authMethod: "local_access_key_v1",
  hmacProof: localE2eeChallengeProof(offlineToken, offlineBootstrap.challenge),
});
assert.equal(offlineAuthorization.auth_method, "local_access_key_v1");
assert.match(offlineAuthorization.trust_context, /^local:[A-Za-z0-9_-]+$/);
const offlineSession = DeviceE2eeSession.initiate({
  local: app,
  peer: cli.public_identity,
  sessionId: "e2s_local_offline_test",
});
const offlineRequest = offlineSession.seal("local.rpc.request", {
  requestId: "rpc-offline",
  method: "GET",
  path: "/local/status",
  query: {},
}, { routing: { directory_head: offlineAuthorization.trust_context } });
const offlineResponse = await offlineGateway.handleEnvelope(offlineRequest, {
  localPort: 3000,
});
assert.equal(
  offlineInternalRequest.options.headers.Authorization,
  `Bearer ${offlineToken}`,
);
assert.equal(
  offlineSession.open(offlineResponse).payload.body.mode,
  "offline",
);

// Rotating the manually shared local access key must immediately invalidate
// sessions authenticated with that key. Account device-signature sessions do
// not depend on this credential and remain unaffected.
writeApiToken(offlineStateDir, "c".repeat(64));
const requestAfterAccessKeyRotation = offlineSession.seal("local.rpc.request", {
  requestId: "rpc-offline-after-key-rotation",
  method: "GET",
  path: "/local/status",
  query: {},
}, { routing: { directory_head: offlineAuthorization.trust_context } });
await assert.rejects(
  () => offlineGateway.handleEnvelope(requestAfterAccessKeyRotation, {
    localPort: 3000,
  }),
  (error) => error?.code === "local_access_key_changed",
);

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

// A daemon may stay running while login or `security rotate` replaces the
// identity file. The next handshake must use the new key and invalidate every
// challenge/session created under the previous private key.
let liveCliIdentity = cli;
const hotReloadGateway = new DeviceE2eeLocalGateway({
  stateDir,
  localIdentity: cli,
  localIdentityProvider: () => liveCliIdentity,
});
const staleBootstrap = hotReloadGateway.createChallenge({
  appDeviceId: app.public_identity.device_id,
  appKeyId: app.public_identity.key_id,
});
const rotation = prepareDeviceE2eeRotation(join(root, "cli"), {
  deviceId: cli.public_identity.device_id,
});
liveCliIdentity = rotation.next;
rotation.commit();
const freshBootstrap = hotReloadGateway.createChallenge({
  appDeviceId: app.public_identity.device_id,
  appKeyId: app.public_identity.key_id,
});
assert.equal(
  freshBootstrap.cli_identity.key_id,
  rotation.next.public_identity.key_id,
);
assert.equal(hotReloadGateway.identityStatus("cli-device").keyVersion, 2);
assert.throws(
  () => hotReloadGateway.authorize({
    challengeId: staleBootstrap.challenge.challenge_id,
    appIdentity: app.public_identity,
    hmacProof: localE2eeChallengeProof(token, staleBootstrap.challenge),
  }),
  /challenge expired/,
);

console.log("device E2EE local gateway tests ok");
