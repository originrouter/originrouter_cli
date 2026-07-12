// Stage 9.9: surety relay access_token 静默刷新。
//
// CLI 存储一个长期 device_grant + 一个短期 access_token (rt_..., 1h)。
// 在每次 LLM 请求前，env builder 调 ensureFreshAccessToken()：
//   1. 读取本地存储的 credential
//   2. 如果 accessTokenExpiresAt - now > 60s，直接返回（token 仍有效）
//   3. 否则，POST tokenEndpoint（surety /api/relay/token）用 device_grant
//      签一个新的 access_token，写回磁盘，返回新 credential

import { writeCodingAuth, readCodingAuth } from "../persistence/codingAuth.js";
import { KEY_KIND } from "./authContract.js";

const HEADROOM_MS = 60_000;

export async function ensureFreshAccessToken({
  stateDir,
  nowMs = Date.now(),
  fetchFn = globalThis.fetch,
} = {}) {
  const stored = readCodingAuth(stateDir);
  if (!stored) return null;
  if (stored.kind !== KEY_KIND.RELAY) {
    const err = new Error(
      "Stored credential uses pre-9.9 shape. Run `originrouter login` again to upgrade.",
    );
    err.code = "RELAY_LOGIN_REQUIRED";
    throw err;
  }
  if (typeof stored.accessTokenExpiresAt !== "number") {
    return stored;
  }
  if (nowMs < stored.accessTokenExpiresAt - HEADROOM_MS) {
    return stored;
  }
  if (!stored.tokenEndpoint || !stored.deviceGrant || !stored.deviceId) {
    const err = new Error(
      "Stored credential is missing tokenEndpoint, deviceGrant, or deviceId. Run `originrouter login` again.",
    );
    err.code = "RELAY_LOGIN_REQUIRED";
    throw err;
  }
  const resp = await fetchFn(stored.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      v: "v1",
      "device-id": stored.deviceId,
      "device-grant": stored.deviceGrant,
    }),
  });
  const body = await resp.json();
  if (body.code !== 0) {
    const errMsg = body.msg || "unknown error";
    const isRevoked = errMsg.includes("revoked") || errMsg.includes("invalid_grant");
    const err = new Error(
      `Relay token refresh failed: ${errMsg}. ` +
      (isRevoked ? "Run `originrouter login` again." : "Check network or surety service."),
    );
    err.code = isRevoked ? "RELAY_GRANT_REVOKED" : "RELAY_REFRESH_FAILED";
    throw err;
  }
  const data = body.data;
  const newStored = {
    ...stored,
    accessToken: data["relay-access-token"],
    accessTokenExpiresAt: data["expires-at"] * 1000,
  };
  writeCodingAuth(stateDir, newStored);
  return newStored;
}
