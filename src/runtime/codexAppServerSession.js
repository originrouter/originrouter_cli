import process from "node:process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  CODEX_APPROVAL_TIMEOUT_MS,
  CodexAppServerClient,
  REMOTE_INTERACTION_DECISION_TIMEOUT_MS,
  isCodexAppServerAvailable,
} from "../adapters/codex/appServerClient.js";
import { mapCodexAppServerEvent } from "../adapters/codex/eventMapper.js";
import { applyConfiguredPricing } from "../collaboration/configuredPricing.js";
import {
  findCodexTranscript,
  readCodexConversationHistory,
} from "../adapters/codex/jsonlScanner.js";
import {
  createRuntimeEventReporter,
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
import { DEFAULT_DEVICE_ID, DEFAULT_RELAY_URL } from "../constants.js";
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
import { protectOriginrouterCodingEnv } from "./originrouterCodingAuthProxy.js";
import { PendingInteractionRegistry } from "./pendingInteractionRegistry.js";
import {
  displaySafeToolInput,
  toolInputContainsSecret,
} from "./displaySafeToolInput.js";
import {
  AGENT_DETAIL_PROFILES,
  resolveAgentDetailProfile,
} from "./agentDetailProfile.js";
import { AiApprovalReviewer } from "./aiApprovalReviewer.js";
import {
  aiReviewPolicyFromEnvironment,
  aiReviewPolicyFromPayload,
} from "./aiReviewPolicy.js";
import {
  readApprovalPolicyReference,
  readWorkspaceApprovalPolicySafe,
  resolveApprovalPolicySelection,
} from "./approvalPolicyStore.js";

const CODEX_MODES = Object.freeze([
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
]);

const codexApprovalExpiresAt = () =>
  Math.ceil((Date.now() + REMOTE_INTERACTION_DECISION_TIMEOUT_MS) / 1000);

export function createSerialAgentEventQueue(handler) {
  let tail = Promise.resolve();
  return {
    enqueue(event) {
      tail = tail.then(() => handler(event)).catch(() => {});
      return tail;
    },
    drain() {
      return tail;
    },
  };
}

function extractOptions(args) {
  const options = {};
  const prompt = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const take = (key) => {
      options[key] = args[index + 1];
      index += 1;
    };
    if (arg === "--originrouter-relay") take("relay");
    else if (arg === "--originrouter-relay-mode") take("relayMode");
    else if (arg === "--originrouter-device") take("device");
    else if (arg === "--originrouter-session") take("session");
    else if (arg === "--originrouter-conversation") take("conversationId");
    else if (arg === "--originrouter-run") take("runId");
    else if (arg === "--originrouter-workspace") take("workspaceId");
    else if (arg === "--originrouter-title") take("title");
    else if (arg === "--provider") take("provider");
    else if (arg === "--model" || arg === "-m") take("model");
    else if (arg === "--prompt") take("initialMessage");
    else if (arg === "--resume") take("resume");
    else if (arg.startsWith("--resume=")) {
      options.resume = arg.slice("--resume=".length);
    } else if (arg === "--originrouter-autonomy") take("autonomyProfile");
    else if (arg === "--originrouter-policy") take("approvalPolicyReference");
    else if (arg === "--originrouter-detail") take("detailProfile");
    else if (arg === "--originrouter-auto-approve")
      options.autonomyProfile = "guarded";
    else if (arg === "--originrouter-auto-allow") {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...String(args[index + 1] || "").split(","),
      ];
      index += 1;
    } else if (arg.startsWith("--originrouter-autonomy=")) {
      options.autonomyProfile = arg.slice("--originrouter-autonomy=".length);
    } else if (arg.startsWith("--originrouter-detail=")) {
      options.detailProfile = arg.slice("--originrouter-detail=".length);
    } else if (arg.startsWith("--originrouter-auto-allow=")) {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...arg.slice("--originrouter-auto-allow=".length).split(","),
      ];
    } else if (!arg.startsWith("-")) prompt.push(arg);
  }
  if (!options.initialMessage && prompt.length)
    options.initialMessage = prompt.join(" ");
  return options;
}

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

function requestInteractionId(method, params, id) {
  return String(params?.itemId || params?.elicitationId || `${method}:${id}`);
}

