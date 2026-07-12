import {
  buildRuntimeEventEnvelope,
  createTerminalActivityReporter,
  reportRuntimeEvent,
  startApprovalDecisionPolling,
} from "../agent/bridgeReporter.js";
import { createAdapter } from "../adapters/createAdapter.js";
import { buildAgentProviderEnv } from "../config/claudeConfig.js";
import { clearRoute, setRoute } from "../config/routes.js";
import { createExecutor } from "../executors/createExecutor.js";
import { staticProxyStatusFn } from "../proxy/snapshot.js";
import { appendSessionStart, patchSessionExit } from "../persistence/sessionLog.js";
import { readConfig, writeConfig } from "../persistence/state.js";
import { DEFAULT_PROXY_PORT } from "../constants.js";
import { buildProviderConfigEvent } from "../util/providerConfigEvent.js";
import { handleRemoteCodingRequest } from "./remoteCodingServer.js";

export class SessionManager {
  constructor({
    relayClient,
    deviceId,
    defaultExecutor,
    proxyManager = null,
    startApprovalDecisionPollingFn = startApprovalDecisionPolling,
    createAdapterFn = createAdapter,
    createExecutorFn = createExecutor,
    buildAgentProviderEnvFn = buildAgentProviderEnv,
  }) {
    this.relayClient = relayClient;
    this.deviceId = deviceId;
    this.defaultExecutor = defaultExecutor;
    this.proxyManager = proxyManager;
    this.startApprovalDecisionPollingFn = startApprovalDecisionPollingFn;
    this.createAdapterFn = createAdapterFn;
    this.createExecutorFn = createExecutorFn;
    this.buildAgentProviderEnvFn = buildAgentProviderEnvFn;
    this.sessions = new Map();
    // Stage 9.2: per-requestId abort controllers for in-flight remote
    // coding fetches. The cancel event aborts the underlying fetch so
    // the worker's local proxy can clean up.
    this.activeRemoteRequests = new Map();
  }

  async resolveLocalProxyUrl() {
    if (!this.proxyManager) return null;
    const status = await this.proxyManager.status();
    if (status && status.state === "running" && status.port) {
      return `http://${status.host || "127.0.0.1"}:${status.port}`;
    }
    return null;
  }

  async handleRemoteCodingEvent(envelope) {
    const controller = new AbortController();
    this.activeRemoteRequests.set(envelope.requestId, controller);
    try {
      await handleRemoteCodingRequest(envelope, {
        relayClient: this.relayClient,
        localProxyUrl: await this.resolveLocalProxyUrl(),
        signal: controller.signal,
      });
    } finally {
      this.activeRemoteRequests.delete(envelope.requestId);
    }
  }

  cancelRemoteCodingRequest(requestId) {
    const controller = this.activeRemoteRequests.get(requestId);
    if (controller) {
      try { controller.abort(); } catch {}
      this.activeRemoteRequests.delete(requestId);
    }
  }

  async restartRouteModeProxy() {
    if (!this.proxyManager || typeof this.proxyManager.restart !== "function") {
      return { ok: false, error: "proxy_manager_unavailable" };
    }
    const status = await this.proxyManager.status();
    const port = status && status.port ? status.port : undefined;
    return this.proxyManager.restart({ mode: "route", port });
  }

  async startRouteModeProxy(port = DEFAULT_PROXY_PORT) {
    if (!this.proxyManager || typeof this.proxyManager.start !== "function") {
      return { ok: false, error: "proxy_manager_unavailable" };
    }
    const parsedPort = Number.parseInt(port, 10);
    return this.proxyManager.start({
      mode: "route",
      port: Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PROXY_PORT,
    });
  }

  async restartRouteModeProxyIfRunning() {
    if (!this.proxyManager || typeof this.proxyManager.status !== "function") return;
    const status = await this.proxyManager.status();
    if (status && status.state === "running" && status.mode === "route") {
      await this.restartRouteModeProxy();
    }
  }

