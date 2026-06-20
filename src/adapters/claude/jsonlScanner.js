import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Kept for backwards compatibility with tests / callers that still import
// `getClaudeProjectPath`. No longer used by ClaudeJsonlScanner itself.
export function getClaudeProjectPath(cwd) {
  const projectId = String(cwd).replace(/[^a-zA-Z0-9-]/g, "-");
  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(claudeConfigDir, "projects", projectId);
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
    for (const block of raw.message?.content || []) {
      if (block.type === "text") {
        events.push({ type: "agent.text", text: block.text });
      }
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
    if (typeof content === "string") {
      events.push({ type: "user.text", text: content });
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
