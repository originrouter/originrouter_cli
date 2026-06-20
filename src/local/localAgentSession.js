import process from "node:process";
import { createAdapter } from "../adapters/createAdapter.js";
import { buildAgentProviderEnv } from "../config/claudeConfig.js";
import { DEFAULT_DEVICE_ID, DEFAULT_RELAY_URL } from "../constants.js";
import { createExecutor } from "../executors/createExecutor.js";
import { appendSessionStart, patchSessionExit } from "../persistence/sessionLog.js";
import { ensureDevice, ensureStateDir, readConfig } from "../persistence/state.js";
import { readLocalProxySnapshot, staticProxyStatusFn } from "../proxy/snapshot.js";
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
  const relayClient = new RelayClient({ relayUrl, deviceId: device.deviceId });
  const adapter = createAdapter({ agent, command: agent, args: passthrough, cwd });
  const executor = createExecutor("pty");
  const localConfig = readConfig();
  // Stage 4: direct CLI sessions read the persisted local proxy snapshot.
  // When LiteLLM is running for the selected openai-compatible provider,
  // buildAgentProviderEnv routes Claude Code through it.
  const proxyStatus = staticProxyStatusFn(readLocalProxySnapshot());
  // buildAgentProviderEnv throws PROVIDER_UNSUPPORTED if --provider or
  // currentProvider[agent] points to an openai-compatible profile AND the
  // proxy is not running for it. Stage 4 routes through the proxy when the
  // status reports `state: "running"` for this exact provider.
  const providerResult = buildAgentProviderEnv(agent, localConfig, {
    provider: options.provider,
    proxyStatus,
  });
  const providerEnv = providerResult.env;
  const resolvedProvider = providerResult.provider;
  const providerSource = providerResult.source;
  const baseEnv = { ...process.env, ...providerEnv };
  let exited = false;
  let scanTimer = null;

  const send = (type, extra = {}) => {
    relayClient.send(type, {
      sessionId,
      localStarted: true,
      ...extra,
    }).catch(() => {});
  };

  const cleanup = () => {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
    if (typeof adapter.cleanup === "function") {
      adapter.cleanup();
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
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
      for (const event of adapter.handleOutput(data)) {
        send("agent.event", { event });
      }
    },
    onExit: ({ code, signal }) => {
      exited = true;
      cleanup();
      const exitedAt = new Date().toISOString();
      try {
        patchSessionExit({ sessionId, status: "exited", code, signal, exitedAt });
      } catch (error) {
        console.error(`[session-log] ${error.message}`);
      }
      send("session.exited", { code, signal });
      process.exitCode = code ?? (signal ? 1 : 0);
      setTimeout(() => process.exit(process.exitCode || 0), 20);
    },
    onError: (error) => {
      send("session.error", { message: error.message });
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

  try {
    appendSessionStart({
      sessionId,
      deviceId: device.deviceId,
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
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
