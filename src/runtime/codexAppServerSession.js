import { NativeModelControl } from './nativeModelControl.js';
import { CodexTurnState } from '../adapters/codex/turnState.js';
import { RuntimeOutputSampler, codexStreamDelta } from "./runtimeOutputSampler.js";
import { createAgentPermissionStateTracker } from "./agentPermissionStateTracker.js";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  CodexAppServerClient,
  isCodexAppServerAvailable,
} from "../adapters/codex/appServerClient.js";
import { mapCodexAppServerEvent } from "../adapters/codex/eventMapper.js";
import {
  looksLikePlaceholderTitle,
  safeTitleText,
} from "../agent/agentTitleSource.js";
import { applyConfiguredPricing } from "../collaboration/configuredPricing.js";
import { workspaceDisplayPath, isCurrentNativeRename } from "../persistence/agentCatalog.js";
import {
  findCodexTranscript,
  readCodexConversationHistory,
} from "../adapters/codex/jsonlScanner.js";
import {
  createRuntimeEventReporter,
  captureRelayAccountContext,
  reportAgentConversationMetadata,
  shouldSyncAgentActivitySnapshot,
  startAgentSessionHeartbeat,
  updateAgentActivitySnapshot,
} from "../agent/bridgeReporter.js";
import {
  buildAgentProviderEnv,
  remoteCodingRouteTarget,
  willRouteRemoteCoding,
} from "../config/claudeConfig.js";
import { DEFAULT_DEVICE_ID } from "../constants.js";
import {
  agentInteractionGraceMs,
  agentInteractionTimeoutMsFromConfig,
} from "../config/agentInteractionTimeout.js";
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
  applyLaunchSessionModel,
  clearSessionModel,
  getSessionModel,
  directProvidersForTransport,
  modelControlForTransport,
  resolveLaunchModelTarget,
  resolvePricingTarget,
  seedSessionModelFromDeviceRoute,
  setSessionModel,
  validateSessionModelTarget,
} from "../proxy/sessionModels.js";
import {
  NOOP_REMOTE_CODING_SNAPSHOT,
  readLocalProxySnapshot,
  snapshotRemoteCodingStatus,
  staticProxyStatusFn,
} from "../proxy/snapshot.js";
import {
  buildAgentRelayPlan,
  normalizeAgentRelayMode,
  relayModeDescription,
} from "../relay/agentRelayPolicy.js";
import { RelayClient } from "../relay/relayClient.js";
import { resolveRelayEndpoint } from "../relay/relayEndpointSelector.js";
import { LocalAgentBridgeClient } from "../local/localAgentBridgeClient.js";
import { createTelemetryPipeline } from "../telemetry/index.js";
import { codexAgentGatewayConfigArgs } from "../mcp/agentGatewayConfig.js";
import { createDeviceToolApprovalHandler } from "./deviceToolApproval.js";
import { codexInteraction } from "./codexInteraction.js";
import {
  buildAutonomyStatusEvent,
  invalidAutonomyScopes,
  normalizeAutonomyProfile,
  normalizeAutonomyScopes,
  resolveWithAutonomy,
} from "./agentAutonomyPolicy.js";
import { protectOriginrouterCodingEnv } from "./originrouterCodingAuthProxy.js";
import { PendingInteractionRegistry } from "./pendingInteractionRegistry.js";
import { isCollaborationSessionPayload } from "./agentSessionKind.js";
import {
  AGENT_DETAIL_PROFILES,
  resolveAgentDetailProfile,
} from "./agentDetailProfile.js";
import { AiApprovalReviewer } from "./aiApprovalReviewer.js";
import { inheritedPermissionConfiguration, resolveAgentAutonomyConfiguration } from "./agentAutonomyConfiguration.js";
import {
  aiReviewPolicyFromEnvironment,
} from "./aiReviewPolicy.js";
import {
  readApprovalPolicyReference,
  readWorkspaceApprovalPolicySafe,
} from "./approvalPolicyStore.js";
import {
  CODEX_MODES,
  assertNoCodexBypassFlag,
  codexApprovalExpiresAt,
  createSerialAgentEventQueue,
  buildCodexCollaborationMode,
  extractOptions,
  gatewayResponseIdsFromTurnResult,
  requestInteractionId,
  textInput,
  withCodexThreadPermission,
  withCodexTurnPermission,
} from "./codexAppServerPrimitives.js";
import {
  effortLevelsForModel,
  normalizeAgentEffort,
} from "./agentEffort.js";
import {
  loadEffortCatalogue,
  readerEffortLevels,
} from "./modelEffortCatalog.js";
import {
  AGENT_COMMAND_TYPE,
  AGENT_SIDE_CLOSED_EVENT,
  AGENT_SIDE_EVENT,
  AGENT_SIDE_OPENED_EVENT,
  buildCommandResultEvent,
  buildCommandsEvent,
  CODEX_INIT_PROMPT,
  codexSideBoundaryItem,
  COMMAND_KIND_SIDE_CLOSE,
  COMMAND_KIND_SIDE_MESSAGE,
  commandsForSession,
  CODEX_SIDE_DEVELOPER_INSTRUCTIONS,
  normalizeCommandPayload,
} from "../agent/slashCommands.js";

export {
  buildCodexCollaborationMode,
  codexCommandApprovalDecision,
  codexCommandApprovalPresentation,
  codexQuestionResponse,
  codexQuestions,
  createSerialAgentEventQueue,
  gatewayResponseIdsFromTurnResult,
} from "./codexAppServerPrimitives.js";

