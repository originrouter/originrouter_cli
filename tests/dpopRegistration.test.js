// When the CLI may carry a proof, and what it does when it may.
//
// The rules are four, and each of them exists to keep a change here from
// reaching a service that knows nothing about DPoP:
//
//   * only the CLI's own control plane and relay;
//   * only the CLI's own token;
//   * only after a registration;
//   * only against a deployment this device has registered with.
//
// The rest of this file walks the four steps the CLI takes to register a
// key, against a server that behaves the way the real one does: it answers
// the status route, it takes a registration, and it refuses a proof it
// cannot check. A step that is wrong here is a step that leaves a device
// unable to talk to its own server.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDpopFetch,
  createDpopProofProvider,
  createDpopRecovery,
  deploymentFor,
  dpopAuthHeaders,
  dpopEnabled,
  ensureDpopRegistered,
  isDpopRefusal,
  originOf,
  recoverDpopRegistration,
  rewriteForDpop,
  usesDpopAudience,
} from "../src/security/dpopRegistration.js";
import {
  readDpopRegistration,
  readDpopStore,
  setDpopRegistration,
  writeDpopStore,
} from "../src/security/dpopStore.js";
import { ensureDeviceE2eeIdentity } from "../src/crypto/deviceE2eeIdentity.js";
import { dpopThumbprint, generateDpopKeyPair } from "../src/crypto/dpopIdentity.js";
import { activateAccount } from "../src/persistence/accounts.js";

const CONTROL_BASE = "https://app.easytransnote.com";
const TOKEN = "or_at_the_cli_token";
const DEVICE_ID = "cli-device-dpop";

function makeStateDir() {
  return mkdtempSync(join(tmpdir(), "originrouter-dpop-"));
}

function removeStateDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function withDpopSwitch(value, run) {
  const previous = process.env.ORIGINROUTER_DPOP;
  if (value === undefined) delete process.env.ORIGINROUTER_DPOP;
  else process.env.ORIGINROUTER_DPOP = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.ORIGINROUTER_DPOP;
    else process.env.ORIGINROUTER_DPOP = previous;
  }
}

/** A device that already holds a key and a registration for one deployment. */
function registerLocalKey(stateDir, { status = "active" } = {}) {
  const pair = generateDpopKeyPair();
  writeDpopStore(stateDir, {
    version: 1,
    key: { private_jwk: pair.privateJwk, public_jwk: pair.publicJwk },
    registrations: {},
  });
  const jkt = dpopThumbprint(pair.publicJwk);
  setDpopRegistration(stateDir, deploymentFor(CONTROL_BASE), {
    status,
    jkt,
    origin: CONTROL_BASE,
  });
  return { pair, jkt };
}

/**
 * A server that behaves the way the deployed one does.
 *
 * `status` decides what the status route answers: "unsupported" is a server
 * that has never heard of DPoP, "unavailable" is one that cannot store keys
 * yet, and anything else is the status and the thumbprint it holds.
 */
function makeFakeServer({
  status = "none",
  jkt = null,
  available = true,
  refuseProof = false,
} = {}) {
  const calls = [];
  const held = { status, jkt };
  const send = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers || {};
    calls.push({ method, path: parsed.pathname, headers, body: init.body || null });
    const reply = (statusCode, payload) => ({
      ok: statusCode >= 200 && statusCode < 300,
      status: statusCode,
      json: async () => payload,
    });
    if (parsed.pathname === "/cli/v1/dpop/status") {
      if (status === "unsupported") return reply(404, { detail: { code: "not_found" } });
      return reply(200, {
        code: 0,
        msg: "ok",
        data: {
          available,
          algorithms: ["EdDSA"],
          enforced_audiences: ["originrouter.control", "originrouter.relay"],
          status: held.status,
          jkt: held.jkt,
        },
      });
    }
    if (parsed.pathname === "/cli/v1/dpop/key" && method === "POST") {
      const body = JSON.parse(String(init.body || "{}"));
      held.status = "pending";
      held.jkt = dpopThumbprint(body.jwk);
      return reply(200, {
        code: 0,
        msg: "ok",
        data: { jkt: held.jkt, alg: body.alg, status: "pending" },
      });
    }
    if (parsed.pathname === "/cli/v1/dpop/proof" && method === "POST") {
      if (refuseProof) {
        return reply(401, { detail: { code: "dpop_proof_signature_invalid" } });
      }
      held.status = "active";
      return reply(200, {
        code: 0,
        msg: "ok",
        data: { status: "active", jkt: held.jkt },
      });
    }
    return reply(404, { detail: { code: "not_found" } });
  };
  return { calls, send, held };
}

