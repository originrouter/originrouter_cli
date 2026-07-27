import { displaySafeToolInput } from "../../runtime/displaySafeToolInput.js";

function safeText(value, maxLength = 4096) {
  return String(value || "").slice(0, maxLength);
}

export function mapCodexAssistantText(value) {
  const raw = String(value || "");
  let containedPrivateThinking = false;
  const visible = raw.replace(/<think>[\s\S]*?<\/think>/gi, () => {
    containedPrivateThinking = true;
    return "";
  }).trim();
  return [
    ...(containedPrivateThinking
      ? [{ type: "agent.thinking", provider: "codex", text: "" }]
      : []),
    ...(visible
      ? [{ type: "agent.text", provider: "codex", text: visible }]
      : []),
  ];
}

function activity(activityType, summary, detail = "", metadata = {}) {
  return {
    type: "agent.activity",
    provider: "codex",
    activity: activityType,
    summary: safeText(summary, 512),
    detail: safeText(detail, 4096),
    metadata: displaySafeToolInput(metadata),
  };
}

function toolNameForItem(item) {
  if (item.type === "mcpToolCall") return `${item.server || "MCP"}/${item.tool || "tool"}`;
  if (item.type === "dynamicToolCall") return item.tool || "dynamic tool";
  if (item.type === "collabAgentToolCall") return item.tool || "collaboration";
  if (item.type === "webSearch") return "web search";
  if (item.type === "imageView") return "image view";
  if (item.type === "imageGeneration") return "image generation";
  if (item.type === "sleep") return "wait";
  return item.type || "tool";
}

function mapCodexThreadItem(method, item = {}) {
  const completed = method === "item/completed";
  if (item.type === "reasoning") {
    if (!completed) return [];
    const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
    return summary ? [{ type: "agent.thinking", provider: "codex", text: safeText(summary, 16_384) }] : [];
  }
  if (item.type === "plan") {
    return completed
      ? [activity("plan", "Codex produced a plan", item.text)]
      : [activity("plan", "Codex is preparing a plan")];
  }
  if (item.type === "contextCompaction") {
    return [activity("context_compacted", completed
      ? "Codex compacted the conversation context"
      : "Codex is compacting the conversation context")];
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return [activity(
      item.type === "enteredReviewMode" ? "review_started" : "review_completed",
      item.type === "enteredReviewMode" ? "Codex entered review mode" : "Codex exited review mode",
      item.review,
    )];
  }
  if (item.type === "subAgentActivity") {
    return [activity("subagent", "Codex subagent activity updated", "", {
      kind: item.kind,
      agent_thread_id: item.agentThreadId,
    })];
  }
  if (item.type === "hookPrompt") {
    return [activity("hook_prompt", "Codex hook supplied additional context", "", {
      fragment_count: Array.isArray(item.fragments) ? item.fragments.length : 0,
    })];
  }
  if ([
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "webSearch",
    "imageView",
    "imageGeneration",
    "sleep",
  ].includes(item.type)) {
    const tool = toolNameForItem(item);
    if (!completed) {
      return [{
        type: "agent.tool_call.start",
        provider: "codex",
        callId: item.id,
        tool,
        input: displaySafeToolInput({
          arguments: item.arguments,
          query: item.query,
          action: item.action,
          duration_ms: item.durationMs,
          model: item.model,
          receiver_count: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : undefined,
        }),
      }];
    }
    return [{
      type: "agent.tool_call.end",
      provider: "codex",
      callId: item.id,
      tool,
      content: safeText(item.error?.message || item.result || item.status || "completed", 4096),
      isError: item.success === false || ["failed", "declined", "error"].includes(String(item.status || "").toLowerCase()),
    }];
  }
  return [];
}

