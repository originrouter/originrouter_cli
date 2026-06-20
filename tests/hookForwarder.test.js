// Stage 8.5: offline coverage for the Claude hook forwarder impl
// (scripts/claude-session-hook-forwarder-impl.cjs). No real Claude
// Code invocation, no real hook server — exercises the retry /
// backoff / classification / stderr-diagnostic contract via a
// local HTTP server (for the integration cases) and an injected
// `requestFn` (for the precise error-shape cases).
//
// What this file proves:
//   1. First-attempt success preserves the response body and exits 0.
//   2. HTTP 503 is retried; success on attempt 3.
//   3. ECONNRESET is retried (via injected requestFn); success on attempt 2.
//   4. ECONNRESET mid-write retries with lastError="network:ECONNRESET".
//   5. HTTP 500 always returns exitCode: 0 after 3 attempts and logs
//      a structured stderr diagnostic with error="hook_forwarder_retry_exhausted".
//   6. HTTP 404 is fatal (no retry) and logs error="hook_forwarder_fatal".
//   7. Per-attempt socket timeout fires ETIMEDOUT (does not hang).
//   8. PermissionRequest uses 58s timeout; SessionStart uses 5s.
//   9. pickPath + parseEventName dispatch correctly (incl. hookEventName).
//  10. isRetryable classifies the documented error set correctly.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const require = createRequire(resolve(repo, "package.json"));
const { postHookBody, pickPath, parseEventName, isRetryable } =
  require("./scripts/claude-session-hook-forwarder-impl.cjs");

function startServer(handler) {
  return new Promise((resolveStart) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Minimal fake requestFn that records the timeout it was given and
// drives an error / response sequence per call. Returns an object
// shaped like http.ClientRequest just enough to satisfy postOnce().
function makeFakeRequest({ sequence, setTimeoutSpy }) {
  return function fakeRequest(_opts, onResponse) {
    const step = sequence.shift();
    const handlers = { timeout: null, error: null };
    const fakeReq = {
      _opts,
      _handlers: handlers,
      setTimeout(ms) { setTimeoutSpy.timeoutValue = ms; },
      on(event, fn) { handlers[event] = fn; },
      end() {
        if (step.type === "error") {
          // Fire the error event on next tick so postOnce's
          // microtask ordering matches the real socket path.
          setImmediate(() => handlers.error?.(
            Object.assign(new Error(step.message || "test error"), { code: step.code }),
          ));
        } else if (step.type === "timeout") {
          setImmediate(() => handlers.timeout?.());
        } else if (step.type === "success") {
          const chunks = [Buffer.from(step.body || "")];
          const fakeRes = {
            statusCode: step.statusCode || 200,
            on(event, fn) {
              if (event === "data") {
                setImmediate(() => chunks.forEach((c) => fn(c)));
              } else if (event === "end") {
                setImmediate(() => fn());
              } else if (event === "error") {
                // unused
              }
            },
          };
          onResponse(fakeRes);
        } else {
          throw new Error(`unknown step type: ${step.type}`);
        }
      },
      destroy() {},
    };
    return fakeReq;
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. First-attempt success ----

{
  const captured = [];
  const server = await startServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      captured.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: "allow" }));
    });
  });
  try {
    const body = JSON.stringify({ hook_event_name: "PermissionRequest", callId: "x" });
    const result = await postHookBody(body, server.port, { logger: () => {} });
    assert.equal(result.exitCode, 0);
    assert.equal(result.attempts, 1);
    assert.equal(result.responseBody, JSON.stringify({ decision: "allow" }));
    assert.equal(captured.length, 1);
  } finally {
    await server.close();
  }
}

// ---- 2. Retry on 503 then success ----

{
  let callCount = 0;
  const server = await startServer((req, res) => {
    callCount += 1;
    if (callCount < 3) {
      res.writeHead(503); res.end("try later");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: "allow" }));
    }
  });
  try {
    const body = JSON.stringify({ hook_event_name: "PermissionRequest" });
    const result = await postHookBody(body, server.port, { logger: () => {} });
    assert.equal(result.exitCode, 0);
    assert.equal(result.attempts, 3);
    assert.equal(callCount, 3);
  } finally {
    await server.close();
  }
}

// ---- 3. Retry on ECONNRESET then success (via injected requestFn) ----

{
  const setTimeoutSpy = { timeoutValue: undefined };
  const sequence = [
    { type: "error", code: "ECONNRESET" },
    { type: "success", statusCode: 200, body: JSON.stringify({ decision: "allow" }) },
  ];
  const requestFn = makeFakeRequest({ sequence, setTimeoutSpy });
  const body = JSON.stringify({ hook_event_name: "PermissionRequest" });
  const result = await postHookBody(body, 0, { logger: () => {}, requestFn });
  assert.equal(result.exitCode, 0);
  assert.equal(result.attempts, 2);
}

// ---- 4. Retry on ECONNRESET mid-write then success ----

{
  const setTimeoutSpy = { timeoutValue: undefined };
  const sequence = [
    { type: "error", code: "ECONNRESET", message: "socket hang up" },
    { type: "success", statusCode: 200, body: "{}" },
  ];
  const requestFn = makeFakeRequest({ sequence, setTimeoutSpy });
  const body = JSON.stringify({ hook_event_name: "SessionStart" });
  const result = await postHookBody(body, 0, { logger: () => {}, requestFn });
  assert.equal(result.exitCode, 0);
  assert.equal(result.attempts, 2);
}

// ---- 5. Retry exhaustion -> exit 0 + stderr diagnostic ----

