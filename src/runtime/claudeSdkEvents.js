import { displaySafeToolInput } from "./displaySafeToolInput.js";

function safeText(value, maxLength = 4096) {
  return String(value || "").slice(0, maxLength);
}

function safeMetadata(value) {
  return displaySafeToolInput(value && typeof value === "object" ? value : {});
}

function messageEventId(message, role, blockIndex = 0) {
  const sourceId = message?.uuid || message?.message?.id;
  return sourceId ? `claude_${String(sourceId).slice(0, 80)}_${role}_${blockIndex}` : undefined;
}

function activity(message, activityType, summary, detail = "", metadata = {}) {
  return {
    type: "agent.activity",
    provider: "claude",
    activity: activityType,
    summary: safeText(summary, 512),
    detail: safeText(detail, 4096),
    metadata: safeMetadata(metadata),
    eventId: messageEventId(message, activityType),
  };
}

function runtimeStatus(message, state, summary, metadata = {}) {
  return {
    type: "agent.adapter.status",
    provider: "claude",
    state: safeText(state, 64),
    message: safeText(summary, 512),
    metadata: safeMetadata(metadata),
    eventId: messageEventId(message, "status"),
  };
}

function safeToolResult(content) {
  if (content && typeof content === "object") return safeMetadata(content);
  return safeText(content, 16_384);
}