export function mapCodexNotification(method, params = {}) {
  const highFrequency = new Set([
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "item/commandExecution/terminalInteraction",
    "item/fileChange/outputDelta",
    "item/fileChange/patchUpdated",
    "command/exec/outputDelta",
    "process/outputDelta",
    "thread/realtime/transcript/delta",
    "thread/realtime/outputAudio/delta",
  ]);
  if (highFrequency.has(method)) return [];

  if (method === "item/started" || method === "item/completed") {
    return mapCodexThreadItem(method, params.item || {});
  }
  if (method === "turn/plan/updated") {
    const plan = (Array.isArray(params.plan) ? params.plan : []).slice(0, 100).map((step) => ({
      step: safeText(step?.step, 1024),
      status: safeText(step?.status, 32),
    }));
    return [activity("plan_progress", "Codex plan updated", params.explanation, { plan })];
  }
  if (method === "thread/compacted") {
    return [activity("context_compacted", "Codex compacted the conversation context")];
  }
  if (method === "thread/status/changed") {
    const state = params.status?.type || params.status || "unknown";
    return [{
      type: "agent.adapter.status",
      provider: "codex",
      state: safeText(state, 64),
      message: `Codex thread status: ${safeText(state, 64)}`,
    }];
  }
  if (method === "thread/settings/updated") {
    const settings = params.threadSettings || {};
    return [activity("settings_applied", "Codex session settings updated", "", {
      model: settings.model,
      model_provider_id: settings.modelProviderId,
      approval_policy: settings.approvalPolicy,
      reasoning_effort: settings.reasoningEffort,
      service_tier: settings.serviceTier,
      collaboration_mode: settings.collaborationMode?.mode,
    })];
  }
  if (method === "hook/started" || method === "hook/completed") {
    const run = params.run || {};
    return [activity("hook", `Codex hook ${run.eventName || "hook"} ${method.endsWith("started") ? "started" : "completed"}`, "", {
      hook_id: run.id,
      event_name: run.eventName,
      status: run.status,
      duration_ms: run.durationMs,
      execution_mode: run.executionMode,
      handler_type: run.handlerType,
    })];
  }
  if (method === "item/mcpToolCall/progress") {
    return [activity("tool_progress", "Codex MCP tool is running", params.message, {
      item_id: params.itemId,
    })];
  }
  if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
    return [activity("approval_review", `Codex automatic approval review ${method.endsWith("started") ? "started" : "completed"}`, "", {
      review_id: params.reviewId,
      target_item_id: params.targetItemId,
      status: params.review?.status,
      risk_level: params.review?.riskLevel,
    })];
  }
  if (method === "model/rerouted") {
    return [activity("model_rerouted", "Codex switched models", safeText(params.reason, 1024), {
      from_model: params.fromModel,
      to_model: params.toModel,
    })];
  }
  if (method === "mcpServer/startupStatus/updated" || method === "mcpServer/oauthLogin/completed") {
    return [activity("mcp_status", "Codex MCP server status changed", safeText(params.error, 1024), {
      server: params.serverName || params.name,
      status: params.status,
      success: params.success,
    })];
  }
  if (method === "error" || method === "thread/realtime/error") {
    const error = params.error || params;
    return [{
      type: "agent.adapter.status",
      provider: "codex",
      state: "error",
      message: safeText(error.message || error, 512),
    }];
  }
  if (method === "turn/diff/updated") {
    return [activity("diff_updated", "Codex updated the current file diff", "", {
      turn_id: params.turnId,
      diff_bytes: Buffer.byteLength(String(params.diff || ""), "utf8"),
    })];
  }
  if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
    return [activity("goal", method.endsWith("cleared") ? "Codex goal cleared" : "Codex goal updated", "", {
      status: params.goal?.status,
      tokens_used: params.goal?.tokensUsed,
      token_budget: params.goal?.tokenBudget,
      time_used_seconds: params.goal?.timeUsedSeconds,
    })];
  }
  if (method === "account/rateLimits/updated") {
    return [activity("rate_limit", "Codex rate limit status changed")];
  }
  return [activity("notification", `Codex notification: ${safeText(method, 128)}`, "", {
    method: safeText(method, 128),
  })];
}

