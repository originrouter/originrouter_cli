import {
  createRuntimeEventReporter,
  createTerminalActivityReporter,
  startAgentSessionHeartbeat,
  startApprovalDecisionPolling,
} from "../agent/bridgeReporter.js";
import { createAdapter } from "../adapters/createAdapter.js";
import { buildAgentProviderEnv } from "../config/claudeConfig.js";
import { clearRoute, replaceAgentRoutes, setRoute } from "../config/routes.js";
import { createExecutor } from "../executors/createExecutor.js";
import { staticProxyStatusFn } from "../proxy/snapshot.js";
import { appendSessionStart, patchSessionExit } from "../persistence/sessionLog.js";
import { ensureStateDir, readConfig, writeConfig } from "../persistence/state.js";
import {
  rollbackCompatibilityPack,
  setCompatibilityPatchEnabled,
} from "../compatibility/patchStore.js";
import { checkCompatibilityPack, refreshCompatibilityPack } from "../compatibility/updater.js";
import { compatibilityStatus } from "../compatibility/status.js";
import { DEFAULT_PROXY_PORT, DEFAULT_REMOTE_SHARE_PROXY_PORT } from "../constants.js";
import { buildProviderConfigEvent } from "../util/providerConfigEvent.js";
import { handleRemoteCodingRequest } from "./remoteCodingServer.js";
import { protectOriginrouterCodingEnv } from "../runtime/originrouterCodingAuthProxy.js";
import { setAgentDetailDefault } from "../runtime/agentDetailProfile.js";
import { buildAuditEvidenceBundle } from "../inquiry/auditEvidenceAdapter.js";
import { browseAgentWorkspaces } from "./workspaceBrowser.js";
import {
  approvalPolicyCapabilities,
  evaluateApprovalRequest,
  validateApprovalPolicy,
} from "../runtime/approvalPolicy.js";
import {
  listApprovalPolicyRevisions,
  rollbackApprovalPolicy,
} from "../runtime/approvalPolicyStore.js";

export class SessionManager {
  constructor({
    relayClient,
    deviceId,
    defaultExecutor,
    proxyManager = null,
    remoteShareProxyManager = null,
    remoteCodingIdentity = null,
    startApprovalDecisionPollingFn = startApprovalDecisionPolling,
    createAdapterFn = createAdapter,
    createExecutorFn = createExecutor,
    buildAgentProviderEnvFn = buildAgentProviderEnv,
    auditStore = null,
    agentCatalog = null,
    managedAgentSupervisor = null,
    onLocalControlChanged = null,
    stateDir = ensureStateDir(),
    compatibilityAutomaticUpdates = true,
  }) {
    this.relayClient = relayClient;
    this.deviceId = deviceId;
    this.defaultExecutor = defaultExecutor;
    this.proxyManager = proxyManager;
    this.remoteShareProxyManager = remoteShareProxyManager;
    this.remoteCodingIdentity = remoteCodingIdentity;
    this.startApprovalDecisionPollingFn = startApprovalDecisionPollingFn;
    this.createAdapterFn = createAdapterFn;
    this.createExecutorFn = createExecutorFn;
    this.buildAgentProviderEnvFn = buildAgentProviderEnvFn;
    this.auditStore = auditStore;
    this.agentCatalog = agentCatalog;
    this.managedAgentSupervisor = managedAgentSupervisor;
    this.onLocalControlChanged = onLocalControlChanged;
    this.stateDir = stateDir;
    this.compatibilityAutomaticUpdates = compatibilityAutomaticUpdates;
    this.lastCompatibilityOperation = null;
    this.sessions = new Map();
    // Stage 9.2: per-requestId abort controllers for in-flight remote
    // coding fetches. The cancel event aborts the underlying fetch so
    // the worker's local proxy can clean up.
    this.activeRemoteRequests = new Map();
    this.recentRemoteRequests = new Map();
  }

  async resolveLocalProxyUrl() {
    if (!this.remoteShareProxyManager) return null;
    const status = await this.remoteShareProxyManager.status();
    if (status && status.state === "running" && status.port) {
      return `http://${status.host || "127.0.0.1"}:${status.port}`;
    }
    return null;
  }

