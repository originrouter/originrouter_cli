// Where a conversation's title comes from.
//
// The title a reader sees in the App is the conversation's own fact, and it is
// stored in our catalog — but nothing in the system used to *read* the title
// the agent had already produced. Claude Code writes an AI title into its
// transcript and Codex writes a thread name into its session index; both were
// on disk, unread, while our own placeholder sat in the title column.
//
// This module is the reader for both, plus the one rule that decides which
// title wins. The rule is deliberately narrow:
//
//   a title the user set  >  a title the agent produced  >  a placeholder
//
// Everything else — the catalog's own precedence, the server's guard — exists
// to keep that order true when two writers meet.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_TITLE_LENGTH = 191;

// How much of a transcript to read when looking for the title. Claude Code
// rewrites the title after each turn, so the newest one is near the end; the
// tail is enough to find it without reading a 100MB conversation.
const TAIL_BYTES = 128 * 1024;

// A whole-file read is only worth it for a file small enough to be cheap.
const FULL_READ_LIMIT = 4 * 1024 * 1024;
const recentClaudeTitles = new Map();

export function safeTitleText(value, maxLength = MAX_TITLE_LENGTH) {
  return String(value ?? "").trim().slice(0, maxLength);
}

/// The name a placeholder is written in, when it differs from the wire id.
///
/// `agy` is the runtime's id; the reader-facing name of the same agent is
/// Antigravity, and a placeholder is a reader-facing string, so it is written
/// with the display name — "antigravity session", not "agy session". Agents
/// without an entry write the placeholder under their own id.
const AGENT_PLACEHOLDER_NAMES = { agy: "antigravity" };

function placeholderAgentName(agentType) {
  const agent = safeTitleText(agentType, 32).toLowerCase() || "agent";
  return AGENT_PLACEHOLDER_NAMES[agent] || agent;
}

/// The placeholder the system writes when it has no title to write.
///
/// It is derived from the agent's own name, so it reads as a fact about the
/// agent rather than about the conversation — which is exactly why it must
/// never be mistaken for a title the user chose.
export function defaultConversationTitle(agentType) {
  return `${placeholderAgentName(agentType)} session`;
}

/// Whether a title is one of our own placeholders rather than a real title.
///
/// The set is relative to the agent: the agent's own name, the agent's name
/// plus "session", the agent's name plus "code", and the generic "agent
/// session". The last one used to be the whole list, which is how "Claude
/// Code" — the agent's *name* in the title slot — came to be treated as a
/// title the user had chosen, and could therefore never be replaced.
///
/// Two spellings count for an agent with a display name: rows written before
/// the rename carry the wire id ("agy session"), rows written after carry the
/// display name ("antigravity session"), and both are our placeholders —
/// misreading either as a chosen name would freeze the conversation under it.
export function looksLikePlaceholderTitle(title, agentType) {
  const normalized = safeTitleText(title).toLowerCase();
  if (!normalized) return true;
  const agent = safeTitleText(agentType, 32).toLowerCase() || "agent";
  const display = placeholderAgentName(agent);
  return normalized === "agent session"
    || normalized === `${agent} session`
    || normalized === agent
    || normalized === `${agent} code`
    || normalized === `${display} session`
    || normalized === display
    || normalized === `${display} code`;
}

/// The title Claude Code gave the conversation, if it has one.
///
/// Claude Code appends `{"type":"ai-title","aiTitle":"…"}` to the session's
/// transcript and rewrites it as the conversation settles — so the *last* one
/// is the current answer. It reads the tail rather than the whole file.
export function readClaudeTranscriptTitle(transcriptPath) {
  const path = safeTitleText(transcriptPath, 4096);
  if (!path) return "";
  let fd;
  try {
    fd = openSync(path, "r");
    const { size, mtimeMs, ino } = fstatSync(fd);
    const cached = recentClaudeTitles.get(path);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.ino === ino) return cached.title;
    if (!size) return "";
    const readWindow = (start, length) => {
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const count = readSync(fd, buffer, offset, length - offset, start + offset);
        if (count === 0) break; // The file may have been truncated meanwhile.
        offset += count;
      }
      return buffer.subarray(0, offset).toString("utf8");
    };
    // Small files can have an explicit name followed much later by an AI title.
    // On large transcripts foreground polling stays bounded. The daemon uses
    // the SDK's getSessionInfo for the authoritative manual name.
    const start = size <= FULL_READ_LIMIT ? 0 : size - TAIL_BYTES;
    const title = parseClaudeTitleRecords(readWindow(start, size - start));
    recentClaudeTitles.delete(path);
    if (recentClaudeTitles.size >= 64) recentClaudeTitles.delete(recentClaudeTitles.keys().next().value);
    recentClaudeTitles.set(path, { size, mtimeMs, ino, title });
    return title;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* The file is already closed. */ }
    }
  }
}

