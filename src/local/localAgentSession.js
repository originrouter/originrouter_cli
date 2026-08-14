import process from "node:process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  startAgentSessionHeartbeat,
  createRuntimeEventReporter,
  createTerminalActivityReporter,
  reportAgentConversationMetadata,
  shouldSyncAgentActivitySnapshot,
  startApprovalDecisionPolling,
  updateAgentActivitySnapshot,
} from "../agent/bridgeReporter.js";
import { createAdapter } from "../adapters/createAdapter.js";
import {
  buildAgentProviderEnv,
  remoteCodingRouteTarget,
  willRouteRemoteCoding,
} from "../config/claudeConfig.js";
import { applyConfiguredPricing } from "../collaboration/configuredPricing.js";
import { DEFAULT_DEVICE_ID, DEFAULT_RELAY_URL } from "../constants.js";
import { createExecutor } from "../executors/createExecutor.js";
import {
  appendSessionStart,
  patchSessionExit,
} from "../persistence/sessionLog.js";
import {
  ensureDevice,
  ensureStateDir,
  readConfig,
  readLocalApiConfig,
} from "../persistence/state.js";
import { RemoteCodingProxyManager } from "../proxy/remoteCodingProxyManager.js";
import {
  readLocalProxySnapshot,
  NOOP_REMOTE_CODING_SNAPSHOT,
  snapshotRemoteCodingStatus,
  staticProxyStatusFn,
} from "../proxy/snapshot.js";
import {
  buildAgentRelayPlan,
  normalizeAgentRelayMode,
  relayModeDescription,
} from "../relay/agentRelayPolicy.js";
import { RelayClient } from "../relay/relayClient.js";
import { buildProviderConfigEvent } from "../util/providerConfigEvent.js";
import { PendingInteractionRegistry } from "../runtime/pendingInteractionRegistry.js";
import {
  buildAutonomyStatusEvent,
  invalidAutonomyScopes,
  normalizeAutonomyProfile,
  normalizeAutonomyScopes,
  resolveWithAutonomy,
} from "../runtime/agentAutonomyPolicy.js";
import { AiApprovalReviewer } from "../runtime/aiApprovalReviewer.js";
import {
  aiReviewPolicyFromEnvironment,
  aiReviewPolicyFromPayload,
} from "../runtime/aiReviewPolicy.js";
import {
  readApprovalPolicyReference,
  readWorkspaceApprovalPolicySafe,
  resolveApprovalPolicySelection,
} from "../runtime/approvalPolicyStore.js";
import { protectOriginrouterCodingEnv } from "../runtime/originrouterCodingAuthProxy.js";
import {
  displaySafeToolInput,
  toolInputContainsSecret,
} from "../runtime/displaySafeToolInput.js";
import {
  AGENT_DETAIL_PROFILES,
  resolveAgentDetailProfile,
} from "../runtime/agentDetailProfile.js";
import { LocalAgentBridgeClient } from "./localAgentBridgeClient.js";
import { createTerminalOutputPump } from "./terminalOutputPump.js";