test("the switch turns the whole thing off and nothing else", () => {
  assert.equal(dpopEnabled({}), true);
  assert.equal(dpopEnabled({ ORIGINROUTER_DPOP: "on" }), true);
  assert.equal(dpopEnabled({ ORIGINROUTER_DPOP: "true" }), true);
  for (const value of ["off", "0", "false", "no", "disabled", "OFF", " Off "]) {
    assert.equal(dpopEnabled({ ORIGINROUTER_DPOP: value }), false, value);
  }
});

test("the public aliases are one deployment and a WebSocket folds onto its origin", () => {
  assert.equal(
    originOf("wss://app.easytransnote.com/relay/v1/devices/d1/ws"),
    "https://app.easytransnote.com",
  );
  assert.equal(
    deploymentFor(`${CONTROL_BASE}/cli/v1/devices`),
    deploymentFor("https://app.originrouter.com/cli/v1/devices"),
  );
  // A deployment of its own is a deployment of its own: a key registered
  // with one is no use at another.
  assert.notEqual(
    deploymentFor(`${CONTROL_BASE}/cli/v1/devices`),
    deploymentFor("https://self-hosted.example.test/cli/v1/devices"),
  );
  assert.equal(
    deploymentFor("https://self-hosted.example.test/cli/v1/devices"),
    "https://self-hosted.example.test",
  );
  assert.equal(deploymentFor("not a url"), null);
});

test("only the control plane and the relay are asked for a proof", () => {
  assert.equal(usesDpopAudience(`${CONTROL_BASE}/cli/v1/devices`), true);
  assert.equal(usesDpopAudience(`${CONTROL_BASE}/relay/v1/messages`), true);
  // The AI, coding and memory audiences are checked by services that know
  // nothing about proofs. A request that arrives with a scheme they do not
  // read is a request they may refuse for the scheme alone.
  assert.equal(usesDpopAudience(`${CONTROL_BASE}/ai/v1/ai-audit/reviews`), false);
  assert.equal(usesDpopAudience("https://api.easytransnote.com/coding/v1/models"), false);
  assert.equal(usesDpopAudience(`${CONTROL_BASE}/memory/v1/notes`), false);
  assert.equal(usesDpopAudience("not a url"), false);
});

test("without a registration the request stays a bearer request", () => {
  const stateDir = makeStateDir();
  try {
    const headers = dpopAuthHeaders({
      stateDir,
      method: "GET",
      url: `${CONTROL_BASE}/cli/v1/devices`,
      token: TOKEN,
    });
    assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
  } finally {
    removeStateDir(stateDir);
  }
});

