// Stage 9.0: minimal persistent storage for the managed coding
// API key. The file holds the key id, the key value (mode 0o600),
// the device grant id, the source, the scopes, and the absolute
// expiry. Rotation helpers overwrite the file in place. logout
// deletes it.
//
// This module is IO only — no I/O happens at import time.
// The CLI never auto-issues a key. Stage 9.0 does not implement
// the exchange / rotation / revocation endpoints; it ships the
// storage shape and a few IO helpers. The exchange flow is
// Stage 9.1+.

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isManagedKeyShape, KEY_KIND, KEY_SCOPE, KEY_SOURCE } from "../runtime/authContract.js";

const FILE_MODE = 0o600;

// Stage 9.0: KEY_KIND is a thin storage-local re-export. The
// canonical shape definitions (and any future shapes like
// KEY_SCOPE / KEY_SOURCE) live in src/runtime/authContract.js.
// codingAuth.js re-exports KEY_KIND so callers of the storage
// layer do not have to import from authContract.js just to
// type-check the kind field. If the two ever drift, the
// authContract.js value wins — codingAuth.js is updated in
// the same patch.
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

// Stage 9.0: the IO layer and the pure shape layer share one
// definition of "valid managed key". writeCodingAuth delegates
// the structural check to isManagedKeyShape so the storage and
// runtime agree on what counts as a well-formed key.
export function writeCodingAuth(stateDir, payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("writeCodingAuth: payload is required");
  }
  // Stage 9.0: the error message is intentionally NOT asserted
  // on a per-field basis. The test suite asserts that
  // writeCodingAuth throws on a malformed payload; it does not
  // pin the message text.
  if (!isManagedKeyShape(payload)) {
    throw new Error(
      `writeCodingAuth: payload is not a well-formed managed key (see isManagedKeyShape)`,
    );
  }
  if (payload.kind !== KEY_KIND.MANAGED) {
    throw new Error(`writeCodingAuth: kind must be '${KEY_KIND.MANAGED}' (got '${payload.kind}')`);
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
