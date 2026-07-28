import { revokeOAuthToken } from "../auth/originrouterAuthClient.js";
import {
  loginWithDeviceFlow,
  persistOAuthCredential,
} from "../auth/originrouterLogin.js";
import {
  DEFAULT_ORIGINROUTER_H5_BASE_URL,
  DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
  DEFAULT_SURETY_BASE_URL,
} from "../config/providerRoutes.js";
import {
  ensureDeviceE2eeIdentity,
  readDeviceE2eeIdentity,
  resetDeviceE2eeIdentityForEpoch,
  signDeviceE2eeEnrollment,
} from "../crypto/deviceE2eeIdentity.js";
import {
  getCliDeviceE2eeDirectory,
  getCliDeviceE2eeStatus,
  registerCliDeviceE2eeIdentity,
} from "../security/deviceE2eeClient.js";
import { storeDeviceE2eeDirectoryCache } from "../security/deviceE2eeDirectoryCache.js";
import {
  clearCodingAuth,
  readCodingAuth,
} from "../persistence/codingAuth.js";
import {
  defaultDeviceDisplayName,
  ensureDevice,
  ensureStateDir,
} from "../persistence/state.js";
import { formatCliError, reportCliError } from "../runtime/cliErrors.js";

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

export async function handleLogin(args) {
  const stateDir = ensureStateDir();
  const suretyBaseUrl = parseFlag(args, "surety-url") ||
    process.env.SURETY_BASE_URL || DEFAULT_SURETY_BASE_URL;
  const h5BaseUrl = parseFlag(args, "login-url") ||
    process.env.ORIGINROUTER_LOGIN_URL || DEFAULT_ORIGINROUTER_H5_BASE_URL;
  const device = ensureDevice();
  const storedBeforeLogin = readDeviceE2eeIdentity(stateDir);
  const enrollmentIdentity = ensureDeviceE2eeIdentity(stateDir, {
    deviceId: device.deviceId,
    epoch: storedBeforeLogin?.public_identity?.epoch || 1,
  });
  try {
    const credential = await loginWithDeviceFlow({
      suretyBaseUrl,
      h5BaseUrl,
      deviceId: device.deviceId,
      deviceName:
        parseFlag(args, "device-name") ||
        device.displayName ||
        defaultDeviceDisplayName(),
      e2eeIdentity: enrollmentIdentity.public_identity,
      signEnrollmentChallenge: (challenge) =>
        signDeviceE2eeEnrollment(enrollmentIdentity, challenge),
      noBrowser: args.includes("--no-browser"),
    });
    persistOAuthCredential({ stateDir, credential });
    let epoch = 1;
    try {
      const status = await getCliDeviceE2eeStatus({
        controlBaseUrl:
          process.env.ORIGINROUTER_CONTROL_BASE_URL ||
          DEFAULT_ORIGINROUTER_CONTROL_BASE_URL,
        accessToken: credential.accessTokens.control.token,
      });
      epoch = Number(status?.policy?.epoch || 1);
    } catch {}
    const storedE2ee = readDeviceE2eeIdentity(stateDir);
    const e2ee = storedE2ee
      && storedE2ee.public_identity.device_id === credential.deviceId
      && storedE2ee.public_identity.epoch !== epoch
      ? resetDeviceE2eeIdentityForEpoch(stateDir, {
          deviceId: credential.deviceId,
          epoch,
        })
      : ensureDeviceE2eeIdentity(stateDir, {
          deviceId: credential.deviceId,
          epoch,
        });
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
