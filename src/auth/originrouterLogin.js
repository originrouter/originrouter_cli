import { spawn } from "node:child_process";

import { writeCodingAuth } from "../persistence/codingAuth.js";
import { KEY_KIND, KEY_SOURCE } from "../runtime/authContract.js";
import {
  AuthClientError,
  bindDeviceE2eeIdentity,
  pollDeviceToken,
  refreshOAuthToken,
  requestDeviceCode,
} from "./originrouterAuthClient.js";

function loginUrlFor(loginBaseUrl) {
  return `${loginBaseUrl.replace(/\/+$/, "")}/cli/authorize`;
}

function verificationUrlFor({ loginBaseUrl, userCode }) {
  const url = new URL(loginUrlFor(loginBaseUrl));
  url.searchParams.set("user_code", userCode);
  return url.toString();
}

export async function openBrowser(url) {
  const commands = {
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["cmd", ["/c", "start", '""', url]],
  };
  const selected = commands[process.platform];
  if (!selected) {
    process.stderr.write(`Please open this URL manually:\n${url}\n`);
    return;
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(selected[0], selected[1], { detached: true, stdio: "ignore" });
      child.on("error", () => resolve());
      child.unref();
      resolve();
    } catch {
      resolve();
    }
  });
}

function tokenRecord(response) {
  if (!response?.access_token?.startsWith("or_at_")) {
    throw new AuthClientError({ code: "invalid_access_token_response" });
  }
  return {
    token: response.access_token,
    expiresAt: Date.now() + Number(response.expires_in || 600) * 1000,
    scopes: String(response.scope || "").split(" ").filter(Boolean),
  };
}

function rotatedRefreshToken(response) {
  if (!response?.refresh_token?.startsWith("or_rt_")) {
    throw new AuthClientError({ code: "invalid_refresh_token_response" });
  }
  return response.refresh_token;
}

function bundledResourceToken(response, resource) {
  const token = response?.access_tokens?.[resource];
  return token && typeof token === "object" ? token : null;
}