export function mapCodexAppServerEvent(message) {
  const type = message?.type;
  if (!type) return [];

  if (type === "agent_message") {
    return mapCodexAssistantText(message.message);
  }

  if (type === "token_count") {
    const total = message.total || message.info?.total || message.info || message;
    const last = message.last || message.info?.last || {};
    const totalTokens = Number(
      total.totalTokens ?? total.total_tokens
      ?? (Number(total.inputTokens ?? total.input_tokens ?? 0)
        + Number(total.outputTokens ?? total.output_tokens ?? 0)
        + Number(total.cachedInputTokens ?? total.cached_input_tokens ?? 0)
        + Number(total.reasoningOutputTokens ?? total.reasoning_output_tokens ?? 0)),
    );
    const lastTokens = Number(
      last.totalTokens ?? last.total_tokens
      ?? (Number(last.inputTokens ?? last.input_tokens ?? 0)
        + Number(last.outputTokens ?? last.output_tokens ?? 0)
        + Number(last.cachedInputTokens ?? last.cached_input_tokens ?? 0)
        + Number(last.reasoningOutputTokens ?? last.reasoning_output_tokens ?? 0)),
    );
    const active = Object.keys(last).length > 0 ? last : total;
    const inputTokens = Math.max(0, Number(active.inputTokens ?? active.input_tokens ?? 0) || 0);
    const outputTokens = Math.max(0, Number(active.outputTokens ?? active.output_tokens ?? 0) || 0);
    const cachedInputTokens = Math.max(0, Number(active.cachedInputTokens ?? active.cached_input_tokens ?? 0) || 0);
    const reasoningTokens = Math.max(0, Number(active.reasoningOutputTokens ?? active.reasoning_output_tokens ?? 0) || 0);
    return [{
      type: "agent.usage",
      provider: "codex",
      sampledTokens: Math.max(0, Number.isFinite(lastTokens) && lastTokens > 0 ? lastTokens : totalTokens),
      tokenUsage: {
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadInputTokens: cachedInputTokens,
      },
      amountMicros: null,
      currency: null,
      costSource: "unsupported",
    }];
  }

  if (type === "agent_reasoning" || type === "agent_reasoning_delta") {
    return [{ type: "agent.thinking", provider: "codex", text: message.text || message.delta || "" }];
  }

  if (type === "exec_command_begin") {
    return [{
      type: "agent.tool_call.start",
      provider: "codex",
      tool: "exec",
      callId: message.call_id || message.id || message.command,
      input: { command: message.command, cwd: message.cwd },
    }];
  }

  if (type === "exec_command_end") {
    return [{
      type: "agent.tool_call.end",
      provider: "codex",
      callId: message.call_id || message.id,
      content: message.output || message.error || "",
      isError: Boolean(message.error)
        || (Number.isFinite(Number(message.exit_code)) && Number(message.exit_code) !== 0),
    }];
  }

  if (type === "patch_apply_begin") {
    return [{
      type: "agent.tool_call.start",
      provider: "codex",
      tool: "patch",
      callId: message.call_id || message.id || "patch",
      input: { changes: message.changes },
    }];
  }

  if (type === "patch_apply_end") {
    return [{
      type: "agent.tool_call.end",
      provider: "codex",
      callId: message.call_id || message.id || "patch",
      content: message.stdout || message.stderr || "",
      isError: !message.success,
    }];
  }

  if (type === "task_started") {
    return [{ type: "agent.task.started", provider: "codex", id: message.turn_id || message.id }];
  }

  if (type === "task_complete") {
    return [{ type: "agent.task.complete", provider: "codex", id: message.turn_id || message.id, status: message.status || "complete" }];
  }

  if (type === "turn_aborted") {
    return [{ type: "agent.task.aborted", provider: "codex", id: message.turn_id || message.id, error: message.error }];
  }

  // Stage 8.1: app-server ready signal. Emitted by CodexAppServerClient
  // after a successful initialize handshake. Maps to agent.ready so the
  // relay can flip UI state from "connecting" to "ready".
  if (type === "codex.initialized") {
    return [{
      type: "agent.ready",
      provider: "codex",
      message: "Codex app-server session is ready.",
    }];
  }

  // Approval timeout. The five-minute remote decision window
  // resolves the underlying Codex request with decline and surfaces this
  // event so the relay can drop the pending permission card with
  // reason: "timeout".
  if (type === "codex.approval.timeout") {
    return [{
      type: "agent.permission.resolved",
      provider: "codex",
      callId: message.callId,
      decision: "denied",
      reason: "timeout",
    }];
  }

  // Stage 8.4: app-server process exit. The client emits a structured
  // event with code/signal; we render it as `agent.adapter.status`
  // with `state: "exited"`. The CodexAdapter (beforeStart) also uses
  // this raw event type to clean up its pendingApprovals map — see
  // src/adapters/codexAdapter.js.
  if (type === "codex.app_server.exit") {
    return [{
      type: "agent.adapter.status",
      provider: "codex",
      appServerAvailable: false,
      state: "exited",
      code: message.code ?? null,
      signal: message.signal ?? null,
    }];
  }

  // Stage 8.4: SIGTERM → SIGKILL escalation fired. Distinct from a
  // graceful exit so the relay can flag the session as abnormal.
  if (type === "codex.app_server.force_kill") {
    return [{
      type: "agent.adapter.status",
      provider: "codex",
      appServerAvailable: false,
      state: "force_killed",
    }];
  }

  if (type === "codex.notification") {
    return mapCodexNotification(message.method, message.params);
  }

  return [{ type: "agent.raw", provider: "codex", event: message }];
}

export function mapCodexApprovalRequest(request) {
  const params = request.params || request.input || request;
  const callId = request.callId || params.callId || params.call_id || params.approvalId || params.itemId || params.id || `${request.method}-${Date.now()}`;
  const tool = request.type || (request.method?.includes("patch") || request.method?.includes("fileChange") ? "patch" : "exec");
  return {
    type: "agent.permission.request.detected",
    provider: "codex",
    callId,
    tool,
    input: {
      ...params,
      command: request.command || params.command,
      cwd: request.cwd || params.cwd,
      reason: request.reason || params.reason,
      fileChanges: request.fileChanges || params.fileChanges,
      serverName: request.serverName || params.serverName,
      message: request.message || params.message,
    },
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: ["approved", "approved_for_session", "denied", "abort"],
    },
  };
}
