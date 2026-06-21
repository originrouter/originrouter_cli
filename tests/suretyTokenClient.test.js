// Stage 9.3 — Surety token client tests.
//
// Spawns a tiny node:http Surety stub on 127.0.0.1, runs the client
// against it, and asserts the result. No real MySQL needed — the
// issue endpoint goes through the file-based store, which is
// initialized with a seed.
//
// Cases:
//   1. happy path -> {ok:true, token:"rt_...", expiresAt, tokenId, scopes:["relay.remote_coding"]}
//   2. surety returns {code:-1} -> {ok:false, error:"invalid_grant"}
//   3. surety returns 500 -> {ok:false, error:"surety_unavailable"}
//   4. surety connection refused -> {ok:false, error:"surety_unavailable"}
//   5. The fake server's captured body never logs the plaintext device-grant

import http from "node:http";
import assert from "node:assert/strict";
import { acquireRelayAccessToken } from "../src/auth/suretyTokenClient.js";

const PORT = 19000 + Math.floor(Math.random() * 1000);

function makeSurety(handler) {
  const captured = { bodies: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      captured.bodies.push(parsed);
      handler(req, res, parsed, captured);
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, "127.0.0.1", () => resolve({ server, captured }));
  });
}

try {
  // 1. happy path
  {
    const { server, captured } = await makeSurety((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            "relay-access-token": "rt_canary_token_xyz",
            "expires-at": 9999999999,
            "token-id": "tk_test_1",
            scopes: ["relay.remote_coding"],
          },
        }),
      );
    });
    const r = await acquireRelayAccessToken({
      suretyUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d-1",
      deviceGrant: "dg-canary",
    });
    assert.equal(r.ok, true);
    assert.equal(r.token, "rt_canary_token_xyz");
    assert.equal(r.tokenId, "tk_test_1");
    assert.deepEqual(r.scopes, ["relay.remote_coding"]);
    // 5. The captured body has the plaintext grant (we sent it);
    //    assert it does NOT appear in any captured log output
    //    (we don't write logs from the client, so this is just a
    //    sentinel: bodies are recorded, but the client never
    //    log.print()s them).
    assert.equal(captured.bodies.length, 1);
    assert.equal(captured.bodies[0]["device-grant"], "dg-canary");
    server.close();
    console.log("[1] happy path -> ok token ok");
  }

  // 2. invalid_grant
  {
    const { server } = await makeSurety((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: -1, msg: "invalid_grant" }));
    });
    const r = await acquireRelayAccessToken({
      suretyUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d-1",
      deviceGrant: "BAD",
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_grant");
    server.close();
    console.log("[2] -1 invalid_grant -> mapped ok");
  }

  // 3. surety 500
  {
    const { server } = await makeSurety((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: -9, msg: "internal_error" }));
    });
    const r = await acquireRelayAccessToken({
      suretyUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d-1",
      deviceGrant: "dg",
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "surety_unavailable");
    server.close();
    console.log("[3] 500 -> surety_unavailable ok");
  }

  // 4. connection refused (port with no server)
  {
    const r = await acquireRelayAccessToken({
      suretyUrl: `http://127.0.0.1:1`, // nothing listens
      deviceId: "d-1",
      deviceGrant: "dg",
      timeoutMs: 1000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "surety_unavailable");
    console.log("[4] connection refused -> surety_unavailable ok");
  }

  // 5. sanity: bodies are not logged
  {
    const originalLog = console.log;
    let loggedAnyText = "";
    console.log = (...args) => {
      loggedAnyText += args.join(" ") + "\n";
      originalLog(...args);
    };
    const { server } = await makeSurety((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 0,
          msg: "success",
          data: {
            "relay-access-token": "rt_secret_value_logged_test",
            "expires-at": 9999999999,
            "token-id": "tk_test_5",
            scopes: ["relay.remote_coding"],
          },
        }),
      );
    });
    await acquireRelayAccessToken({
      suretyUrl: `http://127.0.0.1:${PORT}`,
      deviceId: "d-1",
      deviceGrant: "dg_secret_grant_logged_test",
    });
    console.log = originalLog;
    server.close();
    // We never log the token or grant; the only captured "log" lines
    // in this test are the test runner's own `console.log` calls, which
    // we just rewrote to also capture text. The token value MUST NOT
    // appear in any captured text. (We just made a fresh server, so
    // nothing from the client itself would print token values.)
    assert.ok(
      !loggedAnyText.includes("rt_secret_value_logged_test"),
      "token leaked into log output",
    );
    assert.ok(
      !loggedAnyText.includes("dg_secret_grant_logged_test"),
      "grant leaked into log output",
    );
    console.log("[5] no log leak of token/grant ok");
  }

  console.log("surety token client ok");
} catch (err) {
  console.error("surety token client FAILED:", err.message);
  process.exitCode = 1;
}