/// The title Codex gave the thread, if it has one.
///
/// Codex keeps `~/.codex/session_index.jsonl`: one JSON object per update,
/// each carrying the thread id and the thread's current name. The file grows
/// by appending, so the last line for a thread wins.
export function readCodexThreadTitle(threadId, { codexHome } = {}) {
  const id = safeTitleText(threadId, 191);
  if (!id) return "";
  const home = safeTitleText(codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"), 4096);
  if (!home) return "";
  const indexed = readCodexIndexTitle(id, home);
  if (indexed) return indexed;
  return safeTitleText(readProviderRow(join(home, "state_5.sqlite"),
    "SELECT title FROM threads WHERE id = ?", id)?.title);
}

function readProviderRow(path, sql, id) {
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 25 });
    return db.prepare(sql).get(id);
  } catch {
    // The native runtime can be absent, busy, or on a different schema.
    return null;
  } finally {
    db?.close();
  }
}

function readCodexIndexTitle(id, home) {
  const indexPath = join(home, "session_index.jsonl");
  let text = "";
  try {
    const buffer = readFileSync(indexPath);
    text = buffer.toString("utf8");
  } catch {
    return "";
  }
  let title = "";
  for (const line of text.split("\n")) {
    if (!line.includes(id)) continue;
    let raw = null;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || String(raw.id || "") !== id) continue;
    const name = safeTitleText(raw.thread_name);
    if (name) title = name;
  }
  return title;
}

export function readAgyConversationName(id, home = homedir(), { expected = "", authoritative = false } = {}) {
  const dir = join(home, ".gemini", "antigravity-cli");
  const row = readProviderRow(join(dir, "conversation_summaries.db"),
    "SELECT title, preview FROM conversation_summaries WHERE conversation_id = ?", id);
  const dbTitle = safeTitleText(row?.title);
  if (dbTitle && (dbTitle === expected || !looksLikePlaceholderTitle(dbTitle, "agy"))) {
    return { title: dbTitle, preview: "" };
  }
  if (authoritative) return { title: "", preview: safeTitleText(row?.preview, 1024) };
  let cached;
  try {
    cached = JSON.parse(readFileSync(join(dir, "cache", "conversation_metadata.json"), "utf8"))
      .conversations?.[id]?.summary;
  } catch { /* Older or new installations may not have the picker cache yet. */ }
  const cachedTitle = safeTitleText(cached?.Title);
  const title = cachedTitle && (cachedTitle === expected || !looksLikePlaceholderTitle(cachedTitle, "agy")) ? cachedTitle : "";
  return { title, preview: safeTitleText(cached?.Preview || row?.preview, 1024) };
}

/// The title the agent produced for a session, whichever agent it is.
///
/// Returns "" when the agent has not named the session yet — which is a state,
/// not a failure: the caller keeps the placeholder and the title arrives with
/// the next turn.
export function readAgentSessionTitle({
  agentType,
  transcriptPath,
  nativeSessionId,
  codexHome,
  home = homedir(),
} = {}) {
  const agent = safeTitleText(agentType, 32).toLowerCase();
  if (agent === "agy") return nativeSessionId ? readAgyConversationName(nativeSessionId, home).title : "";
  if (agent === "codex") {
    return readCodexThreadTitle(nativeSessionId, { codexHome });
  }
  return readClaudeTranscriptTitle(transcriptPath);
}

/// Parse the title records out of a chunk of Claude transcript text.
///
/// Claude Code writes both automatic `ai-title` records and user `/rename`
/// `custom-title` records into the JSONL transcript. An explicit user
/// `custom-title` outranks any `ai-title` in the same window.
export function parseClaudeTitleRecords(text, state = { aiTitle: "", customTitle: "" }) {
  for (const line of String(text || "").split("\n")) {
    if (
      !line.includes("aiTitle")
      && !line.includes("ai-title")
      && !line.includes("customTitle")
      && !line.includes("custom-title")
    ) continue;
    let raw = null;
    try {
      raw = JSON.parse(line);
    } catch {
      // A tail read can start in the middle of a line. That line is not
      // readable; the ones after it are.
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.customTitle === "string" || (raw.type === "custom-title" && typeof raw.title === "string")) {
      const value = safeTitleText(typeof raw.customTitle === "string" ? raw.customTitle : raw.title);
      if (value) state.customTitle = value;
      continue;
    }
    const candidate = typeof raw.aiTitle === "string"
      ? raw.aiTitle
      : raw.type === "ai-title" && typeof raw.title === "string"
        ? raw.title
        : "";
    const value = safeTitleText(candidate);
    if (value) state.aiTitle = value;
  }
  return state.customTitle || state.aiTitle;
}

/// The title to store, given what we already had and what the agent says.
///
/// `existing` is the title already on the conversation, `existingIsCustom`
/// says whether a person chose it. A chosen title is never overwritten; a
/// placeholder always gives way to a real one.
export function resolveConversationTitle({
  existing = "",
  existingIsCustom = false,
  agentTitle = "",
  agentType = "",
  requested = "",
} = {}) {
  if (existingIsCustom) {
    const current = safeTitleText(existing);
    if (current) return { title: current, isCustom: true };
  }
  const fromAgent = safeTitleText(agentTitle);
  if (fromAgent) return { title: fromAgent, isCustom: false };
  const asked = safeTitleText(requested);
  if (asked && !looksLikePlaceholderTitle(asked, agentType)) {
    return { title: asked, isCustom: false };
  }
  const current = safeTitleText(existing);
  if (current && !looksLikePlaceholderTitle(current, agentType)) {
    return { title: current, isCustom: false };
  }
  return { title: defaultConversationTitle(agentType), isCustom: false };
}
