export function mapClaudeSdkMessage(message) {
  const events = [];

  if (message.type === "system" && message.subtype === "init") {
    events.push({
      type: "agent.session_id",
      provider: "claude",
      sessionId: message.session_id,
    });
    events.push({
      type: "agent.sdk.metadata",
      provider: "claude",
      tools: message.tools || [],
      slashCommands: message.slash_commands || [],
      mcpServers: message.mcp_servers || [],
      skills: message.skills || [],
    });
  }

  if (message.type === "assistant") {
    for (const block of message.message?.content || []) {
      if (block.type === "text") {
        events.push({
          type: "agent.text",
          provider: "claude",
          text: block.text || "",
        });
      }
      if (block.type === "thinking") {
        events.push({
          type: "agent.thinking",
          provider: "claude",
          text: block.thinking || block.text || "",
        });
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

  if (message.type === "user") {
    const content = message.message?.content;
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

  if (message.type === "result") {
    events.push({
      type: "agent.task.completed",
      provider: "claude",
      subtype: message.subtype,
      result: message.result,
      isError: Boolean(message.is_error),
    });
  }

  return events;
}