// Fallback mode vocabularies for terminal adapters that do not expose their
// own structured mode controller. Native Claude supplies a Hook-confirmed
// controller through ClaudeAdapter; other terminal runtimes remain read-only.
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
    if (
      arg === "--originrouter-native-config" ||
      arg === "--originrouter-native"
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
  const aiApprovalReviewer = new AiApprovalReviewer({ stateDir });

  const { options, passthrough } = extractOriginRouterOptions(rawArgs);
  const relayConfig = readLocalApiConfig();
  const relayUrl =
    options.relay ||
    process.env.ORIGINROUTER_RELAY ||
    relayConfig.relayUrl ||
    DEFAULT_RELAY_URL;
  const relayMode = normalizeAgentRelayMode(
    options.relayMode || relayConfig.relayMode,
    relayUrl,
  );
  const device = ensureDevice(
    options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID,
  );
  const sessionId = options.session || `${agent}-${Date.now()}`;
  const conversationId = options.conversationId || sessionId;
  const sessionStartedAt = new Date().toISOString();
  const cwd = process.cwd();
  const workspaceApprovalPolicy = readWorkspaceApprovalPolicySafe(cwd);
  let relayPlan = await buildAgentRelayPlan({
    stateDir,
    relayUrl,
    fallbackDeviceId: device.deviceId,
    mode: relayMode,
  });
  let relayClient = relayPlan.enabled ? new RelayClient(relayPlan) : null;
  let effectiveDeviceId = relayPlan.deviceId || device.deviceId;
  if (!relayPlan.enabled) {
    process.stderr.write(
      `[originrouter] ${relayModeDescription(relayPlan)}; local and LAN control remain available.\n`,
    );
  }
  const useNativeConfig = options.nativeConfig === true;
  if (useNativeConfig && options.provider) {
    throw new Error(
      "--provider cannot be combined with --originrouter-native-config",
    );
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
      targetDeviceId: remoteCodingRouteTarget(localConfig, agent),
    });
    const startResult = await remoteCodingProxyManager.start();
    if (!startResult.ok) {
      throw new Error(
        `Failed to start remote-coding relay proxy: ${startResult.error}`,
      );
    }
    remoteCodingStatus = staticProxyStatusFn(
      await snapshotRemoteCodingStatus(remoteCodingProxyManager),
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
    ({ providerResult, proxy: originrouterCodingProxy } =
      await protectOriginrouterCodingEnv(agent, providerResult, { stateDir }));
  }
  const providerEnv = providerResult.env;
  const resolvedProvider = providerResult.provider;
  const providerSource = providerResult.source;
  if (typeof adapter.setRoutedModel === "function") {
    adapter.setRoutedModel(providerEnv.OPENAI_MODEL);
  }
  const baseEnv = { ...process.env, ...providerEnv };
  let exited = false;
  let finalizing = false;
  let shutdownRequested = false;
  let scanTimer = null;
  let signalFallbackTimer = null;
  let stopApprovalPolling = () => {};
  let stopSessionHeartbeat = () => {};
  let localAgentBridge = null;
  let relayViaDaemon = false;
  const autonomySupported = agent === "claude";
  const invalidScopes = invalidAutonomyScopes(options.autonomyAllowedScopes);
  if (invalidScopes.length) {
    throw new Error(`Unknown unattended scope(s): ${invalidScopes.join(", ")}`);
  }
  if (
    options.autonomyProfile &&
    !normalizeAutonomyProfile(options.autonomyProfile, "")
  ) {
    throw new Error(`Unknown unattended profile: ${options.autonomyProfile}`);
  }
  if (
    options.autonomyAllowedScopes?.length &&
    options.autonomyProfile &&
    options.autonomyProfile !== "custom"
  ) {
    throw new Error(
      "--originrouter-auto-allow requires --originrouter-autonomy custom or no explicit profile",
    );
  }
  let autonomyAllowedScopes = autonomySupported
    ? normalizeAutonomyScopes(options.autonomyAllowedScopes)
    : [];
  let autonomyProfile = autonomySupported
    ? normalizeAutonomyProfile(
        options.autonomyProfile ||
          (autonomyAllowedScopes.length ? "custom" : "manual"),
      )
    : "manual";
  let approvalPolicy = autonomySupported && autonomyProfile === "custom" && options.approvalPolicyReference
    ? readApprovalPolicyReference(options.approvalPolicyReference, { stateDir })
    : null;
  let aiReviewPolicy = autonomySupported && autonomyProfile === "ai_review"
    ? aiReviewPolicyFromEnvironment()
    : null;
  if (
    !autonomySupported &&
    (options.autonomyProfile || (options.autonomyAllowedScopes || []).length)
  ) {
    process.stderr.write(
      "warning: native Codex cannot expose structured approval requests; " +
        "unattended settings are ignored. Use `originrouter codex-terminal`.\n",
    );
  }
  const signalHandlers = new Map();

  const send = (type, extra = {}) => {
    if (relayViaDaemon || !relayClient)
      return Promise.resolve({ accepted: false, localOnly: true });
    return relayClient
      .send(type, {
        sessionId,
        localStarted: true,
        ...extra,
      })
      .catch(() => {});
  };
  const runtimeReporter = createRuntimeEventReporter({
    sessionId,
    agentType: agent,
    title: `${agent} session`,
    deviceName: device.displayName || device.host,
    stateDir: ensureStateDir(),
  });
  const report = (type, extra = {}) => {
    if (
      type !== "session.started" &&
      type !== "session.exited" &&
      type !== "session.error" &&
      type !== "agent.event"
    ) {
      return Promise.resolve();
    }
    return runtimeReporter.report(type, extra);
  };
  const recentEvents = [];
  let controlReady = false;
  const activitySnapshot = {
    summary: "",
    firstPromptPreview: "",
    lastMessagePreview: "",
    lastAgentPreview: "",
  };
  let activityLastAt = sessionStartedAt;
  let nativeSessionId = "";
  let catalogSyncTail = Promise.resolve({ ok: true, skipped: true });
  let syncCatalog = () => Promise.resolve({ ok: false, skipped: true });
  const sendTransientEvent = async (event) => {
    event = applyConfiguredPricing(event, {
      provider: resolvedProvider,
      model:
        options.model ||
        providerResult.routes?.main?.model ||
        resolvedProvider?.model,
      source: providerSource,
    });
    const transientEvent = {
      ...event,
      eventId: event.eventId || `ate_${randomUUID()}`,
      createdAt: event.createdAt || Math.floor(Date.now() / 1000),
    };
    if (transientEvent.type === "agent.session_id" && transientEvent.sessionId) {
      nativeSessionId = String(transientEvent.sessionId).slice(0, 191);
    }
    activityLastAt = transientEvent.createdAt || activityLastAt;
    updateAgentActivitySnapshot(activitySnapshot, transientEvent);
    recentEvents.push(transientEvent);
    if (recentEvents.length > 100) {
      recentEvents.splice(0, recentEvents.length - 100);
    }
    const catalogSync = shouldSyncAgentActivitySnapshot(transientEvent)
      ? syncCatalog("running")
      : Promise.resolve();
    if (!controlReady) {
      await catalogSync;
      return;
    }
    await Promise.all([
      send("agent.stream.event", { event: transientEvent }),
      report("agent.event", { event: transientEvent }),
      localAgentBridge?.sendEvent(transientEvent),
      catalogSync,
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
  const autonomyStatus = (requestId = null, { accepted = null, reason = null } = {}) =>
    buildAutonomyStatusEvent({
      provider: agent,
      runtime: agent === "claude" ? "claude-pty" : "codex-pty",
      profile: autonomyProfile,
      allowedScopes: autonomyAllowedScopes,
      approvalPolicy,
      aiReviewPolicy,
      control: autonomySupported ? "supported" : "unsupported",
      requestId,
      accepted,
      reason: reason || (autonomySupported
        ? null
        : "Native Codex does not expose its blocking approval channel. Use originrouter codex-terminal."),
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
    try {
      const nextPolicy = requested === "custom"
        ? resolveApprovalPolicySelection(payload, { stateDir, current: approvalPolicy })
        : null;
      const nextAiReviewPolicy = requested === "ai_review"
        ? aiReviewPolicyFromPayload(payload)
        : null;
      autonomyProfile = requested;
      approvalPolicy = nextPolicy;
      aiReviewPolicy = nextAiReviewPolicy;
      autonomyAllowedScopes = requested === "custom" && !approvalPolicy
        ? normalizeAutonomyScopes(payload?.allowedScopes || payload?.allowed_scopes)
        : [];
      await sendTransientEvent(autonomyStatus(payload?.requestId || null, { accepted: true }));
      return true;
    } catch (error) {
      await sendTransientEvent(autonomyStatus(payload?.requestId || null, {
        accepted: false,
        reason: error.code || error.message,
      }));
      return false;
    }
  };
  const registeredInteractions = new Set();
  const registerInteraction = (event) => {
    const request = normalizePtyInteraction(event, sessionId);
    if (registeredInteractions.has(request.interactionId)) return;
    registeredInteractions.add(request.interactionId);
    const resolve = autonomySupported
      ? resolveWithAutonomy({
          request,
          profile: autonomyProfile,
          allowedScopes: autonomyAllowedScopes,
          approvalPolicy,
          workspaceApprovalPolicy,
          workspaceRoot: cwd,
          stateDir,
          aiReviewer: aiApprovalReviewer,
          aiReviewPolicy,
          runtime: "claude-pty",
          requestInteraction: (item) => interactions.request(item),
          onPolicyObserved: ({ request: item, evaluation }) =>
            sendTransientEvent({
              type: "agent.approval_policy.shadow",
              provider: agent,
              interactionId: item.interactionId,
              policyEvaluation: evaluation,
            }),
        })
      : interactions.request(request);
    void resolve
      .then(async (resolved) => {
        const applied = adapter.resolvePermission({
          callId: resolved.interactionId,
          interactionId: resolved.interactionId,
          decision: permissionDecision(resolved),
          reason: resolved.action,
          action: resolved.action,
          response: resolved.response,
          decisionSource: resolved.decisionSource,
        });
        if (resolved.autoResolved) {
          await sendTransientEvent({
            type: "agent.interaction.auto_resolved",
            provider: agent,
            interactionId: request.interactionId,
            kind: request.kind,
            title: request.title,
            autonomyProfile,
            autonomyScope: resolved.scope,
            reason: applied === false ? "native_interaction_not_pending" : resolved.reason,
            status: applied === false ? "failed" : "applied",
            decision: resolved.action,
            decisionSource: resolved.decisionSource || "autonomy_policy",
            aiReview: resolved.aiReview || null,
            policyEvaluation: resolved.policyEvaluation || null,
          });
        } else {
          await interactions.markResult(
            resolved.interactionId,
            applied === false ? "failed" : "applied",
            {
              responseId: resolved.responseId,
              reason: applied === false ? "native_interaction_not_pending" : "",
            },
          );
        }
        registeredInteractions.delete(resolved.interactionId);
      })
      .catch(() => {
        registeredInteractions.delete(request.interactionId);
      });
  };
  let structuredScanTail = Promise.resolve();
  const drainStructuredEvents = () => {
    const pending = structuredScanTail.then(async () => {
      if (typeof adapter.scanStructuredEvents !== "function") return;
      for (const event of adapter.scanStructuredEvents()) {
        let displayEvent = event;
        if (event.type === "agent.session.start" && event.transcriptPath) {
          await localAgentBridge?.update({
            transcriptPath: event.transcriptPath,
          });
          const {
            transcriptPath: _transcriptPath,
            raw: _raw,
            ...safeEvent
          } = event;
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
            await interactions.markResult(
              interactionId,
              expired ? "expired" : "canceled",
              { reason: event.reason || "native_interaction_resolved" },
            );
            registeredInteractions.delete(interactionId);
          }
        }
        await sendTransientEvent(displayEvent);
      }
    });
    structuredScanTail = pending.catch(() => {});
    return pending;
  };
  const terminalActivityReporter = createTerminalActivityReporter({
    sessionId,
    agentType: agent,
    title: `${agent} local session`,
    deviceName: device.displayName || device.host,
    stateDir: ensureStateDir(),
    reportRuntimeEventFn: (payload) =>
      runtimeReporter.report("terminal.activity", { summary: payload.summary }),
  });
  const terminalOutputPump = createTerminalOutputPump({ write: writeLocal });

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
    terminalOutputPump.stop();
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
    await drainStructuredEvents().catch(() => {});
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
    activityLastAt = exitedAt;
    await syncCatalog(signal ? "stopped" : code === 0 ? "completed" : "failed")
      .catch(() => ({ ok: false }));
    await catalogSyncTail.catch(() => ({ ok: false }));
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
      const applied = handleRemoteEvent(payload, {
        sessionId,
        adapter,
        executor,
      });
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
  const fallbackModeList =
    agent === "codex" ? CODEX_AVAILABLE_MODES : CLAUDE_AVAILABLE_MODES;
  const initialModeStatus =
    typeof adapter.modeStatusEvent === "function"
      ? adapter.modeStatusEvent()
      : buildModeStatusEvent({
          sessionId,
          provider: agent === "codex" ? "codex" : "claude",
          runtime,
          availableModes: fallbackModeList,
        });
  const modeList = initialModeStatus.availableModes;
  syncCatalog = (status) => {
    const snapshot = {
      conversationId,
      agentType: agent,
      nativeSessionId,
      title: `${agent} session`,
      status,
      workspaceId: options.workspaceId,
      workspaceName: basename(cwd),
      runtime: runtime || "native-pty",
      provider: resolvedProvider?.name,
      model: resolvedProvider?.model,
      permissionProfile: autonomyProfile,
      createdAt: sessionStartedAt,
      lastActivityAt: activityLastAt,
      ...activitySnapshot,
    };
    const pending = catalogSyncTail.then(
      () => reportAgentConversationMetadata(snapshot, { stateDir }),
      () => reportAgentConversationMetadata(snapshot, { stateDir }),
    );
    catalogSyncTail = pending.catch(() => ({ ok: false }));
    return pending;
  };
  const started = await executor.start({
    command: launch.command,
    args: launch.args,
    cwd,
    env: { ...baseEnv, ...launch.env },
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
    relayToParentTty: process.stdout.isTTY === true,
    onOutput: (data) => {
      terminalOutputPump.push(data);
      terminalActivityReporter.ingest(data);
      for (const event of adapter.handleOutput(data)) {
        void sendTransientEvent(event);
      }
    },
    onExit: ({ code, signal }) => {
      terminalOutputPump.flush();
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
    providerConfig:
      agent === "claude" && !useNativeConfig
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
    onConnectionChange: (connected) => {
      relayViaDaemon = connected;
    },
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
            eventId:
              payload.messageId || payload.commandId
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
  relayViaDaemon = await localAgentBridge.start({
    sessionId,
    conversationId,
    runId: options.runId || sessionId,
    agent,
    title: `${agent} session`,
    deviceId: effectiveDeviceId,
    deviceName: device.displayName || device.host,
    cwd,
    workspaceTrusted: true,
    pid: started.pid,
    startedAt: sessionStartedAt,
    runtime,
    provider: resolvedProvider?.name,
    model: resolvedProvider?.model,
    permissionProfile: autonomyProfile,
    startedBy: "local-wrapper",
    mode: initialModeStatus.mode,
    modeControl: initialModeStatus.modeControl,
    availableModes: modeList,
    autonomyProfile,
    autonomyControl: autonomySupported ? "supported" : "unsupported",
    allowedAutonomyScopes: autonomyAllowedScopes,
    approvalPolicy: approvalPolicy
      ? {
          id: approvalPolicy.policy.id,
          name: approvalPolicy.policy.name || approvalPolicy.policy.id,
          revision: approvalPolicy.revision,
        }
      : null,
    detailProfile: detail.profile,
    detailSource: detail.source,
    transcriptPath:
      typeof adapter.getTranscriptPath === "function"
        ? adapter.getTranscriptPath()
        : null,
  });
  controlReady = true;
  void syncCatalog("running");
  stopSessionHeartbeat = startAgentSessionHeartbeat({
    sessionId,
    stateDir: ensureStateDir(),
  });

  const requestSignalShutdown = (signal) => {
    if (finalizing || shutdownRequested) return;
    shutdownRequested = true;
    process.exitCode = 1;
    signalFallbackTimer = setTimeout(() => {
      void finalizeSession({ code: null, signal }).finally(() =>
        process.exit(1),
      );
    }, 1000);
    try {
      if (signal === "SIGINT") executor.interrupt();
      else executor.stop();
    } catch {
      void finalizeSession({ code: null, signal }).finally(() =>
        process.exit(1),
      );
    }
  };
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) {
    const handler = () => requestSignalShutdown(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  // Publish the same capability snapshot through direct Relay, the durable
  // activity reporter, and the local daemon registry.
  send("agent.event", {
    event: initialModeStatus,
  });
  report("agent.event", {
    event: initialModeStatus,
  });
  void localAgentBridge?.sendEvent(initialModeStatus);
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
      startedAt: sessionStartedAt,
      status: "running",
    });
  } catch (error) {
    console.error(`[session-log] ${error.message}`);
  }

  if (typeof adapter.scanStructuredEvents === "function") {
    scanTimer = setInterval(() => {
      void drainStructuredEvents();
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
      const history =
        typeof adapter.readConversationHistory === "function"
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
      const sessionIds = Array.isArray(payload.sessionIds)
        ? payload.sessionIds
        : [];
      if (!sessionIds.includes(sessionId)) return false;
      await send("agent.interactions.snapshot", {
        requestId: payload.requestId,
        interactions: interactions.snapshot(),
        events: recentEvents,
        mode:
          typeof adapter.modeStatusEvent === "function"
            ? adapter.modeStatusEvent().mode
            : initialModeStatus.mode,
        modeControl: initialModeStatus.modeControl,
        availableModes: modeList,
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
          eventId: payload.messageId
            ? `local-message-${payload.messageId}`
            : undefined,
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
    if (relayViaDaemon) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!relayClient) {
      relayPlan = await buildAgentRelayPlan({
        stateDir: ensureStateDir(),
        relayUrl,
        fallbackDeviceId: device.deviceId,
        mode: relayMode,
      });
      if (relayPlan.enabled) {
        relayClient = new RelayClient(relayPlan);
        effectiveDeviceId = relayPlan.deviceId || effectiveDeviceId;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
    }
    try {
      await relayClient.connectEvents((payload) => {
        if (!relayViaDaemon) return handleRemoteEventBound(payload);
        return false;
      });
    } catch {
      relayClient = null;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
