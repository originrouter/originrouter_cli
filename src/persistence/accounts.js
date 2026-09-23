import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ACTIVE_ACCOUNT_FILE = "active-account.json";
const ACCOUNT_DOMAIN = "originrouter-account-v1:";

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function accountNamespace(accountScope) {
  if (accountScope == null || accountScope === "") return null;
  return createHash("sha256")
    .update(`${ACCOUNT_DOMAIN}${String(accountScope)}`)
    .digest("hex");
}

export function activeAccountPath(stateDir) {
  return join(stateDir, ACTIVE_ACCOUNT_FILE);
}

export function readActiveAccountScope(stateDir) {
  const value = readJson(activeAccountPath(stateDir));
  return typeof value?.accountScope === "string" && value.accountScope
    ? value.accountScope
    : null;
}

export function accountStateDir(stateDir, accountScope) {
  const namespace = accountNamespace(accountScope);
  return namespace ? join(stateDir, "accounts", namespace) : stateDir;
}

export function isAccountStateDir(stateDir) {
  return basename(dirname(stateDir)) === "accounts"
    && /^[a-f0-9]{64}$/i.test(basename(stateDir));
}

export function activeAccountStateDir(stateDir) {
  // Several long-lived components pass their already-resolved account
  // directory to another account-aware helper. Keep the operation idempotent
  // instead of producing accounts/<hash>/accounts/<hash>.
  if (isAccountStateDir(stateDir)) return stateDir;
  return accountStateDir(stateDir, readActiveAccountScope(stateDir));
}

/**
 * Clear only the active-account selector. Account directories are retained so
 * a later login can reactivate the same account without losing its routes or
 * local history. This is deliberately separate from deleting account data.
 */
export function clearActiveAccount(stateDir) {
  const path = activeAccountPath(stateDir);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
}

export function activateAccount(stateDir, accountScope) {
  if (accountScope == null || accountScope === "") {
    throw new Error("activateAccount: accountScope is required");
  }
  const namespace = accountNamespace(accountScope);
  const accountsDir = join(stateDir, "accounts", namespace);
  mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  const path = activeAccountPath(stateDir);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    version: 1,
    accountScope: String(accountScope),
    namespace,
    updatedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return accountsDir;
}