export async function runCodexAppServerSession(rawArgs) {
  // Refuse before anything is spawned. A session that starts with one of these
  // flags has already lost its approval path, and there is no way to restore it
  // afterwards: the thread would be running with a reviewer we cannot reach.
  assertNoCodexBypassFlag(rawArgs);
  const stateDir = ensureStateDir();
  const relayAccount = captureRelayAccountContext(stateDir);
  const aiApprovalReviewer = new AiApprovalReviewer({ stateDir });
  const options = extractOptions(rawArgs);
  if (options.nativeConfig && options.provider) throw new Error("--provider cannot be combined with --native-config");
  const collaborationWorker = isCollaborationSessionPayload({
    ...options, sessionId: options.session,
  });
  if (!(await isCodexAppServerAvailable())) {
    throw new Error(
      "Codex app-server is unavailable. Upgrade Codex or use `originrouter codex-terminal`.",
    );
  }

  const relayConfig = readLocalApiConfig();
  const configuredRelayUrl =
    options.relay ||
    process.env.ORIGINROUTER_RELAY ||
    relayConfig.relayUrl;
  const { relayUrl } = await resolveRelayEndpoint({ configuredRelayUrl });
  const relayMode = normalizeAgentRelayMode(
    options.relayMode || relayConfig.relayMode,
    relayUrl,
  );
  const device = ensureDevice(
    options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID,
  );
  // Random hex, not a timestamp — see `localAgentSession` for the reasoning.
  // The server's `UNIQUE (session_id)` has no `user_id` in it, so this id has
  // to be globally unique, and a millisecond clock only makes it unique within
  // one machine.
  const sessionId = options.session || `codex-${randomUUID().replaceAll("-", "")}`;
  const cwd = process.cwd();
  const workspaceApprovalPolicy = readWorkspaceApprovalPolicySafe(cwd);
  const startedAt = Date.now();
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
  const config = readConfig();
  const detail = resolveAgentDetailProfile({
    config,
    launchOverride: options.detailProfile,
  });
  let remoteCodingProxyManager = null;
  let remoteCodingStatus = staticProxyStatusFn(NOOP_REMOTE_CODING_SNAPSHOT);
  if (options.nativeConfig !== true && willRouteRemoteCoding(config, "codex")) {
    remoteCodingProxyManager = new RemoteCodingProxyManager({
      stateDir,
      relayUrl,
      deviceId: effectiveDeviceId,
      targetDeviceId: remoteCodingRouteTarget(config, "codex"),
    });
    const started = await remoteCodingProxyManager.start();
    if (!started.ok)
      throw new Error(
        `Failed to start remote-coding relay proxy: ${started.error}`,
      );
    remoteCodingStatus = staticProxyStatusFn(
      await snapshotRemoteCodingStatus(remoteCodingProxyManager),
    );
  }
  let providerResult = options.nativeConfig === true ? { env: {}, provider: null, source: "native-config" } : await buildAgentProviderEnv("codex", config, {
    provider: options.provider,
    // Same contract as the Claude runtime: the credential names the session so
    // the compatibility gateway can apply this session's model override.
    sessionId,
    proxyStatus: staticProxyStatusFn(readLocalProxySnapshot()),
    remoteCodingStatus,
  });
  // Which levels a model supports. The catalogue is where that is said, and
  // it is asked for before the proxy starts, because the proxy is what tells
  // Codex which levels its models have.
  const effortCatalogue = options.nativeConfig === true ? [] : await loadEffortCatalogue({ stateDir });
  let originrouterCodingProxy = null;
  let localAgentBridge = null;
  let relayViaDaemon = false;
  let emitGatewayResponseIds = null;
  if (options.nativeConfig !== true) ({ providerResult, proxy: originrouterCodingProxy } =
    await protectOriginrouterCodingEnv("codex", providerResult, {
      stateDir,
      runId: options.runId,
      // The proxy belongs to this session, and the session's own model
      // override is what the proxy resolves the alias against.
      sessionId,
      // The levels the models have, so the model list Codex reads is the
      // model list the device publishes.
      effortCatalogue,
      onGatewayResponseIds: (ids) => { void emitGatewayResponseIds?.(ids); },
    }));
  const telemetry = createTelemetryPipeline({
    stateDir,
    uploadOwner: options.telemetryOwner === "1",
  });
  // A launch-time --model becomes a session override rather than Codex's own
  // model string: Codex must keep asking for the route alias, or the gateway
  // has nothing to translate. Every transport with a gateway in front of the
  // agent gets this; the ones without one keep the old meaning.
  let effectiveOptions = options;
  let launchModel = null;
  if (modelControlForTransport(providerResult.source) === "supported" && options.model) {
    launchModel = applyLaunchSessionModel(config, stateDir, sessionId, {
      agent: "codex",
      model: options.model,
      provider: options.provider,
      allowedProviders: directProvidersForTransport(providerResult),
    });
    if (!launchModel.applied) {
      process.stderr.write(
        `[originrouter] --model ${options.model} ignored (${launchModel.reason}); `
        + "this session uses the device route.\n",
      );
    }
    effectiveOptions = { ...options, model: undefined };
  }
  let model =
    effectiveOptions.model ||
    providerResult.env.OPENAI_MODEL ||
    providerResult.provider?.model;
  const pricingModel =
    effectiveOptions.model ||
    providerResult.routes?.main?.model ||
    providerResult.provider?.model ||
    model;
  // The title this session starts with: whatever the launcher asked for, or
  // our own placeholder. It is not the end of the story — Codex names the
  // thread itself, and that name is the one a reader wants to see.
  //
  // A title the launcher asked for is only kept when it is not one of our
  // own placeholders: "Codex" in the title slot is the agent's name, not a
  // name for this conversation.
  const requestedTitle = looksLikePlaceholderTitle(options.title, "codex")
    ? ""
    : safeTitleText(options.title);
  let agentTitle = "";
  let titleIsCustom = false;
  const sessionTitle = () => agentTitle || requestedTitle || "Codex session";
  const client = new CodexAppServerClient({
    // The RPC-level backstop for an unanswered approval, derived from the same
    // config value that stamps the interaction's own deadline plus the grace
    // between them. `0` arms no timer — see withApprovalTimeout.
    approvalTimeoutMs: agentInteractionGraceMs(
      agentInteractionTimeoutMsFromConfig(config),
    ),
  });
  const recentEvents = [];
  const runtimeReporter = createRuntimeEventReporter({
    enabled: !collaborationWorker,
    sessionId,
    agentType: "codex",
    // The app-server's thread id, once `thread/start` returns it (line ~985).
    nativeSessionId: () => threadId || "",
    // Read lazily: Codex names the thread partway through the run, and every
    // report after that must carry the name it has now — not the one it had
    // when the reporter was built.
    title: () => sessionTitle(),
    deviceName: device.displayName || device.host,
    workspaceDisplayPath: workspaceDisplayPath(cwd),
    ...relayAccount,
    telemetryQueue: telemetry.queue,
    telemetryUploader: telemetry.uploader,
    telemetryContext: () => ({
      providerSource: providerResult.source,
      providerType: providerResult.provider?.type,
      provider: providerResult.provider?.name,
      model,
      deviceId: effectiveDeviceId,
      conversationId: options.conversationId || sessionId,
      runId: options.runId || sessionId,
      sessionKind: options.sessionKind || (String(options.runId || "").startsWith("acr_") ? "collaboration" : "interactive"),
      taskId: options.taskId || "",
      telemetryOwner: options.telemetryOwner === "1",
      bundleOrigin: String(options.runId || "").startsWith("acr_")
        ? "collaboration_run"
        : "direct_wrapper",
      trainingEligible: options.telemetryOwner === "1",
      controlOrigin: options.controlOrigin || "cli",
    }),
  });
  let threadId = null;
  let transcriptPath = null;
  let currentTurnId = null;
  const nativeTurnState = new CodexTurnState();
  let currentMode = "default";
  const nativeControl = new NativeModelControl({
    enabled: options.nativeConfig, provider: 'codex', runtime: 'codex-app-server', current: () => model,
    load: async () => (await client.request('model/list', {limit: 100})).data.map(item => ({
      id: item.model || item.id, displayName: item.displayName,
      efforts: (item.supportedReasoningEfforts || []).map(level => typeof level === 'string' ? level : level.reasoningEffort || level.effort),
    })),
    apply: async value => {
      if (!threadId) throw new Error('native_session_not_ready');
      await client.updateThreadSettings(withCodexTurnPermission({ threadId, model: value,
        collaborationMode: buildCodexCollaborationMode(currentMode, value, null) }));
      model = value;
    },
  });
  // The side conversation's thread, when one is open. One side per parent,
  // exactly as the TUI holds it; events that arrive with this thread id are
  // routed to the side stream instead of the main transcript.
  let sideThreadId = null;
  let sideTurnId = null;
  const sessionCommands = commandsForSession({
    agent: "codex",
    runtime: "codex-app-server",
    nativeConfig: options.nativeConfig === true,
  });
  // The session's model is a snapshot pinned at birth, not a pointer at the
  // device route: a session with none yet — a fresh one, or a stored session
  // from before sessions carried their own — gets the device's current
  // default written as its own override here.
  let sessionModel = options.nativeConfig === true ? null : getSessionModel(stateDir, sessionId);
  if (options.nativeConfig !== true) sessionModel ??= seedSessionModelFromDeviceRoute(config, stateDir, sessionId, {
    agent: "codex",
    providerResult,
  });
  // The reasoning effort this session runs on, as the App last named it.
  // Null means nobody has chosen one yet: the thread is on the model's own
  // default, and the device says so as soon as it can tell.
  let sessionEffort = null;
  // A level the reader picked before the thread was up. Applied when it is.
  let pendingEffortPayload = null;
  // The model whose levels this session is judged by.
  //
  // Codex runs under a route alias, and the alias is not a model: the model
  // behind it changes while the session runs. The levels belong to the model
  // that answers, so they are read from that one — the reader's own pick
  // first, then the device's route, then the provider's model.
  const sessionEffortModelId = () =>
    sessionModel?.model ||
    providerResult.routes?.main?.model ||
    providerResult.provider?.model ||
    "";
  // The levels that model takes.
  //
  // The reader's own words come first: a model they brought with them is a
  // model the cloud's catalogue says nothing about, and they wrote down what
  // it takes when they configured the provider. Then the catalogue — the
  // coding list the App reads too — and then the table of what we know
  // ourselves.
  //
  // A model none of them knows has no levels we can offer. That is not the
  // runtime's whole vocabulary: a level the model cannot take is a row that
  // fails when it is tapped, and the App does not offer rows that fail.
  const sessionEffortLevels = () => {
    if (options.nativeConfig === true) return nativeControl.efforts();
    const modelId = sessionEffortModelId();
    const declared = readerEffortLevels(config, modelId, providerResult.provider?.name);
    if (declared?.length) return declared;
    return effortLevelsForModel(modelId, effortCatalogue);
  };
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
  const inheritedPermission = inheritedPermissionConfiguration(process.env, { stateDir });
  let autonomyAllowedScopes = normalizeAutonomyScopes(
    options.autonomyAllowedScopes,
  );
  let autonomyProfile = normalizeAutonomyProfile(
    options.autonomyProfile ||
      (autonomyAllowedScopes.length ? "custom" : "manual"),
  );
  let approvalPolicy = inheritedPermission
    ? inheritedPermission.approvalPolicy
    : autonomyProfile === "custom" && options.approvalPolicyReference
      ? readApprovalPolicyReference(options.approvalPolicyReference, { stateDir })
      : null;
  let aiReviewPolicy = inheritedPermission
    ? inheritedPermission.aiReviewPolicy
    : autonomyProfile === "ai_review" ? aiReviewPolicyFromEnvironment() : null;
  if (inheritedPermission) {
    autonomyProfile = inheritedPermission.profile;
    autonomyAllowedScopes = inheritedPermission.allowedScopes;
  }

  let stopped = false;
  const activitySnapshot = {
    summary: "",
    firstPromptPreview: "",
    lastMessagePreview: "",
  };
  let stopHeartbeat = () => {};
  const signalHandlers = new Map();
  const syncCatalog = (status) => collaborationWorker
    ? Promise.resolve({ ok: true, skipped: true })
    : reportAgentConversationMetadata(
      {
        conversationId: options.conversationId || sessionId,
        agentType: "codex",
        nativeSessionId: threadId,
        title: sessionTitle(),
        // The agent's title is not a title somebody chose. It may be replaced
        // by a better one, and it must never displace a rename.
        titleIsCustom,
        status,
        workspaceId: options.workspaceId,
        workspaceName: basename(cwd),
        workspacePath: cwd,
        workspaceDisplayPath: workspaceDisplayPath(cwd),
        runtime: "codex-app-server",
        provider: providerResult.provider?.name,
        model,
        permissionProfile: autonomyProfile,
      permissionRevision: permissionState.revision,
        ...activitySnapshot,
      },
      relayAccount,
    ).catch(() => ({ ok: false }));

  // Codex names the thread itself, and says so: the app-server sends
  // `thread/name/updated` when the name lands. Until then the placeholder
  // stands — which is the truth, and better than a title nobody chose.
  const setAgentTitle = (value) => {
    const name = safeTitleText(value);
    if (!name || name === agentTitle) return false;
    agentTitle = name;
    return true;
  };
  // The agent's name, once it has one, has to reach the local catalog as
  // well: the desktop's rail reads it from there, not from the cloud.
  const publishAgentTitle = async () => {
    await localAgentBridge?.update({
      title: sessionTitle(),
      ...(titleIsCustom ? { titleIsCustom: true } : {}),
    });
    await syncCatalog("running");
  };

  const send = (type, extra = {}) => {
    if (collaborationWorker || relayViaDaemon || !relayClient)
      return Promise.resolve({ accepted: false, localOnly: true });
    return relayClient
      .send(type, {
        sessionId,
        localStarted: true,
        ...extra,
      })
      .catch(() => {});
  };
  const report = (type, extra = {}) => runtimeReporter.report(type, extra);
  const refreshTranscriptPath = async () => {
    if (transcriptPath || !threadId) return transcriptPath;
    transcriptPath = findCodexTranscript({
      cwd,
      startedAt,
      sessionId: threadId,
      originators: null,
    });
    if (transcriptPath) await localAgentBridge?.update({ transcriptPath });
    return transcriptPath;
  };
  const sendAgentEvent = async (event) => {
    await refreshTranscriptPath();
    const transientEvent = {
      ...event,
      // "codex" identifies the runtime, not the routed model provider.
      // Preserve the actual route so collaboration telemetry can join cost,
      // model and gateway facts across processes.
      provider: event.provider && event.provider !== "codex"
        ? event.provider
        : (providerResult.provider?.name || event.provider || "codex"),
      providerType: event.providerType || event.provider_type || providerResult.provider?.type || "",
      model: event.model || model || "",
      eventId: event.eventId || `ate_${randomUUID()}`,
      createdAt: event.createdAt || Math.floor(Date.now() / 1000),
    };
    updateAgentActivitySnapshot(activitySnapshot, transientEvent);
    recentEvents.push(transientEvent);
    if (recentEvents.length > 100)
      recentEvents.splice(0, recentEvents.length - 100);
    await Promise.all([
      send("agent.stream.event", { event: transientEvent }),
      report("agent.event", { event: transientEvent }),
      localAgentBridge?.sendEvent(transientEvent),
      shouldSyncAgentActivitySnapshot(transientEvent)
        ? syncCatalog("running")
        : Promise.resolve(),
    ]);
  };
  aiApprovalReviewer.onTelemetry = (event) => sendAgentEvent({
    ...event,
    provider: event.provider || "originrouter",
  });
  // Deliver samples in the same order as turn lifecycle events, but only to
  // the local daemon; sampled output must not become transcript or audit data.
  let outputSampleSequence = 0;
  const outputSampler = new RuntimeOutputSampler({onChunk:(turnId, text) => enqueueOutputSample(turnId, text),
    onGap:() => { outputSampleSequence += 1; }});
  let queuedOutputSamples = 0;
  const agentEventQueue = createSerialAgentEventQueue((event) => {
    if (event.type === "_supervisor.output") {
      return localAgentBridge?.sendObservation(event.turnId, event.text, event.sequence);
    }
    return sendAgentEvent(event);
  });
  const enqueueOutputSample = (turnId, text) => {
    if (!text) return;
    const sequence = ++outputSampleSequence;
    if (queuedOutputSamples >= 8) return;
    queuedOutputSamples += 1;
    void agentEventQueue.enqueue({ type: "_supervisor.output", turnId, text, sequence })
      .finally(() => { queuedOutputSamples -= 1; });
  };
  emitGatewayResponseIds = async (ids) => {
    const gatewayResponseIds = [...new Set((Array.isArray(ids) ? ids : [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim().slice(0, 255)))];
    if (!gatewayResponseIds.length) return;
    await agentEventQueue.enqueue({
      type: "agent.activity",
      activity: "gateway_response",
      summary: "Codex gateway response received",
      gatewayResponseIds,
      responseId: gatewayResponseIds[0],
      metadata: { gateway_response_id: gatewayResponseIds[0] },
    });
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
        localAgentBridge?.sendEvent({
          type: "agent.interaction.result",
          ...result,
        }),
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
  // The reasoning effort of this session.
  //
  // The device owns this fact: the app-server takes the level on the thread
  // (`thread/settings/update`) and on every turn (`turn/start`), and it
  // spells them the way the protocol does — `none`, `minimal`, `low`,
  // `medium`, `high`, `xhigh`, `max`, `ultra`.
  //
  // The levels it publishes are the *model's* levels, not the protocol's
  // whole vocabulary. The app-server will take any level it is given and
  // send it to the model, and a model that cannot take one answers with an
  // error instead of a run. So the device publishes the levels the model
  // behind the alias actually has, and refuses the rest.
  const reportSessionEffort = (requestId = null, { accepted = null, reason = null } = {}) => {
    const levels = sessionEffortLevels();
    return sendAgentEvent({
      type: "agent.effort.status",
      provider: "codex",
      runtime: "codex-app-server",
      sessionId,
      effort: sessionEffort,
      // A session whose model has no levels we know has nothing to offer:
      // saying `supported` beside an empty list is a contradiction the App
      // would have to resolve by guessing.
      effortControl: levels.length ? "supported" : "unsupported",
      availableEfforts: levels,
      requestId,
      accepted,
      reason,
    });
  };
  const applyEffort = async (payload) => {
    const requested = normalizeAgentEffort(payload?.effort);
    if (!requested) {
      await reportSessionEffort(payload?.requestId || null, {
        accepted: false,
        reason: "effort_level_unknown",
      });
      return false;
    }
    if (!sessionEffortLevels().includes(requested)) {
      await reportSessionEffort(payload?.requestId || null, {
        accepted: false,
        reason: "effort_level_unsupported",
      });
      return false;
    }
    if (!threadId) {
      // The thread is not up yet. The choice is kept and applied when it
      // is, so a reader who picks a level before the session is ready does
      // not have to pick it again.
      pendingEffortPayload = payload;
      return true;
    }
    try {
      // The level rides inside the collaboration mode. The app-server gives
      // the mode precedence over the request's own `effort`, and it replaces
      // the mode's settings wholesale — so a mode that left the level out
      // would clear the one the reader chose.
      await client.updateThreadSettings(withCodexTurnPermission({
        threadId,
        collaborationMode: buildCodexCollaborationMode(currentMode, model, requested),
      }));
      sessionEffort = requested;
      await reportSessionEffort(payload?.requestId || null, { accepted: true });
      return true;
    } catch (error) {
      await reportSessionEffort(payload?.requestId || null, {
        accepted: false,
        reason: "effort_change_failed",
      });
      return false;
    }
  };
  // The levels move under the session when the model does.
  //
  // A model change replaces the model the levels were read from, and the level
  // the reader chose can belong to a model that is no longer running. The
  // device says so: the levels are published again, and a level the new model
  // does not have is dropped rather than left standing on a row the App would
  // keep offering.
  //
  // The status carries no request id: it is a consequence of the model
  // change, not the answer to a command.
  const reconcileEffortWithModel = async () => {
    const levels = sessionEffortLevels();
    if (!sessionEffort || levels.includes(sessionEffort)) {
      await reportSessionEffort();
      return;
    }
    sessionEffort = null;
    if (threadId) {
      try {
        // The mode is replaced wholesale, so a mode with no level in it is
        // how the thread is put back on the model's own default.
        await client.updateThreadSettings(withCodexTurnPermission({
          threadId,
          collaborationMode: buildCodexCollaborationMode(currentMode, model, null),
        }));
      } catch {
        // The thread refused the reset. The status still tells the truth: the
        // session is on no level of its own, and the next turn carries
        // whatever the model does on its own.
      }
    }
    await reportSessionEffort();
  };

  const reportMode = (requestId = null) =>
    sendAgentEvent({
      type: "agent.mode.status",
      provider: "codex",
      runtime: "codex-app-server",
      mode: currentMode,
      modeControl: "supported",
      availableModes: CODEX_MODES,
      requestId,
    });
  // Per-session model selection. Codex keeps asking the proxy for the route
  // alias; the compatibility gateway substitutes the concrete model this
  // session pinned, so a change lands on the next turn with no restart.
  const reportSessionModel = (requestId = null, { accepted = null, reason = null } = {}) =>
    options.nativeConfig === true
      ? sendAgentEvent(nativeControl.status({sessionId, requestId, accepted, reason}))
      : sendAgentEvent({
      type: "agent.model.status",
      provider: "codex",
      runtime: "codex-app-server",
      sessionId,
      model: sessionModel?.model || null,
      modelProvider: sessionModel?.provider || null,
      source: sessionModel ? "session" : "device",
      // Three transports have a place to rewrite the request's model — route
      // mode's compatibility gateway, the cloud's per-session auth proxy, the
      // remote device's relay proxy. The others show what the session runs on
      // but must not offer a change they cannot apply.
      modelControl: modelControlForTransport(providerResult.source),
      requestId,
      accepted,
      reason,
    });
  const applySessionModel = async (payload) => {
    if (options.nativeConfig === true) {
      const result = await nativeControl.set(payload);
      await reportSessionModel(payload?.requestId || null, result);
      if (result.accepted) await reconcileEffortWithModel();
      return result.accepted;
    }
    const requested = String(payload?.model || "").trim();
    const requestedProvider = String(payload?.provider || "").trim();
    try {
      if (!requested) {
        // Clearing resets the session to the device's current default: the
        // override is dropped and the default pinned again in its place, so
        // the session keeps a model of its own. This is allowed on every
        // transport: clearing is the safe direction, and it is how an override
        // written while the session was on route mode is removed after the
        // device moved on.
        clearSessionModel(stateDir, sessionId);
        sessionModel = seedSessionModelFromDeviceRoute(config, stateDir, sessionId, {
          agent: "codex",
          providerResult,
        });
        await reportSessionModel(payload?.requestId || null, { accepted: true });
        // The session is back on the device route, so its levels are the
        // route's model's levels now.
        await reconcileEffortWithModel();
        return true;
      }
      // Refused here, not merely hidden in the App: on a transport with no
      // model-rewrite point there is nowhere for an override to take effect,
      // and accepting it would leave a session that claims a model it does not
      // run on.
      if (modelControlForTransport(providerResult.source) !== "supported") {
        await reportSessionModel(payload?.requestId || null, {
          accepted: false,
          reason: "model_control_unsupported",
        });
        return false;
      }
      const target = requestedProvider
        ? validateSessionModelTarget(config, {
          provider: requestedProvider,
          model: requested,
          allowedProviders: directProvidersForTransport(providerResult),
        })
        : resolveLaunchModelTarget(config, {
          agent: "codex",
          model: requested,
          allowedProviders: directProvidersForTransport(providerResult),
        });
      if (!target.ok) {
        await reportSessionModel(payload?.requestId || null, {
          accepted: false,
          reason: target.reason,
        });
        return false;
      }
      setSessionModel(stateDir, sessionId, {
        agent: "codex",
        provider: target.provider,
        model: target.model,
      });
      sessionModel = { provider: target.provider, model: target.model };
      await reportSessionModel(payload?.requestId || null, { accepted: true });
      // The model changed, so the levels the session can offer changed with
      // it. The App draws the device's list, and a list that still names the
      // old model's levels is a list of rows that fail.
      await reconcileEffortWithModel();
      return true;
    } catch (error) {
      await reportSessionModel(payload?.requestId || null, {
        accepted: false,
        reason: error.message,
      });
      return false;
    }
  };
  const permissionState = createAgentPermissionStateTracker({
    stateDir, sessionId, cwd, deviceId: effectiveDeviceId,
    workspaceId: options.workspaceId, agent: "codex", title: sessionTitle,
    conversationId: options.conversationId || sessionId,
  });
  const reportAutonomy = (
    requestId = null,
    { accepted = null, reason = null } = {},
  ) =>
    sendAgentEvent(
      buildAutonomyStatusEvent({
        provider: "codex",
        runtime: "codex-app-server",
        profile: autonomyProfile,
        autonomyRevision: permissionState.capture({
          profile: autonomyProfile, allowedScopes: autonomyAllowedScopes,
          approvalPolicy, aiReviewPolicy,
        }),
        allowedScopes: autonomyAllowedScopes,
        approvalPolicy,
        aiReviewPolicy,
        requestId,
        accepted,
        reason,
      }),
    );
  const reportDetail = () =>
    sendAgentEvent({
      type: "agent.detail.status",
      provider: "codex",
      detailProfile: detail.profile,
      detailSource: detail.source,
      detailControl: "read_only",
      availableDetailProfiles: AGENT_DETAIL_PROFILES,
    });

  const requestRemoteInteraction = (request, signal) => {
    const reviewPolicyAtRequest = aiReviewPolicy;
    const profileAtRequest = autonomyProfile;
    return resolveWithAutonomy({
      request,
      profile: autonomyProfile,
      allowedScopes: autonomyAllowedScopes,
      workspaceRoot: cwd,
      aiReviewer: aiApprovalReviewer,
      aiReviewPolicy,
      isCurrent: () => profileAtRequest === autonomyProfile && reviewPolicyAtRequest === aiReviewPolicy,
      runtime: "codex-app-server",
      approvalPolicy,
      workspaceApprovalPolicy,
      stateDir,
      requestInteraction: (item) => interactions.request(item, signal),
      onAutoResolved: ({ request: item, resolved }) =>
        sendAgentEvent({
          type: "agent.interaction.auto_resolved",
          provider: "codex",
          interactionId: item.interactionId,
          kind: item.kind,
          title: item.title,
          autonomyProfile,
          autonomyScope: resolved.scope,
          reason: resolved.reason,
          decisionSource: resolved.decisionSource || "autonomy_policy",
          aiReview: resolved.aiReview || null,
          policyEvaluation: resolved.policyEvaluation || null,
          decision: resolved.action,
        }),
    });
  };

  const markInteractionApplied = (resolved) =>
    resolved.autoResolved
      ? Promise.resolve()
      : interactions.markResult(resolved.interactionId, "applied", {
          responseId: resolved.responseId,
        });

  const deviceToolApproval = createDeviceToolApprovalHandler({
    sessionId, provider:"codex", runtime:"codex-app-server", requestInteraction:requestRemoteInteraction,
    markApplied:markInteractionApplied, revision:() => permissionState.revision,
    sendResult:(event) => localAgentBridge?.sendDeviceToolApprovalResult(event) || Promise.resolve(false),
  });

  client.onServerRequest(async ({ id, method, params }) => {
    const interaction = codexInteraction(method, params, {
      sessionId, runtime: "codex-app-server", interactionId: requestInteractionId(method, params, id),
      expiresAt: codexApprovalExpiresAt(),
    });
    if (interaction) {
      let resolved;
      try {
        resolved = await requestRemoteInteraction(interaction.request);
      } catch (error) {
        if (method === "item/tool/requestUserInput") return { answers: {} };
        throw error;
      }
      await markInteractionApplied(resolved);
      return interaction.reply(resolved);
    }

    // Dynamic tools execute in the app-server client, not in the Codex
    // runtime. Managed OriginRouter sessions do not expose arbitrary client
    // tools, so return a typed failure instead of treating it as a user
    // approval or leaking it into the collaboration reply channel.
    if (method === "item/tool/call") {
      return {
        contentItems: [{
          type: "inputText",
          text: "OriginRouter does not expose client-side dynamic tools in managed sessions.",
        }],
        success: false,
      };
    }

    // This request is opt-in upstream, but responding correctly makes a
    // newer Codex app-server harmless if it is enabled by configuration.
    if (method === "currentTime/read") {
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    }

    throw new Error(`Unsupported Codex server request: ${method}`);
  });

  client.onEvent((rawEvent) => {
    // The app-server transport is initialized before the managed thread and
    // OriginRouter session exist. Emit one ready event only after thread/start.
    if (rawEvent.type === "codex.initialized") return;
    // A side conversation is a forked thread of this session. Everything that
    // arrives tagged with its thread id (or the turn running on it) belongs to
    // the side stream, not the main transcript.
    if (isSideEvent(rawEvent)) {
      handleSideEvent(rawEvent);
      return;
    }
    // Codex names the thread itself, a turn or two in, and announces it.
    // This is the conversation's real title, and it is the one the App shows.
    if (rawEvent.type === "codex.notification" && rawEvent.method === "thread/name/updated") {
      const notifiedThreadId = String(rawEvent.params?.threadId || "");
      if (!threadId || !notifiedThreadId || notifiedThreadId === threadId) {
        if (setAgentTitle(rawEvent.params?.threadName))
          void publishAgentTitle();
      }
      return;
    }
    if (['task_started', 'task_complete', 'turn_aborted'].includes(rawEvent.type)) {
      const observed = nativeTurnState.observe(rawEvent, currentTurnId, threadId);
      if (!observed.accepted) return;
      if (rawEvent.type === 'task_started') currentTurnId = observed.currentTurnId;
    }
    if (rawEvent.type === "task_started") {
      outputSampler.reset(currentTurnId);
    }
    if (rawEvent.type === "codex.notification" && rawEvent.method === "item/agentMessage/delta") {
      const delta = codexStreamDelta(rawEvent, currentTurnId, threadId);
      if (delta != null) {
        for (const chunk of outputSampler.add(currentTurnId, delta)) enqueueOutputSample(currentTurnId, chunk);
      }
      return;
    }
    if (rawEvent.type === "task_complete" || rawEvent.type === "turn_aborted") {
      const endingTurn = currentTurnId;
      enqueueOutputSample(endingTurn, outputSampler.flush(endingTurn));
      outputSampler.reset();
      currentTurnId = null;
    }
    for (const event of mapCodexAppServerEvent(rawEvent)) {
      void agentEventQueue.enqueue(applyConfiguredPricing(event, {
        // A session override moves the session onto another provider, so the
        // price table has to follow it — otherwise the session is billed at
        // the device route's rate.
        ...resolvePricingTarget(config, sessionModel, {
          provider: providerResult.provider,
          model: pricingModel,
        }),
        source: providerResult.source,
      }));
    }
  });

  // ---- Side conversation (codex /side, /btw) ----
  //
  // The TUI's `side.rs`, mapped onto one thread of this session: fork the
  // parent thread as ephemeral, pin the side developer instructions on it,
  // inject the boundary prompt so the model knows inherited history is
  // reference-only, and run its turns under the same permission pin. One side
  // per session — opening a second focuses the one that exists, and closing
  // discards it.

  const isSideEvent = (event) => {
    if (!sideThreadId) return false;
    const eventThread = event?.thread_id || event?.params?.threadId;
    if (eventThread === sideThreadId) return true;
    const eventTurn = event?.turn_id || event?.params?.turnId;
    return sideTurnId != null && eventTurn != null && eventTurn === sideTurnId;
  };

  const emitSideEvent = (event) =>
    agentEventQueue.enqueue({
      type: AGENT_SIDE_EVENT,
      provider: "codex",
      sessionId,
      sideThreadId,
      event,
    });

  const handleSideEvent = (rawEvent) => {
    if (rawEvent.type === "task_started") {
      sideTurnId = rawEvent.turn_id || sideTurnId;
    } else if (rawEvent.type === "task_complete" || rawEvent.type === "turn_aborted") {
      if (!rawEvent.turn_id || rawEvent.turn_id === sideTurnId) sideTurnId = null;
    }
    // The text stream of the side thread is streamed like the main one's:
    // deltas ride as text.delta so the panel can paint as it arrives, the
    // completed message closes it out.
    if (rawEvent.type === "codex.notification"
      && rawEvent.method === "item/agentMessage/delta") {
      const delta = codexStreamDelta(rawEvent, sideTurnId, sideThreadId);
      if (delta != null) {
        emitSideEvent({ type: "agent.text.delta", provider: "codex", text: delta });
      }
      return;
    }
    for (const event of mapCodexAppServerEvent(rawEvent)) {
      emitSideEvent(event);
    }
  };

  const startSideTurn = async (text) => {
    const result = await client.startTurn(withCodexTurnPermission({
      threadId: sideThreadId,
      input: textInput(text),
      collaborationMode: buildCodexCollaborationMode(currentMode, model, sessionEffort),
    }));
    sideTurnId = result?.turn?.id || sideTurnId;
    emitSideEvent({ type: "user.text", provider: "codex", text });
  };

  const openSide = async () => {
    if (sideThreadId) return { opened: true, already: true };
    if (!threadId) return { opened: false, reason: "thread_not_ready" };
    // The fork is ephemeral and reads the parent's whole history; the
    // response's turn payload is not needed (`excludeTurns` only skips
    // hydrating the reply, never the inherited context).
    const fork = await client.forkThread(threadId, withCodexThreadPermission({
      ephemeral: true,
      excludeTurns: true,
      developerInstructions: CODEX_SIDE_DEVELOPER_INSTRUCTIONS,
    }));
    const forkedId = fork?.thread?.id;
    if (!forkedId) return { opened: false, reason: "fork_failed" };
    sideThreadId = forkedId;
    sideTurnId = null;
    try {
      await client.injectItems(sideThreadId, [codexSideBoundaryItem()]);
    } catch (error) {
      await client.unsubscribeThread(sideThreadId).catch(() => {});
      sideThreadId = null;
      throw error;
    }
    await agentEventQueue.enqueue({
      type: AGENT_SIDE_OPENED_EVENT,
      provider: "codex",
      sessionId,
      sideThreadId,
      // Honest capability label — the App prints this on the panel header.
      capability: "read_only_tools",
    });
    return { opened: true };
  };

  const closeSide = async () => {
    if (!sideThreadId) return { closed: false };
    const closing = sideThreadId;
    if (sideTurnId) {
      await client.interruptTurn(closing, sideTurnId).catch(() => {});
    }
    await client.unsubscribeThread(closing).catch(() => {});
    sideThreadId = null;
    sideTurnId = null;
    await agentEventQueue.enqueue({
      type: AGENT_SIDE_CLOSED_EVENT,
      provider: "codex",
      sessionId,
      sideThreadId: closing,
    });
    return { closed: true };
  };

  // ---- Slash commands (agent.command) ----

  const commandResult = (command, fields) =>
    buildCommandResultEvent({
      sessionId,
      requestId: command.requestId,
      command: command.name || command.kind,
      ...fields,
    });

  const handleAgentCommand = async (payload) => {
    const command = normalizeCommandPayload(payload);
    // The side channel uses the same wire type; it is not a slash command.
    if (command.kind === COMMAND_KIND_SIDE_CLOSE) {
      // Closing is idempotent: a close that finds no side thread still
      // achieved the state the reader asked for, so it is not a refusal.
      const { closed } = await closeSide();
      await agentEventQueue.enqueue(commandResult(command, {
        accepted: true,
        action: closed ? "side_closed" : "side_already_closed",
      }));
      return true;
    }
    if (command.kind === COMMAND_KIND_SIDE_MESSAGE) {
      if (!command.text) {
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: false, reason: "empty_message",
        }));
        return false;
      }
      const opened = await openSide();
      if (!opened.opened) {
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: false, reason: opened.reason || "side_open_failed",
        }));
        return false;
      }
      await startSideTurn(command.text);
      await agentEventQueue.enqueue(commandResult(command, {
        accepted: true, action: "side_message",
      }));
      return true;
    }

    switch (command.name) {
      case "side":
      case "btw": {
        try {
          const opened = await openSide();
          if (!opened.opened) {
            await agentEventQueue.enqueue(commandResult(command, {
              accepted: false, reason: opened.reason || "side_open_failed",
            }));
            return false;
          }
          await agentEventQueue.enqueue(commandResult(command, {
            accepted: true, action: "side_opened",
          }));
          if (command.args) await startSideTurn(command.args);
          return true;
        } catch (error) {
          await agentEventQueue.enqueue(commandResult(command, {
            accepted: false, reason: String(error?.message || "side_open_failed").slice(0, 512),
          }));
          return false;
        }
      }
      case "compact": {
        if (currentTurnId) {
          await agentEventQueue.enqueue(commandResult(command, {
            accepted: false, reason: "turn_in_progress",
          }));
          return false;
        }
        await client.compactThread(threadId);
        await agentEventQueue.enqueue(commandResult(command, { accepted: true }));
        return true;
      }
      case "init": {
        const accepted = await sendMessage(CODEX_INIT_PROMPT, null, "command");
        await agentEventQueue.enqueue(commandResult(command, { accepted }));
        return accepted;
      }
      case "review": {
        const target = command.args
          ? { type: "custom", instructions: command.args }
          : { type: "uncommittedChanges" };
        const result = await client.request("review/start", {
          threadId,
          target,
          delivery: "inline",
        });
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: Boolean(result?.turn?.id || result),
        }));
        return true;
      }
      case "status": {
        const thread = threadId
          ? await client.readThread(threadId).catch(() => null)
          : null;
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: true,
          action: "status",
          data: {
            threadId,
            model,
            mode: currentMode,
            effort: sessionEffort,
            turnInProgress: Boolean(currentTurnId),
            thread: thread?.thread || null,
          },
        }));
        return true;
      }
      case "usage": {
        const usage = await client.accountUsage().catch((error) => ({
          error: String(error?.message || "usage_read_failed"),
        }));
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: true, action: "usage", data: usage,
        }));
        return true;
      }
      case "diff": {
        const result = await client.gitDiff(cwd);
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: true,
          action: "diff",
          data: { sha: result?.sha || null, diff: String(result?.diff || "") },
        }));
        return true;
      }
      case "mcp": {
        const servers = await client.mcpServerStatus().catch((error) => ({
          error: String(error?.message || "mcp_status_failed"),
        }));
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: true, action: "mcp", data: servers,
        }));
        return true;
      }
      case "goal": {
        // The goal record reduces to its objective text; "no goal" and
        // "just cleared" still answer with a map — a null `data` would be
        // dropped by the result builder and the reader would see nothing.
        const goalText = (record) =>
          typeof record === "string"
            ? record
            : record?.objective ?? record?.text ?? null;
        if (!command.args) {
          const goal = await client.getThreadGoal(threadId).catch(() => null);
          await agentEventQueue.enqueue(commandResult(command, {
            accepted: true,
            action: "goal",
            data: { goal: goalText(goal?.goal) },
          }));
          return true;
        }
        if (command.args === "clear") {
          await client.clearThreadGoal(threadId);
          await agentEventQueue.enqueue(commandResult(command, {
            accepted: true,
            action: "goal_cleared",
            data: { goal: null },
          }));
          return true;
        }
        const result = await client.setThreadGoal(threadId, {
          objective: command.args,
          status: "active",
          origin: { type: "user" },
        });
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: true,
          action: "goal_set",
          data: { goal: goalText(result?.goal) ?? command.args },
        }));
        return true;
      }
      case "rename": {
        const nextTitle = safeTitleText(command.args);
        if (!nextTitle || !threadId) {
          await agentEventQueue.enqueue(commandResult(command, {
            accepted: false, reason: "missing_name",
          }));
          return false;
        }
        if (!isCurrentNativeRename(relayAccount.stateDir, "codex", threadId, nextTitle, payload)) return false;
        await client.setThreadName(threadId, nextTitle);
        titleIsCustom = true;
        setAgentTitle(nextTitle);
        void publishAgentTitle();
        await agentEventQueue.enqueue(commandResult(command, { accepted: true }));
        return true;
      }
      case "ps": {
        const page = await client.listBackgroundTerminals(threadId).catch(() => null);
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: true,
          action: "terminals",
          data: { terminals: page?.data || [] },
        }));
        return true;
      }
      case "stop": {
        const page = await client.listBackgroundTerminals(threadId).catch(() => null);
        const terminals = page?.data || [];
        let terminated = 0;
        for (const terminal of terminals) {
          const result = await client
            .terminateBackgroundTerminal(threadId, terminal.processId)
            .catch(() => null);
          if (result?.terminated) terminated += 1;
        }
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: true,
          action: "terminals_stopped",
          data: { terminated, total: terminals.length },
        }));
        return true;
      }
      default: {
        await agentEventQueue.enqueue(commandResult(command, {
          accepted: false, reason: "unsupported",
        }));
        return false;
      }
    }
  };

  const sendMessage = async (message, messageId = null, origin = null) => {
    const text = String(message || "").trim();
    if (!text || !threadId) return false;
    if (!currentTurnId) {
      await sendAgentEvent({
        type: "agent.task.started",
        provider: "codex",
        id: messageId || `turn:${Date.now()}`,
      });
    }
    await sendAgentEvent({
      type: "user.text",
      provider: "codex",
      text,
      ...(origin === "supervisor" ? { origin: "supervisor" } : {}),
      eventId: messageId ? `local-message-${messageId}` : undefined,
    });
    if (currentTurnId) {
      await client.request("turn/steer", {
        threadId,
        expectedTurnId: currentTurnId,
        input: textInput(text),
      });
      return true;
    }
    // Re-pin on every turn. `turn/start` documents all three permission fields
    // as applying "for this turn and subsequent turns", so the thread carries
    // forward whatever the last request set — and Codex itself upgrades an
    // omitted `approvalsReviewer` to its Guardian subagent when the model
    // requires auto-review. Sending them here is what keeps the approval path
    // pointed at the App for the whole session, not just its first request.
    const result = await client.startTurn(withCodexTurnPermission({
      threadId,
      input: textInput(text),
      // The level the reader chose rides inside the collaboration mode, which
      // is the only place the app-server reads it from when a mode is set.
      // A turn that starts right after a change must be on the new level
      // rather than on the thread's older one.
      collaborationMode: buildCodexCollaborationMode(currentMode, model, sessionEffort),
    }));
    currentTurnId = nativeTurnState.acknowledgeStart(result?.turn?.id, currentTurnId);
    const gatewayResponseIds = gatewayResponseIdsFromTurnResult(result);
    if (gatewayResponseIds.length) {
      await sendAgentEvent({
        type: "agent.activity",
        provider: "codex",
        activity: "gateway_response",
        summary: "Codex gateway response received",
        gatewayResponseIds,
        responseId: gatewayResponseIds[0],
        metadata: { gateway_response_id: gatewayResponseIds[0] },
      });
    }
    return true;
  };

  const stopSession = async (signal = null, code = 0) => {
    if (stopped) return;
    stopped = true;
    outputSampler.reset();
    deviceToolApproval.close();
    stopHeartbeat();
    await agentEventQueue.drain();
    await interactions.cancelAll("session_stopped");
    await localAgentBridge?.close(
      signal ? "stopped" : code === 0 ? "completed" : "failed",
    );
    localAgentBridge = null;
    // The side thread is ephemeral: its turns are interrupted and the thread
    // is unsubscribed here, so nothing of it is left running after the session.
    if (sideThreadId) {
      const closing = sideThreadId;
      sideThreadId = null;
      if (sideTurnId)
        await client.interruptTurn(closing, sideTurnId).catch(() => {});
      sideTurnId = null;
      await client.unsubscribeThread(closing).catch(() => {});
    }
    if (currentTurnId && threadId)
      await client.interruptTurn(threadId, currentTurnId).catch(() => {});
    client.disconnect();
    await remoteCodingProxyManager?.stop().catch(() => {});
    await originrouterCodingProxy?.stop().catch(() => {});
    originrouterCodingProxy = null;
    try {
      patchSessionExit({
        sessionId,
        status: "exited",
        code,
        signal,
        exitedAt: new Date().toISOString(),
      });
    } catch {}
    await send("session.exited", { code, signal });
    await report("session.exited", { code, signal });
    await syncCatalog(signal ? "stopped" : code === 0 ? "completed" : "failed");
    await runtimeReporter.flush();
    await telemetry.uploader.flush().catch(() => {});
    telemetry.queue.close();
  };

  const handleRemoteEvent = async (payload) => {
    if (payload?.type === "agent.device_tool.approval") return deviceToolApproval.start(payload);
    if (payload?.type === "agent.device_tool.cancel") return deviceToolApproval.cancel(payload.requestId);
    if (!payload) return false;
    if (payload.type === "agent.interactions.snapshot.request") {
      const sessionIds = Array.isArray(payload.sessionIds)
        ? payload.sessionIds
        : [];
      if (!sessionIds.includes(sessionId)) return false;
      await send("agent.interactions.snapshot", {
        requestId: payload.requestId,
        interactions: interactions.snapshot(),
        events: recentEvents,
        mode: currentMode,
        commands: sessionCommands,
        // The wire fact is the thread's liveness, not its id — the App
        // answers sideOpen from this and never needs the thread id itself.
        sideOpen: Boolean(sideThreadId),
        sideCapability: "read_only_tools",
        autonomyProfile,
        autonomy: buildAutonomyStatusEvent({
          provider: "codex",
          runtime: "codex-app-server",
          profile: autonomyProfile,
          allowedScopes: autonomyAllowedScopes,
        }),
      });
      return true;
    }
    if (payload.sessionId !== sessionId) return false;
    if (payload.type === AGENT_COMMAND_TYPE) {
      return handleAgentCommand(payload);
    }
    if (payload.type === "agent.history.request") {
      await refreshTranscriptPath();
      const history = readCodexConversationHistory(transcriptPath, {
        beforeCursor: payload.beforeCursor,
        limit: payload.limit,
      });
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
      return sendMessage(
        payload.message || payload.data,
        payload.messageId || payload.commandId || null,
        payload.origin,
      );
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
      const mode = String(payload.mode || "");
      if (!CODEX_MODES.some((item) => item.id === mode) || !threadId)
        return false;
      // The permission pin rides along: `thread/settings/update` replaces the
      // values it carries, so a settings update that named only the
      // collaboration mode would leave the thread's approvals wherever the last
      // turn put them.
      //
      // The reasoning level rides along too, for the same reason: a mode
      // replaces the previous mode's settings, so a mode that left the level
      // out would clear the one the reader chose.
      await client.updateThreadSettings(withCodexTurnPermission({
        threadId,
        collaborationMode: buildCodexCollaborationMode(mode, model, sessionEffort),
      }));
      currentMode = mode;
      await reportMode(payload.requestId || null);
      return true;
    }
    if (payload.type === "agent.model.set") {
      return applySessionModel(payload);
    }
    if (payload.type === "agent.effort.set") {
      return applyEffort(payload);
    }
    if (payload.type === "agent.autonomy.set") {
      try {
        const next = resolveAgentAutonomyConfiguration(payload, { stateDir, currentPolicy: approvalPolicy });
        permissionState.capture(next, { changed: true });
        autonomyProfile = next.profile;
        approvalPolicy = next.approvalPolicy;
        aiReviewPolicy = next.aiReviewPolicy;
        autonomyAllowedScopes = next.allowedScopes;
        // The profile is enforced by our broker, so the local switch above is
        // the one that decides anything. The pin is pushed as well: it is what
        // the profile is supposed to mean at the thread level (see
        // withCodexTurnPermission), and it repairs a thread written by an
        // older client. A failed push does not undo the profile — the state is
        // already local and authoritative — so it is reported, not returned.
        if (threadId) {
          await client.updateThreadSettings(withCodexTurnPermission({
            threadId,
          })).catch((error) => {
            void sendAgentEvent({
              type: "agent.adapter.status",
              provider: "codex",
              state: "permission_pin_failed",
              message: error.message,
            });
          });
        }
        await reportAutonomy(payload.requestId || null, { accepted: true });
        return true;
      } catch (error) {
        await sendAgentEvent(buildAutonomyStatusEvent({
          provider: "codex",
          runtime: "codex-app-server",
          profile: autonomyProfile,
          allowedScopes: autonomyAllowedScopes,
          approvalPolicy,
          requestId: payload.requestId || null,
          aiReviewPolicy,
          accepted: false,
          reason: error.code || error.message,
        }));
        return false;
      }
    }
    if (payload.type === "agent.supervisor.interrupt") {
      if (!threadId || !currentTurnId || payload.turnId !== currentTurnId) return false;
      await client.interruptTurn(threadId, currentTurnId);
      return true;
    }
    if (payload.type === "terminal.interrupt" && currentTurnId) {
      await client.interruptTurn(threadId, currentTurnId);
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
      if (relayViaDaemon) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!relayClient) {
        relayPlan = await buildAgentRelayPlan({
          stateDir,
          relayUrl,
          fallbackDeviceId: device.deviceId,
          mode: relayMode,
        });
        if (!relayPlan.enabled) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        relayClient = new RelayClient(relayPlan);
        effectiveDeviceId = relayPlan.deviceId || effectiveDeviceId;
      }
      try {
        await relayClient.connectEvents((payload) => {
          if (!relayViaDaemon) void handleRemoteEvent(payload);
        });
      } catch {
        if (stopped) break;
        relayClient = null;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  };

  try {
    await client.connect({
      cwd,
      env: { ...process.env, ...providerResult.env },
      configArgs: [
        ...(String(options.runId || "").startsWith("acr_") ? codexAgentGatewayConfigArgs(sessionId, {stateDir}) : []),
        ...codexAgentGatewayConfigArgs(sessionId, {deviceTools:true,stateDir}),
      ],
      modelProvider: options.nativeConfig !== true && (providerResult.env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL)
        ? {
            id: "originrouter_proxy",
            name: "OriginRouter Route",
            baseUrl: providerResult.env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL,
            envKey: "OPENAI_API_KEY",
            wireApi: "responses",
          }
        : null,
    });
    // The thread-level pin. `thread/resume` takes the same fields, and a
    // resumed thread inherits whatever settings it was last written with, so
    // both paths send the full set rather than only the freshly started one.
    const threadOptions = withCodexThreadPermission({ cwd, model });
    const thread = options.resume
      ? await client.resumeThread(options.resume, threadOptions)
      : await client.startThread({ ...threadOptions, ephemeral: false });
    threadId = thread?.thread?.id;
    if (!threadId)
      throw new Error("Codex app-server did not return a thread id.");
    // A resumed thread already carries its name, and a fresh one may too.
    // The App-server answers `thread/start` and `thread/resume` with the
    // thread's own metadata, name included — so the title a conversation
    // had before it was closed is available the moment it is reopened.
    setAgentTitle(thread?.thread?.name);
    // Codex may select its configured default model when thread/start omits
    // one. Collaboration-mode settings require that resolved model to be an
    // explicit string, so retain the value returned by the App Server before
    // issuing thread/settings/update or turn/start.
    model = model || thread?.model || thread?.thread?.model;
    if (!model)
      throw new Error("Codex app-server did not return a resolved model.");
    await refreshTranscriptPath();

    await send("session.started", {
      command: "codex app-server",
      args: rawArgs,
      cwd,
      agent: "codex",
      runtime: "codex-app-server",
      executor: "app-server",
      startedBy: options.resume ? "app-resume" : "local-app-server",
    });
    await report("session.started", {
      runtime: "codex-app-server",
      executor: "app-server",
    });
    localAgentBridge = new LocalAgentBridgeClient({
      stateDir,
      sessionId,
      onConnectionChange: (connected) => {
        relayViaDaemon = connected;
        // The daemon relays for this session now; the wrapper's own socket
        // would only keep the device "online" while ignoring every frame.
        // The event loop opens a fresh one if the daemon goes away.
        if (connected && relayClient) {
          relayClient.disconnect();
          relayClient = null;
        }
      },
      onCommand: async (payload) => {
        try {
          const applied = await handleRemoteEvent(payload);
          if (payload?.type === "agent.supervisor.interrupt") {
            await localAgentBridge?.sendEvent({
              type: "agent.recovery.interrupt_result", requestId: payload.requestId,
              turnId: payload.turnId, accepted: applied !== false,
            });
          }
          if (payload?.type === "agent.message") {
            await localAgentBridge?.sendEvent({
              type: "agent.message.result",
              messageId: payload.messageId || payload.commandId,
              accepted: applied !== false,
            });
          }
          return applied;
        } catch (error) {
          if (payload?.type === "agent.supervisor.interrupt") {
            await localAgentBridge?.sendEvent({
              type: "agent.recovery.interrupt_result", requestId: payload.requestId,
              turnId: payload.turnId, accepted: false,
            });
            return false;
          }
          const reason = String(error?.code || error?.message || "agent_command_failed")
            .slice(0, 512);
          await localAgentBridge?.sendEvent({
            type: "agent.task.failed",
            commandType: String(payload?.type || "unknown").slice(0, 64),
            messageId: payload?.messageId || payload?.commandId,
            error: reason,
          });
          if (payload?.type === "agent.message") {
            await localAgentBridge?.sendEvent({
              type: "agent.message.result",
              messageId: payload.messageId || payload.commandId,
              accepted: false,
              reason,
            });
          }
          return false;
        }
      },
    });
    relayViaDaemon = await localAgentBridge.start({
      nativeConfig: options.nativeConfig === true,
      sessionId,
      sessionKind: collaborationWorker ? "collaboration" : "interactive",
      conversationId: options.conversationId || sessionId,
      runId: options.runId || sessionId,
      agent: "codex",
      title: sessionTitle(),
      titleIsCustom: Boolean(requestedTitle && !agentTitle),
      deviceId: effectiveDeviceId,
      deviceName: device.displayName || device.host,
      cwd,
      workspaceTrusted: true,
      pid: client.child?.pid || process.pid,
      startedAt: new Date().toISOString(),
      nativeSessionId: threadId,
      runtime: "codex-app-server",
      supportsRuntimeRecovery: true,
      supportsDeviceTools: true,
      provider: providerResult.provider?.name,
      model,
      permissionProfile: "workspace-write:on-request",
      startedBy: collaborationWorker ? "collaboration-runtime"
        : options.resume ? "app-resume" : "local-app-server",
      mode: currentMode,
      modeControl: "supported",
      availableModes: CODEX_MODES,
      commandMenu: sessionCommands,
      autonomyProfile,
      autonomyControl: "supported",
      allowedAutonomyScopes: autonomyAllowedScopes,
      detailProfile: detail.profile,
      detailSource: detail.source,
      transcriptPath,
    });
    stopHeartbeat = collaborationWorker
      ? () => {}
      : startAgentSessionHeartbeat({ sessionId, ...relayAccount });
    await syncCatalog("running");
    appendSessionStart({
      sessionId,
      deviceId: effectiveDeviceId,
      agent: "codex",
      command: "codex app-server",
      args: rawArgs,
      cwd,
      pid: client.child?.pid,
      executor: "app-server",
      runtime: "codex-app-server",
      startedBy: collaborationWorker ? "collaboration-runtime" : "local-app-server",
      startedAt: new Date().toISOString(),
      status: "running",
    });
    await sendAgentEvent({ type: "agent.ready", provider: "codex" });
    // The session's command list is its own, built when the session came up.
    // Late joiners get the same list again in the interactions snapshot.
    await sendAgentEvent(buildCommandsEvent({
      sessionId,
      provider: "codex",
      commands: sessionCommands,
    }));
    await reportMode();
    await reportAutonomy();
    await reportDetail();
    // The session states its model as soon as it is ready. A session nobody
    // has touched yet still answers on the device route, and the App needs
    // to hear that — including whether this transport can change it — before
    // it can offer a choice.
    await nativeControl.refresh();
    await reportSessionModel();
    // And the effort it runs on. A session nobody has put on a level yet is
    // on the model's own default, and saying so is what lets the App offer
    // the choice at all.
    await reportSessionEffort();
    if (pendingEffortPayload) {
      const payload = pendingEffortPayload;
      pendingEffortPayload = null;
      await applyEffort(payload);
    }
    process.stderr.write("[originrouter] Managed Codex session ready.\n");
    void eventLoop();
    if (options.initialMessage) await sendMessage(options.initialMessage);

    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
      const handler = () =>
        void stopSession(signal).finally(() =>
          process.exit(signal === "SIGINT" ? 130 : 0),
        );
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    const appServerExit = await new Promise((resolve, reject) => {
      client.child?.once("exit", (code, signal) => resolve({ code, signal }));
      client.child?.once("error", reject);
    });
    if (!stopped) {
      const exitCode = appServerExit?.code ?? (appServerExit?.signal ? 1 : 0);
      await stopSession(appServerExit?.signal ?? null, exitCode);
      if (exitCode != 0) process.exitCode = exitCode;
    }
  } catch (error) {
    if (!stopped) {
      await send("session.error", { message: error.message });
      await report("session.error", { message: error.message });
      await stopSession(null, 1);
    }
    throw error;
  } finally {
    await originrouterCodingProxy?.stop().catch(() => {});
    for (const [signal, handler] of signalHandlers)
      process.off(signal, handler);
    if (relayClient) relayClient._aborted = true;
  }
}
