export function mapCodexAppServerEvent(message) {
  const type = message?.type;
  if (!type) return [];

  if (type === "agent_message") {
    return [{ type: "agent.text", provider: "codex", text: message.message || "" }];
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
      isError: Boolean(message.error),
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

  // Stage 8.1: approval timeout. Per-app-server-request timeout (30s)
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
