import process from "node:process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  createRuntimeEventReporter,
  reportAgentConversationMetadata,
  startAgentSessionHeartbeat,
} from "../agent/bridgeReporter.js";
import { buildAgentProviderEnv } from "../config/claudeConfig.js";
import { DEFAULT_DEVICE_ID, DEFAULT_RELAY_URL } from "../constants.js";
import { readLocalProxySnapshot, staticProxyStatusFn } from "../proxy/snapshot.js";
import { ensureDevice, ensureStateDir, readConfig } from "../persistence/state.js";
import { buildRelayClientOptions } from "../relay/relayAuthBootstrap.js";
import { RelayClient } from "../relay/relayClient.js";
import { buildProviderConfigEvent } from "../util/providerConfigEvent.js";
import { LocalAgentBridgeClient } from "../local/localAgentBridgeClient.js";
import {
  buildInteractionRequest,
  INTERACTION_KINDS,
  INTERACTION_SOURCES,
} from "./agentInteractionContract.js";
import {
  buildAutonomyStatusEvent,
  invalidAutonomyScopes,
  normalizeAutonomyProfile,
  normalizeAutonomyScopes,
  resolveWithAutonomy,
} from "./agentAutonomyPolicy.js";
import { AsyncMessageQueue } from "./asyncMessageQueue.js";
import {
  claudeTranscriptPathForSession,
  readClaudeConversationHistory,
} from "./claudeConversationHistory.js";
import { mapClaudeSdkMessage } from "./claudeSdkEvents.js";
import { PendingInteractionRegistry } from "./pendingInteractionRegistry.js";
import { protectOriginrouterCodingEnv } from "./originrouterCodingAuthProxy.js";
import { displaySafeToolInput, toolInputContainsSecret } from "./displaySafeToolInput.js";
import {
  AGENT_DETAIL_PROFILES,
  resolveAgentDetailProfile,
} from "./agentDetailProfile.js";
import { AiApprovalReviewer } from "./aiApprovalReviewer.js";

const CLAUDE_MODES = Object.freeze([
  { id: "default", label: "Default" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
  { id: "dontAsk", label: "Don't ask" },
  { id: "bypassPermissions", label: "Bypass permissions" },
]);

const PLAN_APPROVAL_OPTIONS = Object.freeze([
  { id: "default", label: "Implement with normal approvals" },
  { id: "acceptEdits", label: "Implement and accept file edits" },
  { id: "bypassPermissions", label: "Implement without further prompts" },
]);

function extractOriginRouterOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const take = (key) => {
      options[key] = args[index + 1];
      index += 1;
    };
    if (arg === "--originrouter-relay") take("relay");
    else if (arg === "--originrouter-device") take("device");
    else if (arg === "--originrouter-session") take("session");
    else if (arg === "--originrouter-conversation") take("conversationId");
    else if (arg === "--originrouter-run") take("runId");
    else if (arg === "--originrouter-workspace") take("workspaceId");
    else if (arg === "--originrouter-title") take("title");
    else if (arg === "--provider") take("provider");
    else if (arg === "--model") take("model");
    else if (arg === "--fallback-model") take("fallbackModel");
    else if (arg === "--permission-mode") take("permissionMode");
    else if (arg === "--prompt") take("initialMessage");
    else if (arg === "--originrouter-autonomy") take("autonomyProfile");
    else if (arg === "--originrouter-detail") take("detailProfile");
    else if (arg === "--originrouter-auto-approve") options.autonomyProfile = "guarded";
    else if (arg === "--originrouter-auto-allow") {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...String(args[index + 1] || "").split(","),
      ];
      index += 1;
    }
    else if (arg.startsWith("--originrouter-autonomy=")) {
      options.autonomyProfile = arg.slice("--originrouter-autonomy=".length);
    }
    else if (arg.startsWith("--originrouter-detail=")) {
      options.detailProfile = arg.slice("--originrouter-detail=".length);
    }
    else if (arg.startsWith("--originrouter-auto-allow=")) {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...arg.slice("--originrouter-auto-allow=".length).split(","),
      ];
    }
    else if (arg === "--resume") {
      const value = args[index + 1];
      if (value && !value.startsWith("--")) {
        options.resume = value;
        index += 1;
      } else {
        options.resume = true;
      }
    } else if (arg.startsWith("--resume=")) {
      options.resume = arg.slice("--resume=".length);
    }
  }
  return options;
}

