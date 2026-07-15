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
import { dirname, join } from "node:path";

import { isOAuthCredentialShape, KEY_KIND } from "../runtime/authContract.js";

const FILE_MODE = 0o600;
const LOCK_STALE_MS = 30_000;

export { KEY_KIND, isOAuthCredentialShape };

export function codingAuthPath(stateDir) {
  return join(stateDir, "coding-key.json");
}

function lockPath(stateDir) {
  return join(stateDir, "coding-key.refresh.lock");
}

export function readCodingAuth(stateDir) {
  const path = codingAuthPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isOAuthCredentialShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCodingAuth(stateDir, payload) {
  if (!isOAuthCredentialShape(payload)) {
    throw new Error("writeCodingAuth: payload is not a valid OriginRouter OAuth credential");
  }
  mkdirSync(stateDir, { recursive: true });
  const path = codingAuthPath(stateDir);
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
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withCodingAuthLock(stateDir, fn, { timeoutMs = 10_000 } = {}) {
  mkdirSync(dirname(codingAuthPath(stateDir)), { recursive: true });
  const path = lockPath(stateDir);
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
