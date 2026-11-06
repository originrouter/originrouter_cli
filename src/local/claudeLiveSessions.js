// Claude Code keeps a live registry of the conversations it has open, one
// file per process, under `~/.claude/sessions/<pid>.json`. Each file records
// the conversation id (`sessionId`), the working directory, and the moment
// the process started.
//
// It is the only place that knows whether a conversation is open *right now*,
// and — unlike anything we keep ourselves — it also covers conversations
// opened by a plain `claude` rather than by `originrouter claude`. Two
// decisions read it: refusing to open a conversation that is already open,
// and refusing to switch into one.
//
// The registry is advisory, not a lock: Claude Code writes it but does not
// use it to stop a second process from opening the same conversation. Our own
// lock (`threadLock.js`) is what closes the gap between two processes that
// start at the same moment; this file is what tells us, in plain language,
// which conversation somebody else is sitting in.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readProcessStartEpochs } from "./processLiveness.js";

export function claudeSessionsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, "sessions");
}

// Every session in the registry that is still running right now.
//
// A registry file outlives its process whenever the process is killed rather
// than exiting, so the file's presence proves nothing on its own. The pid is
// checked against the process's own start time: a pid the kernel has since
// recycled belongs to a different process, and the file is stale.
export function readClaudeLiveSessions({
  dir = claudeSessionsDir(),
  now = Date.now,
  ps,
} = {}) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files = entries.filter((name) => name.endsWith(".json"));
  const parsed = [];
  for (const name of files) {
    const path = join(dir, name);
    let record = null;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const pid = Number(record.pid ?? name.slice(0, -5));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const sessionId = String(record.sessionId || "").trim();
    if (!sessionId) continue;
    parsed.push({
      pid,
      sessionId,
      cwd: record.cwd ? String(record.cwd) : null,
      status: record.status ? String(record.status) : null,
      startedAt: Number.isFinite(Number(record.startedAt))
        ? Number(record.startedAt)
        : null,
      // The registry file is written when the process starts, so its mtime
      // stands in for the start time on versions that do not record one.
      fallbackStartedAt: (() => {
        try {
          return statSync(path).mtimeMs;
        } catch {
          return null;
        }
      })(),
    });
  }

  const starts = readProcessStartEpochs(parsed.map((entry) => entry.pid), { ps, now });
  const live = [];
  for (const entry of parsed) {
    const start = starts.get(entry.pid);
    if (start === undefined) continue;
    const reference = entry.startedAt ?? entry.fallbackStartedAt;
    if (reference !== null && Math.abs(start - reference) > 2000) continue;
    live.push({ ...entry, processStartedAt: start });
  }
  return live;
}

// The live session holding `sessionId`, if any.
//
// `excludePids` drops the processes we know are ours: our own wrapper's
// Claude Code child holds the very conversation we are asking about, and
// asking whether it is "open elsewhere" must not count ourselves.
export function findLiveClaudeSession(sessionId, {
  dir = claudeSessionsDir(),
  excludePids = [],
  now = Date.now,
  ps,
} = {}) {
  const wanted = String(sessionId || "").trim();
  if (!wanted) return null;
  const excluded = new Set(excludePids.map((pid) => Number(pid)));
  const live = readClaudeLiveSessions({ dir, now, ps });
  return live.find((entry) => (
    entry.sessionId === wanted && !excluded.has(entry.pid)
  )) || null;
}
