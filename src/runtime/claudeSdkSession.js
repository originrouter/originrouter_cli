import process from "node:process";
import { buildAgentProviderEnv, maskSecret } from "../config/claudeConfig.js";
import { DEFAULT_DEVICE_ID, DEFAULT_RELAY_URL } from "../constants.js";
import { readLocalProxySnapshot, staticProxyStatusFn } from "../proxy/snapshot.js";
import { ensureDevice, ensureStateDir, readConfig } from "../persistence/state.js";
import { buildRelayClientOptions } from "../relay/relayAuthBootstrap.js";
import { RelayClient } from "../relay/relayClient.js";
import { buildProviderConfigEvent } from "../util/providerConfigEvent.js";
import { AsyncMessageQueue } from "./asyncMessageQueue.js";
import { mapClaudeSdkMessage } from "./claudeSdkEvents.js";

function extractOriginRouterOptions(args) {
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
    if (arg === "--provider") {
      options.provider = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--resume") {
      options.resume = args[index + 1];
      if (options.resume && !options.resume.startsWith("--")) {
        index += 1;
      } else {
        options.resume = true;
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      options.resume = arg.slice("--resume=".length);
      continue;
    }
    if (arg === "--model") {
      options.model = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--fallback-model") {
      options.fallbackModel = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--permission-mode") {
      options.permissionMode = args[index + 1];
      index += 1;
      continue;
    }
    passthrough.push(arg);
  }

  return { options, passthrough };
}

function toUserMessage(text) {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: text,
    },
  };
}

function normalizeRemoteText(data) {
  return String(data || "").replace(/[\r\n]+$/g, "").trim();
}

function createPermissionResult(approved, input, reason) {
  if (approved) {
    return {
      behavior: "allow",
      updatedInput: input && typeof input === "object" ? input : {},
    };
  }
  return {
    behavior: "deny",
    message: reason || "The user denied this tool use remotely. Stop and wait for the user to tell you how to proceed.",
  };
}

async function loadClaudeAgentSdk() {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch (error) {
    throw new Error(
      "Claude Agent SDK is not installed. Run `npm install @anthropic-ai/claude-agent-sdk` before using `originrouter claude-sdk`."
    );
  }
}

