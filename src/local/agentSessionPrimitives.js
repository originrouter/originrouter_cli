import {
  displaySafeToolInput,
  toolInputContainsSecret,
} from "../runtime/displaySafeToolInput.js";
import {
  AGENT_COMMAND_TYPE,
  COMMAND_KIND_SLASH,
  normalizeCommandPayload,
} from "../agent/slashCommands.js";

const CLAUDE_AVAILABLE_MODES = Object.freeze([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);
const CODEX_AVAILABLE_MODES = Object.freeze([
  "default",
  "read-only",
  "safe-yolo",
  "yolo",
]);

// Build an agent.mode.status event payload. Pure helper; exported
// for tests via runLocalAgentSession's exports below.
export function buildModeStatusEvent({
  sessionId,
  provider,
  runtime,
  availableModes,
  mode = "default",
  modeControl = "unsupported",
  reason = "Live mode switching is not available for this runtime.",
}) {
  return {
    type: "agent.mode.status",
    sessionId,
    provider,
    runtime: runtime ?? null,
    availableModes: Array.isArray(availableModes) ? availableModes.slice() : [],
    mode,
    modeControl,
    reason,
  };
}

// Stage 8.9: extracted handleRemoteEvent so the runtime wiring test
// (tests/agentInteractionRuntime.test.js) can call it with stub
// adapter/executor pairs. Production code calls it via the closure
// inside runLocalAgentSession.
export function handleRemoteEvent(payload, ctx) {
  if (!payload || payload.sessionId !== ctx.sessionId) return;

  if (payload.type === "agent.message") {
    const message = String(payload.message || "").replace(/[\r\n]+$/g, "");
    if (!message && !payload.content?.length) return false;
    if (payload.content != null && ctx.adapter?.describe?.().runtime !== 'agy-acp') return false;
    if (typeof ctx.adapter?.submitRemoteMessage === 'function') return ctx.adapter.submitRemoteMessage(ctx.executor, message,
      { ...payload, messageId: payload.messageId || payload.commandId });
    return submitRemoteMessage(ctx.executor, message);
  }
  if (payload.type === AGENT_COMMAND_TYPE) {
    // Terminal sessions take commands the same way they take messages: the
    // TUI resolves the line itself. Only slash commands the session's own
    // menu named are injected — side-conversation kinds and anything the
    // table did not offer get a negative result instead of a stray keystroke.
    //
    // Every refusal names its reason on `ctx.commandRefusal` so the caller
    // can fold it into the `agent.command.result` it emits: "unsupported"
    // used to be the only word, which told the reader a busy session did not
    // know the command at all.
    const command = normalizeCommandPayload(payload);
    ctx.commandRefusal = null;
    if (command.kind !== COMMAND_KIND_SLASH) {
      ctx.commandRefusal = "unsupported";
      return false;
    }
    const offered = Array.isArray(ctx.adapter?.commands) ? ctx.adapter.commands : Array.isArray(ctx.sessionCommands)
      ? ctx.sessionCommands
      : [];
    const entry = offered.find(
      (item) =>
        item.name === command.name ||
        (Array.isArray(item.aliases) && item.aliases.includes(command.name)),
    );
    if (!entry || entry.route === "app") {
      ctx.commandRefusal = "unsupported";
      return false;
    }
    const line = `/${command.name}${command.args ? ` ${command.args}` : ""}`;
    if (typeof ctx.adapter?.submitRemoteMessage === 'function') {
      if (ctx.adapter.busy && !entry.availableDuringTask) {
        ctx.commandRefusal = "turn_in_progress";
        return false;
      }
      return Promise.resolve(
        ctx.adapter.submitRemoteMessage(ctx.executor, line),
      ).then((accepted) => {
        if (accepted === false) ctx.commandRefusal = "inject_failed";
        return accepted;
      });
    }
    return submitRemoteMessage(ctx.executor, line).then((accepted) => {
      if (accepted === false) ctx.commandRefusal = "inject_failed";
      return accepted;
    });
  }
  if (payload.type === "terminal.input") {
    if (ctx.adapter?.supportsRawTerminal === false) return false;
    ctx.executor.write(payload.data || "");
    return true;
  }
  if (payload.type === "terminal.resize") {
    ctx.executor.resize(payload.cols, payload.rows);
  }
  if (payload.type === "terminal.interrupt") {
    ctx.adapter.onInterrupt?.();
    ctx.executor.interrupt();
  }
  if (payload.type === 'agent.supervisor.interrupt') {
    return ctx.adapter?.interruptForRecovery?.(payload.turnId) ?? false;
  }
  if (payload.type === "agent.permission.resolve") {
    if (typeof ctx.adapter.resolvePermission === "function") {
      return ctx.adapter.resolvePermission(payload);
    } else if (payload.data) {
      ctx.executor.write(payload.data);
      return true;
    }
    return false;
  }
  if (payload.type === "agent.interaction.resolve") {
    // Native Claude routes permission, questions, plan confirmation,
    // and MCP elicitation through the adapter's blocking Hook resolver.
    // The data fallback remains only for adapters without a resolver.
    if (typeof ctx.adapter.resolvePermission === "function") {
      ctx.adapter.resolvePermission({
        callId: payload.callId || payload.interactionId,
        interactionId: payload.interactionId,
        decision: payload.decision,
        reason: payload.reason,
        data: payload.data,
        value: payload.value,
      });
    } else if (payload.data) {
      ctx.executor.write(payload.data);
    }
  }
  if (
    payload.type === "agent.autonomy.set" &&
    typeof ctx.applyAutonomy === "function"
  ) {
    return ctx.applyAutonomy(payload);
  }
  if (
    payload.type === "agent.mode.set" &&
    typeof ctx.adapter?.setMode === "function"
  ) {
    return ctx.adapter.setMode(payload, ctx.executor);
  }
  if (
    payload.type === "agent.model.set" &&
    typeof ctx.applySessionModel === "function"
  ) {
    return ctx.applySessionModel(payload);
  }
  if (
    payload.type === "agent.effort.set" &&
    typeof ctx.applyEffort === "function"
  ) {
    return ctx.applyEffort(payload);
  }
  if (payload.type === "session.stop") {
    ctx.executor.stop();
    return true;
  }
  return true;
}

async function submitRemoteMessage(executor, message) {
  if (typeof executor?.submitMessage === "function") {
    return (await executor.submitMessage(message)) !== false;
  }
  executor.write(message);
  await new Promise((resolve) => setTimeout(resolve, 30));
  executor.write("\r");
  return true;
}

function permissionDecision(resolved) {
  if (resolved.action === "allow" || resolved.action === "submit") {
    return resolved.response?.remember_for_session
      ? "approved_for_session"
      : "approved";
  }
  if (resolved.action === "cancel") return "abort";
  return "denied";
}

function normalizePtyInteraction(event, sessionId) {
  const createdAt = Number(event?.createdAt || Date.now());
  const tool = String(event?.tool || event?.kind || "permission").slice(0, 64);
  const rawToolInput =
    event?.input && typeof event.input === "object" ? event.input : {};
  const toolInput = displaySafeToolInput(rawToolInput);
  const { input: _rawInput, raw: _rawEvent, ...displaySafeEvent } = event || {};
  const eventPayload =
    event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload
      : null;
  // The canonical interaction contract mirrors legacy `input` in
  // `payload.tool_input` so the App can render a permission card. Re-apply
  // the PTY display-safety boundary here because adapters may have produced
  // that payload before this session-level sanitizer ran.
  const safePayload = eventPayload && event?.kind === "permission"
    ? {
        ...eventPayload,
        tool_input: displaySafeToolInput(
          eventPayload.tool_input && typeof eventPayload.tool_input === "object"
            ? eventPayload.tool_input
            : rawToolInput,
        ),
        ...(typeof eventPayload.command === "string"
          ? { command: eventPayload.command.slice(0, 8192) }
          : {}),
        ...(typeof eventPayload.cwd === "string"
          ? { cwd: eventPayload.cwd.slice(0, 1024) }
          : {}),
      }
    : eventPayload;
  return {
    ...displaySafeEvent,
    sessionId,
    title: event?.title || `${tool} needs permission`,
    prompt: event?.prompt || "Review this action before continuing.",
    payload: safePayload || {
      tool,
      display_name: tool,
      tool_input: toolInput,
      command:
        typeof toolInput.command === "string"
          ? toolInput.command.slice(0, 8192)
          : "",
      cwd:
        typeof toolInput.cwd === "string" ? toolInput.cwd.slice(0, 1024) : "",
      remember_allowed:
        Array.isArray(event?.permissionSuggestions) &&
        event.permissionSuggestions.length > 0,
    },
    containsSecret: Boolean(
      event?.containsSecret || toolInputContainsSecret(rawToolInput),
    ),
    createdAt:
      createdAt > 10_000_000_000
        ? Math.floor(createdAt / 1000)
        : Math.floor(createdAt),
  };
}

export function extractOriginRouterOptions(args) {
  const options = {};
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--originrouter-relay") {
      options.relay = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-relay-mode") {
      options.relayMode = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-device") {
      options.device = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-session") {
      options.session = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-executor") {
      options.executor = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-conversation") {
      options.conversationId = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-run") {
      options.runId = args[index + 1];
      index += 1;
      continue;
    }
    if (['--originrouter-workspace', '--originrouter-task', '--originrouter-session-kind', '--originrouter-telemetry-owner'].includes(arg)) {
      const key = { '--originrouter-workspace': 'workspaceId', '--originrouter-task': 'taskId', '--originrouter-session-kind': 'sessionKind', '--originrouter-telemetry-owner': 'telemetryOwner' }[arg];
      options[key] = args[++index]; continue;
    }
    // The title is ours, not the agent's: the agent names the conversation
    // itself, and this is only the name the launcher already knows.
    if (arg === "--originrouter-title") {
      options.title = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      options.provider = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-autonomy") {
      options.autonomyProfile = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-policy") {
      options.approvalPolicyReference = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-detail") {
      options.detailProfile = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--originrouter-auto-approve") {
      options.autonomyProfile = "guarded";
      continue;
    }
    if (arg === "--originrouter-auto-allow") {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...String(args[index + 1] || "").split(","),
      ];
      index += 1;
      continue;
    }
    if (arg.startsWith("--originrouter-autonomy=")) {
      options.autonomyProfile = arg.slice("--originrouter-autonomy=".length);
      continue;
    }
    if (arg.startsWith("--originrouter-detail=")) {
      options.detailProfile = arg.slice("--originrouter-detail=".length);
      continue;
    }
    if (arg.startsWith("--originrouter-auto-allow=")) {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...arg.slice("--originrouter-auto-allow=".length).split(","),
      ];
      continue;
    }
    if (arg === "--native-config") {
      options.nativeConfig = true;
      continue;
    }
    passthrough.push(arg);
  }

  return { options, passthrough };
}

export {
  CLAUDE_AVAILABLE_MODES,
  CODEX_AVAILABLE_MODES,
  normalizePtyInteraction,
  permissionDecision,
};
