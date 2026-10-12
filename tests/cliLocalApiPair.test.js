import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ensureDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import { startLocalApi } from "../src/local/localApi.js";
import { LocalPairingManager } from "../src/local/localPairing.js";
import {
  apiTokenPath,
  ensureApiToken,
  readApiToken,
} from "../src/persistence/authToken.js";
import { writeDaemonState } from "../src/persistence/state.js";

const runFile = promisify(execFile);
const stateDir = mkdtempSync(join(tmpdir(), "originrouter-cli-local-pair-test-"));
const previousHome = process.env.ORIGINROUTER_HOME;
process.env.ORIGINROUTER_HOME = stateDir;
const env = { ...process.env, ORIGINROUTER_HOME: stateDir };
const bin = join(process.cwd(), "bin/originrouter.js");
const deviceId = "device-0123456789abcdef0123456789abcdef";
let server;

function pairingLineFrom(output) {
  return output.match(/ORIGINROUTER_LOCAL_PAIR_V1:[A-Za-z0-9_-]+/)?.[0] || "";
}

function decodePairingLine(line) {
  const encoded = line.slice("ORIGINROUTER_LOCAL_PAIR_V1:".length);
  const bytes = Buffer.from(encoded, "base64url");
  const signatureOffset = bytes.length - 64;
  let offset = 0;
  const flags = bytes[offset++];
  const expiresAtSeconds = bytes.readUInt32BE(offset); offset += 4;
  const port = bytes.readUInt16BE(offset); offset += 2;
  const kind = flags & 3;
  let host;
  if (kind === 0) host = "127.0.0.1";
  else if (kind === 1) host = "localhost";
  else if (kind === 2) host = "::1";
  else { const length = bytes[offset++]; host = bytes.subarray(offset, offset + length).toString(); offset += length; }
  const ticket = bytes.subarray(offset, offset + 16).toString("base64url");
  return {
    version: 1,
    protocol: "originrouter-local-pair-v1",
    endpoint: `${(flags & 4) ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${port}`,
    expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
    ticket,
    unsigned: bytes.subarray(0, signatureOffset),
  };
}