export function codexQuestions(params) {
  return {
    questions: (Array.isArray(params?.questions) ? params.questions : [])
      .slice(0, 8)
      .map((question, index) => ({
        id: String(question?.id || `q${index + 1}`).slice(0, 128),
        header: String(question?.header || "Question").slice(0, 64),
        question: String(question?.question || "").slice(0, 2048),
        multiple: Boolean(question?.multiSelect || question?.multiple),
        allow_other: question?.allowOther !== false,
        secret: Boolean(question?.isSecret),
        options: (Array.isArray(question?.options) ? question.options : [])
          .slice(0, 16)
          .map((option, index) => ({
            id: `o${index + 1}`,
            label: String(option?.label || "").slice(0, 128),
            description: String(option?.description || "").slice(0, 512),
          })),
      })),
    auto_resolution_ms: Number.isFinite(params?.autoResolutionMs)
      ? params.autoResolutionMs
      : null,
  };
}

export function codexQuestionResponse(params, response) {
  const answers =
    response?.answers && typeof response.answers === "object"
      ? response.answers
      : {};
  const mapped = {};
  (Array.isArray(params?.questions) ? params.questions : []).forEach(
    (question, index) => {
      const id = String(question?.id || `q${index + 1}`);
      const raw = answers[id];
      mapped[id] = {
        answers: (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(
          String,
        ),
      };
    },
  );
  return { answers: mapped };
}

function decisionFor(action, remember) {
  if (action === "allow" || action === "submit")
    return remember ? "acceptForSession" : "accept";
  if (action === "cancel") return "cancel";
  return "decline";
}

function codexDecisionLabel(decision) {
  if (decision === "accept") return "Allow once";
  if (decision === "acceptForSession") return "Allow for this session";
  if (decision?.acceptWithExecpolicyAmendment)
    return "Allow and apply the suggested command rule";
  if (decision?.applyNetworkPolicyAmendment)
    return "Apply the suggested network rule";
  return null;
}

export function codexCommandApprovalPresentation(params = {}) {
  const available = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : null;
  if (!available) {
    return {
      remember_allowed: true,
      approval_options: undefined,
      default_approval_option: undefined,
    };
  }
  const approvalOptions = available.flatMap((decision, index) => {
    const label = codexDecisionLabel(decision);
    return label ? [{ id: `decision-${index}`, label }] : [];
  });
  return {
    remember_allowed: false,
    approval_options: approvalOptions,
    default_approval_option: approvalOptions[0]?.id,
  };
}

export function codexCommandApprovalDecision(params = {}, resolved = {}) {
  if (resolved.action === "cancel") return "cancel";
  if (resolved.action !== "allow" && resolved.action !== "submit")
    return "decline";
  const available = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : null;
  if (!available) {
    return decisionFor(
      resolved.action,
      Boolean(resolved.response?.remember_for_session),
    );
  }
  const selected = String(resolved.response?.approval_option || "");
  const selectedIndex = /^decision-(\d+)$/.exec(selected)?.[1];
  const decision =
    selectedIndex == null ? null : available[Number(selectedIndex)];
  if (codexDecisionLabel(decision)) return decision;
  return available.find((item) => item === "accept") || "decline";
}

function containsSecretSchema(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.writeOnly || schema.format === "password") return true;
  return Object.values(schema).some(containsSecretSchema);
}