test("a registered key turns the request into a proof-carrying one", () => {
  const stateDir = makeStateDir();
  try {
    const { pair } = registerLocalKey(stateDir, { status: "pending" });
    const headers = dpopAuthHeaders({
      stateDir,
      method: "POST",
      url: `${CONTROL_BASE}/cli/v1/dpop/proof`,
      token: TOKEN,
    });
    assert.equal(headers.Authorization, `DPoP ${TOKEN}`);
    assert.ok(headers.DPoP, "the proof travels with the request");
    const [headerPart] = headers.DPoP.split(".");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    assert.equal(header.typ, "dpop+jwt");
    assert.deepEqual(header.jwk, pair.publicJwk);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a revoked key goes back to a bearer request", () => {
  const stateDir = makeStateDir();
  try {
    registerLocalKey(stateDir, { status: "revoked" });
    const headers = dpopAuthHeaders({
      stateDir,
      method: "GET",
      url: `${CONTROL_BASE}/cli/v1/devices`,
      token: TOKEN,
    });
    assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
  } finally {
    removeStateDir(stateDir);
  }
});

test("another service's token is not ours to re-scheme", () => {
  const stateDir = makeStateDir();
  try {
    registerLocalKey(stateDir);
    // A provider's API key is not the CLI's token, even on a path the CLI
    // itself would prove.
    const headers = dpopAuthHeaders({
      stateDir,
      method: "GET",
      url: `${CONTROL_BASE}/cli/v1/devices`,
      token: "sk-provider-key",
    });
    assert.deepEqual(headers, { Authorization: "Bearer sk-provider-key" });
  } finally {
    removeStateDir(stateDir);
  }
});

test("the switch off keeps every request a bearer request", () => {
  const stateDir = makeStateDir();
  try {
    registerLocalKey(stateDir);
    withDpopSwitch("off", () => {
      const headers = dpopAuthHeaders({
        stateDir,
        method: "GET",
        url: `${CONTROL_BASE}/cli/v1/devices`,
        token: TOKEN,
      });
      assert.deepEqual(headers, { Authorization: `Bearer ${TOKEN}` });
    });
  } finally {
    removeStateDir(stateDir);
  }
});

test("the wrapper rewrites only what it is allowed to rewrite", () => {
  const stateDir = makeStateDir();
  try {
    registerLocalKey(stateDir);

    const rewritten = rewriteForDpop(
      `${CONTROL_BASE}/cli/v1/devices`,
      { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } },
      { stateDir },
    );
    assert.ok(rewritten, "an enforced path is rewritten");
    assert.equal(rewritten.init.headers.authorization, `DPoP ${TOKEN}`);
    assert.ok(rewritten.init.headers.dpop);
    // The bearer header is replaced, not joined: a request that carried both
    // spellings would arrive with the two comma-separated.
    assert.equal(Object.keys(rewritten.init.headers).filter(
      (key) => key.toLowerCase() === "authorization",
    ).length, 1);

    // Everything else goes out exactly as it was written.
    assert.equal(
      rewriteForDpop(
        `${CONTROL_BASE}/ai/v1/ai-audit/reviews`,
        { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } },
        { stateDir },
      ),
      null,
    );
    assert.equal(
      rewriteForDpop(
        `${CONTROL_BASE}/cli/v1/devices`,
        { method: "GET", headers: { Authorization: "Bearer sk-provider" } },
        { stateDir },
      ),
      null,
    );
    assert.equal(
      rewriteForDpop(`${CONTROL_BASE}/cli/v1/devices`, { method: "GET" }, { stateDir }),
      null,
    );
  } finally {
    removeStateDir(stateDir);
  }
});

