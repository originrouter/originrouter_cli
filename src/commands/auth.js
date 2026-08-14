import { revokeOAuthToken } from "../auth/originrouterAuthClient.js";
import {
  loginWithDeviceFlow,
  persistOAuthCredential,
} from "../auth/originrouterLogin.js";
import {
  DEFAULT_ORIGINROUTER_LOGIN_BASE_URL,
  DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
  DEFAULT_SURETY_BASE_URL,
} from "../config/providerRoutes.js";
import {
  commitDeviceE2eeIdentity,
  createDeviceE2eeIdentityCandidate,
  discardDeviceE2eeIdentityCandidate,
  invalidateDeviceE2eeIdentity,
  readDeviceE2eeIdentity,
  signCurrentDeviceRemoval,
  signDeviceE2eeEnrollment,
} from "../crypto/deviceE2eeIdentity.js";
import {
  getCliDeviceE2eeDirectory,
  registerCliDeviceE2eeIdentity,
  removeCurrentCliDevice,
  signOutCurrentCliDevice,
} from "../security/deviceE2eeClient.js";
import { storeDeviceE2eeDirectoryCache } from "../security/deviceE2eeDirectoryCache.js";
import {
  clearCodingAuth,
  readCodingAuth,
} from "../persistence/codingAuth.js";
import {
  commitDeviceCandidate,
  createDeviceCandidate,
  discardDeviceCandidate,
  invalidateDevice,
  cliDeviceDisplayName,
  defaultDeviceDisplayName,
  ensureStateDir,
  isStaleDeviceId,
  readDevice,
  updateDeviceDisplayName,
} from "../persistence/state.js";
import { formatCliError, reportCliError } from "../runtime/cliErrors.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import {
  maybeConfigureAgentRoutesAfterLogin,
  resetCloudRoutesOnLogout,
} from "./agentRouteSetup.js";

function parseFlag(args, name) {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === `--${name}` && index + 1 < args.length) return args[index + 1];
    if (args[index].startsWith(`--${name}=`)) return args[index].slice(name.length + 3);
  }
  return undefined;
}

function mask(token) {
  return typeof token === "string" && token.length > 8
    ? `${token.slice(0, 6)}****${token.slice(-4)}`
    : "(none)";
}

function expiry(value) {
  return typeof value === "number" ? new Date(value).toISOString() : "(unknown)";
}

const INVALID_STORED_LOGIN_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "expired_token",
  "access_denied",
  "token_revoked",
  "session_revoked",
  "OAUTH_REFRESH_EXPIRED",
  "OAUTH_RESOURCE_TOKEN_MISSING",
]);

export function storedLoginIsInvalid(error) {
  if (INVALID_STORED_LOGIN_CODES.has(error?.code)) return true;
  // Surety uses HTTP 400/401/403 for terminal OAuth credential failures.
  // Connectivity, rate-limit and server failures must preserve the local
  // credential because they do not prove that the session is invalid.
  return [400, 401, 403].includes(Number(error?.status));
}

export async function inspectStoredLogin({
  stateDir,
  fetchFn = globalThis.fetch,
} = {}) {
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    // Also removes a malformed credential file that readCodingAuth rejected.
    clearCodingAuth(stateDir);
    return { state: "missing", credential: null };
  }
  try {
    const credential = await ensureFreshAccessToken({
      stateDir,
      forceRefresh: true,
      fetchFn,
    });
    return { state: "active", credential };
  } catch (error) {
    if (!storedLoginIsInvalid(error)) throw error;
    clearCodingAuth(stateDir);
    return { state: "invalid", credential: null, error };
  }
}