  compatibilityStatus() {
    return compatibilityStatus(this.stateDir, {
      automaticUpdates: this.compatibilityAutomaticUpdates,
      lastOperation: this.lastCompatibilityOperation,
    });
  }

  async runCompatibilityAction(action, operationId = `compat-${Date.now()}`) {
    const startedAt = new Date().toISOString();
    this.lastCompatibilityOperation = {
      id: operationId,
      action,
      state: "running",
      started_at: startedAt,
      completed_at: null,
      message: "",
    };
    try {
      let result;
      if (action === "check") {
        result = await checkCompatibilityPack({ stateDir: this.stateDir });
      } else if (action === "update") {
        result = await refreshCompatibilityPack({ stateDir: this.stateDir });
      } else if (action === "rollback") {
        result = rollbackCompatibilityPack(this.stateDir);
        if (!result.rolledBack) throw new Error("No previous compatibility bundle is available.");
      } else {
        throw new Error(`Unsupported compatibility action '${action}'.`);
      }
      this.lastCompatibilityOperation = {
        id: operationId,
        action,
        state: "succeeded",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        message: action === "check"
          ? (result.update_available ? `Revision ${result.latest_revision} is available.` : "Compatibility patches are current.")
          : action === "update"
            ? (result.installed ? `Revision ${result.pack?.revision} installed.` : "Compatibility patches are current.")
            : `Rolled back to revision ${result.pack?.revision}.`,
      };
      await this.onLocalControlChanged?.();
      return { ok: true, result, compatibility: this.compatibilityStatus() };
    } catch (error) {
      this.lastCompatibilityOperation = {
        id: operationId,
        action,
        state: "failed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        message: String(error?.message || error).slice(0, 512),
      };
      await this.onLocalControlChanged?.();
      return { ok: false, error: this.lastCompatibilityOperation.message, compatibility: this.compatibilityStatus() };
    }
  }

  async setCompatibilityPatchEnabled(
    patchId,
    enabled,
    operationId = `compat-${Date.now()}`,
  ) {
    const normalizedPatchId = String(patchId || "").trim();
    const current = this.compatibilityStatus();
    if (!current.patches.some((patch) => patch.id === normalizedPatchId)) {
      throw new Error(`Unknown compatibility patch '${normalizedPatchId}'.`);
    }
    const startedAt = new Date().toISOString();
    this.lastCompatibilityOperation = {
      id: operationId,
      action: enabled ? "patch_enable" : "patch_disable",
      state: "running",
      started_at: startedAt,
      completed_at: null,
      message: "",
    };
    try {
      setCompatibilityPatchEnabled(this.stateDir, normalizedPatchId, enabled);
      this.lastCompatibilityOperation = {
        id: operationId,
        action: enabled ? "patch_enable" : "patch_disable",
        state: "succeeded",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        message: enabled
          ? `Compatibility patch '${normalizedPatchId}' enabled.`
          : `Compatibility patch '${normalizedPatchId}' disabled.`,
      };
      await this.onLocalControlChanged?.();
      return { ok: true, compatibility: this.compatibilityStatus() };
    } catch (error) {
      this.lastCompatibilityOperation = {
        id: operationId,
        action: enabled ? "patch_enable" : "patch_disable",
        state: "failed",
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        message: String(error?.message || error).slice(0, 512),
      };
      await this.onLocalControlChanged?.();
      return {
        ok: false,
        error: this.lastCompatibilityOperation.message,
        compatibility: this.compatibilityStatus(),
      };
    }
  }

