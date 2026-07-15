import { hostname, userInfo } from "node:os";

import {
  listDevices,
  revokeDeviceGrant,
  rotateCodingKey,
} from "../auth/originrouterAuthClient.js";
import {
  loginWithDeviceFlow,
  persistRelayTokens,
} from "../auth/originrouterLogin.js";
import {
  DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
  DEFAULT_ORIGINROUTER_H5_BASE_URL,
} from "../config/providerRoutes.js";
import {
  clearCodingAuth,
  readCodingAuth,
  writeCodingAuth,
} from "../persistence/codingAuth.js";
import {
  ensureDevice,
  ensureStateDir,
} from "../persistence/state.js";
import {
  KEY_KIND,
  KEY_SOURCE,
} from "../runtime/authContract.js";
import { formatCliError, reportCliError } from "../runtime/cliErrors.js";

function parseFlag(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

function maskKey(rawKey) {
  if (!rawKey || typeof rawKey !== "string") return "(none)";
  if (rawKey.length < 4) return "****";
  if (rawKey.startsWith("rt_")) return "rt_****" + rawKey.slice(-4);
  return "sk-or-****" + rawKey.slice(-4);
}

function maskAtToken(rawAt) {
  if (!rawAt || typeof rawAt !== "string") return "(none)";
  if (rawAt.length < 4) return "****";
  return "rt_****" + rawAt.slice(-4);
}

function formatExpiry(epochMs) {
  if (!epochMs || typeof epochMs !== "number") return "(unknown)";
  return new Date(epochMs).toISOString();
}

function shortHostname() {
  const h = (hostname() || "").trim();
  return h.replace(/\.local$/i, "");
}

function defaultDeviceName() {
  try {
    const u = userInfo();
    const user = (u.username || "").trim();
    const host = shortHostname();
    if (user && host) return `${user}@${host}`;
    if (user) return `${user}'s CLI`;
    return host || "CLI";
  } catch {
    return "CLI";
  }
}

function ensureDeviceForLogin() {
  return ensureDevice();
}

export async function handleLogin(args) {
  const stateDir = ensureStateDir();
  const apiBaseUrl = parseFlag(args, "api-base-url")
    || process.env.ORIGINROUTER_API_BASE_URL
    || DEFAULT_ORIGINROUTER_CONTROL_BASE_URL;
  const h5BaseUrl = parseFlag(args, "login-url")
    || process.env.ORIGINROUTER_LOGIN_URL
    || DEFAULT_ORIGINROUTER_H5_BASE_URL;
  const deviceName = parseFlag(args, "device-name") || defaultDeviceName();
  const noBrowser = args.includes("--no-browser");
  const device = ensureDeviceForLogin();

  let oauthResp;
  try {
    oauthResp = await loginWithDeviceFlow({
      apiBaseUrl,
      h5BaseUrl,
      deviceId: device.deviceId,
      deviceName,
      source: KEY_SOURCE.ORIGINROUTER_CLI,
      noBrowser,
    });
  } catch (err) {
    formatCliError(err);
    return;
  }

  let stored;
  try {
    stored = persistRelayTokens({ stateDir, relayResponse: oauthResp });
  } catch (err) {
    formatCliError(err);
    return;
  }

  console.log(`Device:    ${stored.deviceId}`);
  console.log(`Token:     ${maskAtToken(stored.accessToken)} (expires ${formatExpiry(stored.accessTokenExpiresAt)})`);
}

export async function handleLogout(args) {
  const stateDir = ensureStateDir();
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    console.log("Not logged in.");
    return;
  }
  const apiBaseUrl = parseFlag(args, "api-base-url")
    || process.env.ORIGINROUTER_API_BASE_URL
    || DEFAULT_ORIGINROUTER_CONTROL_BASE_URL;
  try {
    if (stored.deviceGrant) {
      await revokeDeviceGrant({
        apiBaseUrl,
        deviceGrant: stored.deviceGrant,
        accessToken: stored.accessToken,
        deviceId: stored.deviceId,
      });
    }
  } catch (err) {
    console.warn(`logout: backend revoke failed: ${err.message}`);
    console.warn("Clearing local file anyway. Server-side tokens may still exist.");
  }
  clearCodingAuth(stateDir);
  console.log("Logged out.");
}

function handleAuthStatus() {
  const stateDir = ensureStateDir();
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    console.log("Not logged in.");
    return;
  }
  if (stored.kind === KEY_KIND.RELAY) {
    console.log("Logged in (CLI relay)");
    console.log(`Device:    ${stored.deviceId}`);
    console.log(`Token:     ${maskAtToken(stored.accessToken)} (expires ${formatExpiry(stored.accessTokenExpiresAt)})`);
    console.log(`Endpoint:  ${stored.tokenEndpoint}`);
    console.log(`Source:    ${stored.source}`);
  } else {
    console.log("Logged in (CLI; legacy managed-key shape)");
    console.log(`Device:    ${stored.deviceId}`);
    if (stored.deviceGrantId) {
      console.log(`Grant:     ${stored.deviceGrantId} (idle ${formatExpiry(stored.deviceGrantIdleExpiresAt)} / abs ${formatExpiry(stored.deviceGrantAbsoluteExpiresAt)})`);
    }
    console.log(`Key:       ${maskKey(stored.key)} (id ${stored.keyId}, expires ${formatExpiry(stored.expiresAt)})`);
    console.log(`Source:    ${stored.source}`);
  }
}

