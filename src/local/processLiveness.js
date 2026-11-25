// A pid alone does not identify a process: the kernel reuses pids, so a
// registry file left behind by a dead process would look like a live session
// the moment its pid comes round again. Every liveness check here pairs the
// pid with the process's own start time and compares the two.
//
// `ps -o etime=` is the only source for that start time that is the same
// number on every machine. `lstart` reads better but its format follows the
// locale — on a Chinese macOS it prints `三 11月/ 4 23:13:51 2026` — and it
// is stamped in the local timezone, while the values we compare against are
// UTC epochs. A string comparison would fail on every machine but an English
// one in UTC. `etime` is a bare `[[dd-]hh:]mm:ss` counter, so the same
// process yields the same number everywhere.
import { execFileSync } from "node:child_process";

// `etime` counts in whole seconds, and the `ps` snapshot is taken a moment
// before we read the clock, so the derived start time is off by up to a
// second. Two seconds of slack absorbs that without widening the window
// enough to mistake a recycled pid for the original process.
const START_TIME_TOLERANCE_MS = 2000;

export function parseElapsedSeconds(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const [days, clock] = text.includes("-")
    ? [text.slice(0, text.indexOf("-")), text.slice(text.indexOf("-") + 1)]
    : [null, text];
  const parts = clock.split(":");
  if (parts.length === 2 && /^\d+:\d{2}$/.test(clock)) parts.unshift("0");
  if (parts.length !== 3) return null;
  const [hours, minutes, seconds] = parts.map((part) => Number(part));
  if (![hours, minutes, seconds].every((part) => Number.isFinite(part))) {
    return null;
  }
  return (Number(days || 0) * 86400) + (hours * 3600) + (minutes * 60) + seconds;
}

function runPs(args) {
  try {
    // `ps` complains on stderr about pids it does not like — a pid that has
    // never existed, say — and that complaint is not the reader's problem.
    return execFileSync("ps", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

// The start time of every pid in `pids`, as a UTC epoch in milliseconds.
// A pid that is not running has no entry in the map.
export function readProcessStartEpochs(pids, {
  ps = runPs,
  now = Date.now,
} = {}) {
  const wanted = [...new Set(pids.map((pid) => Number(pid)).filter((pid) => (
    Number.isInteger(pid) && pid > 0
  )))];
  const starts = new Map();
  if (wanted.length === 0) return starts;

  const output = ps(["-o", "pid=,etime=", "-p", wanted.join(",")]);
  if (!output) return starts;

  const sampledAt = now();
  for (const line of String(output).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const elapsed = parseElapsedSeconds(match[2]);
    if (!wanted.includes(pid) || elapsed === null) continue;
    starts.set(pid, sampledAt - (elapsed * 1000));
  }
  return starts;
}

// The start time of one process, or null when it is not running.
export function processStartEpochMs(pid, { ps = runPs, now = Date.now } = {}) {
  return readProcessStartEpochs([pid], { ps, now }).get(Number(pid)) ?? null;
}

// Whether `pid` is still the process that started at `startedAt`.
//
// `startedAt` is compared rather than trusted: a pid that has been recycled
// since the registry file was written answers "alive" to a plain kill(0),
// and mistaking it for the original process is exactly the mistake this
// module exists to prevent. A caller that has no start time to compare
// against gets the weaker answer.
export function isSameLiveProcess(pid, startedAt, {
  ps = runPs,
  now = Date.now,
  toleranceMs = START_TIME_TOLERANCE_MS,
} = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  const start = processStartEpochMs(numericPid, { ps, now });
  if (start === null) return false;
  if (!Number.isFinite(Number(startedAt))) return true;
  return Math.abs(start - Number(startedAt)) <= toleranceMs;
}