test("a Headers object is read the same way a plain object is", () => {
  const stateDir = makeStateDir();
  try {
    registerLocalKey(stateDir);
    const rewritten = rewriteForDpop(
      `${CONTROL_BASE}/cli/v1/devices`,
      { method: "GET", headers: new Headers({ Authorization: `Bearer ${TOKEN}` }) },
      { stateDir },
    );
    assert.ok(rewritten, "a Headers object carries the token too");
    assert.equal(rewritten.init.headers.authorization, `DPoP ${TOKEN}`);
    assert.ok(rewritten.init.headers.dpop);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a server without the routes leaves the device on bearer tokens", async () => {
  const stateDir = makeStateDir();
  try {
    const server = makeFakeServer({ status: "unsupported" });
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "unsupported");
    assert.equal(server.calls.length, 1, "nothing else was attempted");
    assert.equal(readDpopStore(stateDir), null);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a server that cannot store keys yet leaves the device on bearer tokens", async () => {
  const stateDir = makeStateDir();
  try {
    const server = makeFakeServer({ available: false });
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(server.calls.length, 1);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a failed status read never replaces or registers a key", async () => {
  const stateDir = makeStateDir();
  try {
    const { jkt } = registerLocalKey(stateDir);
    let calls = 0;
    const result = await ensureDpopRegistered({
      stateDir, controlBaseUrl: CONTROL_BASE, accessToken: TOKEN, deviceId: DEVICE_ID,
      fetchFn: async () => {
        calls++;
        return { ok: false, status: 503, json: async () => ({ detail: { code: 'dpop_registry_unavailable' } }) };
      },
    });
    assert.equal(result.status, 'refused');
    assert.equal(calls, 1);
    assert.equal(dpopThumbprint(readDpopStore(stateDir).key.public_jwk), jkt);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a device with no identity does not register a key", async () => {
  const stateDir = makeStateDir();
  try {
    const server = makeFakeServer();
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "no_identity");
    assert.equal(
      server.calls.some((call) => call.path === "/cli/v1/dpop/key"),
      false,
      "nothing was registered",
    );
  } finally {
    removeStateDir(stateDir);
  }
});

test("registering walks the four steps and ends up active", async () => {
  const stateDir = makeStateDir();
  try {
    ensureDeviceE2eeIdentity(stateDir, { deviceId: DEVICE_ID });
    const server = makeFakeServer();
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "active");
    const paths = server.calls.map((call) => `${call.method} ${call.path}`);
    assert.deepEqual(paths, [
      "GET /cli/v1/dpop/status",
      "POST /cli/v1/dpop/key",
      "POST /cli/v1/dpop/proof",
    ]);

    // The registration the server took is the key this device signs with,
    // and the binding was signed by the device's own long-term key.
    const registration = server.calls.find((call) => call.path === "/cli/v1/dpop/key");
    const body = JSON.parse(registration.body);
    assert.equal(body.alg, "EdDSA");
    assert.equal(body.jwk.kty, "OKP");
    assert.equal(body.jwk.crv, "Ed25519");
    assert.equal(body.binding.action, "register_dpop_key");
    assert.equal(body.binding.device_id, DEVICE_ID);
    assert.equal(body.binding.jkt, dpopThumbprint(body.jwk));
    assert.ok(body.binding.signature);

    // The proof that turns enforcement on travels with the `DPoP` scheme.
    const proof = server.calls.find((call) => call.path === "/cli/v1/dpop/proof");
    assert.equal(proof.headers.Authorization, `DPoP ${TOKEN}`);
    assert.ok(proof.headers.DPoP);

    // And the device remembers what it registered, so the next request
    // carries a proof without asking again.
    const local = readDpopRegistration(stateDir, deploymentFor(CONTROL_BASE));
    assert.equal(local.status, "active");
    assert.equal(local.jkt, dpopThumbprint(body.jwk));
  } finally {
    removeStateDir(stateDir);
  }
});

test("a key the server already holds is not registered again", async () => {
  const stateDir = makeStateDir();
  try {
    ensureDeviceE2eeIdentity(stateDir, { deviceId: DEVICE_ID });
    const { jkt } = registerLocalKey(stateDir);
    const server = makeFakeServer({ status: "active", jkt });
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "active");
    assert.deepEqual(server.calls.map((call) => call.path), ["/cli/v1/dpop/status"]);
    assert.equal(
      readDpopRegistration(stateDir, deploymentFor(CONTROL_BASE)).status,
      "active",
    );
  } finally {
    removeStateDir(stateDir);
  }
});

