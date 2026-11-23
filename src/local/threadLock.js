// One writer per conversation.
//
// Claude Code keeps a conversation in a single transcript file and does not
// lock it: `~/.claude/projects/<slug>/<uuid>.jsonl` is opened, appended to
// and closed by whoever is running. Two processes in that conversation at the
// same time do not queue — they interleave their writes and fork the
// history, and neither side can tell afterwards which half of the transcript
// belongs to which run.
//
// Codex solves the same problem with an advisory lock on the thread's writer
// file (`codex-rs/rollout/src/writer_lock.rs`): the lock is a file, the
// winner is whoever created it exclusively, and a lock whose owner is gone
// is removed rather than inherited. Node has no `flock`, so `O_EXCL` plus a
// liveness check on the recorded pid plays the same role.
//
// The lock is held for the whole run, keyed by the *provider's* conversation
// id — the id Claude Code itself uses — because that is the thing two
// processes would be writing to. Our own session id cannot be used: two
// runs of the same conversation have two of those.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

import { getStateDir } from "../persistence/state.js";
import { isSameLiveProcess } from "./processLiveness.js";

export function threadLocksDir(stateDir = getStateDir()) {
  return join(stateDir, "thread-locks");
}

// A conversation id is a uuid or one of our own generated ids; both are
// safe as a filename, but a hostile id must not be able to escape the
// directory.
function lockFileName(nativeSessionId) {
  const safe = String(nativeSessionId || "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe) throw new Error("a thread lock needs a conversation id");
  return `${safe}.lock`;
}

function readHolder(path) {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (!record || typeof record !== "object") return null;
    return {
      pid: Number(record.pid),
      startedAt: Number.isFinite(Number(record.startedAt))
        ? Number(record.startedAt)
        : null,
      acquiredAt: Number(record.acquiredAt) || null,
      ...(Number.isInteger(record.childPid) && record.childPid > 0
        ? { childPid: record.childPid, childStartedAt: record.childStartedAt } : {}),
    };
  } catch {
    return null;
  }
}

// Take the lock for `nativeSessionId`.
//
// Returns `{ok: true, path}` when the lock was taken, and `{ok: false,
// holder}` when a live process already holds it. A lock left behind by a
// process that is gone is stale and is reclaimed — the same cleanup Codex
// does, because a killed run must not make its conversation unopenable
// forever.
export function acquireThreadLock(nativeSessionId, {
  dir = threadLocksDir(),
  pid = process.pid,
  startedAt = Date.now(),
  now = Date.now,
  isAlive = isSameLiveProcess,
} = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, lockFileName(nativeSessionId));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd = null;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = readHolder(path);
      if (holder && (isAlive(holder.pid, holder.startedAt, { now })
          || (holder.childPid && isAlive(holder.childPid, holder.childStartedAt, { now })))) {
        return { ok: false, path, holder };
      }
      // The owner is gone. Reclaim the lock and try once more.
      try {
        unlinkSync(path);
      } catch {
        // Another process may have reclaimed it first; the retry decides.
      }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({
        pid,
        startedAt,
        acquiredAt: now(),
      }));
    } finally {
      closeSync(fd);
    }
    return { ok: true, path, pid };
  }

  return { ok: false, path, holder: readHolder(path) };
}

// Give the lock back. The file is only removed when it still names us: a
// lock that has been reclaimed by somebody else belongs to them now.
export function releaseThreadLock(lock, { pid = process.pid, isAlive = isSameLiveProcess } = {}) {
  if (!lock?.path) return false;
  const holder = readHolder(lock.path);
  if (holder && holder.pid !== pid) return false;
  if (holder?.childPid && isAlive(holder.childPid, holder.childStartedAt)) return false;
  try {
    unlinkSync(lock.path);
    return true;
  } catch {
    return false;
  }
}

// Release the lock when the process goes away, however it goes away. A
// `SIGKILL`ed run leaves the file behind, and the next run's liveness check
// is what reclaims it.
export function releaseThreadLockOnExit(lock, { pid = process.pid, isAlive = isSameLiveProcess } = {}) {
  if (!lock?.path) return () => {};
  const release = () => {
    releaseThreadLock(lock, { pid, isAlive });
  };
  process.once("exit", release);
  return release;
}

// Optional child identity, used by agy. Other agents retain the existing lock contract.
export function setThreadLockChild(lock, childPid, childStartedAt, { pid = process.pid } = {}) {
  if (!lock?.path || !Number.isInteger(childPid) || childPid <= 0) return false;
  const holder = readHolder(lock.path);
  if (!holder || holder.pid !== pid) return false;
  const temporary = `${lock.path}.${pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...holder, childPid, childStartedAt }), { mode: 0o600 });
  renameSync(temporary, lock.path);
  return true;
}
