import {
  readCodingAuth,
  withCodingAuthLock,
  writeCodingAuth,
} from "../persistence/codingAuth.js";
import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { refreshOAuthToken } from "../auth/originrouterAuthClient.js";

const HEADROOM_MS = 60_000;

function assertRefreshSessionValid(credential, nowMs) {
  if (credential.refreshExpiresAt <= nowMs) {
    const error = new Error("OriginRouter OAuth refresh session has expired");
    error.code = "OAUTH_REFRESH_EXPIRED";
    throw error;
  }
}

export async function ensureFreshAccessToken({
  stateDir,
  resource = OAUTH_RESOURCES.CONTROL,
  nowMs = Date.now(),
  headroomMs = HEADROOM_MS,
  forceRefresh = false,
  staleToken = null,
  fetchFn = globalThis.fetch,
} = {}) {
  const current = readCodingAuth(stateDir);
  if (!current) return null;
  assertRefreshSessionValid(current, nowMs);
  const existing = accessTokenFor(current, resource);
  if (!forceRefresh && existing && nowMs < existing.expiresAt - headroomMs) return current;

  return withCodingAuthLock(stateDir, async () => {
    const stored = readCodingAuth(stateDir);
    if (!stored) return null;
    assertRefreshSessionValid(stored, Date.now());
    const freshCheck = accessTokenFor(stored, resource);
    if (forceRefresh && staleToken && freshCheck?.token !== staleToken) return stored;
    if (!forceRefresh && freshCheck && Date.now() < freshCheck.expiresAt - headroomMs) return stored;
    const response = await refreshOAuthToken({
      tokenEndpoint: stored.tokenEndpoint,
      refreshToken: stored.refreshToken,
      resource,
      fetchFn,
    });
    if (!response?.access_token?.startsWith("or_at_") ||
        !response?.refresh_token?.startsWith("or_rt_")) {
      const error = new Error("Surety returned an invalid refresh response");
      error.code = "OAUTH_REFRESH_INVALID_RESPONSE";
      throw error;
    }
    const key = Object.entries(OAUTH_RESOURCES)
      .find(([, value]) => value === resource)?.[0]?.toLowerCase();
    if (!key) {
      const error = new Error(`Unsupported OAuth resource ${resource}`);
      error.code = "OAUTH_RESOURCE_UNSUPPORTED";
      throw error;
    }
    const updated = {
      ...stored,
      refreshToken: response.refresh_token,
      refreshExpiresAt: Date.now() + Number(response.refresh_expires_in || 2592000) * 1000,
      accessTokens: {
        ...stored.accessTokens,
        [key]: {
          token: response.access_token,
          expiresAt: Date.now() + Number(response.expires_in || 600) * 1000,
          scopes: String(response.scope || "").split(" ").filter(Boolean),
        },
      },
    };
    writeCodingAuth(stateDir, updated);
    return updated;
  });
}
