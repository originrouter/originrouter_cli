import {
  ensureDeviceE2eeIdentity,
  prepareDeviceE2eeRotation,
  readDeviceE2eeIdentity,
} from "../crypto/deviceE2eeIdentity.js";
import { DEFAULT_ORIGINROUTER_CONTROL_BASE_URL } from "../config/providerRoutes.js";
import { ensureDevice, ensureStateDir } from "../persistence/state.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";
import {
  getCliDeviceE2eeStatus,
  getCliDeviceE2eeDirectory,
  registerCliDeviceE2eeIdentity,
} from "../security/deviceE2eeClient.js";
import { storeDeviceE2eeDirectoryCache } from "../security/deviceE2eeDirectoryCache.js";

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
  const local = readDeviceE2eeIdentity(stateDir);
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
  } catch (error) {
    console.log(`Remote status unavailable: ${error.code || error.message}`);
  }
}

async function rotate() {
  const stateDir = ensureStateDir();
  const device = ensureDevice();
  ensureDeviceE2eeIdentity(stateDir, { deviceId: device.deviceId });
  const auth = await credential(stateDir);
  const prepared = prepareDeviceE2eeRotation(stateDir, {
    deviceId: device.deviceId,
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
  console.log("Restart the OriginRouter daemon to activate the new private key.");
}

export async function handleSecurityCommand(args) {
  const [subcommand] = args;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log("OriginRouter security subcommands:");
    console.log("  status    Show this CLI device's encryption identity and trust state.");
    console.log("  rotate    Rotate this CLI device's keys using an old-key-signed transition.");
    console.log("Device approval and account trust policy are managed only in the App.");
    return;
  }
  if (subcommand === "status") return status();
  if (subcommand === "rotate") return rotate();
  throw new Error(`Unknown security subcommand: ${subcommand}`);
}
