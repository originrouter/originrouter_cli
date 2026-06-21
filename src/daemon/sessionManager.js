import { createAdapter } from "../adapters/createAdapter.js";
import { buildAgentProviderEnv } from "../config/claudeConfig.js";
import { createExecutor } from "../executors/createExecutor.js";
import { staticProxyStatusFn } from "../proxy/snapshot.js";
import { appendSessionStart, patchSessionExit } from "../persistence/sessionLog.js";
import { readConfig } from "../persistence/state.js";
import { buildProviderConfigEvent } from "../util/providerConfigEvent.js";
import { handleRemoteCodingRequest } from "./remoteCodingServer.js";

export class SessionManager {
  constructor({ relayClient, deviceId, defaultExecutor, proxyManager = null }) {
    this.relayClient = relayClient;
    this.deviceId = deviceId;
    this.defaultExecutor = defaultExecutor;
    this.proxyManager = proxyManager;
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

  async startSession(payload) {
    const sessionId = payload.sessionId || `session-${Date.now()}`;
    if (this.sessions.has(sessionId)) return;

    const cwd = payload.cwd || process.cwd();
    const command = payload.command || "bash";
    const args = payload.args || [];
    const agent = payload.agent || (command === "claude" || command === "codex" ? command : "terminal");
    const adapter = createAdapter({ agent, command, args, cwd });
    const executorKind = this.defaultExecutor;
    const executor = createExecutor(executorKind);

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

    const cleanupSession = () => {
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
        providerResult = buildAgentProviderEnv(agent, readConfig(), {
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

      const started = await executor.start({
        command: launch.command,
        args: launch.args,
        cwd,
        env: { ...process.env, ...providerEnv, ...launch.env },
        cols: payload.cols,
        rows: payload.rows,
        onOutput: (data) => {
          send("terminal.output", { data });
          for (const event of adapter.handleOutput(data)) {
            send("agent.event", { event });
          }
        },
        onExit: ({ code, signal }) => {
          session.status = "exited";
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
        },
        onError: (error) => {
          send("session.error", { message: error.message });
        },
      });

      session.status = "running";
      session.pid = started.pid;
      session.executorKind = started.executor;
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
          }
        }, 1000);
      }
    } catch (error) {
      session.status = "error";
      cleanupSession();
      send("session.error", { message: error.message });
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
      if (!session.cleanedUp && typeof session.adapter.cleanup === "function") {
        session.cleanedUp = true;
        session.adapter.cleanup();
      }
      session.executor.stop();
      this.sessions.delete(payload.sessionId);
    }
  }
}
