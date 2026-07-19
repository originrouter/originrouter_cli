import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { displaySafeToolInput } from "../../runtime/displaySafeToolInput.js";
import { mapCodexAssistantText } from "./eventMapper.js";

function sessionsRoot() {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "sessions")
    : join(homedir(), ".codex", "sessions");
}

function dateParts(now = new Date()) {
  return [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ];
}

function eventId(raw, lineIndex, suffix = "") {
  return `codex_${createHash("sha256")
    .update(`${raw.timestamp || ""}\0${lineIndex}\0${suffix}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function mapCodexJsonLine(line, lineIndex = 0) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }
  const payload = raw?.payload || {};
  const createdAt = raw?.timestamp || null;
  const base = { provider: "codex", createdAt };
  if (raw.type === "session_meta") {
    return [{
      ...base,
      type: "agent.session.start",
      eventId: eventId(raw, lineIndex, "session"),
      sessionId: payload.session_id || payload.id,
      transcriptPath: payload.transcript_path || null,
      cwd: payload.cwd,
    }];
  }
  if (raw.type === "event_msg") {
    if (payload.type === "user_message") {
      return [{ ...base, type: "user.text", text: String(payload.message || "").trim(), eventId: eventId(raw, lineIndex, "user") }];
    }
    if (payload.type === "agent_message") {
      return mapCodexAssistantText(payload.message).map((event) => ({
        ...base,
        ...event,
        eventId: eventId(raw, lineIndex, event.type === "agent.thinking" ? "thinking" : "assistant"),
      }));
    }
    if (payload.type === "task_started") {
      return [{ ...base, type: "agent.task.started", id: payload.turn_id, eventId: eventId(raw, lineIndex, "turn-start") }];
    }
    if (payload.type === "task_complete") {
      return [{ ...base, type: "agent.task.complete", id: payload.turn_id, status: "complete", eventId: eventId(raw, lineIndex, "turn-complete") }];
    }
    if (payload.type === "turn_aborted") {
      return [{ ...base, type: "agent.task.aborted", id: payload.turn_id, reason: payload.reason, eventId: eventId(raw, lineIndex, "turn-aborted") }];
    }
    if (payload.type === "token_count") {
      return [{ ...base, type: "token_count", info: payload.info || {}, eventId: eventId(raw, lineIndex, "tokens") }];
    }
    if (payload.type === "thread_settings_applied") {
      const settings = payload.thread_settings || {};
      return [{
        ...base,
        type: "agent.activity",
        activity: "settings_applied",
        summary: "Codex session settings updated",
        metadata: {
          model: String(settings.model || "").slice(0, 128),
          model_provider_id: String(settings.model_provider_id || "").slice(0, 64),
          approval_policy: String(settings.approval_policy || "").slice(0, 64),
          reasoning_effort: String(settings.reasoning_effort || "").slice(0, 32),
          personality: String(settings.personality || "").slice(0, 32),
          collaboration_mode: String(settings.collaboration_mode?.mode || "").slice(0, 32),
          cwd: String(settings.cwd || "").slice(0, 1024),
          permission_profile: String(settings.permission_profile?.type || "").slice(0, 32),
        },
        eventId: eventId(raw, lineIndex, "settings"),
      }];
    }
    if (payload.type === "context_compacted") {
      return [{
        ...base,
        type: "agent.activity",
        activity: "context_compacted",
        summary: "Codex compacted the conversation context",
        metadata: {},
        eventId: eventId(raw, lineIndex, "context-compacted"),
      }];
    }
    if (payload.type === "thread_rolled_back") {
      return [{
        ...base,
        type: "agent.activity",
        activity: "thread_rolled_back",
        summary: "Codex rolled back recent conversation turns",
        metadata: { num_turns: Number(payload.num_turns || 0) },
        eventId: eventId(raw, lineIndex, "thread-rolled-back"),
      }];
    }
    if (payload.type === "thread_goal_updated") {
      return [{
        ...base,
        type: "agent.activity",
        activity: "goal",
        summary: "Codex goal updated",
        metadata: {
          status: String(payload.status || payload.goal?.status || "").slice(0, 32),
          tokens_used: Number(payload.tokens_used || payload.goal?.tokens_used || 0),
          token_budget: Number(payload.token_budget || payload.goal?.token_budget || 0),
        },
        eventId: eventId(raw, lineIndex, "goal"),
      }];
    }
    if (payload.type === "patch_apply_end") {
      return [{
        ...base,
        type: "agent.tool_call.end",
        callId: payload.call_id,
        tool: "patch",
        content: payload.stdout || payload.stderr || "",
        isError: payload.success === false,
        eventId: eventId(raw, lineIndex, "patch-end"),
      }];
    }
  }
  if (raw.type === "response_item") {
    if (payload.type === "reasoning") {
      const summary = (Array.isArray(payload.summary) ? payload.summary : [])
        .map((item) => typeof item === "string" ? item : item?.text)
        .filter(Boolean)
        .join("\n")
        .trim();
      return summary ? [{
        ...base,
        type: "agent.thinking",
        text: summary.slice(0, 16_384),
        eventId: eventId(raw, lineIndex, "reasoning"),
      }] : [];
    }
    if (payload.type === "web_search_call") {
      const action = payload.action || {};
      return [{
        ...base,
        type: "agent.activity",
        activity: "web_search",
        summary: action.type === "open_page"
          ? "Codex opened a web page"
          : action.type === "find_in_page"
            ? "Codex searched within a web page"
            : "Codex searched the web",
        detail: String(action.query || action.pattern || action.url || "").slice(0, 4096),
        metadata: { action: String(action.type || "search").slice(0, 32) },
        eventId: eventId(raw, lineIndex, "web-search"),
      }];
    }
    if (payload.type === "image_generation_call") {
      return [{
        ...base,
        type: "agent.activity",
        activity: "image_generation",
        summary: "Codex image generation updated",
        metadata: { status: String(payload.status || "").slice(0, 32) },
        eventId: eventId(raw, lineIndex, "image-generation"),
      }];
    }
    if (payload.type === "custom_tool_call" || payload.type === "function_call") {
      return [{
        ...base,
        type: "agent.tool_call.start",
        callId: payload.call_id || payload.id,
        tool: payload.name || "tool",
        input: displaySafeToolInput(payload.input || payload.arguments || {}),
        eventId: eventId(raw, lineIndex, "tool-start"),
      }];
    }
    if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
      return [{
        ...base,
        type: "agent.tool_call.end",
        callId: payload.call_id,
        content: payload.output || "",
        eventId: eventId(raw, lineIndex, "tool-end"),
      }];
    }
  }
  return [];
}

