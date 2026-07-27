import { randomUUID } from "node:crypto";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);
const COMPLETE_EVENTS = new Set(["agent.task.complete", "agent.task.completed"]);

function safeText(value, maxLength = 16_384) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function compactId(value, maxLength = 64) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, maxLength);
}

function expectedRole(run) {
  if (["researching", "awaiting_plan_review"].includes(run.state)) return "lead";
  if (["planning", "implementing"].includes(run.state)) return "worker";
  if (run.state === "awaiting_verification") return run.agents.verifier ? "verifier" : "lead";
  return null;
}

function latestContent(run, types, predicate = () => true) {
  const wanted = new Set(types);
  return [...(run.messages || [])].reverse()
    .find((message) => wanted.has(message.type) && predicate(message))?.payload?.content || "";
}

function decision(text, positiveMarkers, negativeMarkers) {
  const normalized = String(text || "").toUpperCase();
  if (positiveMarkers.some((marker) => normalized.includes(marker))) return true;
  if (negativeMarkers.some((marker) => normalized.includes(marker))) return false;
  return false;
}

export class CollaborationRuntime {
  constructor({
    store,
    coordinator,
    supervisor,
    registry,
    catalog = null,
    relayClient = null,
    deviceId = "local",
    registrationTimeoutMs = 15_000,
    pollIntervalMs = 100,
  }) {
    this.store = store;
    this.coordinator = coordinator;
    this.supervisor = supervisor;
    this.registry = registry;
    this.catalog = catalog;
    this.relayClient = relayClient;
    this.deviceId = deviceId;
    this.registrationTimeoutMs = registrationTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.buffers = new Map();
    this.completedEvents = new Set();
    this.accountBudgetBlocked = false;
    this.queue = Promise.resolve();
    this.unsubscribe = registry?.subscribe?.((notification) => this.enqueue(notification)) || (() => {});
  }

  enqueue(notification) {
    this.queue = this.queue
      .then(() => this.handleRegistryNotification(notification))
      .catch((error) => this.failFromNotification(notification, error));
  }

  async start(runId) {
    let run = this.coordinator.start(runId);
    if (this.accountBudgetBlocked) {
      run = this.store.setAccountBudgetBlocked(run.run_id, true).run;
    }
    void this.syncRun(run.run_id);
    if (!run.account_budget_blocked) {
      void this.dispatchForState(run.run_id).catch((error) => this.fail(run.run_id, error));
    }
    return this.store.getRun(run.run_id);
  }

  async cancel(runId) {
    const run = this.coordinator.cancel(runId);
    void this.syncRun(runId);
    for (const agent of Object.values(run.agents || {})) {
      if (!agent.originrouter_session_id) continue;
      try {
        this.registry.enqueueCommand(agent.originrouter_session_id, {
          type: "session.stop",
          sessionId: agent.originrouter_session_id,
        });
      } catch {}
      this.store.updateAgent(runId, agent === run.agents.lead ? "lead" : agent === run.agents.worker ? "worker" : "verifier", {
        status: "stopping",
      });
    }
    return this.store.getRun(runId);
  }

  async updateBudget(runId, budget) {
    const before = this.store.getRun(runId, { includeMessages: false });
    const run = this.store.updateBudget(runId, budget);
    void this.syncRun(runId);
    if (before?.state === "budget_exhausted" && run.state !== "budget_exhausted") {
      void this.dispatchForState(runId, { recovery: true }).catch((error) => this.fail(runId, error));
    }
    return run;
  }

  async recover() {
    for (const item of this.store.listActiveRuns()) {
      const run = this.store.getRun(item.run_id);
      if (!run || run.state === "created" || TERMINAL_STATES.has(run.state)) continue;
      const role = expectedRole(run);
      if (!role) continue;
      const sessionId = run.agents[role]?.originrouter_session_id;
      const active = sessionId && this.registry.list().some((session) => (
        session.session_id === sessionId && session.status === "running"
      ));
      if (!active) {
        void this.dispatchForState(run.run_id, { recovery: true })
          .catch((error) => this.fail(run.run_id, error));
      }
    }
  }