  async handleRemoteCodingEvent(envelope) {
    const requestId = String(envelope?.requestId || "");
    const now = Date.now();
    for (const [seenRequestId, expiresAt] of this.recentRemoteRequests) {
      if (expiresAt <= now) this.recentRemoteRequests.delete(seenRequestId);
    }
    if (!requestId || this.activeRemoteRequests.has(requestId) || this.recentRemoteRequests.has(requestId)) {
      await this.relayClient.send("remote.coding.response.error", {
        requestId,
        code: "e2ee_replay_detected",
        message: "duplicate remote coding request rejected",
      });
      return;
    }
    const controller = new AbortController();
    this.activeRemoteRequests.set(requestId, controller);
    try {
      const config = readConfig();
      await handleRemoteCodingRequest(envelope, {
        relayClient: this.relayClient,
        localProxyUrl: await this.resolveLocalProxyUrl(),
        signal: controller.signal,
        deviceId: this.deviceId,
        e2eeIdentity: this.remoteCodingIdentity,
      });
    } finally {
      this.activeRemoteRequests.delete(requestId);
      this.recentRemoteRequests.set(requestId, Date.now() + 5 * 60_000);
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
    const compatibilityMatch = String(payload.type || "").match(/^local_control\.compatibility\.(check|update|rollback)$/);
    if (compatibilityMatch) {
      await this.runCompatibilityAction(compatibilityMatch[1], String(payload.operation_id || `compat-${Date.now()}`));
      return;
    }
    if (payload.type === "local_control.compatibility.patch.set") {
      await this.setCompatibilityPatchEnabled(
        payload.patch_id,
        payload.enabled === true,
        String(payload.operation_id || `compat-${Date.now()}`),
      );
      return;
    }
    if (payload.type === "local_control.litellm.start") {
      const result = await this.startRouteModeProxy(payload.port);
      if (!result?.ok) throw new Error(result?.error || "agent proxy start failed");
      return;
    }
    if (payload.type === "local_control.litellm.restart") {
      const result = await this.restartRouteModeProxy();
      if (!result?.ok) throw new Error(result?.error || "agent proxy restart failed");
      return;
    }
    if (payload.type === "local_control.remote_share.start") {
      if (!this.remoteShareProxyManager) throw new Error("remote share proxy manager unavailable");
      const result = await this.remoteShareProxyManager.start({
        mode: "share",
        providerNames: payload.providers,
        port: payload.port || DEFAULT_REMOTE_SHARE_PROXY_PORT,
      });
      if (!result?.ok) throw new Error(result?.error || "remote share start failed");
      const config = readConfig();
      writeConfig({
        ...config,
        remoteShare: {
          enabled: true,
          providers: payload.providers,
          port: payload.port || DEFAULT_REMOTE_SHARE_PROXY_PORT,
          e2eePolicy: "required",
        },
      });
      return;
    }
    if (payload.type === "local_control.remote_share.stop") {
      if (!this.remoteShareProxyManager) throw new Error("remote share proxy manager unavailable");
      const result = await this.remoteShareProxyManager.stop();
      if (!result?.ok) throw new Error(result?.error || "remote share stop failed");
      const config = readConfig();
      writeConfig({
        ...config,
        remoteShare: {
          ...(config.remoteShare || {}),
          enabled: false,
        },
      });
      return;
    }
    if (payload.type === "local_control.remote_share.restart") {
      if (!this.remoteShareProxyManager) throw new Error("remote share proxy manager unavailable");
      const result = await this.remoteShareProxyManager.restart({
        mode: "share",
        providerNames: payload.providers,
        port: payload.port || DEFAULT_REMOTE_SHARE_PROXY_PORT,
      });
      if (!result?.ok) throw new Error(result?.error || "remote share restart failed");
      const config = readConfig();
      writeConfig({
        ...config,
        remoteShare: {
          enabled: true,
          providers: payload.providers,
          port: payload.port || DEFAULT_REMOTE_SHARE_PROXY_PORT,
          e2eePolicy: "required",
        },
      });
      return;
    }
    if (payload.type === "local_control.routes.replace") {
      const agent = String(payload.agent || "");
      const config = readConfig();
      const next = replaceAgentRoutes(
        config,
        agent,
        payload.routes && typeof payload.routes === "object" ? payload.routes : {},
      );
      writeConfig(next);
      await this.restartRouteModeProxyIfRunning();
      await this.onLocalControlChanged?.();
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
      await this.onLocalControlChanged?.();
      return;
    }
    if (payload.type === "local_control.route.clear") {
      const config = readConfig();
      const next = clearRoute(config, String(payload.agent || ""), String(payload.slot || ""));
      writeConfig(next);
      await this.restartRouteModeProxyIfRunning();
      await this.onLocalControlChanged?.();
      return;
    }
    if (payload.type === "local_control.agent_detail.set") {
      writeConfig(setAgentDetailDefault(readConfig(), payload.profile));
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
    session.exitPromise = new Promise((resolve) => {
      session.resolveExit = resolve;
    });
    this.sessions.set(sessionId, session);

    const send = (type, extra = {}) => {
      this.relayClient.send(type, {
        sessionId,
        ...extra,
      }).catch((error) => {
        console.error(`[relay] ${error.message}`);
      });
    };
    const runtimeReporter = createRuntimeEventReporter({
      sessionId,
      agentType: agent,
      title: payload.title || `${agent} session`,
      deviceName: payload.deviceName || "",
    });
    const report = (type, extra = {}) => {
      if (type !== "session.started" && type !== "session.exited" && type !== "session.error" && type !== "agent.event") {
        return Promise.resolve();
      }
      return runtimeReporter.report(type, extra);
    };
    let terminalActivityReporter = null;

    const cleanupSession = () => {
      if (typeof session.stopSessionHeartbeat === "function") {
        session.stopSessionHeartbeat();
        session.stopSessionHeartbeat = null;
      }
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
      if (session.originrouterCodingProxy) {
        session.originrouterCodingProxy.stop().catch(() => {});
        session.originrouterCodingProxy = null;
      }
    };

    const finalizeSession = async ({ code, signal }) => {
      if (session.finalized) return session.exitPromise;
      session.finalized = true;
      session.status = "exited";
      const terminalFlush = terminalActivityReporter
        ? terminalActivityReporter.flush().catch(() => {})
        : Promise.resolve();
      cleanupSession();
      await terminalFlush;
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
      try {
        this.agentCatalog?.finishSession(sessionId, {
          status: code === 0 && !signal ? "completed" : "stopped",
          exitCode: code,
          exitSignal: signal,
          exitedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error(`[agent-catalog] ${error.message}`);
      }
      send("session.exited", { code, signal });
      this.sessions.delete(sessionId);
      try {
        await report("session.exited", { code, signal });
      } finally {
        session.resolveExit?.();
      }
    };
    session.finalize = finalizeSession;

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
        const protectedResult = await protectOriginrouterCodingEnv(agent, providerResult, {
          stateDir: ensureStateDir(),
        });
        providerResult = protectedResult.providerResult;
        session.originrouterCodingProxy = protectedResult.proxy;
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
      terminalActivityReporter = createTerminalActivityReporter({
        sessionId,
        agentType: agent,
        title: payload.title || `${agent} session`,
        deviceName: this.deviceName || "",
        reportRuntimeEventFn: (runtimePayload) => runtimeReporter.report(
          "terminal.activity",
          { summary: runtimePayload.summary },
        ),
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
            this.auditStore?.appendEvent({ sessionId, cwd, agent }, event);
            this.agentCatalog?.recordEvent(sessionId, event);
            send("agent.event", { event });
            report("agent.event", { event });
          }
        },
        onExit: ({ code, signal }) => {
          void finalizeSession({ code, signal });
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
        onDecision: async (decisionPayload) => {
          const applied = this.handleEvent(decisionPayload);
          if (applied !== false) {
            await report("agent.event", {
              event: {
                type: "agent.permission.resolved",
                callId: decisionPayload.interactionId,
                decision: decisionPayload.decision,
              },
            });
          }
          return applied;
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
      session.stopSessionHeartbeat = startAgentSessionHeartbeat({ sessionId });

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
      try {
        this.agentCatalog?.upsertSession({
          sessionId,
          conversationId: payload.conversationId || sessionId,
          runId: payload.runId || sessionId,
          deviceId: this.deviceId,
          agent,
          title: payload.title || `${agent} session`,
          cwd,
          pid: started.pid,
          runtime: metadata?.runtime,
          provider: resolvedProvider?.name,
          model: payload.model || resolvedProvider?.model,
          permissionProfile: payload.permissionProfile || "manual",
          startedBy: payload.startedBy || "remote",
          startedAt: session.createdAt,
          status: "running",
        });
      } catch (error) {
        console.error(`[agent-catalog] ${error.message}`);
      }

      if (typeof adapter.scanStructuredEvents === "function") {
        session.scanTimer = setInterval(() => {
          for (const event of adapter.scanStructuredEvents()) {
            this.auditStore?.appendEvent({ sessionId, cwd, agent }, event);
            this.agentCatalog?.recordEvent(sessionId, event);
            send("agent.event", { event });
            report("agent.event", { event });
          }
        }, 1000);
      }
    } catch (error) {
      session.status = "error";
      try {
        this.agentCatalog?.finishSession(sessionId, {
          status: "failed",
          exitedAt: new Date().toISOString(),
        });
      } catch {}
      cleanupSession();
      send("session.error", { message: error.message });
      report("session.error", { message: error.message }).finally(() => {
        session.resolveExit?.();
      });
      this.sessions.delete(sessionId);
    }
  }

  async shutdown(signal = "SIGTERM") {
    for (const controller of this.activeRemoteRequests.values()) {
      try { controller.abort(); } catch {}
    }
    this.activeRemoteRequests.clear();

    const exits = [];
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      exits.push(session.exitPromise);
      try {
        session.executor.stop();
      } catch {
        session.resolveExit?.();
      }
    }
    if (exits.length === 0) return;
    await Promise.race([
      Promise.allSettled(exits),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    for (const session of sessions) {
      if (session.finalized) continue;
      await Promise.race([
        session.finalize({ code: null, signal }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
  }

  handleEvent(payload) {
    if (payload.type?.startsWith("approval.policy.")) {
      const requestId = String(payload.requestId || "").slice(0, 96);
      if (!requestId) return false;
      const respond = (type, body) => this.relayClient.send(type, {
        requestId,
        ...body,
      }).catch((error) => {
        console.error(`[approval-policy] ${error.message}`);
      });
      if (payload.type === "approval.policy.capabilities") {
        respond("approval.policy.capabilities.result", approvalPolicyCapabilities());
        return true;
      }
      if (payload.type === "approval.policy.validate") {
        Promise.resolve().then(() => validateApprovalPolicy(payload.policy))
          .then((result) => respond("approval.policy.validate.result", result))
          .catch((error) => respond("approval.policy.validate.result", {
            error: error.message || "approval policy validation failed",
            reason: error.code || "approval_policy_validation_failed",
          }));
        return true;
      }
      if (payload.type === "approval.policy.simulate") {
        Promise.resolve().then(() => evaluateApprovalRequest(
          payload.request,
          payload.policy,
          {
            workspace: payload.workspace || process.cwd(),
            stateDir: ensureStateDir(),
          },
        )).then((result) => respond("approval.policy.simulate.result", {
          effect: result.effect,
          policy_id: result.policyId,
          revision: result.revision,
          declarations: result.declarations,
          decisions: result.decisions.map((decision) => ({
            action: decision.atom.action,
            risk: decision.atom.risk,
            confidence: decision.atom.confidence,
            effect: decision.effect,
            matched_rules: decision.matchedRules,
            fallback: decision.fallback,
            resource_kind: decision.atom.resource?.kind || null,
          })),
        })).catch((error) => respond("approval.policy.simulate.result", {
          error: error.message || "approval policy simulation failed",
          reason: error.code || "approval_policy_simulation_failed",
        }));
        return true;
      }
      if (payload.type === "approval.policy.revisions") {
        Promise.resolve().then(() => listApprovalPolicyRevisions(
          payload.policyId,
          { stateDir: ensureStateDir() },
        )).then((revisions) => respond("approval.policy.revisions.result", {
          revisions,
        })).catch((error) => respond("approval.policy.revisions.result", {
          error: error.message || "approval policy revision list failed",
          reason: error.code || "approval_policy_revision_list_failed",
        }));
        return true;
      }
      if (payload.type === "approval.policy.rollback") {
        Promise.resolve().then(() => rollbackApprovalPolicy(
          payload.policyId,
          payload.revision,
          {
            stateDir: ensureStateDir(),
            expectedRevision: payload.expectedRevision || null,
          },
        )).then((restored) => respond("approval.policy.rollback.result", {
          policy: restored.summary,
        })).catch((error) => respond("approval.policy.rollback.result", {
          error: error.message || "approval policy rollback failed",
          reason: error.code || "approval_policy_rollback_failed",
        }));
        return true;
      }
      return false;
    }
    if (payload.type === "agent.workspace.browse") {
      const requestId = String(payload.requestId || "").slice(0, 96);
      if (!requestId || !this.agentCatalog) return false;
      browseAgentWorkspaces({
        path: payload.path,
        query: payload.query,
        limit: payload.limit,
        catalog: this.agentCatalog,
        deviceId: this.deviceId,
      }).then((page) => this.relayClient.send("agent.workspace.page", {
        requestId,
        ...page,
      })).catch((error) => this.relayClient.send("agent.workspace.page", {
        requestId,
        error: error.message || "workspace browse failed",
        reason: error.code || "workspace_browse_failed",
      })).catch((error) => {
        console.error(`[agent-workspace] ${error.message}`);
      });
      return true;
    }
    if (payload.type === "agent.workspace.trust") {
      const requestId = String(payload.requestId || "").slice(0, 96);
      if (!requestId || !this.agentCatalog) return false;
      Promise.resolve().then(() => this.agentCatalog.trustWorkspace(payload.path, {
        deviceId: this.deviceId,
      })).then((workspace) => this.relayClient.send("agent.workspace.trust.result", {
        requestId,
        workspace,
      })).catch((error) => this.relayClient.send("agent.workspace.trust.result", {
        requestId,
        error: error.message || "workspace trust failed",
        reason: error.code || "workspace_trust_failed",
      })).catch((error) => {
        console.error(`[agent-workspace] ${error.message}`);
      });
      return true;
    }
    if (payload.type === "agent.launch.request") {
      if (!this.managedAgentSupervisor) return false;
      this.managedAgentSupervisor.start(payload).catch((error) => {
        console.error(`[agent-launch] ${error.code || "launch_failed"}: ${error.message}`);
      });
      return true;
    }
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

    if (payload.type === "agent.audit.request") {
      const sessionId = String(payload.sessionId || "").slice(0, 64);
      const requestId = String(payload.requestId || "").slice(0, 96);
      const category = ["approval", "change"].includes(payload.category)
        ? payload.category
        : "";
      if (!sessionId || !requestId || !this.auditStore) return false;
      const page = this.auditStore.list(sessionId, {
        category,
        beforeCursor: payload.beforeCursor,
        limit: payload.limit,
      });
      this.relayClient.send("agent.audit.page", {
        sessionId,
        requestId,
        category,
        ...page,
      }).catch((error) => {
        console.error(`[audit] ${error.message}`);
      });
      return true;
    }

    if (payload.type === "agent.inquiry.request") {
      const sessionId = String(payload.sessionId || "").slice(0, 64);
      const requestId = String(payload.requestId || "").slice(0, 96);
      if (!sessionId || !requestId || !this.auditStore) return false;
      try {
        const evidenceBundle = buildAuditEvidenceBundle({
          auditStore: this.auditStore,
          sessionId,
          request: {
            protocol_version: payload.protocol_version,
            query_id: payload.query_id,
            domain: payload.domain,
            query: payload.query,
            scope: payload.scope,
            top_k: payload.top_k,
            token_budget: payload.token_budget,
          },
        });
        this.relayClient.send("agent.inquiry.page", {
          sessionId,
          requestId,
          domain: evidenceBundle.domain,
          queryId: evidenceBundle.query_id,
          evidenceBundle,
        }).catch((error) => {
          console.error(`[inquiry] ${error.message}`);
        });
      } catch (error) {
        this.relayClient.send("agent.inquiry.page", {
          sessionId,
          requestId,
          domain: String(payload.domain || ""),
          queryId: String(payload.query_id || ""),
          error: error.code || error.message || "invalid_inquiry_request",
        }).catch((sendError) => {
          console.error(`[inquiry] ${sendError.message}`);
        });
      }
      return true;
    }

    if (typeof payload.type === "string" && payload.type.startsWith("local_control.")) {
      this.handleLocalControlEvent(payload).catch((error) => {
        console.error(`[local-control] ${error.message || String(error)}`);
      });
      return;
    }

    const session = this.sessions.get(payload.sessionId);
    if (!session) return false;

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
        return session.adapter.resolvePermission(payload);
      } else if (payload.data) {
        session.executor.write(payload.data);
        return true;
      }
      return false;
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
      return true;
    }
    return true;
  }
}