export async function runClaudeSdkSession(rawArgs) {
  ensureStateDir();

  const { options } = extractOriginRouterOptions(rawArgs);
  const relayUrl = options.relay || process.env.ORIGINROUTER_RELAY || DEFAULT_RELAY_URL;
  const device = ensureDevice(options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID);
  const sessionId = options.session || `claude-sdk-${Date.now()}`;
  const cwd = process.cwd();
  // Stage 9.5 — when ORIGINROUTER_RELAY_AUTH=on, acquire a Surety token
  // and use the effective deviceId (from coding-key.json).
  let relayClient;
  let effectiveDeviceId;
  try {
    const relayOptions = await buildRelayClientOptions({
      stateDir: ensureStateDir(),
      relayUrl,
      fallbackDeviceId: device.deviceId,
    });
    relayClient = new RelayClient(relayOptions);
    effectiveDeviceId = relayOptions.deviceId;
  } catch (err) {
    console.error(`[claude-sdk] relay auth bootstrap failed: code=${err?.code || "unknown"}`);
    throw err;
  }
  const localConfig = readConfig();
  // Resolve provider env through the unified entry point. Direct SDK launchers
  // read the persisted local proxy snapshot, same as the PTY path.
  const providerResult = buildAgentProviderEnv("claude", localConfig, {
    provider: options.provider,
    proxyStatus: staticProxyStatusFn(readLocalProxySnapshot()),
  });
  const providerEnv = providerResult.env;
  const resolvedProvider = providerResult.provider;
  const providerSource = providerResult.source;
  const messageQueue = new AsyncMessageQueue();
  const pendingPermissions = new Map();
  const abortController = new AbortController();
  let stopped = false;

  const send = (type, extra = {}) => {
    relayClient.send(type, {
      sessionId,
      localStarted: true,
      ...extra,
    }).catch(() => {});
  };

  function sendAgentEvent(event) {
    send("agent.event", { event });
  }

  function resolvePermission(payload) {
    const callId = payload.callId || payload.id;
    const pending = pendingPermissions.get(callId);
    if (!pending) {
      sendAgentEvent({
        type: "agent.permission.resolve.error",
        provider: "claude",
        callId,
        message: "No pending Claude SDK permission found for this callId.",
      });
      return;
    }

    pendingPermissions.delete(callId);
    const approved = payload.decision === "approved" || payload.decision === "approved_for_session";
    pending.resolve(createPermissionResult(approved, pending.input, payload.reason));
    sendAgentEvent({
      type: "agent.permission.resolved",
      provider: "claude",
      callId,
      decision: payload.decision || (approved ? "approved" : "denied"),
    });
  }

  async function handleRemoteEvent(payload) {
    if (payload.sessionId !== sessionId) return;

    if (payload.type === "agent.message") {
      const text = normalizeRemoteText(payload.message || payload.data);
      if (!text) return;
      messageQueue.push(toUserMessage(text));
      sendAgentEvent({ type: "user.text", provider: "claude", text });
    }

    if (payload.type === "terminal.input") {
      const text = normalizeRemoteText(payload.data);
      if (!text) return;
      messageQueue.push(toUserMessage(text));
      sendAgentEvent({ type: "user.text", provider: "claude", text });
    }

    if (payload.type === "agent.permission.resolve") {
      resolvePermission(payload);
    }

    if (payload.type === "terminal.interrupt" || payload.type === "session.stop") {
      stopped = true;
      abortController.abort();
      messageQueue.close();
      for (const [callId, pending] of pendingPermissions) {
        pending.resolve(createPermissionResult(false, pending.input, "Session stopped remotely."));
        pendingPermissions.delete(callId);
      }
      send("session.exited", { code: 0, signal: payload.type === "terminal.interrupt" ? "SIGINT" : null });
    }
  }

  const eventLoop = async () => {
    while (!stopped) {
      try {
        await relayClient.connectEvents(handleRemoteEvent);
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
          console.error(`[claude-sdk] relay auth re-acquire failed: code=${reErr?.code || "unknown"}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  };
  eventLoop();

  const { query } = await loadClaudeAgentSdk();

  send("session.started", {
    command: "claude-sdk",
    args: rawArgs,
    cwd,
    agent: "claude",
    runtime: "claude-sdk",
    executor: "sdk",
    startedBy: "local-sdk",
    providerConfig: buildProviderConfigEvent(resolvedProvider, providerSource),
    metadata: {
      adapter: "claude-sdk",
      structuredSources: ["claude-agent-sdk"],
    },
  });
  sendAgentEvent({
    type: "agent.ready",
    provider: "claude",
    message: "Claude SDK session is ready. Send a message from the remote client.",
  });
  // Local UX hint: stdout is silent in SDK mode (no Claude Code TUI echoes
  // back), and the wrapper may take a beat before the first /client/message
  // arrives. Print to stderr so it doesn't leak into the relay's
  // terminal.output stream.
  process.stderr.write(
    "[originrouter] Claude SDK session ready. Open the remote client and send a message.\n"
  );

  const canUseTool = async (toolName, input, toolOptions = {}) => {
    const callId = toolOptions.toolUseID || `${toolName}-${Date.now()}`;
    sendAgentEvent({
      type: "agent.permission.request.detected",
      provider: "claude",
      callId,
      tool: toolName,
      input,
      resolution: {
        eventType: "agent.permission.resolve",
        decisions: ["approved", "approved_for_session", "denied", "abort"],
      },
    });

    return new Promise((resolve) => {
      pendingPermissions.set(callId, {
        resolve,
        input,
        createdAt: Date.now(),
      });
      toolOptions.signal?.addEventListener("abort", () => {
        if (!pendingPermissions.has(callId)) return;
        pendingPermissions.delete(callId);
        resolve(createPermissionResult(false, input, "Permission request aborted."));
      }, { once: true });
    });
  };

  const sdkOptions = {
    cwd,
    env,
    abortController,
    canUseTool,
    permissionMode: options.permissionMode || "default",
    model: options.model || resolvedProvider?.model,
    fallbackModel: options.fallbackModel || resolvedProvider?.smallFastModel,
  };
  if (typeof options.resume === "string") {
    sdkOptions.resume = options.resume;
  }

  try {
    const response = query({
      prompt: messageQueue,
      options: sdkOptions,
    });

    for await (const message of response) {
      for (const event of mapClaudeSdkMessage(message)) {
        sendAgentEvent(event);
      }
    }

    if (!stopped) {
      stopped = true;
      send("session.exited", { code: 0, signal: null });
    }
  } catch (error) {
    if (stopped) return;
    if (!stopped) {
      stopped = true;
      send("session.error", { message: error instanceof Error ? error.message : String(error) });
      send("session.exited", { code: 1, signal: null });
    }
    throw error;
  }
}