async function handleAuthRotate(args) {
  const stateDir = ensureStateDir();
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    reportCliError("You're not signed in to OriginRouter.", {
      next: "Run `originrouter login`.",
    });
    return;
  }
  const apiBaseUrl = parseFlag(args, "api-base-url")
    || process.env.ORIGINROUTER_API_BASE_URL
    || DEFAULT_ORIGINROUTER_CONTROL_BASE_URL;
  if (stored.kind === KEY_KIND.RELAY && stored.deviceGrant && stored.tokenEndpoint) {
    let body;
    try {
      const resp = await fetch(stored.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          v: "v1",
          "device-id": stored.deviceId,
          "device-grant": stored.deviceGrant,
        }),
      });
      body = await resp.json();
    } catch (err) {
      formatCliError(err);
      return;
    }
    if (body.code !== 0) {
      const errMsg = body.msg || "unknown";
      const isRevoked = errMsg.includes("revoked") || errMsg.includes("invalid_grant");
      reportCliError(
        isRevoked ? "This device was revoked or expired." : "Token rotation failed.",
        {
          detail: errMsg,
          next: isRevoked
            ? "Run `originrouter login` to reconnect."
            : "Run `originrouter doctor` to check connectivity to the relay.",
        },
      );
      return;
    }
    const merged = {
      ...stored,
      accessToken: body.data["relay-access-token"],
      accessTokenExpiresAt: body.data["expires-at"] * 1000,
    };
    writeCodingAuth(stateDir, merged);
    console.log("Token rotated.");
    console.log(`Token:     ${maskAtToken(merged.accessToken)} (expires ${formatExpiry(merged.accessTokenExpiresAt)})`);
    return;
  }
  if (!stored.deviceGrant) {
    reportCliError("Stored credential has no deviceGrant.", {
      next: "Run `originrouter login` first.",
    });
    return;
  }
  let rotated;
  try {
    rotated = await rotateCodingKey({ apiBaseUrl, deviceGrant: stored.deviceGrant });
  } catch (err) {
    formatCliError(err);
    return;
  }
  const merged = {
    ...stored,
    keyId: rotated.managed_coding_key_id,
    key: rotated.managed_coding_key,
    expiresAt: rotated.managed_coding_key_expires_at * 1000,
  };
  writeCodingAuth(stateDir, merged);
  console.log("Key rotated.");
  console.log(`Key:       ${maskKey(merged.key)} (id ${merged.keyId}, expires ${formatExpiry(merged.expiresAt)})`);
}

async function handleAuthDeviceList(args) {
  const stateDir = ensureStateDir();
  const stored = readCodingAuth(stateDir);
  if (!stored || !stored.deviceGrant) {
    reportCliError("You're not signed in to OriginRouter.", {
      next: "Run `originrouter login`.",
    });
    return;
  }
  const apiBaseUrl = parseFlag(args, "api-base-url")
    || process.env.ORIGINROUTER_API_BASE_URL
    || DEFAULT_ORIGINROUTER_CONTROL_BASE_URL;
  let resp;
  try {
    resp = await listDevices({
      apiBaseUrl,
      deviceGrant: stored.deviceGrant,
      accessToken: stored.accessToken,
      deviceId: stored.deviceId,
    });
  } catch (err) {
    formatCliError(err);
    return;
  }
  console.log(`scope: ${resp.scope}`);
  for (const d of resp.devices || []) {
    console.log("---");
    console.log(`Device:           ${d.device_id}`);
    console.log(`Device grant id:  ${d.device_grant_id}`);
    console.log(`Device name:      ${d.device_name}`);
    console.log(`Source:           ${d.source}`);
    console.log(`Scopes:           ${JSON.stringify(d.scopes)}`);
    console.log(`Idle expires:     ${formatExpiry(d.idle_expires_at * 1000)}`);
    console.log(`Absolute expires: ${formatExpiry(d.absolute_expires_at * 1000)}`);
    if (d.last_used_at) console.log(`Last used:        ${formatExpiry(d.last_used_at * 1000)}`);
    console.log(`Revoked:          ${d.revoked_at ? formatExpiry(d.revoked_at * 1000) : "(active)"}`);
  }
}

export async function handleAuthCommand(args) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log("OriginRouter auth subcommands:");
    console.log("  status                 Show local sign-in state (no backend call).");
    console.log("  rotate [--api-base-url <url>]  Rotate the managed coding key via the backend.");
    console.log("  device list [--api-base-url <url>]  List the calling device.");
    return;
  }
  if (sub === "status") return handleAuthStatus(rest);
  if (sub === "rotate") return handleAuthRotate(rest);
  if (sub === "device" && rest[0] === "list") return handleAuthDeviceList(rest.slice(1));
  reportCliError(`Unknown auth subcommand: ${sub}`, {
    next: "Run `originrouter --help` for usage.",
  });
}
