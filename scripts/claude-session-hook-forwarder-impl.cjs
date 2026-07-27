// Stage 8.5: pure implementation of the Claude hook forwarder's HTTP
// path. Extracted from claude-session-hook-forwarder.cjs so the retry,
// backoff, classification, and stderr-diagnostic logic can be unit-tested
// without spawning a real Claude Code hook event. The thin CJS wrapper
// at scripts/claude-session-hook-forwarder.cjs reads stdin / argv and
// calls postHookBody().
//
// The exported `postHookBody(body, port, options)` returns
// `{ exitCode: 0, responseBody, attempts, lastError }`. exitCode is
// always 0 — the user-visible behavior on the post-exhaustion path is
// unchanged from before Stage 8.5. The structured stderr diagnostic
// (see logDiagnostic below) is what makes retry-exhausted hooks
// debuggable via the daemon's logs.

const http = require("node:http");

const DEFAULTS = {
  maxAttempts: 3,
  // Two retry delays for three attempts: after attempt 1 → 50ms;
  // after attempt 2 → 150ms. Total worst case before the retry budget
  // is exhausted is ~600ms (not counting any per-attempt timeout).
  retryDelaysMs: [50, 150],
  // Per-attempt timeout is event-conditional and resolved inside
  // postHookBody (SessionStart: perAttemptTimeoutMs; PermissionRequest:
  // permissionRequestTimeoutMs to safely cover the hook server's five-minute
  // hold-open while staying below the six-minute Claude hook deadline).
  perAttemptTimeoutMs: 5_000,
  permissionRequestTimeoutMs: 330_000,
  retryableHttpStatuses: new Set([429, 500, 502, 503, 504]),
  retryableCodes: new Set([
    "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
    "ENOTFOUND", "EHOSTUNREACH", "EPIPE",
  ]),
};

function pickPath(eventName) {
  if (eventName === "PermissionRequest") return "/hook/permission-request";
  if (eventName === "Elicitation") return "/hook/elicitation";
  if (eventName === "SessionStart") return "/hook/session-start";
  return "/hook/event";
}

// Preserve the original dual-form event-name parsing — Claude Code
// has used both `hook_event_name` (current) and `hookEventName` (legacy)
// across versions.
function parseEventName(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed.hook_event_name || parsed.hookEventName || "";
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable({ code, statusCode }) {
  if (code && DEFAULTS.retryableCodes.has(code)) return true;
  if (statusCode && DEFAULTS.retryableHttpStatuses.has(statusCode)) return true;
  return false;
}

function logDiagnostic(logger, payload) {
  try {
    logger?.(JSON.stringify({ source: "hook_forwarder", ...payload }));
  } catch {}
}

function postOnce(body, port, path, perAttemptTimeoutMs, requestFn) {
  const request = requestFn ?? http.request;
  return new Promise((resolve) => {
    let settled = false;
    const req = request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          statusCode: response.statusCode,
          responseBody: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", (error) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error });
      });
    });
    // Per-attempt socket timeout. The timeout handler MUST resolve
    // the promise; setting only `settled = true` and calling
    // req.destroy() would leave the promise pending forever because
    // the 'error' handler would see `settled` and bail.
    req.setTimeout(perAttemptTimeoutMs);
    req.on("timeout", () => {
      if (settled) return;
      settled = true;
      const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      // Resolve first, then destroy — order matters so the awaiter
      // gets the result before the socket teardown cascades into an
      // 'error' event we no longer want to act on.
      resolve({ ok: false, error: err });
      try { req.destroy(err); } catch {}
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error });
    });
    req.end(body);
  });
}

async function postHookBody(body, port, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const logger = options.logger ?? (() => {});

  const eventName = parseEventName(body);
  const path = pickPath(eventName);
  // PermissionRequest is held open by the server for up to five minutes;
  // the forwarder's per-attempt timeout must safely exceed that,
  // otherwise a normal remote approval would be aborted.
  const perAttemptTimeoutMs = eventName === "PermissionRequest" || eventName === "Elicitation"
    ? opts.permissionRequestTimeoutMs
    : opts.perAttemptTimeoutMs;

  let lastError = null;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
    const result = await postOnce(body, port, path, perAttemptTimeoutMs, opts.requestFn);
    if (result.ok) {
      return { exitCode: 0, responseBody: result.responseBody, attempts: attempt };
    }
    const code = result.error?.code;
    const statusCode = result.statusCode;
    lastError = code ? `network:${code}` : `http:${statusCode}`;
    if (!isRetryable({ code, statusCode })) {
      logDiagnostic(logger, {
        error: "hook_forwarder_fatal",
        attempts: attempt,
        lastError,
        port,
        event: eventName,
        statusCode,
        code,
      });
      return { exitCode: 0, attempts: attempt, lastError };
    }
    if (attempt < opts.maxAttempts) {
      const delay = opts.retryDelaysMs[attempt - 1] ?? 0;
      await sleep(delay);
      continue;
    }
  }
  logDiagnostic(logger, {
    error: "hook_forwarder_retry_exhausted",
    attempts: opts.maxAttempts,
    lastError,
    port,
    event: eventName,
  });
  return { exitCode: 0, attempts: opts.maxAttempts, lastError };
}

module.exports = { postHookBody, pickPath, parseEventName, isRetryable, DEFAULTS };