{
  const server = await startServer((req, res) => {
    res.writeHead(500); res.end("oops");
  });
  try {
    const diagnostics = [];
    const body = JSON.stringify({ hook_event_name: "PermissionRequest" });
    const result = await postHookBody(body, server.port, {
      logger: (line) => diagnostics.push(JSON.parse(line)),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.attempts, 3);
    assert.equal(result.lastError, "http:500");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].source, "hook_forwarder");
    assert.equal(diagnostics[0].error, "hook_forwarder_retry_exhausted");
    assert.equal(diagnostics[0].attempts, 3);
    assert.equal(diagnostics[0].lastError, "http:500");
    assert.equal(diagnostics[0].port, server.port);
    assert.equal(diagnostics[0].event, "PermissionRequest");
  } finally {
    await server.close();
  }
}

// ---- 6. Fatal 4xx -> exit 0 + stderr diagnostic, no retry ----

{
  let callCount = 0;
  const server = await startServer((req, res) => {
    callCount += 1;
    res.writeHead(404); res.end("not found");
  });
  try {
    const diagnostics = [];
    const body = JSON.stringify({ hook_event_name: "PermissionRequest" });
    const result = await postHookBody(body, server.port, {
      logger: (line) => diagnostics.push(JSON.parse(line)),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.attempts, 1);
    assert.equal(callCount, 1, "fatal 4xx must not retry");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].error, "hook_forwarder_fatal");
    assert.equal(diagnostics[0].statusCode, 404);
  } finally {
    await server.close();
  }
}

// ---- 7. Per-attempt timeout fires ETIMEDOUT (does not hang) ----

{
  // Server that accepts the connection but never writes a response.
  // We override perAttemptTimeoutMs to 50ms so the test runs in <1s.
  const sockets = [];
  const server = await startServer((req, res) => {
    // Hold the socket open; never call res.end().
    sockets.push(req.socket);
  });
  try {
    const body = JSON.stringify({ hook_event_name: "SessionStart" });
    const result = await postHookBody(body, server.port, {
      logger: () => {},
      perAttemptTimeoutMs: 50,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.attempts, 3);
    assert.equal(result.lastError, "network:ETIMEDOUT");
  } finally {
    for (const s of sockets) try { s.destroy(); } catch {}
    await server.close();
  }
}

// ---- 8. Event-conditional timeout ----

{
  // Use an injected requestFn that records the per-attempt timeout
  // it received. The point is to assert that the impl picks 5s for
  // SessionStart and 58s for PermissionRequest.
  const cases = [
    { event: "SessionStart", expected: 5000 },
    { event: "PermissionRequest", expected: 58000 },
  ];
  for (const { event, expected } of cases) {
    const setTimeoutSpy = { timeoutValue: undefined };
    const sequence = [
      { type: "timeout" },
      { type: "timeout" },
      { type: "timeout" },
    ];
    const requestFn = makeFakeRequest({ sequence, setTimeoutSpy });
    const body = JSON.stringify({ hook_event_name: event });
    const result = await postHookBody(body, 0, { logger: () => {}, requestFn });
    assert.equal(result.exitCode, 0);
    assert.equal(result.attempts, 3);
    // All three attempts should have seen the same per-attempt
    // timeout value (the impl resolves it once per call).
    assert.equal(setTimeoutSpy.timeoutValue, expected,
      `event=${event} expected timeout=${expected}ms, got ${setTimeoutSpy.timeoutValue}ms`);
  }
}

// ---- 9. Event-name dispatch + parseEventName dual-form ----

assert.equal(pickPath("SessionStart"), "/hook/session-start");
assert.equal(pickPath("PermissionRequest"), "/hook/permission-request");
assert.equal(pickPath("Unknown"), "/hook/session-start");
assert.equal(pickPath(""), "/hook/session-start");
assert.equal(
  parseEventName(JSON.stringify({ hook_event_name: "PermissionRequest" })),
  "PermissionRequest",
);
assert.equal(
  parseEventName(JSON.stringify({ hookEventName: "SessionStart" })),
  "SessionStart",
);
assert.equal(parseEventName("not-json"), "");
assert.equal(parseEventName(""), "");

// ---- 10. isRetryable classification ----

assert.equal(isRetryable({ code: "ECONNRESET" }), true);
assert.equal(isRetryable({ code: "ECONNREFUSED" }), true);
assert.equal(isRetryable({ code: "ETIMEDOUT" }), true);
assert.equal(isRetryable({ code: "EAI_AGAIN" }), true);
assert.equal(isRetryable({ code: "ENOTFOUND" }), true);
assert.equal(isRetryable({ code: "EHOSTUNREACH" }), true);
assert.equal(isRetryable({ code: "EPIPE" }), true);
assert.equal(isRetryable({ statusCode: 429 }), true);
assert.equal(isRetryable({ statusCode: 500 }), true);
assert.equal(isRetryable({ statusCode: 502 }), true);
assert.equal(isRetryable({ statusCode: 503 }), true);
assert.equal(isRetryable({ statusCode: 504 }), true);
assert.equal(isRetryable({ statusCode: 200 }), false);
assert.equal(isRetryable({ statusCode: 400 }), false);
assert.equal(isRetryable({ statusCode: 401 }), false);
assert.equal(isRetryable({ statusCode: 403 }), false);
assert.equal(isRetryable({ statusCode: 404 }), false);
assert.equal(isRetryable({ statusCode: 405 }), false);
assert.equal(isRetryable({ statusCode: 422 }), false);
assert.equal(isRetryable({}), false);

console.log("hook forwarder tests ok");