  async handleLocalControlEvent(payload) {
    if (payload.type === "local_control.litellm.start") {
      await this.startRouteModeProxy(payload.port);
      return;
    }
    if (payload.type === "local_control.litellm.restart") {
      await this.restartRouteModeProxy();
      return;
    }
    if (payload.type === "local_control.route.set") {
      const provider = String(payload.provider || "").trim();
      if (!provider) return;
      const config = readConfig();
      const next = setRoute(config, String(payload.agent || ""), String(payload.slot || ""), {
        provider,
        model: payload.model || undefined,
      });
      writeConfig(next);
      await this.restartRouteModeProxyIfRunning();
      return;
    }
    if (payload.type === "local_control.route.clear") {
      const config = readConfig();
      const next = clearRoute(config, String(payload.agent || ""), String(payload.slot || ""));
      writeConfig(next);
      await this.restartRouteModeProxyIfRunning();
    }
  }

  async startSession(payload) {
    const sessionId = payload.sessionId || `session-${Date.now()}`;
    if (this.sessions.has(sessionId)) return;

    const cwd = payload.cwd || process.cwd();
    const command = payload.command || "bash";
    const args = payload.args || [];
    const agent = payload.agent || (command === "claude" || command === "codex" ? command : "terminal");
    const adapter = this.createAdapterFn({ agent, command, args, cwd });
    const executorKind = this.defaultExecutor;
    const executor = this.createExecutorFn(executorKind);

    const session = {
      id: sessionId,
      agent,
      cwd,
      status: "starting",
      adapter,
      executor,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(sessionId, session);

    const send = (type, extra = {}) => {
      this.relayClient.send(type, {
        sessionId,
        ...extra,
      }).catch((error) => {
        console.error(`[relay] ${error.message}`);
      });
    };
    const report = (type, extra = {}) => {
      if (type !== "session.started" && type !== "session.exited" && type !== "session.error" && type !== "agent.event") {
        return;
      }
      const payloadForBridge = buildRuntimeEventEnvelope({
        sessionId,
        agentType: agent,
        title: payload.title || `${agent} session`,
        deviceName: payload.deviceName || "",
        eventType: type,
        event: type === "agent.event" ? extra.event : extra,
      });
      reportRuntimeEvent(payloadForBridge).catch(() => {});
    };

    const cleanupSession = () => {
      if (typeof session.stopApprovalPolling === "function") {
        session.stopApprovalPolling();
        session.stopApprovalPolling = null;
      }
      if (typeof session.stopTerminalActivityReporter === "function") {
        session.stopTerminalActivityReporter();
        session.stopTerminalActivityReporter = null;
      }
      if (session.scanTimer) {
        clearInterval(session.scanTimer);
        session.scanTimer = null;
      }
      if (!session.cleanedUp && typeof adapter.cleanup === "function") {
        session.cleanedUp = true;
        adapter.cleanup();
      }
    };

    try {
      if (typeof adapter.beforeStart === "function") {
        await adapter.beforeStart({
          cwd,
          env: process.env,
          sessionId,
          relayClient: this.relayClient,
          send,
        });
      }

      const launch = adapter.buildLaunch();
      const metadata = adapter.describe();

      // Provider resolution goes through the same entry point as localAgentSession.
      // `payload.provider` is the forward-looking remote-supplied override; falls
      // back to currentProvider[agent] when absent. PROVIDER_UNSUPPORTED is a
      // hard error — we surface it as session.error and refuse to launch, never
      // silently fall back to legacy config.claude.
      //
      // Stage 4: when the daemon has a ProxyManager, take a fresh snapshot of
      // the proxy state and pass it in. If the proxy is running for the
      // target openai-compatible provider, buildAgentProviderEnv routes through
      // it instead of throwing.
      let providerResult;
      try {
        const proxySnapshot = this.proxyManager
          ? await this.proxyManager.status()
          : null;
        providerResult = await this.buildAgentProviderEnvFn(agent, readConfig(), {
          provider: payload.provider,
          proxyStatus: staticProxyStatusFn(proxySnapshot),
        });
      } catch (providerErr) {
        if (providerErr.code === "PROVIDER_UNSUPPORTED") {
          send("session.error", { message: providerErr.message });
          throw providerErr;
        }
        throw providerErr;
      }
      const providerEnv = providerResult.env;
      const resolvedProvider = providerResult.provider;
      const providerSource = providerResult.source;
      const terminalActivityReporter = createTerminalActivityReporter({
        sessionId,
        agentType: agent,
        title: payload.title || `${agent} session`,
        deviceName: this.deviceName || "",
      });
      session.stopTerminalActivityReporter = () => {
        terminalActivityReporter.stop();
      };

      const started = await executor.start({
        command: launch.command,
        args: launch.args,
        cwd,
        env: { ...process.env, ...providerEnv, ...launch.env },
        cols: payload.cols,
        rows: payload.rows,
        onOutput: (data) => {
          send("terminal.output", { data });
          terminalActivityReporter.ingest(data);
          for (const event of adapter.handleOutput(data)) {
            send("agent.event", { event });
            report("agent.event", { event });
          }
        },
        onExit: ({ code, signal }) => {
          session.status = "exited";
          void terminalActivityReporter.flush();
          cleanupSession();
          try {
            patchSessionExit({
              sessionId,
              status: "exited",
              code,
              signal,
              exitedAt: new Date().toISOString(),
            });
          } catch (error) {
            console.error(`[session-log] ${error.message}`);
          }
          send("session.exited", { code, signal });
          report("session.exited", { code, signal });
        },
        onError: (error) => {
          send("session.error", { message: error.message });
          report("session.error", { message: error.message });
        },
      });

      session.status = "running";
      session.pid = started.pid;
      session.executorKind = started.executor;
      session.stopApprovalPolling = this.startApprovalDecisionPollingFn({
        sessionId,
        onDecision: (decisionPayload) => {
          this.handleEvent(decisionPayload);
        },
      });
      send("session.started", {
        command: launch.command,
        args: launch.args,
        cwd,
        agent,
        metadata,
        providerConfig: agent === "claude" ? buildProviderConfigEvent(resolvedProvider, providerSource) : undefined,
        executor: started.executor,
        pid: started.pid,
        tmuxSession: started.tmuxSession,
      });
      report("session.started", {
        executor: started.executor,
        pid: started.pid,
      });

      try {
        appendSessionStart({
          sessionId,
          deviceId: this.deviceId,
          agent,
          command: launch.command,
          args: launch.args,
          cwd,
          pid: started.pid,
          executor: started.executor,
          runtime: undefined,
          startedBy: payload.startedBy || "remote",
          startedAt: new Date().toISOString(),
          status: "running",
        });
      } catch (error) {
        console.error(`[session-log] ${error.message}`);
      }

      if (typeof adapter.scanStructuredEvents === "function") {
        session.scanTimer = setInterval(() => {
          for (const event of adapter.scanStructuredEvents()) {
            send("agent.event", { event });
            report("agent.event", { event });
          }
        }, 1000);
      }
    } catch (error) {
      session.status = "error";
      cleanupSession();
      send("session.error", { message: error.message });
      report("session.error", { message: error.message });
    }
  }

  handleEvent(payload) {
    if (payload.type === "session.start") {
      this.startSession(payload);
      return;
    }

    // Stage 9.2: worker-side remote coding routing. These events do not
    // carry a sessionId and are routed by requestId to a per-request
    // fetch to the worker's local proxy.
    if (payload.type === "remote.coding.request") {
      this.handleRemoteCodingEvent(payload);
      return;
    }
    if (payload.type === "remote.coding.request.cancel") {
      this.cancelRemoteCodingRequest(payload.requestId);
      return;
    }

    if (typeof payload.type === "string" && payload.type.startsWith("local_control.")) {
      this.handleLocalControlEvent(payload).catch((error) => {
        console.error(`[local-control] ${error.message || String(error)}`);
      });
      return;
    }

    const session = this.sessions.get(payload.sessionId);
    if (!session) return;

    if (payload.type === "terminal.input") {
      session.executor.write(payload.data || "");
    }

    if (payload.type === "terminal.resize") {
      session.executor.resize(payload.cols, payload.rows);
    }

    if (payload.type === "terminal.interrupt") {
      session.executor.interrupt();
    }

    if (payload.type === "agent.permission.resolve") {
      if (typeof session.adapter.resolvePermission === "function") {
        session.adapter.resolvePermission(payload);
      } else if (payload.data) {
        session.executor.write(payload.data);
      }
    }

    if (payload.type === "session.stop") {
      if (session.scanTimer) {
        clearInterval(session.scanTimer);
        session.scanTimer = null;
      }
      if (typeof session.stopApprovalPolling === "function") {
        session.stopApprovalPolling();
        session.stopApprovalPolling = null;
      }
      if (!session.cleanedUp && typeof session.adapter.cleanup === "function") {
        session.cleanedUp = true;
        session.adapter.cleanup();
      }
      session.executor.stop();
      this.sessions.delete(payload.sessionId);
    }
  }
}
