import { hostname, userInfo } from "node:os";

import { revokeOAuthToken } from "../auth/originrouterAuthClient.js";
import {
  loginWithDeviceFlow,
  persistOAuthCredential,
} from "../auth/originrouterLogin.js";
import {
  DEFAULT_ORIGINROUTER_H5_BASE_URL,
  DEFAULT_SURETY_BASE_URL,
} from "../config/providerRoutes.js";
import {
  clearCodingAuth,
  readCodingAuth,
} from "../persistence/codingAuth.js";
import { ensureDevice, ensureStateDir } from "../persistence/state.js";
import { formatCliError, reportCliError } from "../runtime/cliErrors.js";

function parseFlag(args, name) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === `--${name}` && index + 1 < args.length) return args[index + 1];
    if (args[index].startsWith(`--${name}=`)) return args[index].slice(name.length + 3);
  }
  return undefined;
}

function defaultDeviceName() {
  try {
    const user = (userInfo().username || "").trim();
    const host = (hostname() || "").replace(/\.local$/i, "").trim();
    return user && host ? `${user}@${host}` : user || host || "OriginRouter CLI";
  } catch {
    return "OriginRouter CLI";
  }
}

function mask(token) {
  return typeof token === "string" && token.length > 8
    ? `${token.slice(0, 6)}****${token.slice(-4)}`
    : "(none)";
}

function expiry(value) {
  return typeof value === "number" ? new Date(value).toISOString() : "(unknown)";
}

export async function handleLogin(args) {
  const stateDir = ensureStateDir();
  const suretyBaseUrl = parseFlag(args, "surety-url") ||
    process.env.SURETY_BASE_URL || DEFAULT_SURETY_BASE_URL;
  const h5BaseUrl = parseFlag(args, "login-url") ||
    process.env.ORIGINROUTER_LOGIN_URL || DEFAULT_ORIGINROUTER_H5_BASE_URL;
  const device = ensureDevice();
  try {
    const credential = await loginWithDeviceFlow({
      suretyBaseUrl,
      h5BaseUrl,
      deviceId: device.deviceId,
      deviceName: parseFlag(args, "device-name") || defaultDeviceName(),
      noBrowser: args.includes("--no-browser"),
    });
    persistOAuthCredential({ stateDir, credential });
    console.log(`Device:  ${credential.deviceId}`);
    console.log(`Session: ${credential.sessionId}`);
  } catch (error) {
    formatCliError(error);
  }
}

export async function handleLogout() {
  const stateDir = ensureStateDir();
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    console.log("Not logged in.");
    return;
  }
  try {
    await revokeOAuthToken({
      revocationEndpoint: stored.revocationEndpoint,
      token: stored.refreshToken,
    });
  } catch (error) {
    console.warn(`logout: remote revocation failed (${error.code || "unavailable"})`);
  }
  clearCodingAuth(stateDir);
  console.log("Logged out.");
}

function handleAuthStatus() {
  const stored = readCodingAuth(ensureStateDir());
  if (!stored) {
    console.log("Not logged in.");
    return;
  }
  console.log("Logged in (OriginRouter OAuth)");
  console.log(`Device:  ${stored.deviceId}`);
  console.log(`Session: ${stored.sessionId}`);
  console.log(`Refresh: ${mask(stored.refreshToken)} (expires ${expiry(stored.refreshExpiresAt)})`);
  for (const [resource, token] of Object.entries(stored.accessTokens)) {
    console.log(`${resource}: ${mask(token.token)} (expires ${expiry(token.expiresAt)})`);
  }
}

export async function handleAuthCommand(args) {
  const [sub] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log("OriginRouter auth subcommands:");
    console.log("  status    Show the local OAuth session without contacting a server.");
    return;
  }
  if (sub === "status") return handleAuthStatus();
  reportCliError(`Unknown auth subcommand: ${sub}`, {
    next: "Run `originrouter --help` for usage.",
  });
}