async function run(args) {
  const result = await runFile(process.execPath, [bin, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  return result.stdout;
}

try {
  writeFileSync(join(stateDir, "device.json"), JSON.stringify({
    deviceId,
    host: "test-machine",
    displayName: "Test machine · CLI",
    platform: "test",
    verificationStatus: "verified",
  }), { mode: 0o600 });
  ensureApiToken(stateDir);
  const identity = ensureDeviceE2eeIdentity(stateDir, { deviceId });
  const pairingManager = new LocalPairingManager({
    identityProvider: () => identity,
    accessTokenProvider: () => readApiToken(stateDir),
    deviceNameProvider: () => "Test machine · CLI",
  });
  server = await startLocalApi({
    stateDir,
    sessionManager: {},
    bindAddress: "127.0.0.1",
    deviceId,
    localPairingManager: pairingManager,
  }, {
    port: 0,
    apiTokenPath: apiTokenPath(stateDir),
  });
  writeDaemonState({
    pid: process.pid,
    localApiPort: server.port,
    localApiBindAddress: "127.0.0.1",
    localApiBaseUrl: `http://127.0.0.1:${server.port}`,
  });

  // The default is the short code: an 8-character Crockford value plus a QR
  // the App can scan. It never contains the access key, and its address is a
  // suggestion the App lets the user edit.
  const shortOutput = await run(["local", "api", "pair"]);
  const shortJson = JSON.parse(await run(["local", "api", "pair", "--json"]));
  assert.equal(shortJson.version, 2);
  assert.match(shortJson.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.match(shortJson.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(shortJson.signing_public_key, identity.public_identity.signing_public_key);
  assert.equal(shortJson.suggested_port, server.port);
  assert.ok(shortJson.suggested_host, "a suggested host is required");
  assert.match(
    shortJson.deep_link,
    /^originrouter:\/\/pair\?v=1&h=[^&]+&p=\d+&c=[0-9A-HJKMNP-TV-Z]{8}&k=[A-Za-z0-9_-]{43}&e=\d+$/,
  );
  // The QR is what the App reads; the address is only ever a suggestion.
  assert.ok(!shortJson.deep_link.includes(readApiToken(stateDir)));

  assert.doesNotMatch(shortOutput, new RegExp(readApiToken(stateDir)));
  assert.doesNotMatch(shortOutput, new RegExp(deviceId));
  // Each run mints its own code, so the two outputs cannot be compared by
  // value — only by shape.
  const printedCode = shortOutput.match(/\b[0-9A-HJKMNP-TV-Z]{8}\b/)?.[0];
  assert.ok(printedCode, "the code must be printed for anyone not scanning");
  assert.match(shortOutput, new RegExp(`Address\\s+\\S+:${server.port}`));
  assert.match(shortOutput, new RegExp(`Code\\s+${printedCode}`));
  assert.match(shortOutput, /expires in 5 minutes/i);
  assert.match(shortOutput, /never printed/i);
  assert.match(shortOutput, /edit the address/i);
  // A terminal QR is block glyphs; the absence of them means the render is
  // missing, which would leave the user with nothing to scan.
  assert.match(shortOutput, /[▀▄█]/);

  // Redeeming the short code over plain HTTP must work, since that is what the
  // App does after a scan. It is unauthenticated by design — the code is the
  // credential.
  const appKeyPair = generateKeyPairSync("x25519");
  const shortRedeem = await fetch(
    `http://127.0.0.1:${server.port}/local/pair/redeem`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: shortJson.code,
        app_ephemeral_public_key:
          appKeyPair.publicKey.export({ format: "jwk" }).x,
        request_nonce: randomBytes(24).toString("base64url"),
      }),
    },
  );
  assert.equal(shortRedeem.status, 200, "a short code must redeem");
  assert.equal((await shortRedeem.json()).ok, true);

  // `--line` keeps the original signed pairing line, for anything that still
  // expects one — including the daemon binding to loopback, which is what the
  // suggested host works around.
  const output = await run(["local", "api", "pair", "--line"]);
  const pairingLine = pairingLineFrom(output);
  assert.ok(pairingLine, "--line output must include an App pairing line");
  assert.doesNotMatch(output, new RegExp(readApiToken(stateDir)));
  assert.doesNotMatch(output, new RegExp(deviceId));
  assert.doesNotMatch(output, /^URL:/m);
  assert.doesNotMatch(output, /^Port:/m);
  assert.doesNotMatch(output, /^Bearer token:/m);
  assert.doesNotMatch(output, /^Device ID:/m);
  assert.match(output, /access key is not printed or embedded/i);
  assert.match(output, /expires in 5 minutes/i);
  assert.match(output, /copy the pairing line below/i);

  const decoded = decodePairingLine(pairingLine);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.protocol, "originrouter-local-pair-v1");
  assert.equal(decoded.endpoint, `http://127.0.0.1:${server.port}`);
  assert.match(decoded.ticket, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Object.hasOwn(decoded, "bearer_token"), false);

  const unauthenticatedIssue = await fetch(
    `http://127.0.0.1:${server.port}/local/pair/tickets`,
    { method: "POST" },
  );
  assert.equal(unauthenticatedIssue.status, 401);
  const unauthenticatedShort = await fetch(
    `http://127.0.0.1:${server.port}/local/pair/short`,
    { method: "POST" },
  );
  assert.equal(unauthenticatedShort.status, 401);

  const redeem = await fetch(
    `http://127.0.0.1:${server.port}/local/pair/redeem`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: decoded.ticket,
        app_ephemeral_public_key:
          appKeyPair.publicKey.export({ format: "jwk" }).x,
        request_nonce: randomBytes(24).toString("base64url"),
      }),
    },
  );
  const redeemBody = await redeem.json();
  assert.equal(redeem.status, 200);
  assert.equal(redeemBody.ok, true);
  assert.equal(Object.hasOwn(redeemBody, "bearer_token"), false);
  assert.match(redeemBody.ciphertext, /^[A-Za-z0-9_-]+$/);

  const jsonOutput = JSON.parse(await run(["local", "api", "pair", "--line", "--json"]));
  assert.equal(jsonOutput.version, 1);
  assert.match(jsonOutput.pairing_line, /^ORIGINROUTER_LOCAL_PAIR_V1:/);
  assert.match(jsonOutput.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(jsonOutput.credential_files.access_key, join(stateDir, "local-api.token"));
  assert.equal(Object.hasOwn(jsonOutput, "bearer_token"), false);
  assert.equal(Object.hasOwn(jsonOutput, "device_id"), false);
  assert.equal(Object.hasOwn(jsonOutput, "url"), false);
  assert.equal(Object.hasOwn(jsonOutput, "port"), false);
  assert.equal(Object.hasOwn(shortJson, "bearer_token"), false);
  assert.equal(Object.hasOwn(shortJson, "device_id"), false);
} finally {
  await server?.close();
  rmSync(stateDir, { recursive: true, force: true });
  if (previousHome == null) delete process.env.ORIGINROUTER_HOME;
  else process.env.ORIGINROUTER_HOME = previousHome;
}

console.log("cli local API pairing output ok");
