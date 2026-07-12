import process from "node:process";
import {
  buildRuntimeEventEnvelope,
  createTerminalActivityReporter,
  reportRuntimeEvent,
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

  if (payload.type === "terminal.input") {
    ctx.executor.write(payload.data || "");
  }
  if (payload.type === "terminal.resize") {
    ctx.executor.resize(payload.cols, payload.rows);
  }
  if (payload.type === "terminal.interrupt") {
    ctx.executor.interrupt();
  }
  if (payload.type === "agent.permission.resolve") {
    if (typeof ctx.adapter.resolvePermission === "function") {
      ctx.adapter.resolvePermission(payload);
    } else if (payload.data) {
      ctx.executor.write(payload.data);
    }
  }
  if (payload.type === "agent.interaction.resolve") {
    // Stage 8.9: only kind: "permission" is wired for resolve. Other
    // kinds (raw_terminal, confirm, single_select, multi_select,
    // free_text) are NOT claimed by 8.9. The data fallback below is
    // a defensive guard for a future kind with no permission
    // resolver target; it is NOT a "raw terminal" implementation.
    // For structured terminal control today, callers should use the
    // existing `terminal.input` event.
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
  if (payload.type === "session.stop") {
    ctx.executor.stop();
  }
}

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
    passthrough.push(arg);
  }

  return { options, passthrough };
}

function writeLocal(data) {
  process.stdout.write(data);
}

export async function runLocalAgentSession(agent, rawArgs) {
  ensureStateDir();

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
      stateDir: ensureStateDir(),
      relayUrl,
      fallbackDeviceId: device.deviceId,
    });
    relayClient = new RelayClient(relayOptions);
    effectiveDeviceId = relayOptions.deviceId;
  } catch (err) {
    console.error(`[local-session] relay auth bootstrap failed: code=${err?.code || "unknown"}`);
    throw err;
  }
  const adapter = createAdapter({ agent, command: agent, args: passthrough, cwd });
  const executor = createExecutor("pty");
  const localConfig = readConfig();
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
  if (willRouteRemoteCoding(localConfig, agent)) {
    remoteCodingProxyManager = new RemoteCodingProxyManager({
      stateDir: ensureStateDir(),
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
  const providerResult = await buildAgentProviderEnv(agent, localConfig, {
    provider: options.provider,
    proxyStatus,
    remoteCodingStatus,
  });
  const providerEnv = providerResult.env;
  const resolvedProvider = providerResult.provider;
  const providerSource = providerResult.source;
  const baseEnv = { ...process.env, ...providerEnv };
  let exited = false;
  let scanTimer = null;
  let stopApprovalPolling = () => {};
  const terminalActivityReporter = createTerminalActivityReporter({
    sessionId,
    agentType: agent,
    title: `${agent} local session`,
    deviceName: device.host,
    stateDir: ensureStateDir(),
  });

  const send = (type, extra = {}) => {
    relayClient.send(type, {
      sessionId,
      localStarted: true,
      ...extra,
    }).catch(() => {});
  };
  const report = (type, extra = {}) => {
    if (type !== "session.started" && type !== "session.exited" && type !== "session.error" && type !== "agent.event") {
      return;
    }
    const payload = buildRuntimeEventEnvelope({
      sessionId,
      agentType: agent,
      title: `${agent} session`,
      deviceName: device.host,
      eventType: type,
      event: type === "agent.event" ? extra.event : extra,
      summary: extra.summary,
    });
    reportRuntimeEvent(payload, { stateDir: ensureStateDir() }).catch(() => {});
  };

  const cleanup = () => {
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
    onDecision: (payload) => handleRemoteEvent(payload, { sessionId, adapter, executor }),
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
      send("terminal.output", { data });
      terminalActivityReporter.ingest(data);
      for (const event of adapter.handleOutput(data)) {
        send("agent.event", { event });
        report("agent.event", { event });
      }
    },
    onExit: ({ code, signal }) => {
      exited = true;
      void terminalActivityReporter.flush();
      cleanup();
      const exitedAt = new Date().toISOString();
      try {
        patchSessionExit({ sessionId, status: "exited", code, signal, exitedAt });
      } catch (error) {
        console.error(`[session-log] ${error.message}`);
      }
      send("session.exited", { code, signal });
      report("session.exited", { code, signal });
      process.exitCode = code ?? (signal ? 1 : 0);
      setTimeout(() => process.exit(process.exitCode || 0), 20);
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
    providerConfig: agent === "claude" ? buildProviderConfigEvent(resolvedProvider, providerSource) : undefined,
    executor: started.executor,
    pid: started.pid,
    startedBy: "local-wrapper",
  });
  report("session.started", {
    runtime,
    executor: started.executor,
  });

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
        send("agent.event", { event });
        report("agent.event", { event });
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

  const handleRemoteEventBound = (payload) => {
    handleRemoteEvent(payload, { sessionId, adapter, executor });
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