test("a key the server holds as pending is proved, not registered", async () => {
  const stateDir = makeStateDir();
  try {
    ensureDeviceE2eeIdentity(stateDir, { deviceId: DEVICE_ID });
    const { jkt } = registerLocalKey(stateDir, { status: "pending" });
    const server = makeFakeServer({ status: "pending", jkt });
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "active");
    assert.deepEqual(server.calls.map((call) => call.path), [
      "/cli/v1/dpop/status",
      "/cli/v1/dpop/proof",
    ]);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a proof the server refuses leaves the key pending, which enforces nothing", async () => {
  const stateDir = makeStateDir();
  try {
    ensureDeviceE2eeIdentity(stateDir, { deviceId: DEVICE_ID });
    const server = makeFakeServer({ refuseProof: true });
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "pending");
    assert.equal(result.code, "dpop_proof_signature_invalid");
    assert.equal(
      readDpopRegistration(stateDir, deploymentFor(CONTROL_BASE)).status,
      "pending",
    );
  } finally {
    removeStateDir(stateDir);
  }
});

test("a revoked key on the server is replaced with a new one", async () => {
  const stateDir = makeStateDir();
  try {
    ensureDeviceE2eeIdentity(stateDir, { deviceId: DEVICE_ID });
    const { jkt: oldJkt } = registerLocalKey(stateDir);
    const server = makeFakeServer({ status: "revoked", jkt: oldJkt });
    const result = await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(result.status, "active");
    const registration = server.calls.find((call) => call.path === "/cli/v1/dpop/key");
    const body = JSON.parse(registration.body);
    assert.notEqual(
      dpopThumbprint(body.jwk),
      oldJkt,
      "a revoked key is not signed with again",
    );
  } finally {
    removeStateDir(stateDir);
  }
});

