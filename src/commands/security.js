import {
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
  readDeviceE2eeIdentity,
} from "../crypto/deviceE2eeIdentity.js";
import { DEFAULT_ORIGINROUTER_CONTROL_BASE_URL } from "../config/providerRoutes.js";
import { ensureDevice, ensureStateDir } from "../persistence/state.js";
import { readCodingAuth } from "../persistence/codingAuth.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import {
  createCliTrustUpgradeRequest,
  getCliDeviceE2eeStatus,
  getCliDeviceE2eeDirectory,
  getCliTrustUpgradeStatus,
  registerCliDeviceE2eeIdentity,
} from "../security/deviceE2eeClient.js";
import { storeDeviceE2eeDirectoryCache } from "../security/deviceE2eeDirectoryCache.js";
import qrcode from "qrcode-terminal";

function controlBaseUrl() {
  return process.env.ORIGINROUTER_CONTROL_BASE_URL ||
    DEFAULT_ORIGINROUTER_CONTROL_BASE_URL;
}

async function credential(stateDir) {
  const value = await ensureFreshAccessToken({ stateDir });
  if (!value?.accessTokens?.control?.token) {
    const error = new Error("Sign in before managing the device encryption identity.");
    error.code = "DEVICE_E2EE_LOGIN_REQUIRED";
    throw error;
  }
  return value;
}

async function status() {
  const stateDir = ensureStateDir();
  const device = ensureDevice();
  const accountScope = readCodingAuth(stateDir)?.accountScope;
  const local = readDeviceE2eeIdentity(stateDir, { accountScope });
  if (!local) {
    console.log("Device encryption identity: not initialized");
    console.log("Run `originrouter login` to initialize and register it.");
    return;
  }
  console.log(`Device:      ${device.deviceId}`);
  console.log(`Key ID:      ${local.public_identity.key_id}`);
  console.log(`Key version: ${local.public_identity.key_version}`);
  try {
    const auth = await credential(stateDir);
    const remote = await getCliDeviceE2eeStatus({
      controlBaseUrl: controlBaseUrl(),
      accessToken: auth.accessTokens.control.token,
    });
    console.log(`Trust:       ${remote.identity?.trust_status || "not registered"}`);
    console.log(
      `New devices: ${remote.policy?.new_device_approval_required
        ? "require approval in the App"
        : "account login is sufficient"}`,
    );
    if (remote.identity?.trust_status === "pending") {
      console.log("This CLI session is signed in but is not a trusted device.");
      console.log("Run `originrouter security verify` to confirm it with a trusted App.");
    }
  } catch (error) {
    console.log(`Remote status unavailable: ${error.code || error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verify() {
  const stateDir = ensureStateDir();
  const auth = await credential(stateDir);
  const identity = readDeviceE2eeIdentity(stateDir, {
    accountScope: auth.accountScope,
  });
  if (!identity) throw new Error("Device encryption identity is not initialized.");
  const options = {
    controlBaseUrl: controlBaseUrl(),
    accessToken: auth.accessTokens.control.token,
  };
  const request = await createCliTrustUpgradeRequest(options);
  if (request.already_trusted) {
    console.log("This CLI device is already trusted.");
    return;
  }
  const enrollment = request.enrollment || {};
  const requestId = String(enrollment.request_id || "");
  const expiresAt = Number(enrollment.expires_at || 0) * 1000;
  if (!requestId || !expiresAt) throw new Error("Server returned an incomplete trust-upgrade request.");
  const approvalUri = `originrouter://device-approval?v=2&r=${encodeURIComponent(requestId)}`;
  console.log("Open the OriginRouter App on a trusted phone and scan this code:");
  qrcode.generate(approvalUri, { small: true });
  console.log(`Request expires: ${new Date(expiresAt).toISOString()}`);
  console.log("Waiting for trusted-device confirmation…");
  while (Date.now() < expiresAt) {
    await sleep(2000);
    const status = await getCliTrustUpgradeStatus(requestId, options);
    const trustStatus = status.identity?.trust_status;
    const authorizationStatus = status.enrollment?.authorization_status;
    if (trustStatus === "trusted" || authorizationStatus === "approved") {
      const directory = await getCliDeviceE2eeDirectory(options);
      storeDeviceE2eeDirectoryCache(stateDir, directory, { namespace: auth.sessionId });
      console.log("CLI device is now trusted.");
      return;
    }
    if (authorizationStatus === "denied") {
      const error = new Error("Trusted-device confirmation was denied.");
      error.code = "device_trust_upgrade_denied";
      throw error;
    }
  }
  const error = new Error("Trusted-device confirmation expired.");
  error.code = "device_trust_upgrade_expired";
  throw error;
}

async function rotate() {
  const stateDir = ensureStateDir();
  const device = ensureDevice();
  const auth = await credential(stateDir);
  const accountScope = auth.accountScope;
  ensureDeviceE2eeIdentity(stateDir, { deviceId: device.deviceId, accountScope });
  const prepared = prepareDeviceE2eeRotation(stateDir, {
    deviceId: device.deviceId,
    accountScope,
  });
  const registered = await registerCliDeviceE2eeIdentity({
    controlBaseUrl: controlBaseUrl(),
    accessToken: auth.accessTokens.control.token,
    identity: prepared.next.public_identity,
  });
  if (registered.key_id !== prepared.next.public_identity.key_id) {
    throw new Error("Server returned an unexpected device key after rotation");
  }
  prepared.commit();
  const directory = await getCliDeviceE2eeDirectory({
    controlBaseUrl: controlBaseUrl(),
    accessToken: auth.accessTokens.control.token,
  });
  storeDeviceE2eeDirectoryCache(stateDir, directory, {
    namespace: auth.sessionId,
  });
  console.log("Device encryption key rotated.");
  console.log(`Key ID:      ${registered.key_id}`);
  console.log(`Key version: ${registered.key_version}`);
  console.log(`Trust:       ${registered.trust_status}`);
  console.log("A running OriginRouter daemon will activate the new key automatically.");
}

export async function handleSecurityCommand(args) {
  const [subcommand] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log("OriginRouter security subcommands:");
    console.log("  status    Show this CLI device's encryption identity and trust state.");
    console.log("  verify    Show a QR code to upgrade a signed-in pending device.");
    console.log("  rotate    Rotate this CLI device's keys using an old-key-signed transition.");
    console.log("Device approval and account trust policy are managed only in the App.");
    return;
  }
  if (subcommand === "status") return status();
  if (subcommand === "verify") return verify();
  if (subcommand === "rotate") return rotate();
  throw new Error(`Unknown security subcommand: ${subcommand}`);
}
