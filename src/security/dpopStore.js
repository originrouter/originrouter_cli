// Where a CLI device's DPoP key lives, and what it is registered with.
//
// The key is private, so it is written with the same care as the rest of the
// CLI's private material: one file, 0600, written atomically. It is *not*
// written into the device E2EE identity file — that file carries a key id
// and a signature chain that the server checks, and adding a second key to
// it would corrupt both.
//
// The record is scoped to the account, because the server's registry is
// scoped to the account too: one account's key means nothing to another,
// and a device that is signed into two accounts over its life has to be
// able to hold a key for each.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  accountStateDir,
  activeAccountStateDir,
  isAccountStateDir,
  readActiveAccountScope,
} from "../persistence/accounts.js";

const FILE_MODE = 0o600;
const STORE_VERSION = 1;

/**
 * The file the record lives in.
 *
 * The account scope decides the directory, so two accounts on one machine
 * never share a key. When there is no account yet — a CLI that has never
 * logged in — the record goes to the state root, which is where the
 * credential would be as well.
 */
export function dpopStorePath(stateDir, { accountScope } = {}) {
  // A caller that already resolved the account directory gets that one, the
  // way the OAuth credential is stored. Everything else resolves the active
  // account, which is the account the CLI is speaking for.
  if (isAccountStateDir(stateDir)) return join(stateDir, "dpop-key.json");
  const scope = accountScope ?? readActiveAccountScope(stateDir);
  const directory = scope ? accountStateDir(stateDir, scope) : activeAccountStateDir(stateDir);
  return join(directory, "dpop-key.json");
}

export function readDpopStore(stateDir, { accountScope, strict = false } = {}) {
  const path = dpopStorePath(stateDir, { accountScope });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (strict) throw Object.assign(new Error("DPoP key store is unreadable"), { code: "dpop_key_unavailable" });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.key || typeof parsed.key.private_jwk !== "object" ||
      !parsed.registrations || typeof parsed.registrations !== "object" || Array.isArray(parsed.registrations)) {
    if (strict) throw Object.assign(new Error("DPoP key store is invalid"), { code: "dpop_key_unavailable" });
    return null;
  }
  return {
    version: Number(parsed.version || STORE_VERSION),
    key: parsed.key,
    registrations: parsed.registrations && typeof parsed.registrations === "object"
      ? parsed.registrations
      : {},
  };
}

export function writeDpopStore(stateDir, store, { accountScope } = {}) {
  const path = dpopStorePath(stateDir, { accountScope });
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...store, version: STORE_VERSION }, null, 2)}\n`, {
    mode: FILE_MODE,
  });
  chmodSync(temporary, FILE_MODE);
  renameSync(temporary, path);
  chmodSync(path, FILE_MODE);
  return store;
}

export function clearDpopStore(stateDir, { accountScope } = {}) {
  const path = dpopStorePath(stateDir, { accountScope });
  if (!existsSync(path)) return;
  try { unlinkSync(path); } catch {}
}

/**
 * Record what one deployment says about this device's key.
 *
 * The record is kept per deployment rather than per origin: the public
 * control-plane aliases answer for one service, so a key registered
 * through one of them is the same key to the others.
 */
export function setDpopRegistration(stateDir, deployment, registration, { accountScope } = {}) {
  const store = readDpopStore(stateDir, { accountScope, strict: true }) || {
    version: STORE_VERSION,
    key: null,
    registrations: {},
  };
  const next = {
    ...store,
    registrations: { ...store.registrations, [deployment]: registration },
  };
  return writeDpopStore(stateDir, next, { accountScope });
}

/**
 * Drop what one deployment says about this device's key.
 *
 * The key itself stays: a deployment that no longer knows the key is a
 * deployment to register with again, not a reason to throw away the
 * private half.
 */
export function forgetDpopRegistration(stateDir, deployment, { accountScope } = {}) {
  const store = readDpopStore(stateDir, { accountScope, strict: true });
  if (!store || !store.registrations[deployment]) return store;
  const registrations = { ...store.registrations };
  delete registrations[deployment];
  return writeDpopStore(stateDir, { ...store, registrations }, { accountScope });
}

export function readDpopRegistration(stateDir, deployment, { accountScope } = {}) {
  const store = readDpopStore(stateDir, { accountScope });
  const registration = store?.registrations?.[deployment];
  if (!registration || typeof registration !== "object") return null;
  return {
    status: String(registration.status || "none"),
    jkt: typeof registration.jkt === "string" ? registration.jkt : null,
    origin: typeof registration.origin === "string" ? registration.origin : null,
  };
}
