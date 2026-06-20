// Stage 6: local API bearer-token storage.
//
// The token is a 32-byte random value, hex-encoded (64 chars). It lives in
// `<stateDir>/local-api.token` with mode 0o600. There is exactly one token
// per machine — multi-client fan-out is a YAGNI problem solved later if it
// ever shows up.
//
// `ensureApiToken()` is idempotent: if the file already exists, return it.
// Otherwise mint a new one. `rotateApiToken()` always overwrites.
//
// Used by:
//   - `startDaemon` (boot) to guarantee the file exists before the local API
//     accepts any requests.
//   - `localApi` dispatch (read on every request) to compare the
//     `Authorization: Bearer …` header against the stored value.
//   - `originrouter token rotate` (CLI) for explicit rotation.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const API_TOKEN_BYTES = 32;
export const API_TOKEN_HEX_LENGTH = API_TOKEN_BYTES * 2; // 64

export function apiTokenPath(stateDir) {
  return join(stateDir, "local-api.token");
}

export function readApiToken(stateDir) {
  const p = apiTokenPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, "utf8").trim();
    return /^[a-f0-9]{64}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeApiToken(stateDir, token) {
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error("apiToken must be a 64-char hex string");
  }
  const p = apiTokenPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, token, { mode: 0o600 });
  chmodSync(p, 0o600);
  return resolve(p);
}

export function ensureApiToken(stateDir) {
  const existing = readApiToken(stateDir);
  if (existing) return existing;
  const t = randomBytes(API_TOKEN_BYTES).toString("hex");
  writeApiToken(stateDir, t);
  return t;
}

export function rotateApiToken(stateDir) {
  const t = randomBytes(API_TOKEN_BYTES).toString("hex");
  writeApiToken(stateDir, t);
  return t;
}