export async function runCodexAppServerSession(rawArgs) {
  const stateDir = ensureStateDir();
  const aiApprovalReviewer = new AiApprovalReviewer({ stateDir });
  const options = extractOptions(rawArgs);
  if (!(await isCodexAppServerAvailable())) {
    throw new Error(
      "Codex app-server is unavailable. Upgrade Codex or use `originrouter codex-terminal`.",
    );
  }

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
  const sessionId = options.session || `codex-${Date.now()}`;
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
  if (willRouteRemoteCoding(config, "codex")) {
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
  let providerResult = await buildAgentProviderEnv("codex", config, {
    provider: options.provider,
    proxyStatus: staticProxyStatusFn(readLocalProxySnapshot()),
    remoteCodingStatus,
  });
  let originrouterCodingProxy = null;
  let localAgentBridge = null;
  let relayViaDaemon = false;
  ({ providerResult, proxy: originrouterCodingProxy } =
    await protectOriginrouterCodingEnv("codex", providerResult, { stateDir }));
  const model =
    options.model ||
    providerResult.env.OPENAI_MODEL ||
    providerResult.provider?.model;
  const pricingModel =
    options.model ||
    providerResult.routes?.main?.model ||
    providerResult.provider?.model ||
    model;
  const sessionTitle = String(options.title || "Codex session")
    .trim()
    .slice(0, 191);
  const client = new CodexAppServerClient();
  const recentEvents = [];
  const runtimeReporter = createRuntimeEventReporter({
    sessionId,
    agentType: "codex",
    title: sessionTitle,
    deviceName: device.displayName || device.host,
    stateDir,
  });
  let threadId = null;
  let transcriptPath = null;
  let currentTurnId = null;
  let currentMode = "default";
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
  let autonomyAllowedScopes = normalizeAutonomyScopes(
    options.autonomyAllowedScopes,
  );
  let autonomyProfile = normalizeAutonomyProfile(
    options.autonomyProfile ||
      (autonomyAllowedScopes.length ? "custom" : "manual"),
  );
  let approvalPolicy = autonomyProfile === "custom" && options.approvalPolicyReference
    ? readApprovalPolicyReference(options.approvalPolicyReference, { stateDir })
    : null;
  let aiReviewPolicy = autonomyProfile === "ai_review"
    ? aiReviewPolicyFromEnvironment()
    : null;
  let stopped = false;
  const activitySnapshot = {
    summary: "",
    firstPromptPreview: "",
    lastMessagePreview: "",
  };
  let stopHeartbeat = () => {};
  const signalHandlers = new Map();
  const syncCatalog = (status) =>
    reportAgentConversationMetadata(
      {
        conversationId: options.conversationId || sessionId,
        agentType: "codex",
        nativeSessionId: threadId,
        title: sessionTitle,
        status,
        workspaceId: options.workspaceId,
        workspaceName: basename(cwd),
        runtime: "codex-app-server",
        provider: providerResult.provider?.name,
        model,
        permissionProfile: autonomyProfile,
        ...activitySnapshot,
      },
      { stateDir },
    ).catch(() => ({ ok: false }));

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
  const agentEventQueue = createSerialAgentEventQueue(sendAgentEvent);
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
  const reportAutonomy = (
    requestId = null,
    { accepted = null, reason = null } = {},
  ) =>
    sendAgentEvent(
      buildAutonomyStatusEvent({
        provider: "codex",
        runtime: "codex-app-server",
        profile: autonomyProfile,
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

  const requestRemoteInteraction = (request) =>
    resolveWithAutonomy({
      request,
      profile: autonomyProfile,
      allowedScopes: autonomyAllowedScopes,
      workspaceRoot: cwd,
      aiReviewer: aiApprovalReviewer,
      aiReviewPolicy,
      runtime: "codex-app-server",
      approvalPolicy,
      workspaceApprovalPolicy,
      stateDir,
      requestInteraction: (item) => interactions.request(item),
      onPolicyObserved: ({ request: item, evaluation }) =>
        sendAgentEvent({
          type: "agent.approval_policy.shadow",
          provider: "codex",
          interactionId: item.interactionId,
          policyEvaluation: evaluation,
        }),
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

  const markInteractionApplied = (resolved) =>
    resolved.autoResolved
      ? Promise.resolve()
      : interactions.markResult(resolved.interactionId, "applied", {
          responseId: resolved.responseId,
        });

  client.onServerRequest(async ({ id, method, params }) => {
    const interactionId = requestInteractionId(method, params, id);
    if (method === "item/tool/requestUserInput") {
      let resolved;
      try {
        resolved = await requestRemoteInteraction(
          buildInteractionRequest({
            provider: "codex",
            runtime: "codex-app-server",
            sessionId,
            interactionId,
            source: INTERACTION_SOURCES.APP_SERVER,
            kind: INTERACTION_KINDS.QUESTIONS,
            title: "Codex needs input",
            prompt: "Answer the questions to continue.",
            payload: codexQuestions(params),
            containsSecret: (params.questions || []).some(
              (question) => question?.isSecret,
            ),
            expiresAt: params.autoResolutionMs
              ? Math.ceil((Date.now() + params.autoResolutionMs) / 1000)
              : codexApprovalExpiresAt(),
          }),
        );
      } catch {
        return { answers: {} };
      }
      await markInteractionApplied(resolved);
      if (resolved.action !== "submit" && resolved.action !== "allow")
        return { answers: {} };
      return codexQuestionResponse(params, resolved.response);
    }

    if (method === "mcpServer/elicitation/request") {
      const isUrl = params.mode === "url";
      const resolved = await requestRemoteInteraction(
        buildInteractionRequest({
          provider: "codex",
          runtime: "codex-app-server",
          sessionId,
          interactionId,
          source: INTERACTION_SOURCES.APP_SERVER,
          kind: isUrl ? INTERACTION_KINDS.URL : INTERACTION_KINDS.FORM,
          title: params.serverName || "MCP request",
          prompt: params.message || "The MCP server needs input.",
          payload: isUrl
            ? { url: params.url || "", server_name: params.serverName || "" }
            : {
                schema: params.requestedSchema || {},
                server_name: params.serverName || "",
              },
          containsSecret: containsSecretSchema(params.requestedSchema),
          expiresAt: codexApprovalExpiresAt(),
        }),
      );
      await markInteractionApplied(resolved);
      if (resolved.action === "submit" || resolved.action === "allow") {
        return {
          action: "accept",
          content: resolved.response?.values || resolved.response || {},
          _meta: null,
        };
      }
      return {
        action: resolved.action === "cancel" ? "cancel" : "decline",
        content: null,
        _meta: null,
      };
    }

    if (
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "execCommandApproval",
        "applyPatchApproval",
      ].includes(method)
    ) {
      const tool =
        method.includes("fileChange") || method.includes("Patch")
          ? "file_change"
          : "command";
      const commandPresentation =
        tool === "command" && !method.startsWith("execCommand")
          ? codexCommandApprovalPresentation(params)
          : { remember_allowed: true };
      const resolved = await requestRemoteInteraction(
        buildInteractionRequest({
          provider: "codex",
          runtime: "codex-app-server",
          sessionId,
          interactionId,
          source: INTERACTION_SOURCES.APP_SERVER,
          kind: INTERACTION_KINDS.PERMISSION,
          title:
            tool === "command"
              ? "Run this command?"
              : "Apply these file changes?",
          prompt: params.reason || "Review this action before continuing.",
          payload: {
            tool,
            command:
              typeof params.command === "string"
                ? params.command.slice(0, 2048)
                : "",
            cwd: String(params.cwd || "").slice(0, 1024),
            file_changes:
              tool === "file_change"
                ? displaySafeToolInput(
                    params.fileChanges || params.changes || {},
                    { maxEncodedLength: 32_768 },
                  )
                : undefined,
            additional_permissions:
              tool === "command"
                ? displaySafeToolInput(params.additionalPermissions || {})
                : undefined,
            network_approval_context:
              tool === "command"
                ? displaySafeToolInput(params.networkApprovalContext || {})
                : undefined,
            ...commandPresentation,
          },
          containsSecret: toolInputContainsSecret(params),
          expiresAt: codexApprovalExpiresAt(),
        }),
      );
      await markInteractionApplied(resolved);
      const legacy =
        method === "execCommandApproval" || method === "applyPatchApproval";
      let decision =
        tool === "command" && !legacy
          ? codexCommandApprovalDecision(params, resolved)
          : decisionFor(
              resolved.action,
              Boolean(resolved.response?.remember_for_session),
            );
      if (legacy) {
        decision = {
          accept: "approved",
          acceptForSession: "approved_for_session",
          decline: "denied",
          cancel: "abort",
        }[decision];
      }
      return { decision };
    }

    if (method === "item/permissions/requestApproval") {
      const resolved = await requestRemoteInteraction(
        buildInteractionRequest({
          provider: "codex",
          runtime: "codex-app-server",
          sessionId,
          interactionId,
          source: INTERACTION_SOURCES.APP_SERVER,
          kind: INTERACTION_KINDS.PERMISSION,
          title: "Grant additional permissions?",
          prompt:
            params.reason || "Codex requested additional sandbox permissions.",
          payload: {
            tool: "permissions",
            cwd: String(params.cwd || "").slice(0, 1024),
            requested: displaySafeToolInput(params.permissions || {}),
            remember_allowed: true,
          },
          containsSecret: toolInputContainsSecret(params.permissions),
          expiresAt: codexApprovalExpiresAt(),
        }),
      );
      await markInteractionApplied(resolved);
      const allowed =
        resolved.action === "allow" || resolved.action === "submit";
      return {
        permissions: allowed
          ? {
              ...(params.permissions?.network
                ? { network: params.permissions.network }
                : {}),
              ...(params.permissions?.fileSystem
                ? { fileSystem: params.permissions.fileSystem }
                : {}),
            }
          : {},
        scope:
          allowed && resolved.response?.remember_for_session
            ? "session"
            : "turn",
      };
    }

    throw new Error(`Unsupported Codex server request: ${method}`);
  });

  client.onEvent((rawEvent) => {
    // The app-server transport is initialized before the managed thread and
    // OriginRouter session exist. Emit one ready event only after thread/start.
    if (rawEvent.type === "codex.initialized") return;
    if (rawEvent.type === "task_started")
      currentTurnId = rawEvent.turn_id || currentTurnId;
    if (rawEvent.type === "task_complete" || rawEvent.type === "turn_aborted")
      currentTurnId = null;
    for (const event of mapCodexAppServerEvent(rawEvent)) {
      void agentEventQueue.enqueue(applyConfiguredPricing(event, {
        provider: providerResult.provider,
        model: pricingModel,
        source: providerResult.source,
      }));
    }
  });

  const sendMessage = async (message, messageId = null) => {
    const text = String(message || "").trim();
    if (!text || !threadId) return false;
    await sendAgentEvent({
      type: "user.text",
      provider: "codex",
      text,
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
    const result = await client.startTurn({
      threadId,
      input: textInput(text),
      collaborationMode: {
        mode: currentMode,
        settings: {
          model,
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
    currentTurnId = result?.turn?.id || currentTurnId;
    return true;
  };

  const stopSession = async (signal = null, code = 0) => {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    await agentEventQueue.drain();
    await interactions.cancelAll("session_stopped");
    await localAgentBridge?.close(
      signal ? "stopped" : code === 0 ? "completed" : "failed",
    );
    localAgentBridge = null;
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
  };

  const handleRemoteEvent = async (payload) => {
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
      await client.updateThreadSettings({
        threadId,
        collaborationMode: {
          mode,
          settings: {
            model,
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      });
      currentMode = mode;
      await reportMode(payload.requestId || null);
      return true;
    }
    if (payload.type === "agent.autonomy.set") {
      const requested = normalizeAutonomyProfile(payload.profile, "");
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
          ? normalizeAutonomyScopes(payload.allowedScopes || payload.allowed_scopes)
          : [];
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
          accepted: false,
          reason: error.code || error.message,
        }));
        return false;
      }
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
      modelProvider: providerResult.env.OPENAI_BASE_URL
        ? {
            id: "originrouter_proxy",
            name: "OriginRouter Route",
            baseUrl: providerResult.env.OPENAI_BASE_URL,
            envKey: "OPENAI_API_KEY",
            wireApi: "responses",
          }
        : null,
    });
    const threadOptions = {
      cwd,
      model,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
    const thread = options.resume
      ? await client.resumeThread(options.resume, threadOptions)
      : await client.startThread({ ...threadOptions, ephemeral: false });
    threadId = thread?.thread?.id;
    if (!threadId)
      throw new Error("Codex app-server did not return a thread id.");
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
      },
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
    relayViaDaemon = await localAgentBridge.start({
      sessionId,
      conversationId: options.conversationId || sessionId,
      runId: options.runId || sessionId,
      agent: "codex",
      title: sessionTitle,
      deviceId: effectiveDeviceId,
      deviceName: device.displayName || device.host,
      cwd,
      workspaceTrusted: true,
      pid: client.child?.pid || process.pid,
      startedAt: new Date().toISOString(),
      nativeSessionId: threadId,
      runtime: "codex-app-server",
      provider: providerResult.provider?.name,
      model,
      permissionProfile: "workspace-write:on-request",
      startedBy: options.resume ? "app-resume" : "local-app-server",
      mode: currentMode,
      modeControl: "supported",
      availableModes: CODEX_MODES,
      autonomyProfile,
      autonomyControl: "supported",
      allowedAutonomyScopes: autonomyAllowedScopes,
      detailProfile: detail.profile,
      detailSource: detail.source,
      transcriptPath,
    });
    stopHeartbeat = startAgentSessionHeartbeat({ sessionId, stateDir });
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
      startedBy: "local-app-server",
      startedAt: new Date().toISOString(),
      status: "running",
    });
    await sendAgentEvent({ type: "agent.ready", provider: "codex" });
    await reportMode();
    await reportAutonomy();
    await reportDetail();
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
