// Stage 9.2.1 — Secret-leak audit.
//
// Sends a real remote.coding.request through a real spawned
// originrouter-server, carrying a known prompt and a canary
// authorization + x-api-key. Fetches /debug/events afterwards and
// asserts the ring contains:
//   - the request envelope (type=remote.coding.request) with
//     headers replaced by { "<masked>": true } and body replaced
//     by null
//   - NO instance of the prompt substring
//   - NO instance of the canary API key
//   - NO `authorization` value with the canary token
//   - NO raw prompt text
//   - NO instance of the "Bearer " prefix combined with the canary
//
// The relay's only path to the body is via the `remember()` ring
// entry; the test inspects that ring's stringified form. If the
// sanitizer regresses (forgets to mask, forgets to null body, leaks
// the canary), this test fails loudly.

import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import http from "node:http";

const PORT = 17787 + Math.floor(Math.random() * 1000);
const PROMPT_CANARY = `the-secret-prompt-content-${Math.random().toString(36).slice(2, 10)}`;
const KEY_CANARY    = `sk-probe-leak-canary-${Math.random().toString(36).slice(2, 10)}`;

const serverProcess = spawn(
  "node",
  ["../originrouter-server/src/server.js"],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), ORIGINROUTER_RELAY_AUTH: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let started = false;
serverProcess.stdout.on("data", (chunk) => {
  if (chunk.toString("utf8").includes("listening")) started = true;
});
serverProcess.stderr.on("data", (chunk) => process.stderr.write(chunk));

for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 50));
if (!started) {
  serverProcess.kill();
  console.error("relay did not start");
  process.exit(1);
}

function postJson(path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1", port: PORT, path, method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed = {};
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed = {};
          try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

try {
  // Step 1: send the canary request (target_offline is fine — the ring
  // records the request envelope regardless of worker state).
  const requestId = `req-leak-${Date.now()}`;
  const requestBody = JSON.stringify({
    messages: [{ role: "user", content: PROMPT_CANARY }],
  });
  const r = await postJson("/device/message", {
    type: "remote.coding.request",
    requestId,
    sourceDeviceId: "caller-leak",
    targetDeviceId: "worker-leak",
    runtime: "claude",
    method: "POST",
    path: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${KEY_CANARY}`,
      "x-api-key": KEY_CANARY,
      "anthropic-version": "2023-06-01",
    },
    body: Buffer.from(requestBody).toString("base64"),
  });
  // We don't care about the response (target_offline or 200). What
  // matters is the request was recorded in the ring.
  assert.equal(r.status, 200);

  // Step 2: fetch the debug ring and inspect.
  const ring = await getJson("/debug/events");
  assert.equal(ring.status, 200);
  const ringStr = JSON.stringify(ring.body);

  // The canary prompt must NEVER appear.
  assert.ok(
    !ringStr.includes(PROMPT_CANARY),
    `prompt leaked into /debug/events ring: ${ringStr.slice(0, 400)}...`
  );
  // The canary API key value must NEVER appear.
  assert.ok(
    !ringStr.includes(KEY_CANARY),
    `API key leaked into /debug/events ring: ${ringStr.slice(0, 400)}...`
  );
  // No "Bearer " prefix with the canary token.
  assert.ok(
    !ringStr.includes(`Bearer ${KEY_CANARY}`),
    `authorization Bearer leaked into /debug/events ring`
  );

  // The ring entry's shape: find our specific request, assert headers masked
  // and body null.
  const events = (ring.body.events || []).filter((e) => e.type === "remote.coding.request");
  const ourEvent = events.find((e) => e.requestId === requestId);
  assert.ok(ourEvent, `our request not in ring; saw: ${JSON.stringify(events.map((e) => e.requestId))}`);
  assert.deepEqual(ourEvent.headers, { "<masked>": true });
  assert.equal(ourEvent.body, null);

  // No request event in the ring should expose ANY non-masked header.
  for (const e of events) {
    assert.equal(typeof e.headers, "object");
    assert.deepEqual(e.headers, { "<masked>": true }, `event ${e.requestId} headers not masked: ${JSON.stringify(e.headers)}`);
    assert.equal(e.body, null, `event ${e.requestId} body not nulled: ${JSON.stringify(e.body)}`);
  }

  console.log("remote coding secret-leak audit ok");
} catch (err) {
  console.error("remote coding secret-leak audit FAILED:", err.message);
  process.exitCode = 1;
} finally {
  serverProcess.kill();
  await once(serverProcess, "exit").catch(() => {});
}
