import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, getStateDir } from "./state.js";

const SESSION_LOG_FILE = "sessions.jsonl";

function sessionLogPath() {
  ensureStateDir();
  return join(getStateDir(), SESSION_LOG_FILE);
}

function ensureFile(path) {
  if (!existsSync(path)) {
    writeFileSync(path, "");
    try {
      chmodSync(path, 0o600);
    } catch {}
  }
}

// Append a `running` entry for a freshly started session.
// Best-effort: failures are swallowed by the caller (see localAgentSession.js /
// sessionManager.js) so that a broken log file does not abort the session.
export function appendSessionStart(entry) {
  const path = sessionLogPath();
  ensureFile(path);
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// Mark the matching session as exited. We rewrite the whole file because the
// JSONL file is small (tens of entries), and partial-rewrite on disk would
// risk corruption if the process dies mid-write. A full rewrite is atomic
// from the perspective of "the file is consistent at any point".
export function patchSessionExit({ sessionId, status, code, signal, exitedAt }) {
  const path = sessionLogPath();
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  let mutated = false;

  const next = lines.map((line) => {
    if (!line.trim() || mutated) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (record.sessionId !== sessionId) return line;
    if (record.status === "exited") return line;
    mutated = true;
    return JSON.stringify({
      ...record,
      status: status || "exited",
      code: code ?? null,
      signal: signal ?? null,
      exitedAt: exitedAt || new Date().toISOString(),
    });
  });

  if (mutated) {
    writeFileSync(path, `${next.join("\n")}`);
  }
}

export function readSessions() {
  const path = sessionLogPath();
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip malformed line, keep the rest
    }
  }
  return records;
}