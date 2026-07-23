import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptRemoteCodingRequest,
  decryptRemoteCodingResponse,
  encryptRemoteCodingRequest,
  encryptRemoteCodingResponse,
  generateRemoteCodingIdentity,
  verifyAndPinRemotePublicKey,
} from "../src/crypto/remoteCodingE2ee.js";
import { handleRemoteCodingRequest } from "../src/daemon/remoteCodingServer.js";

const caller = "caller-device";
const worker = "worker-device";
const requestId = "req-e2ee-1";
const workerIdentity = generateRemoteCodingIdentity();
const sensitivePrompt = "secret prompt that the relay must never see";

const encrypted = encryptRemoteCodingRequest({
  sourceDeviceId: caller,
  targetDeviceId: worker,
  requestId,
  targetPublicKey: workerIdentity.publicKey,
  payload: {
    runtime: "claude",
    method: "POST",
    path: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ prompt: sensitivePrompt })).toString("base64"),
  },
});

assert.equal(encrypted.envelope.protocol, "e2ee-v1");
assert.equal(encrypted.envelope.sequence, 0);
assert.equal(JSON.stringify(encrypted.envelope).includes(sensitivePrompt), false);
assert.equal("method" in encrypted.envelope, false);
assert.equal("path" in encrypted.envelope, false);
assert.equal("body" in encrypted.envelope, false);

const opened = decryptRemoteCodingRequest(encrypted.envelope, workerIdentity);
assert.equal(opened.payload.method, "POST");
assert.equal(
  JSON.parse(Buffer.from(opened.payload.body, "base64").toString("utf8")).prompt,
  sensitivePrompt,
);

const start = encryptRemoteCodingResponse(opened.context, "remote.coding.response.start", {
  status: 200,
  headers: { "content-type": "text/event-stream" },
});
const chunk = encryptRemoteCodingResponse(opened.context, "remote.coding.response.chunk", {
  chunk: Buffer.from("private model answer").toString("base64"),
});
const end = encryptRemoteCodingResponse(opened.context, "remote.coding.response.end", {});
assert.equal(JSON.stringify(chunk).includes("private model answer"), false);

const startPlain = decryptRemoteCodingResponse(encrypted.context, start);
assert.equal(startPlain.status, 200);
const chunkPlain = decryptRemoteCodingResponse(encrypted.context, chunk);
assert.equal(Buffer.from(chunkPlain.chunk, "base64").toString("utf8"), "private model answer");
decryptRemoteCodingResponse(encrypted.context, end);

assert.throws(
  () => decryptRemoteCodingResponse(encrypted.context, end),
  (error) => error?.code === "e2ee_replay_detected",
);

const tampered = { ...encrypted.envelope };
const bytes = Buffer.from(tampered.ciphertext, "base64");
bytes[0] ^= 1;
tampered.ciphertext = bytes.toString("base64");
assert.throws(
  () => decryptRemoteCodingRequest(tampered, workerIdentity),
  (error) => error?.code === "e2ee_auth_failed",
);

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-e2ee-pin-"));
try {
  verifyAndPinRemotePublicKey(stateDir, worker, workerIdentity.publicKey);
  verifyAndPinRemotePublicKey(stateDir, worker, workerIdentity.publicKey);
  const replacement = generateRemoteCodingIdentity();
  assert.throws(
    () => verifyAndPinRemotePublicKey(stateDir, worker, replacement.publicKey),
    (error) => error?.code === "e2ee_key_mismatch",
  );
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

const relayedResponses = [];
const workerEncrypted = encryptRemoteCodingRequest({
  sourceDeviceId: caller,
  targetDeviceId: worker,
  requestId: "req-worker-roundtrip",
  targetPublicKey: workerIdentity.publicKey,
  payload: {
    runtime: "claude",
    method: "POST",
    path: "/v1/messages",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}", "utf8").toString("base64"),
  },
});
const workerResult = await handleRemoteCodingRequest(workerEncrypted.envelope, {
  relayClient: {
    async send(type, payload) {
      relayedResponses.push({ type, ...payload });
      return { ok: true };
    },
  },
  localProxyUrl: "http://127.0.0.1:40124",
  deviceId: worker,
  e2eePolicy: "required",
  e2eeIdentity: workerIdentity,
  fetchFn: async (url, init) => {
    assert.equal(url, "http://127.0.0.1:40124/v1/messages");
    assert.equal(init.method, "POST");
    return new Response("private worker response", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  },
});
assert.equal(workerResult.ok, true);
assert.deepEqual(
  relayedResponses.map((event) => event.type),
  [
    "remote.coding.response.start",
    "remote.coding.response.chunk",
    "remote.coding.response.end",
  ],
);
assert.equal(relayedResponses.every((event) => event.protocol === "e2ee-v1"), true);
const workerStart = decryptRemoteCodingResponse(
  workerEncrypted.context,
  relayedResponses[0],
);
assert.equal(workerStart.status, 200);
const workerChunk = decryptRemoteCodingResponse(
  workerEncrypted.context,
  relayedResponses[1],
);
assert.equal(
  Buffer.from(workerChunk.chunk, "base64").toString("utf8"),
  "private worker response",
);
decryptRemoteCodingResponse(workerEncrypted.context, relayedResponses[2]);

let plaintextFetchCalled = false;
const plaintextResponses = [];
const plaintextResult = await handleRemoteCodingRequest({
  type: "remote.coding.request",
  requestId: "plaintext-rejected",
  sourceDeviceId: caller,
  targetDeviceId: worker,
  method: "POST",
  path: "/v1/messages",
}, {
  relayClient: {
    async send(type, payload) {
      plaintextResponses.push({ type, ...payload });
      return { ok: true };
    },
  },
  localProxyUrl: "http://127.0.0.1:40124",
  deviceId: worker,
  e2eePolicy: "required",
  e2eeIdentity: workerIdentity,
  fetchFn: async () => {
    plaintextFetchCalled = true;
    return new Response("should not run");
  },
});
assert.equal(plaintextResult.code, "e2ee_required");
assert.equal(plaintextFetchCalled, false);
assert.equal(plaintextResponses[0].code, "e2ee_required");

console.log("remote coding e2ee tests ok");