function toUserMessage(text) {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}

function safeLaunchMessage(value) {
  return String(value || "").trim().slice(0, 8192);
}

function normalizeRemoteText(data) {
  return String(data || "").replace(/[\r\n]+$/g, "").trim();
}

function permissionResult({ action, input, response, suggestions, reason }) {
  if (action === "allow") {
    return {
      behavior: "allow",
      updatedInput: input && typeof input === "object" ? input : {},
      ...(response?.remember_for_session && Array.isArray(suggestions)
        ? { updatedPermissions: suggestions }
        : {}),
    };
  }
  return {
    behavior: "deny",
    message: reason || "The user denied this action remotely.",
    interrupt: action === "cancel",
  };
}

function questionPayload(input) {
  const questions = Array.isArray(input?.questions) ? input.questions.slice(0, 4) : [];
  return {
    questions: questions.map((question, index) => ({
      id: `q${index + 1}`,
      header: String(question?.header || `Question ${index + 1}`).slice(0, 64),
      question: String(question?.question || "").slice(0, 2048),
      multiple: Boolean(question?.multiSelect),
      allow_other: true,
      options: (Array.isArray(question?.options) ? question.options : []).slice(0, 8).map((option, optionIndex) => ({
        id: `o${optionIndex + 1}`,
        label: String(option?.label || "").slice(0, 128),
        description: String(option?.description || "").slice(0, 512),
        preview: String(option?.preview || "").slice(0, 4096),
      })),
    })),
  };
}

function claudeQuestionAnswers(input, response) {
  const answers = response?.answers && typeof response.answers === "object"
    ? response.answers
    : {};
  const result = {};
  (Array.isArray(input?.questions) ? input.questions : []).slice(0, 4).forEach((question, index) => {
    const raw = answers[`q${index + 1}`];
    const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    result[String(question?.question || `Question ${index + 1}`)] = values.map(String).join(", ");
  });
  return result;
}

async function loadClaudeAgentSdk() {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    throw new Error(
      "Claude Agent SDK is not installed. Run `npm install @anthropic-ai/claude-agent-sdk`.",
    );
  }
}

