// The native TUI writes its process PID in the log header and announces the
// foreground conversation in its UI manager. Server-side conversation lookups
// can refer to other threads and are deliberately ignored.
import { closeSync, existsSync, mkdirSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readProcessStartEpochs } from '../../local/processLiveness.js';

const logDir = () => join(homedir(), '.gemini', 'antigravity-cli', 'log');
const blockSize = 64 * 1024;
const pidHeader = /^I\d{4} [\d:.]+\s+\d+ server\.go:\d+\] Starting language server process with pid (\d+)\s*$/;
const foreground = /^I\d{4} [\d:.]+\s+\d+ (?:common\.go:\d+\] Resuming conversation|conversation_manager\.go:\d+\] Streaming conversation) ([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\s*$/i;

// The native default name has one-second resolution. Give each managed PTY
// its own file even when two terminals start in the same second.
export function newAgyLogPath(home = homedir(), date = new Date()) {
  const dir = join(home, '.gemini', 'antigravity-cli', 'log');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pad = n => String(n).padStart(2, '0');
  const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('');
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join('');
  return join(dir, `cli-${day}_${clock}-or-${randomUUID()}.log`);
}

function nativeLogs(dir, from, until) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap(name => {
    const parts = /^cli-(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)(?:-or-[a-f0-9-]+)?\.log$/.exec(name);
    if (!parts) return [];
    const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
    const start = new Date(year, month - 1, day, hour, minute, second).getTime();
    return start >= from && start <= until ? [{ path: join(dir, name), start }] : [];
  });
}

function headerPid(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(512);
    const size = readSync(fd, buf, 0, buf.length, 0);
    return Number(buf.toString('utf8', 0, size).split('\n')[0]
      .match(pidHeader)?.[1]) || null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export class AgyConversationLog {
  constructor({ pid, startedAt, path, dir = logDir() }) {
    this.pid = pid;
    this.startedAt = startedAt;
    this.explicitPath = path;
    this.dir = dir;
    this.offset = 0;
    this.partial = '';
    this.nextLookup = 0;
  }

  read({ until = Date.now(), all = false, since = 0 } = {}) {
    const ids = [];
    if (this.ambiguous) return ids;
    if (!this.path) {
      if (!all && Date.now() < this.nextLookup) return ids;
      this.nextLookup = Date.now() + 500;
      const candidates = this.explicitPath ? [{ path: this.explicitPath }]
        : nativeLogs(this.dir, this.startedAt - 2000, until + 1000);
      const matches = candidates.filter(candidate => headerPid(candidate.path) === this.pid);
      if (matches.length !== 1) return ids;
      this.path = matches[0].path;
    }
    let fd;
    try {
      fd = openSync(this.path, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile()) return ids;
      if (this.inode !== undefined && (this.inode !== stat.ino || stat.size < this.offset)) {
        this.path = null;
        this.offset = 0;
        this.partial = '';
        this.inode = undefined;
        return ids;
      }
      this.inode = stat.ino;
      const end = all ? stat.size : Math.min(stat.size, this.offset + 4 * blockSize);
      const buffer = Buffer.allocUnsafe(blockSize);
      while (this.offset < end) {
        const n = readSync(fd, buffer, 0, Math.min(end - this.offset, blockSize), this.offset);
        if (!n) break;
        this.offset += n;
        const lines = (this.partial + buffer.toString('latin1', 0, n)).split('\n');
        this.partial = lines.pop();
        if (this.partial.length > 8192) this.partial = '#';
        for (const line of lines) {
          const pid = pidHeader.exec(line)?.[1];
          if (pid && Number(pid) !== this.pid) {
            this.ambiguous = true;
            return [];
          }
          const id = foreground.exec(line)?.[1];
          if (id && since) {
            const parts = /^I(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})/.exec(line);
            if (parts) {
              const [month, day, hour, minute, second, ms] = parts.slice(1).map(Number);
              const date = new Date(since);
              const time = new Date(date.getFullYear(), month - 1, day, hour, minute, second, ms);
              if (time - date > 183 * 86400000) time.setFullYear(time.getFullYear() - 1);
              if (date - time > 183 * 86400000) time.setFullYear(time.getFullYear() + 1);
              if (time.getTime() < since) continue;
            }
          }
          if (id && id !== ids.at(-1)) ids.push(id);
        }
      }
    } catch { /* The hook remains authoritative if the log is unavailable. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    return ids;
  }
}

export function findLiveAgySession(id, { excludePids = [], dir = logDir() } = {}) {
  if (!id || !existsSync(dir)) return null;
  // Verify both the process identity and its start time before trusting a log.
  const candidates = nativeLogs(dir, 0, Infinity).map(log => ({ ...log, pid: headerPid(log.path) }))
    .filter(log => log.pid && !excludePids.includes(log.pid));
  const live = candidates.filter(({ pid }) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
  const starts = readProcessStartEpochs(live.map(log => log.pid));
  for (const log of live) {
    const startedAt = starts.get(log.pid);
    if (startedAt === undefined || Math.abs(startedAt - log.start) > 2500) continue;
    const reader = new AgyConversationLog({ pid: log.pid, path: log.path, startedAt });
    if (reader.read({ all: true }).at(-1) === id) return { pid: log.pid, sessionId: id };
  }
  return null;
}
