import { createHash } from "node:crypto";

import { displaySafeToolInput } from "./displaySafeToolInput.js";

function textEntries(content) {
  if (typeof content === "string") return [{ text: content, blockIndex: 0 }];
  if (!Array.isArray(content)) return [];
  const entries = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (block?.type === "text" && typeof block.text === "string") {
      entries.push({ text: block.text, blockIndex: index });
    }
  }
  return entries;
}

function stableMessageId(raw, lineIndex, role, blockIndex, text) {
  const sourceId = raw.uuid || raw.message?.id || raw.id;
  if (sourceId) {
    return `claude_${String(sourceId).slice(0, 80)}_${role}_${blockIndex}`;
  }
  return `claude_${createHash("sha256")
    .update(`${lineIndex}\0${role}\0${blockIndex}\0${text}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function claudeConversationMessagesFromRaw(raw, { lineIndex = 0 } = {}) {
  const isLocalCommandOutput = raw?.type === "system" && raw?.subtype === "local_command_output";
  const role = raw?.type === "assistant" || isLocalCommandOutput
    ? "assistant"
    : raw?.type === "user"
      ? "user"
      : null;
  if (!role) return [];
  const content = isLocalCommandOutput ? raw.content : raw.message?.content;
  return textEntries(content)
    .map(({ text, blockIndex }) => ({
      messageId: stableMessageId(raw, lineIndex, role, blockIndex, text),
      role,
      text: text.trim(),
      createdAt: typeof raw.timestamp === "string" ? raw.timestamp : null,
    }))
    .filter((message) => message.text);
}

function safeToolResult(content) {
  if (typeof content === "string") return content.slice(0, 16_384);
  if (Array.isArray(content)) {
    return content.slice(0, 100).map((item) => {
      if (item?.type === "text") return { type: "text", text: String(item.text || "").slice(0, 16_384) };
      return displaySafeToolInput(item && typeof item === "object" ? item : {});
    });
  }
  return displaySafeToolInput(content && typeof content === "object" ? content : {});
}

export function claudeConversationTimelineItemsFromRaw(raw, { lineIndex = 0 } = {}) {
  const isLocalCommandOutput = raw?.type === "system" && raw?.subtype === "local_command_output";
  const role = raw?.type === "assistant" || isLocalCommandOutput
    ? "assistant"
    : raw?.type === "user"
      ? "user"
      : null;
  if (!role) return [];
  const content = isLocalCommandOutput ? raw.content : raw?.message?.content;
  if (!Array.isArray(content)) {
    return claudeConversationMessagesFromRaw(raw, { lineIndex });
  }
  const items = [];
  for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
    const block = content[blockIndex];
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      items.push({
        messageId: stableMessageId(raw, lineIndex, role, blockIndex, block.text),
        role,
        text: block.text.trim(),
        createdAt: typeof raw.timestamp === "string" ? raw.timestamp : null,
      });
    }
    if (raw.type === "assistant" && block?.type === "tool_use") {
      items.push({
        messageId: stableMessageId(raw, lineIndex, "event", blockIndex, `tool-start:${block.id || block.name || "tool"}`),
        role: "event",
        createdAt: typeof raw.timestamp === "string" ? raw.timestamp : null,
        event: {
          type: "agent.tool_call.start",
          provider: "claude",
          callId: block.id,
          tool: String(block.name || "tool").slice(0, 128),
          input: displaySafeToolInput(block.input),
        },
      });
    }
    if (raw.type === "user" && block?.type === "tool_result") {
      items.push({
        messageId: stableMessageId(raw, lineIndex, "event", blockIndex, `tool-end:${block.tool_use_id || blockIndex}`),
        role: "event",
        createdAt: typeof raw.timestamp === "string" ? raw.timestamp : null,
        event: {
          type: "agent.tool_call.end",
          provider: "claude",
          callId: block.tool_use_id,
          content: safeToolResult(block.content),
          isError: Boolean(block.is_error),
        },
      });
    }
  }
  return items;
}