export function mapClaudeSdkMessage(message) {
  const events = [];

  if (message.type === "system" && message.subtype === "init") {
    events.push({
      type: "agent.session_id",
      provider: "claude",
      sessionId: message.session_id,
      model: safeText(message.model, 128),
    });
    events.push(activity(message, "session_metadata", "Claude session initialized", "", {
      tools: (message.tools || []).slice(0, 128),
      slash_commands: (message.slash_commands || []).slice(0, 128),
      mcp_servers: (message.mcp_servers || []).slice(0, 64),
      skills: (message.skills || []).slice(0, 128),
      model: safeText(message.model, 128),
      cwd: safeText(message.cwd, 1024),
      permission_mode: safeText(message.permissionMode, 32),
      claude_code_version: safeText(message.claude_code_version, 64),
      plugins: (message.plugins || []).slice(0, 64).map((plugin) => ({
        name: safeText(plugin?.name, 128),
      })),
    }));
  }

  if (message.type === "assistant") {
    if (message.error) {
      events.push(runtimeStatus(
        message,
        "assistant_error",
        `Claude request failed: ${message.error}`,
        { error: message.error, request_id: message.request_id },
      ));
    }
    for (const [blockIndex, block] of (message.message?.content || []).entries()) {
      if (block.type === "text") {
        events.push({
          type: "agent.text",
          provider: "claude",
          text: block.text || "",
          eventId: messageEventId(message, "assistant", blockIndex),
          messageId: messageEventId(message, "assistant", blockIndex),
          parentToolUseId: message.parent_tool_use_id || null,
          subagentType: safeText(message.subagent_type, 128),
          taskDescription: safeText(message.task_description, 512),
        });
      }
      if (block.type === "thinking") {
        events.push({
          type: "agent.thinking",
          provider: "claude",
          text: block.thinking || block.text || "",
          eventId: messageEventId(message, "thinking", blockIndex),
          parentToolUseId: message.parent_tool_use_id || null,
          subagentType: safeText(message.subagent_type, 128),
        });
      }
      if (block.type === "tool_use") {
        events.push({
          type: "agent.tool_call.start",
          provider: "claude",
          callId: block.id,
          tool: block.name,
          input: safeMetadata(block.input),
          eventId: messageEventId(message, `tool-${block.id || blockIndex}`),
        });
      }
    }
  }

  if (message.type === "user") {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const [blockIndex, block] of content.entries()) {
        if (block.type === "tool_result") {
          events.push({
            type: "agent.tool_call.end",
            provider: "claude",
            callId: block.tool_use_id,
            content: safeToolResult(block.content),
            isError: Boolean(block.is_error),
            eventId: messageEventId(message, `tool-result-${block.tool_use_id || blockIndex}`),
          });
        }
      }
    }
  }

  if (message.type === "result") {
    const usage = message.usage && typeof message.usage === "object" ? message.usage : {};
    const sampledTokens = Number(usage.input_tokens || 0)
      + Number(usage.output_tokens || 0)
      + Number(usage.cache_creation_input_tokens || 0)
      + Number(usage.cache_read_input_tokens || 0);
    if (sampledTokens > 0 || Number(message.total_cost_usd || 0) > 0 || Number(message.duration_ms || 0) > 0) {
      events.push({
        type: "agent.usage",
        provider: "claude",
        sampledTokens: Math.max(0, sampledTokens),
        tokenUsage: {
          inputTokens: Math.max(0, Number(usage.input_tokens || 0)
            + Number(usage.cache_creation_input_tokens || 0)
            + Number(usage.cache_read_input_tokens || 0)),
          outputTokens: Math.max(0, Number(usage.output_tokens || 0)),
          reasoningTokens: 0,
          cacheReadInputTokens: Math.max(0, Number(usage.cache_read_input_tokens || 0)),
          cacheWriteInputTokens: Math.max(0, Number(usage.cache_creation_input_tokens || 0)),
          cacheWrite5mInputTokens: Math.max(0, Number(usage.cache_creation?.ephemeral_5m_input_tokens || 0)),
          cacheWrite1hInputTokens: Math.max(0, Number(usage.cache_creation?.ephemeral_1h_input_tokens || 0)),
        },
        amountMicros: null,
        currency: null,
        costSource: "unsupported",
        eventId: messageEventId(message, "usage"),
      });
    }
    events.push({
      type: message.is_error ? "agent.task.failed" : "agent.task.completed",
      provider: "claude",
      subtype: message.subtype,
      result: safeText(message.result || message.errors?.join("\n"), 16_384),
      error: message.is_error
        ? safeText(message.result || message.errors?.join("\n") || "Claude request failed", 2048)
        : undefined,
      isError: Boolean(message.is_error),
      stopReason: safeText(message.stop_reason, 128),
      durationMs: Number(message.duration_ms || 0),
      numTurns: Number(message.num_turns || 0),
      eventId: messageEventId(message, "result"),
    });
  }

  if (message.type === "system" && message.subtype === "status") {
    events.push(runtimeStatus(
      message,
      message.status || "idle",
      message.status === "compacting"
        ? "Claude is compacting context"
        : message.status === "requesting"
          ? "Claude is waiting for the model"
          : "Claude is idle",
      {
        permission_mode: message.permissionMode,
        compact_result: message.compact_result,
        compact_error: message.compact_error,
      },
    ));
  }

  if (message.type === "system" && message.subtype === "session_state_changed") {
    events.push(runtimeStatus(
      message,
      message.state,
      message.state === "requires_action"
        ? "Claude requires user action"
        : message.state === "running"
          ? "Claude is running"
          : "Claude is ready",
      { session_state: message.state },
    ));
  }

  if (message.type === "system" && message.subtype === "api_retry") {
    events.push(runtimeStatus(message, "retrying", "Claude API request will retry", {
      attempt: message.attempt,
      max_retries: message.max_retries,
      retry_delay_ms: message.retry_delay_ms,
      error_status: message.error_status,
      error: message.error,
    }));
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    events.push(activity(message, "context_compacted", "Claude compacted the conversation context", "", {
      trigger: message.compact_metadata?.trigger,
      pre_tokens: message.compact_metadata?.pre_tokens,
      post_tokens: message.compact_metadata?.post_tokens,
      duration_ms: message.compact_metadata?.duration_ms,
    }));
  }

  if (message.type === "system" && ["hook_started", "hook_progress", "hook_response"].includes(message.subtype)) {
    const phase = message.subtype.replace("hook_", "");
    events.push(activity(
      message,
      "hook",
      `Claude hook ${message.hook_name || message.hook_event || "hook"} ${phase}`,
      message.subtype === "hook_response" && message.outcome === "error"
        ? safeText(message.stderr || message.output, 4096)
        : "",
      {
        phase,
        hook_id: message.hook_id,
        hook_name: message.hook_name,
        hook_event: message.hook_event,
        outcome: message.outcome,
        exit_code: message.exit_code,
      },
    ));
  }

  if (message.type === "system" && ["task_started", "task_progress", "task_updated", "task_notification"].includes(message.subtype)) {
    const taskStatus = message.status || message.patch?.status || message.subtype.replace("task_", "");
    events.push(activity(
      message,
      "background_task",
      safeText(message.summary || message.description || `Background task ${taskStatus}`, 512),
      safeText(message.patch?.error, 4096),
      {
        task_id: message.task_id,
        tool_use_id: message.tool_use_id,
        status: taskStatus,
        subagent_type: message.subagent_type,
        task_type: message.task_type,
        workflow_name: message.workflow_name,
        last_tool_name: message.last_tool_name,
        usage: message.usage,
        is_backgrounded: message.patch?.is_backgrounded,
        skip_transcript: message.skip_transcript,
      },
    ));
  }

  if (message.type === "tool_progress") {
    events.push(activity(message, "tool_progress", `${message.tool_name || "Tool"} is running`, "", {
      tool_use_id: message.tool_use_id,
      tool_name: message.tool_name,
      elapsed_time_seconds: message.elapsed_time_seconds,
      task_id: message.task_id,
    }));
  }

  if (message.type === "tool_use_summary") {
    events.push(activity(message, "tool_summary", message.summary || "Tool work completed", "", {
      preceding_tool_use_ids: (message.preceding_tool_use_ids || []).slice(0, 64),
    }));
  }

  if (message.type === "system" && message.subtype === "permission_denied") {
    events.push(activity(message, "permission_denied", `${message.tool_name || "Tool"} was denied`, message.message, {
      tool_name: message.tool_name,
      tool_use_id: message.tool_use_id,
      agent_id: message.agent_id,
      decision_reason_type: message.decision_reason_type,
      decision_reason: message.decision_reason,
    }));
  }

  if (message.type === "rate_limit_event") {
    events.push(runtimeStatus(message, `rate_limit_${message.rate_limit_info?.status || "unknown"}`, "Claude rate limit status changed", {
      ...message.rate_limit_info,
    }));
  }

  if (message.type === "auth_status") {
    events.push(runtimeStatus(
      message,
      message.error ? "authentication_failed" : message.isAuthenticating ? "authenticating" : "authenticated",
      message.error || (message.isAuthenticating ? "Claude is authenticating" : "Claude authentication completed"),
      { is_authenticating: message.isAuthenticating },
    ));
  }

  if (message.type === "system" && message.subtype === "memory_recall") {
    const scopes = [...new Set((message.memories || []).map((item) => item?.scope).filter(Boolean))];
    events.push(activity(message, "memory_recall", `Claude recalled ${message.memories?.length || 0} memory item(s)`, "", {
      mode: message.mode,
      count: message.memories?.length || 0,
      scopes,
    }));
  }

  if (message.type === "system" && message.subtype === "plugin_install") {
    events.push(activity(message, "plugin_install", `Claude plugin install ${message.status}`, message.error, {
      status: message.status,
      name: message.name,
    }));
  }

  if (message.type === "system" && message.subtype === "commands_changed") {
    events.push(activity(message, "commands_changed", "Claude command list changed", "", {
      count: message.commands?.length || 0,
      commands: (message.commands || []).slice(0, 64).map((command) => safeText(command?.name || command, 128)),
    }));
  }

  if (message.type === "system" && message.subtype === "files_persisted") {
    events.push(activity(message, "files_persisted", "Claude persisted generated files", "", {
      persisted_count: message.files?.length || 0,
      failed_count: message.failed?.length || 0,
      files: (message.files || []).slice(0, 64).map((item) => safeText(item?.filename, 256)),
      failed: (message.failed || []).slice(0, 32).map((item) => ({
        filename: safeText(item?.filename, 256),
        error: safeText(item?.error, 512),
      })),
    }));
  }

  if (message.type === "system" && message.subtype === "notification") {
    events.push(activity(message, "notification", message.text || "Claude notification", "", {
      key: message.key,
      priority: message.priority,
      timeout_ms: message.timeout_ms,
    }));
  }

  if (message.type === "system" && message.subtype === "local_command_output") {
    events.push({
      type: "agent.text",
      provider: "claude",
      text: safeText(message.content, 16_384),
      eventId: messageEventId(message, "assistant", 0),
      messageId: messageEventId(message, "assistant", 0),
    });
  }

  if (message.type === "prompt_suggestion") {
    events.push(activity(message, "prompt_suggestion", "Claude suggested a follow-up prompt", message.suggestion));
  }

  if (message.type === "system" && message.subtype === "elicitation_complete") {
    events.push(activity(message, "elicitation_complete", "MCP input request completed", "", {
      mcp_server_name: message.mcp_server_name,
      elicitation_id: message.elicitation_id,
    }));
  }

  if (message.type === "system" && message.subtype === "mirror_error") {
    events.push(runtimeStatus(message, "transcript_mirror_error", "Claude transcript mirror failed", {
      error: message.error,
      project_key: message.key?.projectKey,
      session_id: message.key?.sessionId,
      subpath: message.key?.subpath,
    }));
  }

  // stream_event duplicates the final assistant message, while thinking_tokens
  // is high-frequency telemetry. Neither is forwarded as a standalone event.
  return events;
}
