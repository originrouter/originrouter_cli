// Stage 9.9: persistent storage for the OriginRouter auth credential.
// The on-disk shape is now a surety relay record. The file holds the
// device_grant (long-lived), the cached access_token (short-lived,
// ~1h, format rt_<base64url>, silently re-signed by surety), the
// token_endpoint (surety URL), the device_id, and the scopes.
// Mode 0o600.
//
// Pre-9.9 files with the legacy managed-key shape (sk-or-... long-
// lived key) are still readable for the transition window via
// `isAnyManagedCredentialShape` (see runtime/authContract.js).
// New writes always use the relay shape.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isAnyManagedCredentialShape,
  isManagedKeyShape,
  isRelayShape,
  KEY_KIND,
  KEY_SCOPE,
  KEY_SOURCE,
} from "../runtime/authContract.js";

const FILE_MODE = 0o600;

export { KEY_KIND };

export function codingAuthPath(stateDir) {
  return join(stateDir, "coding-key.json");
}

export function readCodingAuth(stateDir) {
  const p = codingAuthPath(stateDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function writeCodingAuth(stateDir, payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("writeCodingAuth: payload is required");
  }
  if (!isAnyManagedCredentialShape(payload)) {
    throw new Error(
      `writeCodingAuth: payload is not a well-formed relay or managed key shape`,
    );
  }
  if (payload.source !== KEY_SOURCE.ORIGINROUTER_CLI) {
    throw new Error(
      `writeCodingAuth: CLI storage only accepts source='${KEY_SOURCE.ORIGINROUTER_CLI}' ` +
      `(got '${payload.source}')`,
    );
  }
  if (!Array.isArray(payload.scopes) || !payload.scopes.includes(KEY_SCOPE.CODING)) {
    throw new Error(
      `writeCodingAuth: scopes must include '${KEY_SCOPE.CODING}' (got ${JSON.stringify(payload.scopes)})`,
    );
  }
  const p = codingAuthPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({ ...payload, writtenAt: Date.now() }, null, 2),
    { mode: FILE_MODE },
  );
  chmodSync(p, FILE_MODE);
}

export function clearCodingAuth(stateDir) {
  const p = codingAuthPath(stateDir);
  if (existsSync(p)) {
    try { unlinkSync(p); } catch {}
  }
}

export { isManagedKeyShape, isRelayShape };
