import {
  displaySafeToolInput,
  toolInputContainsSecret,
} from "../runtime/displaySafeToolInput.js";

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
    if (!message) return false;
    return submitRemoteMessage(ctx.executor, message);
  }
  if (payload.type === "terminal.input") {
    ctx.executor.write(payload.data || "");
    return true;
  }
  if (payload.type === "terminal.resize") {
    ctx.executor.resize(payload.cols, payload.rows);
  }
  if (payload.type === "terminal.interrupt") {
    ctx.executor.interrupt();
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
  if (payload.type === "session.stop") {
    ctx.executor.stop();
    return true;
  }
  return true;
}

async function submitRemoteMessage(executor, message) {
  if (typeof executor?.submitMessage === "function") {
    await executor.submitMessage(message);
    return true;
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
  return {
    ...displaySafeEvent,
    sessionId,
    title: event?.title || `${tool} needs permission`,
    prompt: event?.prompt || "Review this action before continuing.",
    payload: event?.payload || {
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