function sessionMeta(path) {
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    const raw = JSON.parse(first);
    return raw?.type === "session_meta" ? raw.payload || {} : {};
  } catch {
    return {};
  }
}

export function findCodexTranscript({
  cwd,
  startedAt,
  sessionId = null,
  originators = ["codex-tui"],
}) {
  const candidates = [];
  for (const offset of [0, -1]) {
    const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
    const dir = join(sessionsRoot(), ...dateParts(date));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.birthtimeMs < startedAt - 5000) continue;
        if (stat.mtimeMs < startedAt - 5000) continue;
        const meta = sessionMeta(path);
        if (String(meta.cwd || "") !== String(cwd || "")) continue;
        if (sessionId && String(meta.session_id || meta.id || "") !== String(sessionId)) continue;
        if (
          Array.isArray(originators)
          && meta.originator
          && !originators.includes(meta.originator)
        ) continue;
        candidates.push({ path, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path || null;
}

export function readCodexConversationHistory(path, { beforeCursor, limit = 50 } = {}) {
  if (!path || !existsSync(path)) return { messages: [], nextCursor: null, hasMore: false };
  const lines = readFileSync(path, "utf8").split("\n");
  const all = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    for (const event of mapCodexJsonLine(lines[lineIndex], lineIndex)) {
      if ((event.type === "user.text" || event.type === "agent.text") && String(event.text || "").trim()) {
        all.push({
          messageId: event.eventId,
          role: event.type === "user.text" ? "user" : "assistant",
          text: String(event.text).trim(),
          createdAt: event.createdAt,
          sequence: all.length,
        });
        continue;
      }
      if ([
        "agent.thinking",
        "agent.tool_call.start",
        "agent.tool_call.end",
        "agent.task.started",
        "agent.task.complete",
        "agent.task.aborted",
        "agent.activity",
      ].includes(event.type)) {
        all.push({
          messageId: event.eventId,
          role: "event",
          event,
          createdAt: event.createdAt,
          sequence: all.length,
        });
      }
    }
  }
  const end = beforeCursor != null && beforeCursor !== "" && Number.isFinite(Number(beforeCursor))
    ? Math.max(0, Math.min(all.length, Number(beforeCursor)))
    : all.length;
  const pageSize = Math.max(1, Math.min(Number(limit) || 50, 100));
  const start = Math.max(0, end - pageSize);
  return {
    messages: all.slice(start, end),
    nextCursor: start > 0 ? String(start) : null,
    hasMore: start > 0,
  };
}

export class CodexJsonlScanner {
  constructor({ cwd, startedAt }) {
    this.cwd = cwd;
    this.startedAt = startedAt;
    this.transcriptPath = null;
    this.fileOffset = 0;
    this.lineIndex = 0;
  }

  scan() {
    if (!this.transcriptPath) {
      this.transcriptPath = findCodexTranscript({ cwd: this.cwd, startedAt: this.startedAt });
    }
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return [];
    const text = readFileSync(this.transcriptPath, "utf8");
    if (text.length <= this.fileOffset) return [];
    const chunk = text.slice(this.fileOffset);
    this.fileOffset = text.length;
    const events = [];
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      const mapped = mapCodexJsonLine(line, this.lineIndex).filter((event) => {
        const timestamp = Date.parse(event.createdAt || "");
        return !Number.isFinite(timestamp) || timestamp >= this.startedAt - 1000;
      });
      events.push(...mapped);
      this.lineIndex += 1;
    }
    return events.filter((event) => event.text == null || event.text.length > 0);
  }
}
