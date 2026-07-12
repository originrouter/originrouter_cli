// Stage 9.8: OriginRouter login flow.
//
// One orchestrator:
//   - loginWithDeviceFlow(...) — RFC 8628 device authorization grant.
//     Calls /device/code, prints the 8-char user_code +
//     verification_uri, opens the browser (optional), then
//     polls /device/token at the recommended interval. No
//     local HTTP callback server needed. Suitable for SSH,
//     Docker, CI, or any environment where the CLI cannot
//     receive a browser redirect.
//
// Stage 9.8: the /device/token success response is now an OAuth 2.0
// (access_token, refresh_token) pair (RFC 6749 §5.1), NOT a long-
// lived managed key. The CLI stores the refresh_token; the
// access_token is silently rotated via /device/refresh when it
// approaches expiry. See `oauthTokenRefresher.js` for the
// silent-refresh logic.
//
// The Stage 9.6 browser-callback orchestrator
// (loginWithDevMintCallback) was retired in Stage 9.7 along
// with the backend's /login-code/dev-mint + /device/approve
// routes — see `README.md` for the migration notes.
//
// `openBrowser(url)` dispatches per-platform WITHOUT
// `shell: true` on darwin / linux to avoid shell-injection
// risks on URLs with special characters.

import { spawn } from "node:child_process";

import { writeCodingAuth } from "../persistence/codingAuth.js";
import {
  AuthClientError,
  pollDeviceToken,
  requestDeviceCode,
} from "./originrouterAuthClient.js";