export async function handleLogin(args, {
  fetchFn = globalThis.fetch,
  agentRouteSetupFn = maybeConfigureAgentRoutesAfterLogin,
} = {}) {
  const configureAgents = args.includes("--configure-agents");
  const keepRoutes = args.includes("--keep-agent-routes") ||
    args.includes("--no-agent-setup");
  if (configureAgents && keepRoutes) {
    reportCliError("Choose either --configure-agents or --keep-agent-routes, not both.");
    return;
  }
  const stateDir = ensureStateDir();
  const suretyBaseUrl = parseFlag(args, "surety-url") ||
    process.env.SURETY_BASE_URL || DEFAULT_SURETY_BASE_URL;
  const loginBaseUrl = parseFlag(args, "login-url") ||
    process.env.ORIGINROUTER_LOGIN_URL || DEFAULT_ORIGINROUTER_LOGIN_BASE_URL;
  const requestedDeviceName = parseFlag(args, "device-name");
  let storedLogin;
  try {
    storedLogin = await inspectStoredLogin({ stateDir, fetchFn });
  } catch (error) {
    formatCliError(error);
    return;
  }
  if (storedLogin.state === "active") {
    const credential = storedLogin.credential;
    console.log("Already signed in to OriginRouter.");
    console.log(`Device:  ${credential.deviceName || credential.deviceId}`);
    console.log("Run `originrouter auth status` to view the session.");
    try {
      await agentRouteSetupFn({ args, stateDir });
    } catch (error) {
      console.warn(`Agent route setup was not completed: ${error?.message || error}`);
      console.warn("The existing OriginRouter login and Agent routes remain active.");
    }
    return;
  }
  if (storedLogin.state === "invalid") {
    console.log("The previous sign-in is no longer valid. Starting a new sign-in.");
  }

  const storedDevice = readDevice();
  // `local-dev` was a pre-device-identity placeholder. Keep the old formal
  // record untouched until the replacement login succeeds, but never send it
  // to Surety as a new authorization identity.
  const installedDevice = storedDevice && !isStaleDeviceId(storedDevice.deviceId)
    ? storedDevice
    : null;
  const device = installedDevice ?? createDeviceCandidate(stateDir, {
    displayName: requestedDeviceName
      ? cliDeviceDisplayName(requestedDeviceName)
      : undefined,
  });
  const storedBeforeLogin = readDeviceE2eeIdentity(stateDir);
  const matchingStoredIdentity = storedBeforeLogin
    && storedBeforeLogin.public_identity.device_id === device.deviceId
    ? storedBeforeLogin
    : null;
  const enrollmentIdentity = matchingStoredIdentity ??
    createDeviceE2eeIdentityCandidate(stateDir, {
      deviceId: device.deviceId,
      epoch: 1,
    });
  const candidateNeedsCommit = matchingStoredIdentity == null;
  const deviceNeedsCommit = installedDevice == null;
  try {
    const credential = await loginWithDeviceFlow({
      suretyBaseUrl,
      loginBaseUrl,
      deviceId: device.deviceId,
      deviceName:
        (requestedDeviceName && cliDeviceDisplayName(requestedDeviceName)) ||
        device.displayName ||
        defaultDeviceDisplayName(),
      e2eeIdentity: enrollmentIdentity.public_identity,
      signEnrollmentChallenge: (challenge) =>
        signDeviceE2eeEnrollment(enrollmentIdentity, challenge),
      noBrowser: args.includes("--no-browser"),
      fetchFn,
    });
    if (deviceNeedsCommit) commitDeviceCandidate(device, stateDir);
    if (requestedDeviceName) {
      updateDeviceDisplayName(requestedDeviceName, stateDir);
    }
    if (candidateNeedsCommit) {
      commitDeviceE2eeIdentity(stateDir, enrollmentIdentity);
    }
    persistOAuthCredential({ stateDir, credential });
    const e2ee = readDeviceE2eeIdentity(stateDir);
    let registered = null;
    let registrationError = null;
    try {
      registered = await registerCliDeviceE2eeIdentity({
        controlBaseUrl:
          process.env.ORIGINROUTER_CONTROL_BASE_URL ||
          DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
        accessToken: credential.accessTokens.control.token,
        identity: e2ee.public_identity,
      });
      const directory = await getCliDeviceE2eeDirectory({
        controlBaseUrl:
          process.env.ORIGINROUTER_CONTROL_BASE_URL ||
          DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
        accessToken: credential.accessTokens.control.token,
      });
      storeDeviceE2eeDirectoryCache(stateDir, directory, {
        namespace: credential.sessionId,
      });
    } catch (error) {
      registrationError = error;
    }
    console.log(`Device:  ${credential.deviceId}`);
    console.log(`Session: ${credential.sessionId}`);
    console.log(`E2EE key fingerprint: ${e2ee.public_identity.key_id}`);
    console.log(`E2EE:    ${registered
      ? registered.trust_status === "pending"
        ? "waiting for approval in the App"
        : "trusted"
      : `identity saved locally; registration pending (${registrationError?.code || "server unavailable"})`}`);
    if (registered?.trust_status === "pending") {
      console.log("Compare this fingerprint with the pending-device entry in the App before approving it.");
    }
    try {
      await agentRouteSetupFn({ args, stateDir });
    } catch (error) {
      console.warn(`Agent route setup was not completed: ${error?.message || error}`);
      console.warn("The OriginRouter login succeeded and existing Agent routes were preserved.");
    }
  } catch (error) {
    if (error?.code === "device_flow_denied") {
      invalidateDeviceE2eeIdentity(stateDir);
      invalidateDevice(stateDir);
    } else {
      discardDeviceE2eeIdentityCandidate(stateDir);
      discardDeviceCandidate(stateDir);
    }
    formatCliError(error);
  }
}

