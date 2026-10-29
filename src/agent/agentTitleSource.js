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

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_TITLE_LENGTH = 191;

// How much of a transcript to read when looking for the title. Claude Code
// rewrites the title after each turn, so the newest one is near the end; the
// tail is enough to find it without reading a 100MB conversation.
const TAIL_BYTES = 128 * 1024;

// A whole-file read is only worth it for a file small enough to be cheap.
const FULL_READ_LIMIT = 4 * 1024 * 1024;

export function safeTitleText(value, maxLength = MAX_TITLE_LENGTH) {
  return String(value ?? "").trim().slice(0, maxLength);
}

/// The placeholder the system writes when it has no title to write.
///
/// It is derived from the agent's own name, so it reads as a fact about the
/// agent rather than about the conversation — which is exactly why it must
/// never be mistaken for a title the user chose.
export function defaultConversationTitle(agentType) {
  const agent = safeTitleText(agentType, 32) || "agent";
  return `${agent} session`;
}

/// Whether a title is one of our own placeholders rather than a real title.
///
/// The set is relative to the agent: the agent's own name, the agent's name
/// plus "session", the agent's name plus "code", and the generic "agent
/// session". The last one used to be the whole list, which is how "Claude
/// Code" — the agent's *name* in the title slot — came to be treated as a
/// title the user had chosen, and could therefore never be replaced.
export function looksLikePlaceholderTitle(title, agentType) {
  const normalized = safeTitleText(title).toLowerCase();
  if (!normalized) return true;
  const agent = safeTitleText(agentType, 32).toLowerCase() || "agent";
  return normalized === "agent session"
    || normalized === `${agent} session`
    || normalized === agent
    || normalized === `${agent} code`;
}

/// The title Claude Code gave the conversation, if it has one.
///
/// Claude Code appends `{"type":"ai-title","aiTitle":"…"}` to the session's
/// transcript and rewrites it as the conversation settles — so the *last* one
/// is the current answer. It reads the tail rather than the whole file.
export function readClaudeTranscriptTitle(transcriptPath) {
  const path = safeTitleText(transcriptPath, 4096);
  if (!path) return "";
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (!size) return "";
  try {
    const buffer = readFileSync(path);
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const tail = buffer.subarray(start).toString("utf8");
    const found = parseClaudeTitleRecords(tail);
    if (found) return found;
    // The tail held no title. For a file small enough to read whole, the
    // title may simply be older than the tail window.
    if (size <= FULL_READ_LIMIT) {
      return parseClaudeTitleRecords(buffer.toString("utf8"));
    }
    return "";
  } catch {
    return "";
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
} = {}) {
  const agent = safeTitleText(agentType, 32).toLowerCase();
  if (agent === "codex") {
    return readCodexThreadTitle(nativeSessionId, { codexHome });
  }
  return readClaudeTranscriptTitle(transcriptPath);
}

/// Parse the title records out of a chunk of Claude transcript text.
///
/// A record is a title when it carries an `aiTitle` string, or when it is
/// typed `ai-title` and carries a `title` string. Both shapes have been seen
/// on disk, and the field is the one the SDK itself reads.
export function parseClaudeTitleRecords(text) {
  let title = "";
  for (const line of String(text || "").split("\n")) {
    if (!line.includes("aiTitle") && !line.includes("ai-title")) continue;
    let raw = null;
    try {
      raw = JSON.parse(line);
    } catch {
      // A tail read can start in the middle of a line. That line is not
      // readable; the ones after it are.
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const candidate = typeof raw.aiTitle === "string"
      ? raw.aiTitle
      : raw.type === "ai-title" && typeof raw.title === "string"
        ? raw.title
        : "";
    const value = safeTitleText(candidate);
    if (value) title = value;
  }
  return title;
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