async function completeBundle({
  suretyBaseUrl,
  control,
  deviceId,
  deviceName,
  fetchFn,
}) {
  const tokenEndpoint = `${suretyBaseUrl.replace(/\/+$/, "")}/api/oauth/token`;
  const revocationEndpoint = `${suretyBaseUrl.replace(/\/+$/, "")}/api/oauth/revoke`;
  const bundled = {
    control: bundledResourceToken(control, "originrouter.control"),
    ai: bundledResourceToken(control, "originrouter.ai"),
    coding: bundledResourceToken(control, "originrouter.coding"),
    relay: bundledResourceToken(control, "originrouter.relay"),
    memory: bundledResourceToken(control, "originrouter.memory"),
  };
  if (Object.values(bundled).every(Boolean)) {
    return {
      kind: KEY_KIND.OAUTH,
      clientId: "originrouter_cli",
      source: KEY_SOURCE.ORIGINROUTER_CLI,
      deviceId,
      deviceName: deviceName || deviceId,
      sessionId: control.session_id,
      refreshToken: rotatedRefreshToken(control),
      refreshExpiresAt:
        Date.now() + Number(control.refresh_expires_in || 2592000) * 1000,
      tokenEndpoint,
      revocationEndpoint,
      accessTokens: {
        control: tokenRecord(bundled.control),
        ai: tokenRecord(bundled.ai),
        coding: tokenRecord(bundled.coding),
        relay: tokenRecord(bundled.relay),
        memory: tokenRecord(bundled.memory),
      },
    };
  }
  let refreshToken = rotatedRefreshToken(control);
  const ai = await refreshOAuthToken({
    tokenEndpoint,
    refreshToken,
    resource: "originrouter.ai",
    fetchFn,
  });
  refreshToken = rotatedRefreshToken(ai);
  const coding = await refreshOAuthToken({
    tokenEndpoint,
    refreshToken,
    resource: "originrouter.coding",
    fetchFn,
  });
  refreshToken = rotatedRefreshToken(coding);
  const relay = await refreshOAuthToken({
    tokenEndpoint,
    refreshToken,
    resource: "originrouter.relay",
    fetchFn,
  });
  refreshToken = rotatedRefreshToken(relay);
  const memory = await refreshOAuthToken({
    tokenEndpoint,
    refreshToken,
    resource: "originrouter.memory",
    fetchFn,
  });
  refreshToken = rotatedRefreshToken(memory);
  return {
    kind: KEY_KIND.OAUTH,
    clientId: "originrouter_cli",
    source: KEY_SOURCE.ORIGINROUTER_CLI,
    deviceId,
    deviceName: deviceName || deviceId,
    sessionId: memory.session_id || relay.session_id || control.session_id,
    refreshToken,
    refreshExpiresAt: Date.now() + Number(memory.refresh_expires_in || 2592000) * 1000,
    tokenEndpoint,
    revocationEndpoint,
    accessTokens: {
      control: tokenRecord(control),
      ai: tokenRecord(ai),
      coding: tokenRecord(coding),
      relay: tokenRecord(relay),
      memory: tokenRecord(memory),
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loginWithDeviceFlow({
  suretyBaseUrl,
  loginBaseUrl,
  deviceId,
  deviceName,
  e2eeIdentity,
  signEnrollmentChallenge,
  timeoutMs = 600_000,
  initialIntervalMs = 5_000,
  noBrowser = false,
  openBrowserFn = openBrowser,
  sleepFn = sleep,
  printFn = (line) => process.stderr.write(line + "\n"),
  fetchFn = globalThis.fetch,
}) {
  if (!suretyBaseUrl) throw new Error("loginWithDeviceFlow: suretyBaseUrl is required");
  if (!loginBaseUrl) throw new Error("loginWithDeviceFlow: loginBaseUrl is required");
  if (!deviceId) throw new Error("loginWithDeviceFlow: deviceId is required");
  if (!e2eeIdentity || typeof signEnrollmentChallenge !== "function") {
    throw new Error("loginWithDeviceFlow: E2EE identity binding is required");
  }

  const issued = await requestDeviceCode({
    suretyBaseUrl,
    deviceId,
    deviceName: deviceName || deviceId,
    fetchFn,
  });
  if (!issued?.device_code?.startsWith("or_dc_") || !issued.user_code
      || !issued.enrollment_challenge?.startsWith("or_ch_")) {
    throw new AuthClientError({ code: "device_code_invalid_response" });
  }
  const bindingSignature = await signEnrollmentChallenge(
    issued.enrollment_challenge,
  );
  await bindDeviceE2eeIdentity({
    suretyBaseUrl,
    deviceCode: issued.device_code,
    enrollmentChallenge: issued.enrollment_challenge,
    identity: e2eeIdentity,
    bindingSignature,
    fetchFn,
  });
  const verificationUriComplete = verificationUrlFor({
    loginBaseUrl,
    userCode: issued.user_code,
  });
  printFn("! To complete login, open this URL:");
  printFn(`!   ${verificationUriComplete}`);
  printFn(`! Your code: ${issued.user_code}`);
  if (!noBrowser) await openBrowserFn(verificationUriComplete);

  const deadline = Date.now() + Math.min(timeoutMs, Number(issued.expires_in || 600) * 1000);
  let intervalMs = Number(issued.interval || initialIntervalMs / 1000) * 1000;
  while (Date.now() < deadline) {
    await sleepFn(intervalMs);
    try {
      const control = await pollDeviceToken({
        suretyBaseUrl,
        deviceCode: issued.device_code,
        resource: "originrouter.control",
        fetchFn,
      });
      const credential = await completeBundle({
        suretyBaseUrl,
        control,
        deviceId,
        deviceName,
        fetchFn,
      });
      printFn("✓ Authorization received.");
      return credential;
    } catch (error) {
      if (error?.code === "authorization_pending") continue;
      if (error?.code === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (error?.code === "expired_token") {
        throw new AuthClientError({ code: "device_flow_expired" });
      }
      if (error?.code === "access_denied") {
        throw new AuthClientError({ code: "device_flow_denied" });
      }
      throw error;
    }
  }
  throw new AuthClientError({ code: "device_flow_timeout" });
}

export function persistOAuthCredential({ stateDir, credential }) {
  writeCodingAuth(stateDir, credential);
  return credential;
}

export { loginUrlFor, verificationUrlFor };
