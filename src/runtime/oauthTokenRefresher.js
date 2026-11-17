import {
  readCodingAuth,
  sameCredentialSession,
  withAuthStateLock,
  withCodingAuthLock,
  writeCodingAuth,
} from "../persistence/codingAuth.js";
import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { refreshOAuthToken } from "../auth/originrouterAuthClient.js";
import { accountSelectionRoot, isAccountStateDir } from '../persistence/accounts.js';

const HEADROOM_MS = 60_000;

function assertActiveSession(stateDir, credential) {
  if (isAccountStateDir(stateDir) &&
      !sameCredentialSession(readCodingAuth(accountSelectionRoot(stateDir)), credential)) {
    throw Object.assign(new Error('Account changed during token refresh'), {code: 'account_changed'});
  }
}

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
  assertActiveSession(stateDir, current);
  assertRefreshSessionValid(current, nowMs);
  const existing = accessTokenFor(current, resource);
  if (!forceRefresh && existing && nowMs < existing.expiresAt - headroomMs) return current;

  return withCodingAuthLock(stateDir, async () => {
    const stored = readCodingAuth(stateDir);
    if (!sameCredentialSession(stored, current)) {
      throw Object.assign(new Error('Account changed during token refresh'), {code: 'account_changed'});
    }
    assertActiveSession(stateDir, stored);
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
    // A refresh may answer with every audience the session is allowed, not
    // just the one this call asked for. Taking only the requested audience
    // would throw the rest away and then ask for them again later, one
    // request per resource — and every one of those requests spends the
    // refresh token we just stored. Store everything the answer carried.
    const refreshedAt = Date.now();
    const bundled = response.access_tokens;
    const accessTokens = { ...stored.accessTokens };
    if (bundled && typeof bundled === "object") {
      for (const [entry, value] of Object.entries(OAUTH_RESOURCES)) {
        const bundleKey = entry.toLowerCase();
        const audience = bundled[value];
        const token = audience?.access_token;
        if (typeof token !== "string" || !token.startsWith("or_at_")) continue;
        accessTokens[bundleKey] = {
          token,
          expiresAt:
            refreshedAt + Number(audience.expires_in || response.expires_in || 600) * 1000,
          scopes: String(audience.scope || response.scope || "")
            .split(" ")
            .filter(Boolean),
        };
      }
    }
    accessTokens[key] = {
      token: response.access_token,
      expiresAt: refreshedAt + Number(response.expires_in || 600) * 1000,
      scopes: String(response.scope || "").split(" ").filter(Boolean),
    };
    const updated = {
      ...stored,
      refreshToken: response.refresh_token,
      refreshExpiresAt:
        Date.now() + Number(response.refresh_expires_in || 2592000) * 1000,
      accessTokens,
    };
    await withAuthStateLock(stateDir, () => {
      assertActiveSession(stateDir, stored);
      const live = readCodingAuth(stateDir);
      if (!sameCredentialSession(live, stored) || live.refreshToken !== stored.refreshToken) {
        throw Object.assign(new Error('Account changed during token refresh'), {code: 'account_changed'});
      }
      writeCodingAuth(stateDir, updated);
    });
    return updated;
  });
}
