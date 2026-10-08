import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";

import { canonicalJson } from "../crypto/deviceE2eeIdentity.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const KEY_BYTES = 32;

/**
 * Session group keys let one live event reach every subscribed App with a
 * single encryption instead of one per recipient.
 *
 * The pairwise device session is still what *distributes* the key — a
 * requesting device asks over its existing E2EE channel and the CLI answers on
 * that same channel. Nothing here replaces pairwise E2EE; it removes the
 * per-recipient encryption from the *publish* path, where the cost scales with
 * the number of viewers rather than with the amount of information.
 *
 * Scope is deliberately narrow. Only the live event stream uses a group key.
 * Request/response traffic (history paging, audit, interaction resolve) stays
 * pairwise: it has exactly one recipient by construction, so a group key would
 * buy nothing and cost the sender binding that pairwise gives us for free.
 */

function hash(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A session id is attacker-influenced (it arrives in a relay payload), so it
 * must never be interpolated into a path directly. Hashing it keeps the file
 * name a fixed, safe shape and makes traversal impossible.
 */
function keyPath(stateDir, sessionId) {
  return join(stateDir, "session-group-keys", `${hash(sessionId)}.json`);
}

function readRecord(stateDir, sessionId) {
  const path = keyPath(stateDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schema !== 1
        || parsed.session_id !== text(sessionId)
        || typeof parsed.group_key_id !== "string" || !parsed.group_key_id
        || typeof parsed.key !== "string" || !parsed.key) {
      return null;
    }
    const key = Buffer.from(parsed.key, "base64url");
    if (key.length !== KEY_BYTES) return null;
    return { ...parsed, key };
  } catch {
    // A corrupt key file is not worth crashing a session over: treat it as
    // absent and mint a fresh key. Devices re-request on the next subscribe.
    return null;
  }
}

function writeRecord(stateDir, record) {
  const directory = join(stateDir, "session-group-keys");
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);
  const value = {
    schema: 1,
    session_id: record.session_id,
    group_key_id: record.group_key_id,
    key: record.key.toString("base64url"),
    created_at: record.created_at,
  };
  const path = keyPath(stateDir, record.session_id);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: FILE_MODE });
  chmodSync(temporary, FILE_MODE);
  renameSync(temporary, path);
  chmodSync(path, FILE_MODE);
  return value;
}

/**
 * The identity of a group key. It travels in `recipient_key_id`, which the
 * relay validator caps at 96 characters and which must not collide with a
 * device key id (those are `sha256:...`), so it carries its own prefix.
 */
export function groupKeyIdFor(sessionId, key) {
  return `grp:${hash(canonicalJson({
    session_id: text(sessionId),
    key: key.toString("base64url"),
  })).slice(0, 40)}`;
}

/**
 * Return the group key for a session, creating and persisting one on first
 * use.
 *
 * The key is persisted because it must outlive a daemon restart: an App that
 * already holds it will keep receiving events, and a restart that silently
 * rotated the key would make every subsequent event undecryptable until each
 * App noticed and re-requested. Rotating is a deliberate act, not a side
 * effect of `originrouter daemon restart`.
 */
export function ensureSessionGroupKey(stateDir, sessionId, { now = Date.now() } = {}) {
  const id = text(sessionId);
  if (!id) throw new Error("session group key requires a session id");
  const existing = readRecord(stateDir, id);
  if (existing) return existing;
  const key = randomBytes(KEY_BYTES);
  const record = {
    session_id: id,
    group_key_id: groupKeyIdFor(id, key),
    key,
    created_at: new Date(now).toISOString(),
  };
  writeRecord(stateDir, record);
  return record;
}

/**
 * Read the group key without creating one.
 *
 * A device asking for the key of a session the CLI has never published for
 * must not cause a key to spring into existence — that would let any trusted
 * device pre-seed a key for a session that does not exist yet.
 */
export function readSessionGroupKey(stateDir, sessionId) {
  return readRecord(stateDir, text(sessionId));
}

export function forgetSessionGroupKey(stateDir, sessionId) {
  const path = keyPath(stateDir, text(sessionId));
  if (existsSync(path)) unlinkSync(path);
}

export function sessionGroupKeyPath(stateDir, sessionId) {
  return keyPath(stateDir, sessionId);
}

/**
 * Guard for callers that only have a state directory and an untrusted id.
 * Exported so the daemon can assert a path stays inside the state directory
 * when it logs or ships the location.
 */
export function isInsideStateDir(stateDir, candidate) {
  const base = resolve(stateDir);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}