function loginUrlFor(apiBaseUrl) {
  return `${apiBaseUrl.replace(/\/+$/, "")}/cli/authorize`;
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

// ---------------------------------------------------------------------------
// Stage 9.8: persist the OAuth 2.0 token response (RFC 6749 §5.1).
// ---------------------------------------------------------------------------
//
// The /device/token success payload carries (Stage 9.9):
//   access_token             rt_<base64url>        (1h, surety relay)
//   device_grant             <secrets.token_urlsafe(48)>  (长期凭证)
//   token_endpoint           surety /api/relay/token URL
//   device_id                "device-<fingerprint>"
//   expires_at               unix seconds (access_token 过期时间)
//   scopes                   ["coding"]
//   source                   "originrouter_cli"
//   token_type               "Bearer"
//
// This helper converts the response to the on-disk relay
// shape (see isRelayShape) and writes it to
// `<stateDir>/coding-key.json`. The device_grant is the durable
// credential the CLI keeps; the access_token is the short-lived
// Bearer the env builder uses for LLM calls.

import { KEY_KIND, KEY_SCOPE, KEY_SOURCE } from "../runtime/authContract.js";

export function relayResponseToShape(relayResponse) {
  if (!relayResponse || typeof relayResponse !== "object") {
    throw new AuthClientError({
      status: 0, body: null, message: "relayResponse is required",
    });
  }
  const required = [
    "access_token", "device_grant", "token_endpoint",
    "device_id", "expires_at",
  ];
  for (const f of required) {
    if (!relayResponse[f]) {
      throw new AuthClientError({
        status: 0, body: null,
        message: `relayResponse missing field: ${f}`,
      });
    }
  }
  if (typeof relayResponse.access_token !== "string" || !relayResponse.access_token.startsWith("rt_")) {
    throw new AuthClientError({ status: 0, body: null, message: "access_token must start with rt_" });
  }
  return {
    kind: KEY_KIND.RELAY,
    accessToken: relayResponse.access_token,
    accessTokenExpiresAt: Number(relayResponse.expires_at) * 1000,
    deviceGrant: relayResponse.device_grant,
    tokenEndpoint: relayResponse.token_endpoint,
    deviceId: relayResponse.device_id,
    scopes: Array.isArray(relayResponse.scopes)
      ? relayResponse.scopes
      : [KEY_SCOPE.CODING],
    source: KEY_SOURCE.ORIGINROUTER_CLI,
  };
}

export function persistRelayTokens({ stateDir, relayResponse }) {
  const shape = relayResponseToShape(relayResponse);
  writeCodingAuth(stateDir, shape);
  return shape;
}

// Stage 9.9: 登录成功后调用 persistRelayTokens 写入 coding-key.json

// ---------------------------------------------------------------------------
// Stage 9.7/9.8 — RFC 8628 device-flow orchestrator.
//
// The CLI:
//   1. POSTs to /device/code with its local device_id → receives a
//      user_code + verification_uri_complete + expires_in + interval.
//   2. Prints the URL + the 8-char user_code for the user.
//   3. (Optional) opens the verification_uri_complete in the local
//      browser if `openBrowserFn` is provided and `noBrowser` is false.
//   4. Polls /device/token at `interval` seconds. On
//      `authorization_pending` it keeps polling; on `slow_down` it
//      backs off (RFC 8628 §4.1.2: double interval, +5s floor);
//      on any other error it rejects.
//   5. On success, the response carries an OAuth 2.0 token pair
//      (access_token + refresh_token). The caller pipes it
//      through `persistOAuthTokens(...)` to write coding-key.json.
// ---------------------------------------------------------------------------

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function loginWithDeviceFlow({
  apiBaseUrl,
  h5BaseUrl,
  deviceId,
  deviceName,
  source,
  timeoutMs = 600_000,        // 10 minutes — matches server expires_in
  initialIntervalMs = 5_000,  // RFC 8628 §4.1.2 default
  noBrowser = false,
  openBrowserFn = openBrowser,
  // Test seam: lets unit tests inject a deterministic sleep.
  sleepFn = _sleep,
  // Test seam: lets unit tests capture the printed URL/code.
  printFn = (line) => process.stderr.write(line + "\n"),
}) {
  if (!apiBaseUrl) throw new Error("loginWithDeviceFlow: apiBaseUrl is required");
  if (!h5BaseUrl) throw new Error("loginWithDeviceFlow: h5BaseUrl is required");
  if (!deviceId) throw new Error("loginWithDeviceFlow: deviceId is required");

  // Step 1: mint the user_code.
  const codeResp = await requestDeviceCode({
    apiBaseUrl,
    deviceId,
    deviceName: deviceName || deviceId,
    source: source || "originrouter_cli",
  });
  if (!codeResp || typeof codeResp.user_code !== "string" || !codeResp.user_code) {
    throw new AuthClientError({
      status: 0, body: null, message: "device_code_invalid_response",
    });
  }

  const userCode = codeResp.user_code;
  const verificationUri = codeResp.verification_uri;
  const verificationUriComplete =
    codeResp.verification_uri_complete || `${verificationUri}?user_code=${userCode}`;
  // Server-provided interval wins (gateway is the source of truth);
  // the constructor default is the floor.
  const baseIntervalMs = (codeResp.interval ? codeResp.interval * 1000 : initialIntervalMs);

  // Step 2: print the URL (code is embedded in the link).
  printFn(`! To complete login, open this URL and click Authorize:`);
  printFn(`!   ${verificationUriComplete}`);
  printFn(`! Your code: ${userCode}`);
  printFn(`! Waiting for authorization (expires in ${Math.floor(timeoutMs / 1000)}s)...`);

  // Step 3: optionally open the browser.
  if (!noBrowser && typeof openBrowserFn === "function") {
    try {
      await openBrowserFn(verificationUriComplete);
    } catch { /* logged in openBrowser */ }
  }

  // Step 4: poll /device/token.
  const deadline = Date.now() + timeoutMs;
  let intervalMs = baseIntervalMs;
  let lastErrorCode = null;
  while (Date.now() < deadline) {
    await sleepFn(intervalMs);
    try {
      const result = await pollDeviceToken({
        apiBaseUrl,
        deviceCode: userCode,
        deviceId,
        source: source || "originrouter_cli",
      });
      // Success — `result` is the OAuth 2.0 token response
      // (access_token + refresh_token + expires_in + ...).
      printFn("✓ Authorization received.");
      return result;
    } catch (e) {
      const code = (e && (e.code || e.message)) || "device_flow_error";
      lastErrorCode = code;
      if (code === "authorization_pending") {
        continue;
      }
      if (code === "slow_down") {
        // RFC 8628 §4.1.2: client MUST increase the polling interval
        // by 5 seconds for this request and subsequent requests.
        intervalMs += 5_000;
        continue;
      }
      if (code === "expired_token") {
        throw new AuthClientError({
          status: 0, body: null, message: "device_flow_expired",
        });
      }
      if (code === "access_denied") {
        throw new AuthClientError({
          status: 0, body: null, message: "device_flow_denied",
        });
      }
      // invalid_grant + anything else: hard fail.
      throw new AuthClientError({
        status: e.status || 0, body: null,
        message: `device_flow_${code}`,
      });
    }
  }
  throw new AuthClientError({
    status: 0, body: null,
    message: lastErrorCode
      ? `device_flow_timeout_after_${lastErrorCode}`
      : "device_flow_timeout",
  });
}

export { loginUrlFor };