export async function runClaudeSdkSession(rawArgs) {
  const stateDir = ensureStateDir();
  const aiApprovalReviewer = new AiApprovalReviewer({ stateDir });
  const options = extractOriginRouterOptions(rawArgs);
  const relayUrl = options.relay || process.env.ORIGINROUTER_RELAY || DEFAULT_RELAY_URL;
  const device = ensureDevice(options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID);
  const sessionId = options.session || `claude-${Date.now()}`;
  const cwd = process.cwd();
  const relayOptions = await buildRelayClientOptions({
    stateDir,
    relayUrl,
    fallbackDeviceId: device.deviceId,
  });
  const relayClient = new RelayClient(relayOptions);
  const config = readConfig();
  const detail = resolveAgentDetailProfile({
    config,
    launchOverride: options.detailProfile,
  });
  let providerResult = await buildAgentProviderEnv("claude", config, {
    provider: options.provider,
    proxyStatus: staticProxyStatusFn(readLocalProxySnapshot()),
  });
  let originrouterCodingProxy = null;
  let localAgentBridge = null;
  ({ providerResult, proxy: originrouterCodingProxy } = await protectOriginrouterCodingEnv(
    "claude",
    providerResult,
    { stateDir },
  ));
  const messageQueue = new AsyncMessageQueue();
  const sessionTitle = String(options.title || "Claude session").trim().slice(0, 191);
  const initialMessage = safeLaunchMessage(options.initialMessage);
  if (initialMessage) messageQueue.push(toUserMessage(initialMessage));
  const recentEvents = [];
  const abortController = new AbortController();
  const runtimeReporter = createRuntimeEventReporter({
    sessionId,
    agentType: "claude",
    title: sessionTitle,
    deviceName: device.host,
    stateDir,
  });
  let queryRef = null;
  let claudeSessionId = typeof options.resume === "string" ? options.resume : null;
  let transcriptPath = claudeTranscriptPathForSession(cwd, claudeSessionId);
  let stopped = false;
  let currentMode = options.permissionMode || "default";
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
  let autonomyAllowedScopes = normalizeAutonomyScopes(options.autonomyAllowedScopes);
  let autonomyProfile = normalizeAutonomyProfile(
    options.autonomyProfile || (autonomyAllowedScopes.length ? "custom" : "manual"),
  );
  let pendingModePayload = null;
  let stopHeartbeat = () => {};
  const signalHandlers = new Map();
  const syncCatalog = (status) => reportAgentConversationMetadata({
    conversationId: options.conversationId || sessionId,
    agentType: "claude",
    nativeSessionId: claudeSessionId,
    title: sessionTitle,
    status,
    workspaceId: options.workspaceId,
    workspaceName: basename(cwd),
    runtime: "claude-sdk",
    provider: providerResult.provider?.name,
    model: options.model || providerResult.provider?.model,
    permissionProfile: autonomyProfile,
  }, { stateDir }).catch(() => ({ ok: false }));

  const send = (type, extra = {}) => relayClient.send(type, {
    sessionId,
    localStarted: true,
    ...extra,
  }).catch(() => {});
  const report = (type, extra = {}) => runtimeReporter.report(type, extra);
  const sendAgentEvent = async (event) => {
    const transientEvent = {
      ...event,
      eventId: event.eventId || `ate_${randomUUID()}`,
      createdAt: event.createdAt || Math.floor(Date.now() / 1000),
    };
    recentEvents.push(transientEvent);
    if (recentEvents.length > 100) recentEvents.splice(0, recentEvents.length - 100);
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
      await Promise.all([
        send("agent.interaction.result", result),
        localAgentBridge?.sendEvent({ type: "agent.interaction.result", ...result }),
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
  const reportMode = (requestId = null) => sendAgentEvent({
    type: "agent.mode.status",
    provider: "claude",
    runtime: "claude-sdk",
    mode: currentMode,
    modeControl: "supported",
    availableModes: CLAUDE_MODES,
    requestId,
  });
  const reportAutonomy = (requestId = null) => sendAgentEvent(buildAutonomyStatusEvent({
    provider: "claude",
    runtime: "claude-sdk",
    profile: autonomyProfile,
    allowedScopes: autonomyAllowedScopes,
    requestId,
  }));
  const reportDetail = () => sendAgentEvent({
    type: "agent.detail.status",
    provider: "claude",
    detailProfile: detail.profile,
    detailSource: detail.source,
    detailControl: "read_only",
    availableDetailProfiles: AGENT_DETAIL_PROFILES,
  });
  const applyAutonomy = async (payload) => {
    const requested = normalizeAutonomyProfile(payload?.profile, "");
    if (!requested) return false;
    autonomyProfile = requested;
    autonomyAllowedScopes = requested === "custom"
      ? normalizeAutonomyScopes(payload?.allowedScopes || payload?.allowed_scopes)
      : [];
    await reportAutonomy(payload?.requestId || null);
    return true;
  };
  const applyMode = async (payload) => {
    const mode = String(payload?.mode || "");
    if (!CLAUDE_MODES.some((item) => item.id === mode)) return false;
    if (!queryRef) {
      pendingModePayload = payload;
      return true;
    }
    try {
      await queryRef.setPermissionMode(mode);
      currentMode = mode;
      await reportMode(payload?.requestId || null);
      return true;
    } catch (error) {
      await sendAgentEvent({
        type: "agent.adapter.status",
        provider: "claude",
        state: "mode_change_failed",
        message: error.message,
      });
      return false;
    }
  };

  const markInteractionApplied = (resolved) => interactions.markResult(
    resolved.interactionId,
    "applied",
    { responseId: resolved.responseId },
  );
  const requestInteraction = (request, signal) => resolveWithAutonomy({
    request,
    profile: autonomyProfile,
    allowedScopes: autonomyAllowedScopes,
    workspaceRoot: cwd,
    aiReviewer: aiApprovalReviewer,
    runtime: "claude-sdk",
    requestInteraction: (item) => interactions.request(item, signal),
    onAutoResolved: ({ request: item, resolved }) => sendAgentEvent({
      type: "agent.interaction.auto_resolved",
      provider: "claude",
      interactionId: item.interactionId,
      kind: item.kind,
      title: item.title,
      autonomyProfile,
      autonomyScope: resolved.scope,
      reason: resolved.reason,
      decisionSource: resolved.decisionSource || "autonomy_policy",
      aiReview: resolved.aiReview || null,
      decision: resolved.action,
    }),
  });

  const stopSession = async (signal = null) => {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    abortController.abort();
    messageQueue.close();
    await interactions.cancelAll("session_stopped");
    await localAgentBridge?.close(signal ? "stopped" : "completed");
    localAgentBridge = null;
    await originrouterCodingProxy?.stop().catch(() => {});
    originrouterCodingProxy = null;
    await send("session.exited", { code: 0, signal });
    await report("session.exited", { code: 0, signal });
    await syncCatalog(signal ? "stopped" : "completed");
    await runtimeReporter.flush();
  };

  const handleRemoteEvent = async (payload) => {
    if (!payload) return false;
    if (payload.type === "agent.interactions.snapshot.request") {
      const sessionIds = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
      if (!sessionIds.includes(sessionId)) return false;
      await send("agent.interactions.snapshot", {
        requestId: payload.requestId,
        interactions: interactions.snapshot(),
        events: recentEvents,
        mode: currentMode,
        autonomyProfile,
        autonomy: buildAutonomyStatusEvent({
          provider: "claude",
          runtime: "claude-sdk",
          profile: autonomyProfile,
          allowedScopes: autonomyAllowedScopes,
        }),
      });
      return true;
    }
    if (payload.sessionId !== sessionId) return false;
    if (payload.type === "agent.history.request") {
      let history = { messages: [], nextCursor: null, hasMore: false };
      try {
        history = readClaudeConversationHistory(transcriptPath, {
          beforeCursor: payload.beforeCursor,
          limit: payload.limit,
        });
      } catch (error) {
        await sendAgentEvent({
          type: "agent.adapter.status",
          provider: "claude",
          state: "history_read_failed",
          message: error.message,
        });
      }
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
    if (payload.type === "agent.message" || payload.type === "terminal.input") {
      const text = normalizeRemoteText(payload.message || payload.data);
      if (!text) return false;
      await sendAgentEvent({
        type: "agent.task.started",
        provider: "claude",
        id: payload.messageId || payload.commandId,
      });
      messageQueue.push(toUserMessage(text));
      await sendAgentEvent({
        type: "user.text",
        provider: "claude",
        text,
        eventId: payload.messageId || payload.commandId
          ? `local-message-${payload.messageId || payload.commandId}`
          : undefined,
      });
      return true;
    }
    if (payload.type === "agent.interaction.resolve") {
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
    if (payload.type === "agent.mode.set") {
      return applyMode(payload);
    }
    if (payload.type === "agent.autonomy.set") {
      return applyAutonomy(payload);
    }
    if (payload.type === "terminal.interrupt") {
      await queryRef?.interrupt().catch(() => {});
      return true;
    }
    if (payload.type === "session.stop") {
      await stopSession("SIGTERM");
      return true;
    }
    return false;
  };

  const eventLoop = async () => {
    while (!stopped) {
      try {
        await relayClient.connectEvents((payload) => void handleRemoteEvent(payload));
      } catch {
        if (stopped) break;
        try {
          const refreshed = await buildRelayClientOptions({
            stateDir,
            relayUrl,
            fallbackDeviceId: device.deviceId,
          });
          relayClient.deviceId = refreshed.deviceId;
          relayClient.setAuthToken(refreshed.authToken);
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  };
  void eventLoop();

  const canUseTool = async (toolName, input, toolOptions = {}) => {
    const interactionId = toolOptions.toolUseID || `${toolName}-${Date.now()}`;
    if (toolName === "AskUserQuestion") {
      const resolved = await requestInteraction(buildInteractionRequest({
        provider: "claude",
        runtime: "claude-sdk",
        sessionId,
        interactionId,
        source: INTERACTION_SOURCES.HOOK,
        kind: INTERACTION_KINDS.QUESTIONS,
        title: toolOptions.title || "Claude has questions",
        prompt: toolOptions.description || "Answer the questions to continue.",
        payload: questionPayload(input),
      }), toolOptions.signal).catch(() => ({ action: "cancel", response: {} }));
      if (resolved.interactionId && !resolved.autoResolved) await markInteractionApplied(resolved);
      if (resolved.action !== "submit" && resolved.action !== "allow") {
        return permissionResult({ action: resolved.action, input, reason: "The user canceled the questions." });
      }
      return {
        behavior: "allow",
        updatedInput: {
          ...input,
          answers: claudeQuestionAnswers(input, resolved.response),
        },
      };
    }

    const isPlanConfirmation = toolName === "ExitPlanMode" || toolName === "exit_plan_mode";
    const safeInput = displaySafeToolInput(input);
    const resolved = await requestInteraction(buildInteractionRequest({
      provider: "claude",
      runtime: "claude-sdk",
      sessionId,
      interactionId,
      source: INTERACTION_SOURCES.HOOK,
      kind: isPlanConfirmation ? INTERACTION_KINDS.CONFIRM : INTERACTION_KINDS.PERMISSION,
      title: toolOptions.title || (isPlanConfirmation ? "Implement this plan?" : `${toolName} needs permission`),
      prompt: toolOptions.description || toolOptions.decisionReason || "Review this action before continuing.",
      payload: {
        tool: toolName,
        display_name: toolOptions.displayName || toolName,
        blocked_path: toolOptions.blockedPath || "",
        tool_input: safeInput,
        command: typeof input?.command === "string" ? input.command.slice(0, 8192) : "",
        cwd: typeof input?.cwd === "string" ? input.cwd.slice(0, 1024) : cwd,
        ...(isPlanConfirmation
          ? {
              plan: typeof input?.plan === "string" ? input.plan.slice(0, 65_536) : "",
              approval_options: PLAN_APPROVAL_OPTIONS,
              default_approval_option: "default",
            }
          : {}),
        remember_allowed: Array.isArray(toolOptions.suggestions) && toolOptions.suggestions.length > 0,
      },
      containsSecret: toolInputContainsSecret(input),
    }), toolOptions.signal).catch(() => ({ action: "cancel", response: {} }));
    if (resolved.interactionId && !resolved.autoResolved) await markInteractionApplied(resolved);
    if (
      isPlanConfirmation
      && (resolved.action === "allow" || resolved.action === "submit")
    ) {
      const requestedMode = String(resolved.response?.permission_mode || "default");
      const nextMode = PLAN_APPROVAL_OPTIONS.some((item) => item.id === requestedMode)
        ? requestedMode
        : "default";
      await queryRef?.setPermissionMode(nextMode);
      currentMode = nextMode;
      await reportMode();
    }
    return permissionResult({
      action: resolved.action,
      input,
      response: resolved.response,
      suggestions: toolOptions.suggestions,
    });
  };

  const onElicitation = async (request, { signal }) => {
    const interactionId = request.elicitationId || `claude-mcp-${Date.now()}`;
    const isUrl = request.mode === "url";
    const resolved = await requestInteraction(buildInteractionRequest({
      provider: "claude",
      runtime: "claude-sdk",
      sessionId,
      interactionId,
      source: INTERACTION_SOURCES.APP_SERVER,
      kind: isUrl ? INTERACTION_KINDS.URL : INTERACTION_KINDS.FORM,
      title: request.title || request.displayName || request.serverName || "MCP request",
      prompt: request.description || request.message || "The MCP server needs input.",
      payload: isUrl
        ? { url: request.url || "", server_name: request.serverName || "" }
        : { schema: request.requestedSchema || {}, server_name: request.serverName || "" },
      containsSecret: Boolean(request.requestedSchema?.properties
        && Object.values(request.requestedSchema.properties).some((field) => field?.writeOnly || field?.format === "password")),
    }), signal).catch(() => ({ action: "cancel", response: {} }));
    if (resolved.interactionId && !resolved.autoResolved) await markInteractionApplied(resolved);
    if (resolved.action === "submit" || resolved.action === "allow") {
      return { action: "accept", content: resolved.response?.values || resolved.response || {} };
    }
    return { action: resolved.action === "cancel" ? "cancel" : "decline" };
  };

  const { query } = await loadClaudeAgentSdk();
  await send("session.started", {
    command: "claude",
    args: rawArgs,
    cwd,
    agent: "claude",
    runtime: "claude-sdk",
    executor: "sdk",
    startedBy: "local-sdk",
    providerConfig: buildProviderConfigEvent(providerResult.provider, providerResult.source),
    metadata: { adapter: "claude-sdk", structuredSources: ["claude-agent-sdk"] },
  });
  await report("session.started", { runtime: "claude-sdk", executor: "sdk" });
  stopHeartbeat = startAgentSessionHeartbeat({ sessionId, stateDir });

  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => void stopSession(signal).finally(() => process.exit(signal === "SIGINT" ? 130 : 0));
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    queryRef = query({
      prompt: messageQueue,
      options: {
        cwd,
        env: { ...process.env, ...providerResult.env },
        abortController,
        canUseTool,
        onElicitation,
        permissionMode: currentMode,
        allowDangerouslySkipPermissions: true,
        model: options.model || providerResult.provider?.model,
        fallbackModel: options.fallbackModel || providerResult.provider?.smallFastModel,
        includeHookEvents: true,
        forwardSubagentText: true,
        ...(typeof options.resume === "string" ? { resume: options.resume } : {}),
      },
    });
    localAgentBridge = new LocalAgentBridgeClient({
      stateDir,
      sessionId,
      onCommand: async (payload) => {
        const applied = await handleRemoteEvent(payload);
        if (payload?.type === "agent.message") {
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
      agent: "claude",
      title: sessionTitle,
      deviceId: relayOptions.deviceId,
      deviceName: device.host,
      cwd,
      workspaceTrusted: true,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      nativeSessionId: claudeSessionId,
      runtime: "claude-sdk",
      provider: providerResult.provider?.name,
      model: options.model || providerResult.provider?.model,
      permissionProfile: currentMode,
      startedBy: "local-sdk",
      mode: currentMode,
      modeControl: "supported",
      availableModes: CLAUDE_MODES,
      autonomyProfile,
      autonomyControl: "supported",
      allowedAutonomyScopes: autonomyAllowedScopes,
      detailProfile: detail.profile,
      detailSource: detail.source,
      transcriptPath,
    });
    if (pendingModePayload) {
      const payload = pendingModePayload;
      pendingModePayload = null;
      await applyMode(payload);
    }
    await syncCatalog("running");
    await sendAgentEvent({ type: "agent.ready", provider: "claude" });
    await reportMode();
    await reportAutonomy();
    await reportDetail();
    process.stderr.write("[originrouter] Managed Claude session ready.\n");
    for await (const message of queryRef) {
      for (const event of mapClaudeSdkMessage(message)) {
        if (event.type === "agent.session_id" && event.sessionId) {
          claudeSessionId = event.sessionId;
          transcriptPath = claudeTranscriptPathForSession(cwd, claudeSessionId);
          await localAgentBridge?.update({
            nativeSessionId: claudeSessionId,
            transcriptPath,
          });
          await syncCatalog("running");
        }
        await sendAgentEvent(event);
      }
    }
    if (!stopped) await stopSession(null);
  } catch (error) {
    if (stopped) return;
    await send("session.error", { message: error.message });
    await report("session.error", { message: error.message });
    stopped = true;
    stopHeartbeat();
    messageQueue.close();
    await interactions.cancelAll("session_error");
    await localAgentBridge?.close("failed");
    localAgentBridge = null;
    await originrouterCodingProxy?.stop().catch(() => {});
    originrouterCodingProxy = null;
    await send("session.exited", { code: 1, signal: null });
    await report("session.exited", { code: 1, signal: null });
    await runtimeReporter.flush();
    throw error;
  } finally {
    await originrouterCodingProxy?.stop().catch(() => {});
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    relayClient._aborted = true;
  }
}
