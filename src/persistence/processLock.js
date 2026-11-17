// SQLite provides an OS-backed, crash-released cross-process lock. A live
// operation is never displaced merely because it took longer than a TTL.
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

// Keep native connections strongly reachable across awaits. A suspended
// Promise alone need not keep its closure alive in V8 when it is otherwise
// unreachable; finalizing a connection would silently release its lock.
const activeConnections = new Set();

export async function withProcessLock(storePath, operation, {
  timeoutMs = 120_000, timeoutCode = 'process_lock_timeout',
} = {}) {
  const path = `${storePath}.lock.sqlite`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // Never open and close an existing lock file outside SQLite. On POSIX,
    // closing any descriptor for an inode can release this process's locks
    // on it, including those held by another in-process SQLite connection.
    const fd = openSync(path, 'wx', 0o600);
    closeSync(fd);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const database = new Database(path, { timeout: 0 });
  activeConnections.add(database);
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  try {
    while (!acquired) {
      try {
        database.exec('CREATE TABLE IF NOT EXISTS registration_lock (id INTEGER PRIMARY KEY)');
        database.exec('BEGIN IMMEDIATE');
        acquired = true;
      } catch (error) {
        if (error?.code !== 'SQLITE_BUSY' && error?.code !== 'SQLITE_LOCKED') throw error;
        if (Date.now() >= deadline) {
          throw Object.assign(new Error('Timed out waiting for a process lock'), {
            code: timeoutCode,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return await operation();
  } finally {
    try {
      if (acquired) database.exec('ROLLBACK');
    } finally {
      database.close();
      activeConnections.delete(database);
    }
  }
}
