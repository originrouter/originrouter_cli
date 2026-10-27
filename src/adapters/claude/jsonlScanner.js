import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConversationMessagesFromRaw } from "../../runtime/claudeTranscriptMessages.js";

// Kept for backwards compatibility with tests / callers that still import
// `getClaudeProjectPath`. No longer used by ClaudeJsonlScanner itself.
export function getClaudeProjectPath(cwd) {
  const projectId = String(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(claudeConfigDir, "projects", projectId);
}

/// The marker Claude Code writes into its transcript when the reader stops a
/// turn from the terminal (Ctrl+C).
///
/// The text is the CLI's own, and it is the only trace of the interrupt: no
/// terminal event reaches the device when the reader presses the key in the
/// terminal. So the marker has to be read for what it is — the end of a turn.
export function isInterruptMarker(text) {
  const value = String(text || "").trim();
  return (
    value === "[Request interrupted by user]" ||
    value === "[Request interrupted by user and no further input requested]"
  );
}

export function mapClaudeJsonLine(line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }

  const events = [];
  if (raw.sessionId || raw.session_id) {
    events.push({ type: "agent.session_id", sessionId: raw.sessionId || raw.session_id });
  }

  if (raw.type === "assistant") {
    for (const message of claudeConversationMessagesFromRaw(raw)) {
      events.push({
        type: "agent.text",
        text: message.text,
        eventId: message.messageId,
        createdAt: message.createdAt,
      });
    }
    for (const block of raw.message?.content || []) {
      if (block.type === "thinking") {
        events.push({ type: "agent.thinking", text: block.thinking || block.text || "" });
      }
      if (block.type === "tool_use") {
        events.push({
          type: "agent.tool_call.start",
          provider: "claude",
          callId: block.id,
          tool: block.name,
          input: block.input,
        });
      }
    }
  }

  if (raw.type === "user") {
    const content = raw.message?.content;
    for (const message of claudeConversationMessagesFromRaw(raw)) {
      events.push({
        type: "user.text",
        text: message.text,
        eventId: message.messageId,
        createdAt: message.createdAt,
      });
      // An interrupted turn is a **turn that ended**, and the file records
      // that as a user message carrying the marker. Read as a message it is
      // only a line of text; read as what it is, it is the end of the turn —
      // and the turn's end is what the whole run state hangs on: the daemon
      // latches `turn_state` from turn events alone, so a run interrupted
      // from the terminal stayed latched to `running` and the App kept
      // offering a **stop** button for a run that had already been stopped.
      //
      // The terminal event is what clears the latch. The marker itself is
      // still published as a message, so the conversation keeps the record of
      // what happened (the App drops that line from the flow — it is a
      // control signal, not something anyone said).
      if (isInterruptMarker(message.text)) {
        events.push({
          type: "agent.task.aborted",
          eventId: `claude_${String(raw.uuid || message.messageId).slice(0, 80)}_aborted`,
          createdAt: message.createdAt,
          summary: "Turn interrupted",
          reason: message.text,
        });
      }
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          events.push({
            type: "agent.tool_call.end",
            provider: "claude",
            callId: block.tool_use_id,
            content: block.content,
            isError: Boolean(block.is_error),
          });
        }
      }
    }
  }

  return events;
}

// Map a single line of Claude JSONL into zero or more OriginRouter agent
// events, with timestamp filtering. Lines older than `startedAtMs` are
// dropped entirely — this prevents `resume` and pre-existing transcripts
// from replaying old tool calls as if they happened now.
export function mapClaudeJsonLineSince(line, startedAtMs) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }

  if (startedAtMs != null && typeof raw.timestamp === "string") {
    const ts = Date.parse(raw.timestamp);
    if (Number.isFinite(ts) && ts < startedAtMs) {
      return [];
    }
  }

  return mapClaudeJsonLine(line);
}

// Single-file scanner tied to the transcript_path that the SessionStart hook
// reported for this run. It does NOT walk the project directory — that was
// the source of the historical-replay bug. The caller (ClaudeAdapter) is
// responsible for resolving transcriptPath via the hook and passing both it
// and the wrapper's beforeStart timestamp here.
export class ClaudeJsonlScanner {
  constructor({ transcriptPath, startedAt }) {
    this.transcriptPath = transcriptPath || null;
    this.startedAt = typeof startedAt === "number" ? startedAt : null;
    this.fileOffset = 0;
    this.emittedSessionIds = new Set();
  }

  setTranscriptPath(transcriptPath, startedAt) {
    if (transcriptPath) this.transcriptPath = transcriptPath;
    if (typeof startedAt === "number") this.startedAt = startedAt;
    // New transcript → reset offset so we start at the beginning of the file.
    // The timestamp filter then drops anything from before wrapper start.
    this.fileOffset = 0;
    this.emittedSessionIds.clear();
  }

  scan() {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return [];
    const text = readFileSync(this.transcriptPath, "utf8");
    const previous = this.fileOffset;
    if (text.length <= previous) return [];

    const newContent = text.slice(previous);
    this.fileOffset = text.length;

    const events = [];
    for (const line of newContent.split("\n")) {
      if (!line.trim()) continue;
      for (const event of mapClaudeJsonLineSince(line, this.startedAt)) {
        if (event.type === "agent.session_id") {
          if (this.emittedSessionIds.has(event.sessionId)) continue;
          this.emittedSessionIds.add(event.sessionId);
        }
        events.push(event);
      }
    }
    return events;
  }
}
