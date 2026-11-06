// Which requests the CLI proves, checked against a server that asks.
//
// The other DPoP tests check the rules one at a time. This one checks the
// wiring: it runs the CLI's real code paths — the fetch wrapper, the relay
// client, the caller-side relay client — against a server that behaves the
// way the deployed one does. A bearer request to an enforced path is
// refused there, exactly as it is refused in production, and a service that
// knows nothing about proofs refuses a scheme it does not read.
//
// So a change that re-schemes a request the server does not enforce, or
// forgets to re-scheme one it does, fails here rather than in the field.
//
// Cases:
//   1. the wrapper proves a request to the control plane
//   2. the wrapper leaves a request to the AI audience alone
//   3. the wrapper leaves another service's token alone
//   4. the relay client proves the message it posts
//   5. the relay client proves the WebSocket handshake
//   6. the caller-side relay client proves the e2ee directory read
//   7. the caller-side relay client proves the message it posts
//   8. without a registration the same requests stay bearer, and are refused

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  createDpopFetch,
  createDpopProofProvider,
  deploymentFor,
  installDpopFetch,
} from "../src/security/dpopRegistration.js";
import {
  setDpopRegistration,
  writeDpopStore,
} from "../src/security/dpopStore.js";
import { dpopThumbprint, generateDpopKeyPair } from "../src/crypto/dpopIdentity.js";
import { RelayClient } from "../src/relay/relayClient.js";
import { RemoteCodingRelayClient } from "../src/relay/remoteCodingRelayClient.js";

const TOKEN = "or_at_the_cli_token";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check a proof the way the server checks it.
 *
 * The claims are compared against the request that actually arrived, and the
 * signature is checked against the key the proof carries.
 */
function verifyProof(proof, { method, url, token }) {
  const parts = String(proof || "").split(".");
  if (parts.length !== 3) return { ok: false, code: "dpop_proof_malformed" };
  const [headerPart, payloadPart, signaturePart] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return { ok: false, code: "dpop_proof_malformed" };
  }
  if (header.typ !== "dpop+jwt") return { ok: false, code: "dpop_proof_malformed" };
  if (header.alg !== "EdDSA") {
    return { ok: false, code: "dpop_proof_unsupported_algorithm" };
  }
  if (payload.ath !== createHash("sha256").update(String(token)).digest("base64url")) {
    return { ok: false, code: "dpop_proof_ath_mismatch" };
  }
  if (payload.htm !== method) return { ok: false, code: "dpop_proof_htm_mismatch" };
  const parsed = new URL(url);
  const expected = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  if (payload.htu !== expected) return { ok: false, code: "dpop_proof_htu_mismatch" };
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key: header.jwk, format: "jwk" }),
      Buffer.from(signaturePart, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: "dpop_proof_signature_invalid" };
  return { ok: true, jkt: dpopThumbprint(header.jwk) };
}

/**
 * A server that behaves the way the deployed one does.
 *
 * The control plane and the relay are enforced: a bearer request to them is
 * refused with `dpop_proof_required`, and a proof that does not belong to
 * the request is refused with the reason it failed. Everything else is a
 * service that has never heard of a proof, and refuses a scheme it does not
 * read — which is why the CLI must not re-scheme those requests.
 */
function makeControlPlane() {
  const seen = [];
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "ping" }));
    setTimeout(() => ws.close(), 30);
  });

  const judge = (record) => {
    const enforced = record.path.startsWith("/cli/v1/")
      || record.path.startsWith("/relay/v1/");
    const authorization = String(record.headers.authorization || "");
    const scheme = authorization.split(/\s+/)[0] || "";
    const token = authorization.slice(scheme.length + 1).trim();
    if (!enforced) {
      if (scheme !== "Bearer") return { ok: false, code: "unknown_scheme" };
      return { ok: true };
    }
    if (scheme === "Bearer") return { ok: false, code: "dpop_proof_required" };
    if (scheme !== "DPoP") return { ok: false, code: "unknown_scheme" };
    if (!record.headers.dpop) return { ok: false, code: "dpop_proof_required" };
    return verifyProof(record.headers.dpop, {
      method: record.method,
      url: record.url,
      token,
    });
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const record = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
        url: `http://${req.headers.host}${req.url}`,
      };
      seen.push(record);
      const verdict = judge(record);
      if (!verdict.ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: { code: verdict.code } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { protocol: "e2ee-v1" } }));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const record = {
      method: "GET",
      path: req.url,
      headers: req.headers,
      body: "",
      url: `ws://${req.headers.host}${req.url}`,
    };
    seen.push(record);
    const verdict = judge(record);
    if (!verdict.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        wss,
        seen,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          wss.close();
          server.close(() => done());
        }),
      });
    });
  });
}