export async function handleLogout(args = [], {
  resetCloudRoutesFn = resetCloudRoutesOnLogout,
} = {}) {
  const stateDir = ensureStateDir();
  const stored = readCodingAuth(stateDir);
  if (!stored) {
    resetCloudRoutesFn();
    console.log("Not logged in.");
    return;
  }
  if (args.includes("--remove-device")) {
    const device = readDevice();
    const identity = readDeviceE2eeIdentity(stateDir);
    if (!device || !identity) {
      reportCliError("This device identity is incomplete.", {
        next: "Run `originrouter logout` to clear the local session, then sign in again.",
      });
      return;
    }
    try {
      const fresh = await ensureFreshAccessToken({ stateDir });
      await removeCurrentCliDevice({
        controlBaseUrl:
          process.env.ORIGINROUTER_CONTROL_BASE_URL ||
          DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
        accessToken: fresh.accessTokens.control.token,
        signedRemoval: signCurrentDeviceRemoval(identity),
      });
      clearCodingAuth(stateDir);
      resetCloudRoutesFn();
      invalidateDeviceE2eeIdentity(stateDir);
      invalidateDevice(stateDir);
      console.log("Signed out and removed this device from the account.");
      console.log("A later sign-in will register it as a new device.");
    } catch (error) {
      formatCliError(error);
    }
    return;
  }
  let signedOutThroughControl = false;
  try {
    const fresh = await ensureFreshAccessToken({ stateDir });
    await signOutCurrentCliDevice({
      controlBaseUrl:
        process.env.ORIGINROUTER_CONTROL_BASE_URL ||
        DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
      accessToken: fresh.accessTokens.control.token,
    });
    signedOutThroughControl = true;
  } catch (error) {
    console.warn(`logout: device registry update failed (${error.code || "unavailable"})`);
  }
  if (!signedOutThroughControl) {
    const latestStored = readCodingAuth(stateDir) || stored;
    try {
      await revokeOAuthToken({
        revocationEndpoint: latestStored.revocationEndpoint,
        token: latestStored.refreshToken,
      });
    } catch (error) {
      console.warn(`logout: remote revocation failed (${error.code || "unavailable"})`);
    }
  }
  clearCodingAuth(stateDir);
  resetCloudRoutesFn();
  console.log("Logged out. This device remains trusted for a later sign-in.");
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