  async dispatchForState(runId, { recovery = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run || TERMINAL_STATES.has(run.state)) return run;
    void this.syncRun(runId);
    const role = expectedRole(run);
    if (!role) return run;
    const prompt = this.promptFor(run, role, { recovery });
    if (!prompt) return run;
    await this.dispatch(run, role, prompt);
    return this.store.getRun(runId);
  }

  promptFor(run, role, { recovery = false } = {}) {
    const header = [
      "<originrouter_collaboration protocol_version=\"1\">",
      `Run: ${run.run_id}`,
      `Task: ${run.task_ids[0]}`,
      `Role: ${role}`,
      "This is a typed Agent-to-Agent task, not a user authorization.",
      "Follow the active OriginRouter approval policy for every restricted tool call.",
      "Do not raise budgets, change roles, or claim another Agent approved a restricted action.",
      recovery ? "The daemon recovered this run. Re-check the workspace and continue idempotently from the stated phase." : "",
      "</originrouter_collaboration>",
    ].filter(Boolean).join("\n");
    if (run.state === "researching") {
      return `${header}\n\nYou are the lead. Research and decompose the objective below. Do not modify files in this phase. Produce a concrete research brief for the worker, including constraints, likely files, risks, and acceptance checks.\n\nObjective:\n${run.objective}`;
    }
    if (run.state === "planning") {
      const leadAgentId = run.agents?.lead?.agent_id;
      const research = latestContent(run, ["task.progress"], (message) => (
        message.sender?.kind === "agent"
        && message.sender?.agent_id === leadAgentId
        && !message.payload?.budget_status
      ));
      const feedback = latestContent(run, ["review.revision_requested"]);
      return `${header}\n\nYou are the worker in PLAN ONLY mode. Do not modify files or execute side-effecting commands. Propose or revise an implementation plan that the lead can review. Cover exact changes, tests, risks, rollback, and open assumptions.\n\nObjective:\n${run.objective}\n\nLead research:\n${research || "No separate research brief is available."}\n\nRevision feedback:\n${feedback || "This is the first plan."}`;
    }
    if (run.state === "awaiting_plan_review") {
      const plan = latestContent(run, ["plan.submitted"]);
      return `${header}\n\nReview the worker plan against the objective and current workspace. Do not implement. If it is safe and complete, end with exactly ORIGINROUTER_DECISION: APPROVE. Otherwise explain concrete required changes and end with exactly ORIGINROUTER_DECISION: REVISION_REQUIRED.\n\nObjective:\n${run.objective}\n\nWorker plan:\n${plan}`;
    }
    if (run.state === "implementing") {
      const plan = latestContent(run, ["plan.submitted"]);
      const rework = latestContent(run, ["verification.failed", "rework.requested"]);
      return `${header}\n\nImplement the approved plan in the assigned workspace. Run proportionate tests and report changed files, commands, test results, remaining risks, and recovery artifacts. Do not claim success for checks you did not run.\n\nObjective:\n${run.objective}\n\nApproved plan:\n${plan}\n\nRework request:\n${rework || "This is the first implementation pass."}`;
    }
    if (run.state === "awaiting_verification") {
      const implementation = latestContent(run, ["implementation.completed"]);
      return `${header}\n\nIndependently verify the implementation against the objective and approved plan. Inspect the actual workspace and run suitable checks. If complete and correct, end with exactly ORIGINROUTER_VERIFICATION: PASS. Otherwise list reproducible defects and end with exactly ORIGINROUTER_VERIFICATION: REWORK.\n\nObjective:\n${run.objective}\n\nImplementation report:\n${implementation}`;
    }
    return "";
  }

