// Stage 9.1A: OriginRouter login flow.
//
// Two orchestrators:
//   - loginWithManualCode(...) — the required 9.1A completion
//     path. The user pastes a one-time code obtained from the
//     backend (e.g. via curl against the test backend).
//   - loginWithCallback(...) — experimental. Starts a local
//     HTTP server on 127.0.0.1, opens the browser, waits for
//     the callback. End-to-end UX requires Universal_PDF_H5 to
//     call /originrouter/auth/login-code and redirect to the
//     callback URL; that wiring is 9.1A.1. The CLI shape is
//     correct so 9.1A.1 does NOT need to change the CLI.
//
// `openBrowser(url)` dispatches per-platform WITHOUT
// `shell: true` on darwin / linux to avoid shell-injection
// risks on URLs with special characters.

import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { exchangeLoginCode } from "./originrouterAuthClient.js";

function generateState() {
  // 16-byte url-safe token; defeats CSRF on the local callback.
  return randomBytes(16).toString("base64url");
}

function loginUrlFor(apiBaseUrl) {
  return `${apiBaseUrl.replace(/\/+$/, "")}/originrouter/login`;
}

// ---------------------------------------------------------------------------
// Required 9.1A completion path
// ---------------------------------------------------------------------------

export async function loginWithManualCode({ apiBaseUrl, code, deviceId, deviceName, source }) {
  if (!code) throw new Error("loginWithManualCode: code is required");
  if (!apiBaseUrl) throw new Error("loginWithManualCode: apiBaseUrl is required");
  const payload = await exchangeLoginCode({
    apiBaseUrl,
    code,
    deviceId,
    deviceName,
    source,
  });
  return payload;
}

// ---------------------------------------------------------------------------
// Experimental browser callback path (9.1A.1 follow-up)
// ---------------------------------------------------------------------------

async function _startCallbackServer({ expectedState, timeoutMs, onListening }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      fn(value);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/originrouter/login/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code) {
        res.statusCode = 400;
        res.end("missing code");
        settle(reject, new Error("callback missing code"));
        return;
      }
      if (state !== expectedState) {
        res.statusCode = 400;
        res.end("state mismatch");
        settle(reject, new Error("callback state mismatch"));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("OK — you can close this window.");
      settle(resolve, code);
    });
    server.on("error", (err) => settle(reject, err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        settle(reject, new Error("failed to bind local callback server"));
        return;
      }
      if (typeof onListening === "function") {
        try {
          onListening(addr.port);
        } catch (err) {
          settle(reject, err);
          return;
        }
      }
      timer = setTimeout(() => settle(reject, new Error("callback timed out")), timeoutMs);
    });
  });
}

export async function loginWithCallback({
  apiBaseUrl,
  loginUrl,
  deviceId,
  deviceName,
  source,
  timeoutMs = 300_000,
  openBrowserFn = openBrowser,
}) {
  if (!apiBaseUrl) throw new Error("loginWithCallback: apiBaseUrl is required");
  if (!loginUrl) loginUrl = loginUrlFor(apiBaseUrl);

  const state = generateState();

  let opened = false;
  const codeReceived = _startCallbackServer({
    expectedState: state,
    timeoutMs,
    onListening: (port) => {
      // Build the URL via URLSearchParams (NOT string concat).
      const redirect_uri = `http://127.0.0.1:${port}/originrouter/login/callback`;
      const params = new URLSearchParams({
        originrouter_cli: "1",
        device_id: deviceId,
        device_name: deviceName,
        source,
        redirect_uri,
        state,
      });
      const target = `${loginUrl}?${params.toString()}`;

      // Open the browser — fire and forget.
      opened = true;
      openBrowserFn(target).catch(() => { /* logged in openBrowser */ });
    },
  });
  if (!opened) {
    // onListening runs asynchronously after bind; this branch is
    // intentionally empty, but keeping the flag prevents accidental
    // removal of the callback in future edits.
  }

  const code = await codeReceived;

  // Now exchange the code.
  return exchangeLoginCode({ apiBaseUrl, code, deviceId, deviceName, source });
}

// ---------------------------------------------------------------------------
// openBrowser
// ---------------------------------------------------------------------------

export async function openBrowser(url) {
  const platform = process.platform;
  let cmd, argv;
  if (platform === "darwin") {
    cmd = "open";
    argv = [url];
  } else if (platform === "linux") {
    cmd = "xdg-open";
    argv = [url];
  } else if (platform === "win32") {
    // argv form (NOT shell string): ["cmd", "/c", "start", '""', url]
    cmd = "cmd";
    argv = ["/c", "start", '""', url];
  } else {
    // Unknown platform: best-effort — print the URL so the user can copy it.
    process.stderr.write(`openBrowser: unknown platform; please open this URL manually:\n${url}\n`);
    return;
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, argv, {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        // ENOENT — the platform command is missing. Print URL.
        process.stderr.write(`openBrowser: failed to launch ${cmd}: ${err.message}\nPlease open this URL manually:\n${url}\n`);
        resolve();
      });
      child.unref();
      resolve();
    } catch (err) {
      process.stderr.write(`openBrowser: unexpected error: ${err.message}\nPlease open this URL manually:\n${url}\n`);
      resolve();
    }
  });
}

export { loginUrlFor };
