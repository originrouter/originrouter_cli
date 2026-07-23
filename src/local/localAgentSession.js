import process from "node:process";
import { randomUUID } from "node:crypto";
import {
  startAgentSessionHeartbeat,
  createRuntimeEventReporter,
  createTerminalActivityReporter,
  startApprovalDecisionPolling,
} from "../agent/bridgeReporter.js";
import { createAdapter } from "../adapters/createAdapter.js";
import { buildAgentProviderEnv, willRouteRemoteCoding } from "../config/claudeConfig.js";
import { DEFAULT_DEVICE_ID, DEFAULT_RELAY_URL } from "../constants.js";
import { createExecutor } from "../executors/createExecutor.js";
import { appendSessionStart, patchSessionExit } from "../persistence/sessionLog.js";
import { ensureDevice, ensureStateDir, readConfig } from "../persistence/state.js";
import { RemoteCodingProxyManager } from "../proxy/remoteCodingProxyManager.js";
import { readLocalProxySnapshot, NOOP_REMOTE_CODING_SNAPSHOT, snapshotRemoteCodingStatus, staticProxyStatusFn } from "../proxy/snapshot.js";
import { buildRelayClientOptions } from "../relay/relayAuthBootstrap.js";
import { RelayClient } from "../relay/relayClient.js";
import { buildProviderConfigEvent } from "../util/providerConfigEvent.js";
import { PendingInteractionRegistry } from "../runtime/pendingInteractionRegistry.js";
import {
  buildAutonomyStatusEvent,
  evaluateAutonomyInteraction,
  invalidAutonomyScopes,
  normalizeAutonomyProfile,
  normalizeAutonomyScopes,
} from "../runtime/agentAutonomyPolicy.js";
import { protectOriginrouterCodingEnv } from "../runtime/originrouterCodingAuthProxy.js";
import { displaySafeToolInput, toolInputContainsSecret } from "../runtime/displaySafeToolInput.js";
import {
  AGENT_DETAIL_PROFILES,
  resolveAgentDetailProfile,
} from "../runtime/agentDetailProfile.js";
import { LocalAgentBridgeClient } from "./localAgentBridgeClient.js";

