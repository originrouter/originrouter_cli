import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isOAuthCredentialShape, KEY_KIND } from "../runtime/authContract.js";
import {
  accountStateDir,
  activateAccount,
  activeAccountStateDir,
  clearActiveAccount,
  isAccountStateDir,
  readActiveAccountScope,
} from "./accounts.js";

const FILE_MODE = 0o600;
const LOCK_STALE_MS = 30_000;

// These files were installation-root scoped before account directories were
// introduced. They contain user/account data, unlike device.json, local-api,
// runtimes, and daemon state. A verified account credential is the only safe
// ownership signal, so migrate them only after an accountScope is known.
const LEGACY_ACCOUNT_STATE_NAMES = Object.freeze([
  "sessions.jsonl",
  "agent-catalog.sqlite3",
  "collaboration.sqlite3",
  "telemetry.sqlite3",
  "agent-budgets.sqlite3",
  "proxy-requests.sqlite3",
  "collaboration-drafts.json",
  "collaboration-capabilities.json",
  "policies",
  "audit",
  "remote-coding-peer-keys.json",
  "proxy.state.d",
  "remote-share-proxy.state.d",
]);

export { KEY_KIND, isOAuthCredentialShape };

export function codingAuthPath(stateDir) {
  return join(activeAccountStateDir(stateDir), "coding-key.json");
}

export function accountCodingAuthPath(stateDir, accountScope) {
  return join(accountStateDir(stateDir, accountScope), "coding-key.json");
}

function parsedCredential(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isOAuthCredentialShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Pre-account-directory clients kept both config.json and coding-key.json at
// the state root. Migrate only when the legacy credential itself identifies
// the account. Guessing would be worse than leaving an unowned legacy config
// in place: it could make account B inherit account A's providers.
function migrateLegacyRootAccount(stateDir) {
  if (readActiveAccountScope(stateDir)) return null;
  const legacyCredentialPath = join(stateDir, "coding-key.json");
  const legacy = parsedCredential(legacyCredentialPath);
  if (!legacy?.accountScope) return null;
  const scopedStateDir = activateAccount(stateDir, legacy.accountScope);
  for (const name of ["coding-key.json", "config.json"]) {
    const source = join(stateDir, name);
    const target = join(scopedStateDir, name);
    if (!existsSync(source) || existsSync(target)) continue;
    try { renameSync(source, target); } catch {}
  }
  migrateLegacyAccountState(stateDir, scopedStateDir);
  return scopedStateDir;
}

function migrateLegacyAccountState(stateDir, scopedStateDir) {
  mkdirSync(scopedStateDir, { recursive: true, mode: 0o700 });
  for (const name of LEGACY_ACCOUNT_STATE_NAMES) {
    const source = join(stateDir, name);
    const target = join(scopedStateDir, name);
    if (!existsSync(source) || existsSync(target)) continue;
    try { renameSync(source, target); } catch {}
    // SQLite may have WAL/SHM sidecars created while the process was alive.
    if (name.endsWith(".sqlite3")) {
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${source}${suffix}`;
        const targetSidecar = `${target}${suffix}`;
        if (existsSync(sidecar) && !existsSync(targetSidecar)) {
          try { renameSync(sidecar, targetSidecar); } catch {}
        }
      }
    }
  }
}

function lockPath(stateDir) {
  return join(stateDir, "coding-key.refresh.lock");
}

export function readCodingAuth(stateDir) {
  if (isAccountStateDir(stateDir)) {
    return parsedCredential(join(stateDir, "coding-key.json"));
  }
  migrateLegacyRootAccount(stateDir);
  const path = codingAuthPath(stateDir);
  return parsedCredential(path);
}

export function writeCodingAuth(stateDir, payload) {
  if (!isOAuthCredentialShape(payload)) {
    throw new Error("writeCodingAuth: payload is not a valid OriginRouter OAuth credential");
  }
  if (isAccountStateDir(stateDir)) {
    const path = join(stateDir, "coding-key.json");
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...payload, writtenAt: Date.now() }, null, 2), {
      mode: FILE_MODE,
    });
    chmodSync(temporary, FILE_MODE);
    renameSync(temporary, path);
    chmodSync(path, FILE_MODE);
    return;
  }
  // Preserve a verified legacy account before switching to a newly issued
  // credential. This is a no-op for fresh installations and scoped stores.
  migrateLegacyRootAccount(stateDir);
  const scopedStateDir = payload.accountScope
    ? activateAccount(stateDir, payload.accountScope)
    : stateDir;
  mkdirSync(scopedStateDir, { recursive: true });
  const path = join(scopedStateDir, "coding-key.json");
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...payload, writtenAt: Date.now() }, null, 2), {
    mode: FILE_MODE,
  });
  chmodSync(temporary, FILE_MODE);
  renameSync(temporary, path);
  chmodSync(path, FILE_MODE);
}

export function clearCodingAuth(stateDir) {
  const path = codingAuthPath(stateDir);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
  // A credential-less installation must not continue selecting the previous
  // account's config/history. Keep the account directory itself intact; the
  // next login will activate it again using the credential's accountScope.
  clearActiveAccount(stateDir);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withCodingAuthLock(stateDir, fn, { timeoutMs = 10_000 } = {}) {
  const scopedStateDir = activeAccountStateDir(stateDir);
  mkdirSync(scopedStateDir, { recursive: true });
  const path = lockPath(scopedStateDir);
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  while (fd == null) {
    try {
      fd = openSync(path, "wx", FILE_MODE);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch {}
      if (Date.now() >= deadline) {
        const timeout = new Error("Timed out waiting for OAuth refresh lock");
        timeout.code = "OAUTH_REFRESH_LOCK_TIMEOUT";
        throw timeout;
      }
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(path); } catch {}
  }
}