function registerLocalKey(stateDir, baseUrl) {
  const pair = generateDpopKeyPair();
  writeDpopStore(stateDir, {
    version: 1,
    key: { private_jwk: pair.privateJwk, public_jwk: pair.publicJwk },
    registrations: {},
  });
  const jkt = dpopThumbprint(pair.publicJwk);
  setDpopRegistration(stateDir, deploymentFor(baseUrl), {
    status: "active",
    jkt,
    origin: baseUrl,
  });
  return { pair, jkt };
}

test("the wrapper proves a request to the control plane", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const wrapped = createDpopFetch({ stateDir });
    const response = await wrapped(`${plane.baseUrl}/cli/v1/devices`, {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.headers.authorization, `DPoP ${TOKEN}`);
    assert.ok(record.headers.dpop);
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the wrapper leaves a request to the AI audience alone", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const wrapped = createDpopFetch({ stateDir });
    const response = await wrapped(`${plane.baseUrl}/ai/v1/ai-audit/reviews`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(record.headers.dpop, undefined);
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the wrapper leaves another service's token alone", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const wrapped = createDpopFetch({ stateDir });
    const response = await wrapped(`${plane.baseUrl}/cli/v1/devices`, {
      method: "GET",
      headers: { Authorization: "Bearer sk-provider-key" },
    });
    assert.equal(response.status, 401);
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.headers.authorization, "Bearer sk-provider-key");
    assert.equal(record.headers.dpop, undefined);
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the relay client proves the message it posts", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const client = new RelayClient({
      relayUrl: plane.baseUrl,
      deviceId: "device-1",
      authToken: TOKEN,
      proofProvider: createDpopProofProvider({ stateDir }),
    });
    await client.send("test", { foo: "bar" });
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.path, "/relay/v1/messages");
    assert.equal(record.headers.authorization, `DPoP ${TOKEN}`);
    assert.ok(record.headers.dpop);
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the relay client proves the WebSocket handshake", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const client = new RelayClient({
      relayUrl: plane.baseUrl,
      deviceId: "device-1",
      authToken: TOKEN,
      proofProvider: createDpopProofProvider({ stateDir }),
    });
    const connected = client.connectEvents(() => {});
    await delay(150);
    const record = plane.seen.find((item) => item.path.includes("/ws"));
    assert.ok(record, "the handshake reached the server");
    assert.equal(record.headers.authorization, `DPoP ${TOKEN}`);
    assert.ok(record.headers.dpop);
    await connected;
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the caller-side relay client proves the e2ee directory read", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const client = new RemoteCodingRelayClient({
      relayUrl: plane.baseUrl,
      deviceId: "device-1",
      authToken: TOKEN,
      proofProvider: createDpopProofProvider({ stateDir }),
    });
    await client.getTargetE2ee("target-1");
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.path, "/relay/v1/devices/target-1/e2ee");
    assert.equal(record.headers.authorization, `DPoP ${TOKEN}`);
    assert.ok(record.headers.dpop);
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the caller-side relay client proves the message it posts", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const client = new RemoteCodingRelayClient({
      relayUrl: plane.baseUrl,
      deviceId: "device-1",
      authToken: TOKEN,
      proofProvider: createDpopProofProvider({ stateDir }),
    });
    const result = await client.publishRequest({
      type: "remote.coding.request",
      requestId: "req-1",
      targetDeviceId: "target-1",
    });
    assert.equal(result.status, 200);
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.path, "/relay/v1/messages");
    assert.equal(record.headers.authorization, `DPoP ${TOKEN}`);
    assert.ok(record.headers.dpop);
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("without a registration the same requests stay bearer, and are refused", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  try {
    // No key, no registration: the device is where it was before this
    // existed, and the server refuses it because it has told the server
    // nothing about a key.
    const client = new RelayClient({
      relayUrl: plane.baseUrl,
      deviceId: "device-1",
      authToken: TOKEN,
      proofProvider: createDpopProofProvider({ stateDir }),
    });
    await assert.rejects(() => client.send("test", {}));
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(record.headers.dpop, undefined);
  } finally {
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the installed wrapper is the one every request goes out through", async () => {
  const plane = await makeControlPlane();
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-dpop-wire-"));
  const originalFetch = globalThis.fetch;
  try {
    registerLocalKey(stateDir, plane.baseUrl);
    const wrapped = installDpopFetch({ stateDir, fetchFn: originalFetch });
    assert.equal(globalThis.fetch, wrapped);
    const response = await globalThis.fetch(`${plane.baseUrl}/cli/v1/devices`, {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const record = plane.seen[plane.seen.length - 1];
    assert.equal(record.headers.authorization, `DPoP ${TOKEN}`);
    // A second call keeps the wrapper in place and updates where it reads.
    const again = installDpopFetch({ stateDir, fetchFn: originalFetch });
    assert.equal(globalThis.fetch, again);
    assert.equal(again.options.stateDir, stateDir);
  } finally {
    globalThis.fetch = originalFetch;
    await plane.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