// Stage 8.9: agent.mode.status surface. The available mode lists
// match the planned Stage 9.0+ vocabulary; 8.9 does not wire any
// of them (modeControl: "unsupported"). Listed for App-side display
// only.
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
}) {
  return {
    type: "agent.mode.status",
    sessionId,
    provider,
    runtime: runtime ?? null,
    availableModes: Array.isArray(availableModes) ? availableModes.slice() : [],
    mode: "default",
    modeControl: "unsupported",
    reason: "Live mode switching is not wired in Stage 8.9. Display only.",
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
  if (payload.type === "agent.autonomy.set" && typeof ctx.applyAutonomy === "function") {
    return ctx.applyAutonomy(payload);
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
  const rawToolInput = event?.input && typeof event.input === "object" ? event.input : {};
  const toolInput = displaySafeToolInput(rawToolInput);
  const {
    input: _rawInput,
    raw: _rawEvent,
    ...displaySafeEvent
  } = event || {};
  return {
    ...displaySafeEvent,
    sessionId,
    title: event?.title || `${tool} needs permission`,
    prompt: event?.prompt || "Review this action before continuing.",
    payload: event?.payload || {
      tool,
      display_name: tool,
      tool_input: toolInput,
      command: typeof toolInput.command === "string"
        ? toolInput.command.slice(0, 8192)
        : "",
      cwd: typeof toolInput.cwd === "string" ? toolInput.cwd.slice(0, 1024) : "",
      remember_allowed: Array.isArray(event?.permissionSuggestions)
        && event.permissionSuggestions.length > 0,
    },
    containsSecret: Boolean(event?.containsSecret || toolInputContainsSecret(rawToolInput)),
    createdAt: createdAt > 10_000_000_000
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
    if (
      arg === "--originrouter-native-config"
      || arg === "--originrouter-native"
    ) {
      options.nativeConfig = true;
      continue;
    }
    passthrough.push(arg);
  }

  return { options, passthrough };
}

function writeLocal(data) {
  process.stdout.write(data);
}

export async function runLocalAgentSession(agent, rawArgs) {
  const stateDir = ensureStateDir();

  const { options, passthrough } = extractOriginRouterOptions(rawArgs);
  const relayUrl = options.relay || process.env.ORIGINROUTER_RELAY || DEFAULT_RELAY_URL;
  const device = ensureDevice(options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID);
  const sessionId = options.session || `${agent}-${Date.now()}`;
  const cwd = process.cwd();
  // Stage 9.5 — when ORIGINROUTER_RELAY_AUTH=on, acquire a Surety token
  // and use the effective deviceId (from coding-key.json) for the relay.
  let relayClient;
  let effectiveDeviceId;
  try {
    const relayOptions = await buildRelayClientOptions({
      stateDir,
      relayUrl,
      fallbackDeviceId: device.deviceId,
    });
    relayClient = new RelayClient(relayOptions);
    effectiveDeviceId = relayOptions.deviceId;
  } catch (err) {
    console.error(`[local-session] relay auth bootstrap failed: code=${err?.code || "unknown"}`);
    throw err;
  }
  const useNativeConfig = options.nativeConfig === true;
  if (useNativeConfig && options.provider) {
    throw new Error("--provider cannot be combined with --originrouter-native-config");
  }
  const adapter = createAdapter({
    agent,
    command: agent,
    args: passthrough,
    cwd,
    nativeConfig: useNativeConfig,
  });
  const executor = createExecutor("pty");
  const localConfig = readConfig();
  const detail = resolveAgentDetailProfile({
    config: localConfig,
    launchOverride: options.detailProfile,
  });
  // Stage 4: direct CLI sessions read the persisted local proxy snapshot.
  // When LiteLLM is running for the selected openai-compatible provider,
  // buildAgentProviderEnv routes Claude Code through it.
  const proxyStatus = staticProxyStatusFn(readLocalProxySnapshot());

  // Stage 9.2: when the resolved route is type=remote, target=proxy, the
  // local wrapper owns the caller-side `RemoteCodingRelayProxy`. We
  // start it lazily so the env builder can read the bound port through
  // a frozen sync snapshot — the same pattern as the LiteLLM proxy.
  let remoteCodingProxyManager = null;
  let remoteCodingStatus = staticProxyStatusFn(NOOP_REMOTE_CODING_SNAPSHOT);
  if (!useNativeConfig && willRouteRemoteCoding(localConfig, agent)) {
    remoteCodingProxyManager = new RemoteCodingProxyManager({
      stateDir,
      relayUrl,
      deviceId: effectiveDeviceId,
    });
    const startResult = await remoteCodingProxyManager.start();
    if (!startResult.ok) {
      throw new Error(`Failed to start remote-coding relay proxy: ${startResult.error}`);
    }
    remoteCodingStatus = staticProxyStatusFn(
      await snapshotRemoteCodingStatus(remoteCodingProxyManager)
    );
  }

  // buildAgentProviderEnv throws PROVIDER_UNSUPPORTED if --provider or
  // currentProvider[agent] points to an openai-compatible profile AND the
  // proxy is not running for it. Stage 4 routes through the proxy when the
  // status reports `state: "running"` for this exact provider.
  let providerResult = useNativeConfig
    ? { env: {}, provider: null, source: "native-config" }
    : await buildAgentProviderEnv(agent, localConfig, {
        provider: options.provider,
        proxyStatus,
        remoteCodingStatus,
      });
  let originrouterCodingProxy = null;
  if (!useNativeConfig) {
    ({ providerResult, proxy: originrouterCodingProxy } = await protectOriginrouterCodingEnv(
      agent,
      providerResult,
      { stateDir },
    ));
  }
  const providerEnv = providerResult.env;
  const resolvedProvider = providerResult.provider;
  const providerSource = providerResult.source;
  const baseEnv = { ...process.env, ...providerEnv };
  let exited = false;
  let finalizing = false;
  let shutdownRequested = false;
  let scanTimer = null;
  let signalFallbackTimer = null;
  let stopApprovalPolling = () => {};
  let stopSessionHeartbeat = () => {};
  let localAgentBridge = null;
  const autonomySupported = agent === "claude";
  const invalidScopes = invalidAutonomyScopes(options.autonomyAllowedScopes);
  if (invalidScopes.length) {
    throw new Error(`Unknown unattended scope(s): ${invalidScopes.join(", ")}`);
  }
  if (options.autonomyProfile && !normalizeAutonomyProfile(options.autonomyProfile, "")) {
    throw new Error(`Unknown unattended profile: ${options.autonomyProfile}`);
  }
  if (options.autonomyAllowedScopes?.length && options.autonomyProfile && options.autonomyProfile !== "custom") {
    throw new Error("--originrouter-auto-allow requires --originrouter-autonomy custom or no explicit profile");
  }
  let autonomyAllowedScopes = autonomySupported
    ? normalizeAutonomyScopes(options.autonomyAllowedScopes)
    : [];
  let autonomyProfile = autonomySupported
    ? normalizeAutonomyProfile(
        options.autonomyProfile || (autonomyAllowedScopes.length ? "custom" : "manual"),
      )
    : "manual";
  if (
    !autonomySupported
    && (options.autonomyProfile || (options.autonomyAllowedScopes || []).length)
  ) {
    process.stderr.write(
      "warning: native Codex cannot expose structured approval requests; "
      + "unattended settings are ignored. Use `originrouter codex-terminal`.\n",
    );
  }
  const signalHandlers = new Map();

  const send = (type, extra = {}) => {
    return relayClient.send(type, {
      sessionId,
      localStarted: true,
      ...extra,
    }).catch(() => {});
  };
  const runtimeReporter = createRuntimeEventReporter({
    sessionId,
    agentType: agent,
    title: `${agent} session`,
    deviceName: device.host,
    stateDir: ensureStateDir(),
  });
  const report = (type, extra = {}) => {
    if (type !== "session.started" && type !== "session.exited" && type !== "session.error" && type !== "agent.event") {
      return Promise.resolve();
    }
    return runtimeReporter.report(type, extra);
  };
  const recentEvents = [];
  let controlReady = false;
  const sendTransientEvent = async (event) => {
    const transientEvent = {
      ...event,
      eventId: event.eventId || `ate_${randomUUID()}`,
      createdAt: event.createdAt || Math.floor(Date.now() / 1000),
    };
    recentEvents.push(transientEvent);
    if (recentEvents.length > 100) {
      recentEvents.splice(0, recentEvents.length - 100);
    }
    if (!controlReady) return;
    await Promise.all([
      send("agent.stream.event", { event: transientEvent }),
      report("agent.event", { event: transientEvent }),
      localAgentBridge?.sendEvent(transientEvent),
    ]);
  };
  const interactions = new PendingInteractionRegistry({
    onRequested: async (request) => {
      await Promise.all([
        send("agent.interaction.requested", request),
        report("agent.event", { event: request }),
        localAgentBridge?.sendEvent(request),
      ]);
    },
    onResult: async (result) => {
      const event = {
        type: "agent.interaction.result",
        ...result,
      };
      await Promise.all([
        send("agent.interaction.result", result),
        localAgentBridge?.sendEvent(event),
        report("agent.event", {
          event: {
            type: `agent.interaction.${result.status}`,
            interactionId: result.interactionId,
            reason: result.reason,
          },
        }),
      ]);
    },
  });
  const autonomyStatus = (requestId = null) => buildAutonomyStatusEvent({
    provider: agent,
    runtime: agent === "claude" ? "claude-pty" : "codex-pty",
    profile: autonomyProfile,
    allowedScopes: autonomyAllowedScopes,
    control: autonomySupported ? "supported" : "unsupported",
    requestId,
    reason: autonomySupported
      ? null
      : "Native Codex does not expose its blocking approval channel. Use originrouter codex-terminal.",
  });
  const detailStatus = () => ({
    type: "agent.detail.status",
    provider: agent,
    detailProfile: detail.profile,
    detailSource: detail.source,
    detailControl: "read_only",
    availableDetailProfiles: AGENT_DETAIL_PROFILES,
  });
  const applyAutonomy = async (payload) => {
    if (!autonomySupported) {
      await sendTransientEvent(autonomyStatus(payload?.requestId || null));
      return false;
    }
    const requested = normalizeAutonomyProfile(payload?.profile, "");
    if (!requested) return false;
    autonomyProfile = requested;
    autonomyAllowedScopes = requested === "custom"
      ? normalizeAutonomyScopes(payload?.allowedScopes || payload?.allowed_scopes)
      : [];
    await sendTransientEvent(autonomyStatus(payload?.requestId || null));
    return true;
  };
  const registeredInteractions = new Set();
  const registerInteraction = (event) => {
    const request = normalizePtyInteraction(event, sessionId);
    if (registeredInteractions.has(request.interactionId)) return;
    const automatic = autonomySupported
      ? evaluateAutonomyInteraction(request, {
          profile: autonomyProfile,
          allowedScopes: autonomyAllowedScopes,
          workspaceRoot: cwd,
        })
      : { autoResolve: false };
    if (automatic.autoResolve) {
      const applied = adapter.resolvePermission({
        callId: request.interactionId,
        interactionId: request.interactionId,
        decision: "approved",
        reason: automatic.reason,
        action: automatic.action,
        response: automatic.response,
      });
      void sendTransientEvent({
        type: "agent.interaction.auto_resolved",
        provider: agent,
        interactionId: request.interactionId,
        kind: request.kind,
        title: request.title,
        autonomyProfile,
        autonomyScope: automatic.scope,
        reason: applied === false ? "native_interaction_not_pending" : automatic.reason,
        status: applied === false ? "failed" : "applied",
      });
      return;
    }
    registeredInteractions.add(request.interactionId);
    void interactions.request(request).then(async (resolved) => {
      const applied = adapter.resolvePermission({
        callId: resolved.interactionId,
        interactionId: resolved.interactionId,
        decision: permissionDecision(resolved),
        reason: resolved.action,
        action: resolved.action,
        response: resolved.response,
      });
      await interactions.markResult(
        resolved.interactionId,
        applied === false ? "failed" : "applied",
        {
          responseId: resolved.responseId,
          reason: applied === false ? "native_interaction_not_pending" : "",
        },
      );
      registeredInteractions.delete(resolved.interactionId);
    }).catch(() => {
      registeredInteractions.delete(request.interactionId);
    });
  };
  const terminalActivityReporter = createTerminalActivityReporter({
    sessionId,
    agentType: agent,
    title: `${agent} local session`,
    deviceName: device.host,
    stateDir: ensureStateDir(),
    reportRuntimeEventFn: (payload) => runtimeReporter.report(
      "terminal.activity",
      { summary: payload.summary },
    ),
  });

  const cleanup = () => {
    stopSessionHeartbeat();
    stopSessionHeartbeat = () => {};
    stopApprovalPolling();
    stopApprovalPolling = () => {};
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    if (typeof adapter.cleanup === "function") {
      adapter.cleanup();
    }
    terminalActivityReporter.stop();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    // Stage 9.2: tear down the caller-side relay proxy through the
    // wrapper's existing cleanup path. No new process.once signal
    // handlers — see the plan §C.7 for why this is the right seam.
    if (remoteCodingProxyManager) {
      remoteCodingProxyManager.stop().catch(() => {});
      remoteCodingProxyManager = null;
    }
    if (originrouterCodingProxy) {
      originrouterCodingProxy.stop().catch(() => {});
      originrouterCodingProxy = null;
    }
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  const finalizeSession = async ({ code, signal }) => {
    if (finalizing) return runtimeReporter.flush();
    finalizing = true;
    exited = true;
    if (signalFallbackTimer) {
      clearTimeout(signalFallbackTimer);
      signalFallbackTimer = null;
    }
    await terminalActivityReporter.flush().catch(() => {});
    await interactions.cancelAll("session_stopped");
    cleanup();
    await localAgentBridge?.close(signal ? "stopped" : "completed");
    localAgentBridge = null;
    const exitedAt = new Date().toISOString();
    try {
      patchSessionExit({ sessionId, status: "exited", code, signal, exitedAt });
    } catch (error) {
      console.error(`[session-log] ${error.message}`);
    }
    send("session.exited", { code, signal });
    await report("session.exited", { code, signal });
  };

  if (typeof adapter.beforeStart === "function") {
    await adapter.beforeStart({
      cwd,
      env: baseEnv,
      sessionId,
      relayClient,
      send,
    });
  }

  stopApprovalPolling = startApprovalDecisionPolling({
    sessionId,
    stateDir: ensureStateDir(),
    onDecision: async (payload) => {
      const applied = handleRemoteEvent(payload, { sessionId, adapter, executor });
      if (applied !== false) {
        await report("agent.event", {
          event: {
            type: "agent.permission.resolved",
            callId: payload.interactionId,
            decision: payload.decision,
          },
        });
      }
      return applied;
    },
  });

  const launch = adapter.buildLaunch();
  const metadata = adapter.describe();
  // Stage 8.4: lift the runtime tag to a top-level local so the
  // session.started event AND the session log entry both see it. The
  // adapter's describe() returns `runtime: "codex-app-server"` when
  // the structured app-server path is active, `null` otherwise.
  const runtime = metadata.runtime ?? null;
  const started = await executor.start({
    command: launch.command,
    args: launch.args,
    cwd,
    env: { ...baseEnv, ...launch.env },
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
    onOutput: (data) => {
      writeLocal(data);
      terminalActivityReporter.ingest(data);
      for (const event of adapter.handleOutput(data)) {
        void sendTransientEvent(event);
      }
    },
    onExit: ({ code, signal }) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      Promise.race([
        finalizeSession({ code, signal }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]).finally(() => process.exit(process.exitCode || 0));
    },
    onError: (error) => {
      send("session.error", { message: error.message });
      report("session.error", { message: error.message });
      console.error(error.message);
    },
  });

  send("session.started", {
    command: launch.command,
    args: launch.args,
    cwd,
    agent,
    metadata,
    // Stage 8.4: top-level runtime field mirrors metadata.runtime so
    // relay/UI consumers that only read top-level fields see it.
    runtime,
    providerConfig: agent === "claude" && !useNativeConfig
      ? buildProviderConfigEvent(resolvedProvider, providerSource)
      : undefined,
    nativeConfig: useNativeConfig,
    executor: started.executor,
    pid: started.pid,
    startedBy: "local-wrapper",
  });
  await report("session.started", {
    runtime,
    executor: started.executor,
  });
  localAgentBridge = new LocalAgentBridgeClient({
    stateDir,
    sessionId,
    onCommand: async (payload) => {
      let applied;
      if (payload?.type === "agent.interaction.resolve") {
        try {
          applied = interactions.resolve(payload).accepted;
        } catch {
          applied = false;
        }
      } else {
        applied = await handleRemoteEvent(payload, {
          sessionId,
          adapter,
          executor,
          applyAutonomy,
        });
      }
      if (payload?.type === "agent.message") {
        const message = String(payload.message || "").replace(/[\r\n]+$/g, "");
        if (applied !== false && message) {
          await sendTransientEvent({
            type: "user.text",
            provider: agent,
            text: message,
            eventId: payload.messageId || payload.commandId
              ? `local-message-${payload.messageId || payload.commandId}`
              : undefined,
          });
        }
        await localAgentBridge?.sendEvent({
          type: "agent.message.result",
          messageId: payload.messageId || payload.commandId,
          accepted: applied !== false,
        });
      }
      return applied;
    },
  });
  await localAgentBridge.start({
    sessionId,
    conversationId: options.conversationId || sessionId,
    runId: options.runId || sessionId,
    agent,
    title: `${agent} session`,
    deviceId: effectiveDeviceId,
    deviceName: device.host,
    cwd,
    workspaceTrusted: true,
    pid: started.pid,
    startedAt: new Date().toISOString(),
    runtime,
    provider: resolvedProvider?.name,
    model: resolvedProvider?.model,
    permissionProfile: autonomyProfile,
    startedBy: "local-wrapper",
    autonomyProfile,
    autonomyControl: autonomySupported ? "supported" : "unsupported",
    allowedAutonomyScopes: autonomyAllowedScopes,
    detailProfile: detail.profile,
    detailSource: detail.source,
    transcriptPath: typeof adapter.getTranscriptPath === "function"
      ? adapter.getTranscriptPath()
      : null,
  });
  controlReady = true;
  stopSessionHeartbeat = startAgentSessionHeartbeat({
    sessionId,
    stateDir: ensureStateDir(),
  });

  const requestSignalShutdown = (signal) => {
    if (finalizing || shutdownRequested) return;
    shutdownRequested = true;
    process.exitCode = 1;
    signalFallbackTimer = setTimeout(() => {
      void finalizeSession({ code: null, signal }).finally(() => process.exit(1));
    }, 1000);
    try {
      if (signal === "SIGINT") executor.interrupt();
      else executor.stop();
    } catch {
      void finalizeSession({ code: null, signal }).finally(() => process.exit(1));
    }
  };
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) {
    const handler = () => requestSignalShutdown(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  // Stage 8.9: emit agent.mode.status once per session. The local
  // `agent` command is mapped to the protocol provider string
  // explicitly; the runtime tag is the same value session.started
  // already carries. modeControl: "unsupported" — 8.9 supports
  // viewing mode/status only. Remote mode switching is Stage 9.0+.
  const modeList = agent === "codex" ? CODEX_AVAILABLE_MODES : CLAUDE_AVAILABLE_MODES;
  send("agent.event", {
    event: buildModeStatusEvent({
      sessionId,
      provider: agent === "codex" ? "codex" : "claude",
      runtime,
      availableModes: modeList,
    }),
  });
  report("agent.event", {
    event: buildModeStatusEvent({
      sessionId,
      provider: agent === "codex" ? "codex" : "claude",
      runtime,
      availableModes: modeList,
    }),
  });
  void localAgentBridge?.sendEvent(buildModeStatusEvent({
    sessionId,
    provider: agent === "codex" ? "codex" : "claude",
    runtime,
    availableModes: modeList,
  }));
  void sendTransientEvent(autonomyStatus());
  void sendTransientEvent(detailStatus());

  try {
    appendSessionStart({
      sessionId,
      deviceId: effectiveDeviceId,
      agent,
      command: launch.command,
      args: launch.args,
      cwd,
      pid: started.pid,
      executor: started.executor,
      // Stage 8.4: was a hardcoded `undefined`. Now reads the
      // derived runtime tag — "codex-app-server" for Codex app-server
      // sessions, null otherwise. Existing schema field.
      runtime,
      startedBy: "local-wrapper",
      startedAt: new Date().toISOString(),
      status: "running",
    });
  } catch (error) {
    console.error(`[session-log] ${error.message}`);
  }

  if (typeof adapter.scanStructuredEvents === "function") {
    scanTimer = setInterval(() => {
      for (const event of adapter.scanStructuredEvents()) {
        let displayEvent = event;
        if (event.type === "agent.session.start" && event.transcriptPath) {
          void localAgentBridge?.update({ transcriptPath: event.transcriptPath });
          const { transcriptPath: _transcriptPath, raw: _raw, ...safeEvent } = event;
          displayEvent = safeEvent;
        }
        if (event.type === "agent.permission.request.detected") continue;
        if (event.type === "agent.interaction.requested") {
          registerInteraction(event);
          continue;
        }
        if (event.type === "agent.permission.resolved") {
          const interactionId = event.callId || event.interactionId;
          if (interactionId && registeredInteractions.has(interactionId)) {
            const expired = /timeout|expired/i.test(String(event.reason || ""));
            void interactions.markResult(
              interactionId,
              expired ? "expired" : "canceled",
              { reason: event.reason || "native_interaction_resolved" },
            );
            registeredInteractions.delete(interactionId);
          }
        }
        void sendTransientEvent(displayEvent);
      }
    }, 1000);
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    executor.write(data.toString("utf8"));
  });

  process.stdout.on("resize", () => {
    executor.resize(process.stdout.columns || 100, process.stdout.rows || 30);
    send("terminal.resize.local", {
      cols: process.stdout.columns || 100,
      rows: process.stdout.rows || 30,
    });
  });

  const handleRemoteEventBound = async (payload) => {
    if (payload?.type === "agent.history.request") {
      const history = typeof adapter.readConversationHistory === "function"
        ? adapter.readConversationHistory({
            beforeCursor: payload.beforeCursor,
            limit: payload.limit,
          })
        : { messages: [], nextCursor: null, hasMore: false };
      await send("agent.history.page", {
        requestId: payload.requestId,
        messages: history.messages,
        nextCursor: history.nextCursor,
        hasMore: history.hasMore,
        detailProfile: detail.profile,
        detailSource: detail.source,
      });
      return true;
    }
    if (payload?.type === "agent.interactions.snapshot.request") {
      const sessionIds = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
      if (!sessionIds.includes(sessionId)) return false;
      await send("agent.interactions.snapshot", {
        requestId: payload.requestId,
        interactions: interactions.snapshot(),
        events: recentEvents,
        mode: "default",
        autonomyProfile,
        autonomy: autonomyStatus(),
      });
      return true;
    }
    if (payload?.type === "agent.interaction.resolve") {
      try {
        return interactions.resolve(payload).accepted;
      } catch (error) {
        await send("agent.interaction.result", {
          interactionId: payload?.interactionId,
          responseId: payload?.responseId,
          status: "failed",
          reason: error.message,
        });
        return false;
      }
    }
    const applied = await handleRemoteEvent(payload, {
      sessionId,
      adapter,
      executor,
      applyAutonomy,
    });
    if (payload?.type === "agent.message") {
      const message = String(payload.message || "").replace(/[\r\n]+$/g, "");
      if (applied !== false && message) {
        await sendTransientEvent({
          type: "user.text",
          provider: agent,
          text: message,
          eventId: payload.messageId ? `local-message-${payload.messageId}` : undefined,
        });
      }
      await send("agent.message.result", {
        messageId: payload.messageId,
        accepted: applied !== false,
      });
    }
    return applied;
  };

  while (!exited) {
    try {
      await relayClient.connectEvents(handleRemoteEventBound);
    } catch {
      // Stage 9.5 — re-acquire a fresh token before reconnecting. BOTH
      // relayClient.deviceId and relayClient.authToken must be updated.
      try {
        const relayOptions = await buildRelayClientOptions({
          stateDir: ensureStateDir(),
          relayUrl,
          fallbackDeviceId: device.deviceId,
        });
        relayClient.deviceId = relayOptions.deviceId;
        relayClient.setAuthToken(relayOptions.authToken);
        effectiveDeviceId = relayOptions.deviceId;
      } catch (reErr) {
        console.error(`[local-session] relay auth re-acquire failed: code=${reErr?.code || "unknown"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