test("recovery puts a key back in place after the server refused the old one", async () => {
  const stateDir = makeStateDir();
  try {
    ensureDeviceE2eeIdentity(stateDir, { deviceId: DEVICE_ID });
    const server = makeFakeServer();
    await ensureDpopRegistered({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(
      readDpopRegistration(stateDir, deploymentFor(CONTROL_BASE)).status,
      "active",
    );
    // The server lost the key — a reinstall, a restored backup. The device
    // drops what it remembers and registers again.
    server.held.status = "none";
    server.held.jkt = null;
    const recovered = await recoverDpopRegistration({
      stateDir,
      controlBaseUrl: CONTROL_BASE,
      accessToken: TOKEN,
      deviceId: DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(recovered.status, "active");
    assert.equal(
      server.calls.some((call) => call.path === "/cli/v1/dpop/key"),
      true,
    );
  } finally {
    removeStateDir(stateDir);
  }
});

test("a refusal that names DPoP is told apart from an ordinary failure", () => {
  assert.equal(isDpopRefusal(401, { detail: { code: "dpop_proof_required" } }), true);
  assert.equal(isDpopRefusal(401, { code: "dpop_key_not_registered" }), true);
  // This one means the server cannot store keys yet — a reason to wait,
  // not a reason to change what the request carries.
  assert.equal(isDpopRefusal(401, { detail: { code: "dpop_registry_unavailable" } }), false);
  assert.equal(isDpopRefusal(401, { detail: { code: "unauthorized" } }), false);
  assert.equal(isDpopRefusal(403, { detail: { code: "dpop_proof_required" } }), false);
  assert.equal(isDpopRefusal(500, { detail: { code: "dpop_proof_required" } }), false);
});

test("the proof provider answers the same way the wrapper does", async () => {
  const stateDir = makeStateDir();
  try {
    const provider = createDpopProofProvider({ stateDir });
    assert.equal(
      await provider({ method: "GET", url: `${CONTROL_BASE}/cli/v1/devices` }),
      null,
      "no token, no answer",
    );
    assert.deepEqual(
      await provider({ method: "GET", url: `${CONTROL_BASE}/cli/v1/devices`, token: TOKEN }),
      { Authorization: `Bearer ${TOKEN}` },
      "a token with no registration is a bearer request",
    );
    registerLocalKey(stateDir);
    const headers = await provider({
      method: "GET",
      url: `${CONTROL_BASE}/cli/v1/devices`,
      token: TOKEN,
    });
    assert.equal(headers.Authorization, `DPoP ${TOKEN}`);
    assert.ok(headers.DPoP);
  } finally {
    removeStateDir(stateDir);
  }
});

test("the wrapped fetch leaves a request it does not recognise alone", async () => {
  const stateDir = makeStateDir();
  try {
    const seen = [];
    const inner = async (input, init) => {
      seen.push({ input, init });
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const wrapped = createDpopFetch({ stateDir, fetchFn: inner });
    await wrapped(`${CONTROL_BASE}/ai/v1/ai-audit/reviews`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(seen[0].init.headers.DPoP, undefined);
    assert.equal(wrapped.dpop, true);
    assert.equal(wrapped.raw, inner);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a refusal that says the key is wrong is reported to the caller", async () => {
  const stateDir = makeStateDir();
  try {
    const refusals = [];
    const inner = async () => ({
      ok: false,
      status: 401,
      headers: new Headers({
        "www-authenticate": 'DPoP, error="dpop_key_mismatch"',
      }),
      json: async () => ({ detail: { code: "dpop_key_mismatch" } }),
    });
    const wrapped = createDpopFetch({
      stateDir,
      fetchFn: inner,
      onRefusal: async (refusal) => {
        refusals.push(refusal);
      },
    });
    await wrapped(`${CONTROL_BASE}/cli/v1/agent/approvals/decisions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refusals.length, 1, "the refusal is reported");
    assert.equal(refusals[0].code, "dpop_key_mismatch");
    assert.equal(refusals[0].status, 401);
    assert.match(refusals[0].url, /\/cli\/v1\/agent\/approvals\/decisions$/);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a read retries when registration completes during the first request", async () => {
  const stateDir = makeStateDir();
  try {
    const seen = [];
    let recovery = 0;
    const wrapped = createDpopFetch({ stateDir, onRefusal: () => { recovery++; }, fetchFn: async (_url, init) => {
      seen.push(init);
      if (seen.length === 1) {
        registerLocalKey(stateDir);
        return { status: 401, headers: new Headers({"www-authenticate": 'DPoP, error="dpop_proof_required"'}) };
      }
      return { status: 200, headers: new Headers() };
    }});
    const result = await wrapped(`${CONTROL_BASE}/cli/v1/devices`, { headers: {Authorization: `Bearer ${TOKEN}`} });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    assert.ok(seen[1].headers.dpop);
    assert.equal(recovery, 0);
  } finally { removeStateDir(stateDir); }
});

test("an unreadable DPoP store does not silently send a bearer request", async () => {
  const stateDir = makeStateDir();
  try {
    writeFileSync(join(stateDir, "dpop-key.json"), "{invalid");
    let requests = 0;
    const wrapped = createDpopFetch({ stateDir, fetchFn: async () => { requests++; return {status: 200}; } });
    await assert.rejects(() => wrapped(`${CONTROL_BASE}/cli/v1/devices`, {headers: {Authorization: `Bearer ${TOKEN}`}}), {code: "dpop_key_unavailable"});
    assert.equal(requests, 0);
  } finally { removeStateDir(stateDir); }
});

test("a delayed refusal cannot retry or recover using another account", async () => {
  const stateDir = makeStateDir();
  try {
    activateAccount(stateDir, "first");
    let calls = 0;
    let recovery = 0;
    const wrapped = createDpopFetch({ stateDir, onRefusal: () => { recovery++; }, fetchFn: async () => {
      calls++;
      activateAccount(stateDir, "second");
      registerLocalKey(stateDir);
      return { status: 401, headers: new Headers({"www-authenticate": 'DPoP, error="dpop_proof_required"'}) };
    }});
    const result = await wrapped(`${CONTROL_BASE}/cli/v1/devices`, { headers: {Authorization: `Bearer ${TOKEN}`} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.status, 401);
    assert.equal(calls, 1);
    assert.equal(recovery, 0);
  } finally { removeStateDir(stateDir); }
});

test("a mutation is not replayed when registration appears in flight", async () => {
  const stateDir = makeStateDir();
  try {
    let calls = 0;
    const wrapped = createDpopFetch({ stateDir, fetchFn: async () => {
      calls++;
      registerLocalKey(stateDir);
      return { status: 401, headers: new Headers({"www-authenticate": 'DPoP, error="dpop_proof_required"'}) };
    }});
    const result = await wrapped(`${CONTROL_BASE}/cli/v1/devices`, {method: "POST", body: "{}", headers: {Authorization: `Bearer ${TOKEN}`}});
    assert.equal(result.status, 401);
    assert.equal(calls, 1);
  } finally { removeStateDir(stateDir); }
});

test("a refusal that does not name the key is not reported", async () => {
  const stateDir = makeStateDir();
  try {
    const refusals = [];
    const inner = async () => ({
      ok: false,
      status: 401,
      headers: new Headers({ "www-authenticate": 'Bearer error="unauthorized"' }),
      json: async () => ({ detail: { code: "unauthorized" } }),
    });
    const wrapped = createDpopFetch({
      stateDir,
      fetchFn: inner,
      onRefusal: async (refusal) => {
        refusals.push(refusal);
      },
    });
    await wrapped(`${CONTROL_BASE}/cli/v1/agent/approvals/decisions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refusals.length, 0, "a refusal about the token is not the key's fault");
  } finally {
    removeStateDir(stateDir);
  }
});

test("a refusal outside the audiences that read proofs is not reported", async () => {
  const stateDir = makeStateDir();
  try {
    const refusals = [];
    const inner = async () => ({
      ok: false,
      status: 401,
      headers: new Headers({
        "www-authenticate": 'DPoP, error="dpop_proof_required"',
      }),
      json: async () => ({ detail: { code: "dpop_proof_required" } }),
    });
    const wrapped = createDpopFetch({
      stateDir,
      fetchFn: inner,
      onRefusal: async (refusal) => {
        refusals.push(refusal);
      },
    });
    await wrapped(`${CONTROL_BASE}/ai/v1/ai-audit/reviews`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refusals.length, 0, "a service that never asks for a proof cannot refuse one");
  } finally {
    removeStateDir(stateDir);
  }
});

test("the recovery reads what it needs when it runs, not when it is set up", async () => {
  const stateDir = makeStateDir();
  try {
    ensureDeviceE2eeIdentity(stateDir, { deviceId: DEVICE_ID });
    const server = makeFakeServer();
    let askedForBase = 0;
    let askedForToken = 0;
    const recovery = createDpopRecovery({
      stateDir,
      controlBaseUrl: () => {
        askedForBase += 1;
        return CONTROL_BASE;
      },
      accessToken: () => {
        askedForToken += 1;
        return TOKEN;
      },
      deviceId: () => DEVICE_ID,
      fetchFn: server.send,
    });
    assert.equal(askedForBase, 0, "setting the recovery up asks for nothing");
    assert.equal(askedForToken, 0, "setting the recovery up asks for nothing");

    const result = await recovery();
    assert.equal(askedForBase, 1);
    assert.equal(askedForToken, 1);
    assert.equal(result.status, "active", "the key is put back in place");
    assert.deepEqual(server.calls.map((call) => call.path), [
      "/cli/v1/dpop/status",
      "/cli/v1/dpop/key",
      "/cli/v1/dpop/proof",
    ]);
  } finally {
    removeStateDir(stateDir);
  }
});

test("a recovery with nothing to recover with does nothing", async () => {
  const stateDir = makeStateDir();
  try {
    const server = makeFakeServer();
    const recovery = createDpopRecovery({
      stateDir,
      controlBaseUrl: () => null,
      accessToken: () => null,
      deviceId: () => null,
      fetchFn: server.send,
    });
    assert.equal(await recovery(), null);
    assert.equal(server.calls.length, 0, "nothing was asked of the server");
  } finally {
    removeStateDir(stateDir);
  }
});