  async dispatch(run, role, prompt) {
    const agent = run.agents[role];
    if (!agent) throw new Error(`missing collaboration role: ${role}`);
    const turnKey = `${run.state}:${run.counters.plan_revisions || 0}:${run.counters.rework_rounds || 0}`;
    const messageKey = `dispatch-${role}-${turnKey}`;
    this.store.appendMessage(run.run_id, {
      task_id: run.task_ids[0],
      type: "agent.message",
      idempotency_key: messageKey,
      sender: { kind: "coordinator", device_id: this.deviceId },
      recipient: { kind: "agent", agent_id: agent.agent_id, device_id: agent.device_id },
      payload: { phase: run.state, content: prompt },
    });
    this.buffers.set(`${run.run_id}:${role}`, []);
    if (agent.device_id !== this.deviceId && agent.device_id !== "local") {
      if (!this.relayClient) throw new Error("collaboration relay is unavailable");
      const assignmentId = compactId(`assign-${run.run_id}-${role}`, 96);
      const result = await this.relayClient.send("collaboration.remote.dispatch", {
        protocolVersion: "1",
        sourceDeviceId: this.deviceId,
        targetDeviceId: agent.device_id,
        deliveryId: compactId(`delivery-${run.run_id}-${role}-${turnKey}`, 96),
        assignmentId,
        runId: run.run_id,
        taskId: run.task_ids[0],
        role,
        phase: run.state,
        runtime: agent.runtime,
        workspaceId: agent.workspace_id,
        provider: agent.provider,
        model: agent.model,
        permissionProfile: agent.permission_profile || "manual",
        prompt,
      });
      const data = result?.data || result || {};
      if (data.accepted === false && !data.queued) {
        const error = new Error(data.reason || "remote collaboration dispatch rejected");
        error.code = String(data.reason || "COLLABORATION_REMOTE_DISPATCH_REJECTED");
        throw error;
      }
      this.store.updateAgent(run.run_id, role, { status: data.queued ? "waiting_device" : "dispatched" });
      return;
    }
    let sessionId = agent.originrouter_session_id;
    let active = sessionId && this.registry.list().some((session) => (
      session.session_id === sessionId && session.status === "running"
    ));
    if (!active) {
      sessionId = compactId(`collab-${role}-${randomUUID()}`);
      const conversationId = agent.conversation_id || compactId(`collab-${run.run_id}-${role}`, 96);
      const launch = await this.supervisor.start({
        launchId: compactId(`launch-${run.run_id}-${role}-${randomUUID()}`, 96),
        sessionId,
        conversationId,
        runId: run.run_id,
        agentType: agent.runtime,
        workspaceId: agent.workspace_id,
        provider: agent.provider,
        model: agent.model,
        permissionProfile: agent.permission_profile || "manual",
        ...(agent.native_session_id ? {
          resumeConversationId: conversationId,
          nativeSessionId: agent.native_session_id,
        } : {}),
        title: `${run.objective.slice(0, 120)} · ${role}`,
        startedBy: "collaboration-runtime",
      });
      this.store.updateAgent(run.run_id, role, {
        status: "starting",
        originrouterSessionId: launch.sessionId,
        conversationId: launch.conversationId,
      });
      await this.waitForSession(launch.sessionId);
      active = true;
    }
    if (!active) throw new Error(`collaboration Agent ${role} did not become ready`);
    if (run.state === "planning") {
      this.registry.enqueueCommand(sessionId, { type: "agent.mode.set", sessionId, mode: "plan" });
    } else {
      this.registry.enqueueCommand(sessionId, { type: "agent.mode.set", sessionId, mode: "default" });
    }
    this.registry.enqueueCommand(sessionId, {
      type: "agent.message",
      sessionId,
      message: prompt,
      messageId: messageKey,
    });
    this.store.updateAgent(run.run_id, role, { status: "running" });
  }

  async waitForSession(sessionId) {
    const deadline = Date.now() + this.registrationTimeoutMs;
    while (Date.now() < deadline) {
      if (this.registry.list().some((session) => (
        session.session_id === sessionId && session.status === "running"
      ))) return;
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    const error = new Error("managed Agent did not register with the local daemon");
    error.code = "COLLABORATION_AGENT_START_TIMEOUT";
    throw error;
  }

  async handleRegistryNotification(notification) {
    const binding = this.store.findAgentBySession(notification.sessionId);
    if (!binding) {
      const assignment = this.store.findRemoteAssignmentBySession(notification.sessionId);
      if (assignment) await this.handleRemoteAgentNotification(assignment, notification);
      return;
    }
    if (notification.type === "registered" || notification.type === "updated") {
      const nativeSessionId = notification.payload.nativeSessionId || notification.payload.native_session_id;
      this.store.updateAgent(binding.run_id, binding.role, {
        status: notification.type === "registered" ? "running" : undefined,
        ...(nativeSessionId ? { nativeSessionId } : {}),
      });
      return;
    }
    if (notification.type === "unregistered") {
      this.store.updateAgent(binding.run_id, binding.role, { status: notification.payload.status || "stopped" });
      return;
    }
    if (notification.type !== "event") return;
    const event = notification.payload || {};
    if (event.type === "agent.usage") {
      const usageId = `usage-${notification.sessionId}-${event.eventId || event.localSequence}`;
      const usage = this.store.recordUsage(binding.run_id, {
        eventId: usageId,
        agentId: this.store.getRun(binding.run_id, { includeMessages: false })?.agents?.[binding.role]?.agent_id,
        sampledTokens: event.sampledTokens,
        amountMicros: event.amountMicros,
        currency: event.currency,
        costSource: event.costSource,
      });
      void this.reportUsage(binding.run_id, usageId, event);
      await this.handleBudgetResult(binding.run_id, binding.role, notification.sessionId, usage);
      return;
    }
    const key = `${binding.run_id}:${binding.role}`;
    if (event.type === "agent.text" && safeText(event.text)) {
      const buffer = this.buffers.get(key) || [];
      buffer.push(safeText(event.text));
      this.buffers.set(key, buffer.slice(-32));
    }
    if (!COMPLETE_EVENTS.has(event.type)) return;
    const completionKey = `${notification.sessionId}:${event.eventId || event.id || event.localSequence}`;
    if (this.completedEvents.has(completionKey)) return;
    this.completedEvents.add(completionKey);
    const completionStatus = safeText(event.status, 32).toLowerCase();
    if (
      event.isError === true
      || ["failed", "error", "aborted", "cancelled", "canceled"].includes(completionStatus)
    ) {
      const error = new Error(
        safeText(event.error?.message || event.message, 2048)
        || `Collaboration Agent ${binding.role} turn failed${completionStatus ? ` (${completionStatus})` : ""}.`,
      );
      error.code = safeText(event.code, 96) || "COLLABORATION_AGENT_TURN_FAILED";
      await this.fail(binding.run_id, error);
      return;
    }
    const buffer = this.buffers.get(key) || [];
    const output = safeText(event.result || buffer.join("\n\n"), 16_384);
    this.buffers.set(key, []);
    await this.handleTurnCompleted(binding.run_id, binding.role, output, completionKey);
  }

  async handleRelayEvent(payload = {}) {
    if (payload.type === "collaboration.budget.status") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const blocked = Boolean(payload.blocked);
      this.accountBudgetBlocked = blocked;
      const requestedRunId = safeText(payload.run_id ?? payload.runId, 195);
      const runIds = requestedRunId
        ? [requestedRunId]
        : this.store.listActiveRuns({ limit: 500 }).map((run) => run.run_id);
      for (const runId of runIds) {
        const before = this.store.getRun(runId, { includeMessages: false });
        if (!before) continue;
        const activeRole = expectedRole(before);
        const result = this.store.setAccountBudgetBlocked(runId, blocked);
        const run = result.run;
        if (!run || !result.changed) continue;
        this.store.appendMessage(runId, {
          task_id: run.task_ids[0],
          type: "task.progress",
          idempotency_key: `account-budget-${blocked ? "blocked" : "resumed"}-${compactId(run.updated_at, 80)}`,
          sender: { kind: "coordinator", device_id: this.deviceId },
          recipient: { kind: "user" },
          payload: {
            content: blocked
              ? "Daily or weekly account budget exhausted; the Coordinator paused further work."
              : result.restored
                ? "Account budget is available again; the Coordinator resumed the paused phase."
                : "Account budget is available again; this run remains paused by its task budget.",
            budget_status: blocked ? "account_exhausted" : "account_available",
            account_budget: true,
          },
        });
        if (blocked) {
          const agent = activeRole ? before.agents[activeRole] : null;
          if (agent?.originrouter_session_id) {
            try {
              this.registry.enqueueCommand(agent.originrouter_session_id, {
                type: "terminal.interrupt",
                sessionId: agent.originrouter_session_id,
              });
            } catch {}
          }
        } else if (result.restored) {
          void this.dispatchForState(runId, { recovery: true })
            .catch((error) => this.fail(runId, error));
        }
        void this.syncRun(runId);
      }
      return true;
    }
    if (!String(payload.type || "").startsWith("collaboration.remote.")) return false;
    if (payload.type === "collaboration.remote.dispatch") {
      try {
        await this.receiveRemoteDispatch(payload);
      } catch (error) {
        await this.relayClient?.send("collaboration.remote.error", {
          protocolVersion: "1",
          sourceDeviceId: this.deviceId,
          targetDeviceId: safeText(payload.sourceDeviceId, 191),
          runId: safeText(payload.runId, 195),
          taskId: safeText(payload.taskId, 195),
          role: safeText(payload.role, 32),
          deliveryId: safeText(payload.deliveryId, 96),
          code: safeText(error?.code || "remote_dispatch_failed", 96),
          message: safeText(error?.message || "Remote collaboration dispatch failed.", 2048),
        });
      }
      return true;
    }
    if (payload.type === "collaboration.remote.result") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const run = this.store.getRun(payload.runId);
      if (!run || run.task_ids[0] !== payload.taskId) return true;
      const role = safeText(payload.role, 32);
      if (expectedRole(run) !== role) return true;
      if (payload.nativeSessionId || payload.conversationId) {
        this.store.updateAgent(run.run_id, role, {
          status: "idle",
          nativeSessionId: payload.nativeSessionId,
          conversationId: payload.conversationId,
        });
      }
      await this.handleTurnCompleted(
        run.run_id,
        role,
        safeText(payload.output),
        safeText(payload.completionId, 160) || compactId(`remote-${payload.deliveryId || randomUUID()}`, 160),
      );
      return true;
    }
    if (payload.type === "collaboration.remote.usage") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const run = this.store.getRun(payload.runId, { includeMessages: false });
      const role = safeText(payload.role, 32);
      if (!run || !run.agents[role] || run.task_ids[0] !== payload.taskId) return true;
      const usage = this.store.recordUsage(run.run_id, {
        eventId: `usage-${safeText(payload.usageId, 160)}`,
        agentId: run.agents[role].agent_id,
        sampledTokens: payload.sampledTokens,
        amountMicros: payload.amountMicros,
        currency: payload.currency,
        costSource: payload.costSource,
      });
      void this.reportUsage(run.run_id, `usage-${safeText(payload.usageId, 160)}`, payload);
      await this.handleBudgetResult(run.run_id, role, null, usage);
      if (usage.exhausted) {
        await this.relayClient?.send("collaboration.remote.cancel", {
          protocolVersion: "1",
          sourceDeviceId: this.deviceId,
          targetDeviceId: run.agents[role].device_id,
          assignmentId: safeText(payload.assignmentId, 195),
          runId: run.run_id,
          taskId: run.task_ids[0],
          role,
          reason: "budget_exhausted",
          deliveryId: compactId(`budget-cancel-${run.run_id}-${role}`, 96),
        });
      }
      return true;
    }
    if (payload.type === "collaboration.remote.cancel") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const assignment = this.store.getRemoteAssignment(payload.assignmentId);
      if (!assignment || assignment.run_id !== payload.runId) return true;
      if (assignment.originrouter_session_id) {
        try {
          this.registry.enqueueCommand(assignment.originrouter_session_id, {
            type: "terminal.interrupt",
            sessionId: assignment.originrouter_session_id,
          });
        } catch {}
      }
      this.store.updateRemoteAssignment(assignment.assignment_id, { status: "budget_exhausted" });
      return true;
    }
    if (payload.type === "collaboration.remote.error") {
      if (safeText(payload.targetDeviceId, 191) === this.deviceId && payload.runId) {
        await this.fail(payload.runId, Object.assign(
          new Error(safeText(payload.message, 2048) || "Remote collaboration Agent failed."),
          { code: safeText(payload.code, 96) },
        ));
      }
      return true;
    }
    return true;
  }

  async receiveRemoteDispatch(payload) {
    if (safeText(payload.protocolVersion, 8) !== "1") throw new Error("unsupported collaboration protocol");
    if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return;
    if (safeText(payload.sourceDeviceId, 191) === this.deviceId) throw new Error("invalid collaboration source device");
    const prompt = safeText(payload.prompt, 32_768);
    if (!prompt) throw new Error("remote collaboration prompt is required");
    let assignment = this.store.upsertRemoteAssignment({
      assignmentId: payload.assignmentId,
      runId: payload.runId,
      taskId: payload.taskId,
      role: payload.role,
      phase: payload.phase,
      sourceDeviceId: payload.sourceDeviceId,
      targetDeviceId: payload.targetDeviceId,
      runtime: payload.runtime,
      workspaceId: payload.workspaceId,
      provider: payload.provider,
      model: payload.model,
      permissionProfile: payload.permissionProfile,
    });
    const bufferKey = `remote:${assignment.assignment_id}`;
    this.buffers.set(bufferKey, []);
    let sessionId = assignment.originrouter_session_id;
    let active = sessionId && this.registry.list().some((session) => (
      session.session_id === sessionId && session.status === "running"
    ));
    if (!active) {
      sessionId = compactId(`collab-remote-${assignment.role}-${randomUUID()}`);
      const conversationId = assignment.conversation_id
        || compactId(`remote-${assignment.run_id}-${assignment.role}`, 96);
      const launch = await this.supervisor.start({
        launchId: compactId(`remote-launch-${payload.deliveryId || randomUUID()}`, 96),
        sessionId,
        conversationId,
        runId: assignment.run_id,
        agentType: assignment.runtime,
        workspaceId: assignment.workspace_id,
        provider: assignment.provider,
        model: assignment.model,
        permissionProfile: assignment.permission_profile || "manual",
        ...(assignment.native_session_id ? {
          resumeConversationId: conversationId,
          nativeSessionId: assignment.native_session_id,
        } : {}),
        title: `Remote collaboration · ${assignment.role}`,
        startedBy: "collaboration-remote",
      });
      assignment = this.store.updateRemoteAssignment(assignment.assignment_id, {
        status: "starting",
        originrouterSessionId: launch.sessionId,
        conversationId: launch.conversationId,
        phase: payload.phase,
      });
      await this.waitForSession(launch.sessionId);
      active = true;
    }
    if (!active) throw new Error("remote collaboration Agent did not become ready");
    this.registry.enqueueCommand(sessionId, {
      type: "agent.mode.set",
      sessionId,
      mode: payload.phase === "planning" ? "plan" : "default",
    });
    this.registry.enqueueCommand(sessionId, {
      type: "agent.message",
      sessionId,
      message: prompt,
      messageId: safeText(payload.deliveryId, 96),
    });
    this.store.updateRemoteAssignment(assignment.assignment_id, { status: "running", phase: payload.phase });
  }

  async handleRemoteAgentNotification(assignment, notification) {
    if (notification.type === "registered" || notification.type === "updated") {
      const nativeSessionId = notification.payload.nativeSessionId || notification.payload.native_session_id;
      this.store.updateRemoteAssignment(assignment.assignment_id, {
        status: notification.type === "registered" ? "running" : assignment.status,
        ...(nativeSessionId ? { nativeSessionId } : {}),
      });
      return;
    }
    if (notification.type === "unregistered") {
      this.store.updateRemoteAssignment(assignment.assignment_id, {
        status: notification.payload.status || "stopped",
      });
      return;
    }
    if (notification.type !== "event") return;
    const event = notification.payload || {};
    if (event.type === "agent.usage") {
      await this.relayClient?.send("collaboration.remote.usage", {
        protocolVersion: "1",
        sourceDeviceId: this.deviceId,
        targetDeviceId: assignment.source_device_id,
        assignmentId: assignment.assignment_id,
        runId: assignment.run_id,
        taskId: assignment.task_id,
        role: assignment.role,
        usageId: `${notification.sessionId}-${event.eventId || event.localSequence}`,
        sampledTokens: Math.max(0, Math.floor(Number(event.sampledTokens) || 0)),
        amountMicros: event.amountMicros == null ? null : Math.max(0, Math.floor(Number(event.amountMicros) || 0)),
        currency: safeText(event.currency, 3).toUpperCase(),
        costSource: safeText(event.costSource, 32),
      });
      return;
    }
    const key = `remote:${assignment.assignment_id}`;
    if (event.type === "agent.text" && safeText(event.text)) {
      const buffer = this.buffers.get(key) || [];
      buffer.push(safeText(event.text));
      this.buffers.set(key, buffer.slice(-32));
    }
    if (!COMPLETE_EVENTS.has(event.type)) return;
    const completionId = `${notification.sessionId}:${event.eventId || event.id || event.localSequence}`;
    if (this.completedEvents.has(completionId)) return;
    this.completedEvents.add(completionId);
    const output = safeText(event.result || (this.buffers.get(key) || []).join("\n\n"));
    this.buffers.set(key, []);
    const latest = this.store.updateRemoteAssignment(assignment.assignment_id, { status: "idle" });
    await this.relayClient?.send("collaboration.remote.result", {
      protocolVersion: "1",
      sourceDeviceId: this.deviceId,
      targetDeviceId: latest.source_device_id,
      assignmentId: latest.assignment_id,
      runId: latest.run_id,
      taskId: latest.task_id,
      role: latest.role,
      phase: latest.phase,
      completionId,
      output,
      nativeSessionId: latest.native_session_id,
      conversationId: latest.conversation_id,
    });
  }

  async handleTurnCompleted(runId, role, output, completionKey) {
    let run = this.store.getRun(runId);
    if (!run || TERMINAL_STATES.has(run.state) || expectedRole(run) !== role) return;
    const base = {
      task_id: run.task_ids[0],
      sender: { kind: "agent", agent_id: run.agents[role].agent_id, device_id: run.agents[role].device_id },
      recipient: { kind: "coordinator", device_id: this.deviceId },
      payload: { content: output || "Agent completed without a textual report." },
    };
    if (run.state === "researching") {
      this.coordinator.receive(runId, { ...base, type: "task.progress", idempotency_key: `research-${completionKey}` });
      run = this.coordinator.beginPlanning(runId);
      await this.dispatchForState(runId);
      return;
    }
    if (run.state === "planning") {
      run = this.coordinator.receive(runId, { ...base, type: "plan.submitted", idempotency_key: `plan-${completionKey}` }).run;
      if (run.gates.plan_requires_approval === false) {
        run = this.coordinator.receive(runId, {
          ...base,
          type: "review.approved",
          idempotency_key: `auto-plan-approval-${completionKey}`,
          sender: { kind: "coordinator", device_id: this.deviceId },
        }).run;
        this.coordinator.beginImplementation(runId);
      }
      await this.dispatchForState(runId);
      return;
    }
    if (run.state === "awaiting_plan_review") {
      const approved = decision(output, ["ORIGINROUTER_DECISION: APPROVE"], ["ORIGINROUTER_DECISION: REVISION_REQUIRED"]);
      run = this.coordinator.receive(runId, {
        ...base,
        type: approved ? "review.approved" : "review.revision_requested",
        idempotency_key: `plan-review-${completionKey}`,
      }).run;
      if (run.state === "plan_approved") this.coordinator.beginImplementation(runId);
      else if (run.state === "revision_requested") this.coordinator.beginPlanning(runId);
      await this.dispatchForState(runId);
      return;
    }
    if (run.state === "implementing") {
      run = this.coordinator.receive(runId, { ...base, type: "implementation.completed", idempotency_key: `implementation-${completionKey}` }).run;
      if (run.gates.implementation_requires_verification === false) {
        this.coordinator.receive(runId, {
          ...base,
          type: "verification.passed",
          idempotency_key: `auto-verification-${completionKey}`,
          sender: { kind: "coordinator", device_id: this.deviceId },
        });
        void this.syncRun(runId);
        return;
      }
      await this.dispatchForState(runId);
      return;
    }
    if (run.state === "awaiting_verification") {
      const passed = decision(output, ["ORIGINROUTER_VERIFICATION: PASS"], ["ORIGINROUTER_VERIFICATION: REWORK"]);
      run = this.coordinator.receive(runId, {
        ...base,
        type: passed ? "verification.passed" : "verification.failed",
        idempotency_key: `verification-${completionKey}`,
      }).run;
      if (run.state === "rework_requested") {
        this.coordinator.beginImplementation(runId);
        await this.dispatchForState(runId);
      } else {
        void this.syncRun(runId);
      }
    }
  }

  async handleBudgetResult(runId, role, sessionId, result) {
    if (!result || result.duplicate || !result.warning) return;
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run) return;
    this.store.appendMessage(runId, {
      task_id: run.task_ids[0],
      type: "task.progress",
      idempotency_key: `budget-${result.warning}-${runId}`,
      sender: { kind: "coordinator", device_id: this.deviceId },
      recipient: { kind: "user" },
      payload: {
        content: result.exhausted
          ? "Task budget exhausted; the Coordinator paused further work."
          : "Task budget reached 80%; review usage before continuing.",
        budget_status: result.warning,
        ratio: Number(result.ratio || 0),
        role,
      },
    });
    if (result.exhausted && sessionId) {
      try {
        this.registry.enqueueCommand(sessionId, { type: "terminal.interrupt", sessionId });
      } catch {}
    }
    void this.syncRun(runId);
  }

  async syncRun(runId) {
    if (!this.relayClient) return;
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run) return;
    await this.relayClient.send("collaboration.run.project", {
      sourceDeviceId: this.deviceId,
      runId: run.run_id,
      templateId: run.template_id,
      objectivePreview: safeText(run.objective, 512),
      state: run.state,
      taskTitle: safeText(run.tasks[0]?.title, 256),
      budget: run.budget,
      usage: run.usage,
      counters: run.counters,
      createdAt: Math.floor(new Date(run.created_at).getTime() / 1000),
      finishedAt: run.finished_at ? Math.floor(new Date(run.finished_at).getTime() / 1000) : null,
    });
  }

  async reportUsage(runId, usageId, usage) {
    if (!this.relayClient) return;
    await this.relayClient.send("collaboration.usage.report", {
      sourceDeviceId: this.deviceId,
      usageId: safeText(usageId, 191),
      runId,
      sampledTokens: Math.max(0, Math.floor(Number(usage.sampledTokens) || 0)),
      amountMicros: usage.amountMicros == null ? null : Math.max(0, Math.floor(Number(usage.amountMicros) || 0)),
      currency: safeText(usage.currency, 3).toUpperCase(),
      costSource: safeText(usage.costSource, 32),
    });
  }

  async refreshAccountBudgetStatus() {
    if (!this.relayClient) return { accepted: false, reason: "relay_unavailable" };
    return this.relayClient.send("collaboration.budget.status.request", {
      sourceDeviceId: this.deviceId,
    });
  }

  async failFromNotification(notification, error) {
    const binding = this.store.findAgentBySession(notification?.sessionId);
    if (binding) await this.fail(binding.run_id, error);
  }

  async fail(runId, error) {
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run || TERMINAL_STATES.has(run.state)) return;
    try {
      this.coordinator.receive(runId, {
        task_id: run.task_ids[0],
        type: "task.failed",
        idempotency_key: `runtime-failed-${compactId(error?.code || error?.message || randomUUID(), 80)}-${run.updated_at}`,
        sender: { kind: "coordinator", device_id: this.deviceId },
        recipient: { kind: "user" },
        payload: { content: safeText(error?.message || "Collaboration runtime failed.", 2048), code: safeText(error?.code, 96) },
      });
    } catch {
      this.store.transition(runId, "failed", { taskState: "failed" });
    }
    for (const [role, agent] of Object.entries(run.agents || {})) {
      if (!agent.originrouter_session_id) continue;
      try {
        this.registry.enqueueCommand(agent.originrouter_session_id, {
          type: "session.stop",
          sessionId: agent.originrouter_session_id,
        });
        this.store.updateAgent(runId, role, { status: "stopping" });
      } catch {}
    }
  }

  close() { this.unsubscribe(); }
}
