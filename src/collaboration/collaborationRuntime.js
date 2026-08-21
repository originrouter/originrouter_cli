import { randomUUID } from "node:crypto";

import {
  ADAPTIVE_TEMPLATE_ID,
  buildPlannerPrompt,
  parsePlannerOutput,
  taskPrompt,
} from "./adaptivePlan.js";
import { browseAgentWorkspaces } from "../daemon/workspaceBrowser.js";
import { displaySafeToolInput } from "../runtime/displaySafeToolInput.js";
import { CollaborationApprovalSupervisor } from "./collaborationApprovalSupervisor.js";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);
const COMPLETE_EVENTS = new Set(["agent.task.complete", "agent.task.completed"]);
const FAILED_EVENTS = new Set(["agent.task.failed", "agent.task.aborted"]);
const FATAL_DELIVERY_CODES = new Set([
  "COLLABORATION_ASSIGNMENT_CONFLICT",
  "COLLABORATION_FENCING_CONFLICT",
  "COLLABORATION_OUTBOX_CONFLICT",
  "DEVICE_E2EE_AUTH_UNAVAILABLE",
  "DEVICE_E2EE_DIRECTORY_FORK",
  "device_e2ee_required",
]);
const AGENT_RESUME_BINDING_CODES = new Set([
  "INVALID_RESUME_REQUEST",
  "RESUME_AGENT_MISMATCH",
  "RESUME_CONVERSATION_NOT_FOUND",
  "RESUME_SESSION_MISMATCH",
  "RESUME_WORKSPACE_MISMATCH",
]);

function safeText(value, maxLength = 16_384) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function compactId(value, maxLength = 64) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, maxLength);
}

function isAgentResumeBindingError(error) {
  return AGENT_RESUME_BINDING_CODES.has(safeText(error?.code, 96));
}

function expectedRole(run) {
  if (["researching", "awaiting_plan_review"].includes(run.state)) return "lead";
  if (["planning", "implementing"].includes(run.state)) return "worker";
  if (run.state === "awaiting_verification") return run.agents.verifier ? "verifier" : "lead";
  return null;
}

function activeRoles(run) {
  if (run?.template_id === ADAPTIVE_TEMPLATE_ID) {
    return Object.entries(run.agents || {})
      .filter(([, agent]) => agent.current_task_id)
      .map(([role]) => role);
  }
  const role = expectedRole(run);
  return role ? [role] : [];
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

function retryableDeliveryError(error) {
  const code = safeText(error?.code, 96);
  if (FATAL_DELIVERY_CODES.has(code)) return false;
  return !/forbidden|invalid.*(payload|assignment|message)/i.test(
    `${code} ${safeText(error?.message, 256)}`,
  );
}

function executionEventProjection(event = {}) {
  const type = safeText(event.type, 96) || "agent.activity";
  const activity = safeText(event.activity, 64);
  const summary = safeText(
    event.summary
      || event.message
      || event.title
      || (activity ? activity.replaceAll("_", " ") : type.replaceAll(".", " ")),
    1024,
  );
  const detail = safeText(
    event.detail
      || event.text
      || event.result
      || event.error?.message
      || event.reason,
    8192,
  );
  return {
    type,
    summary,
    detail,
    payload: type.startsWith("agent.interaction.") ? {
      interaction_id: safeText(event.interactionId || event.callId, 191),
      kind: safeText(event.kind, 64) || null,
      source: safeText(event.source, 64) || null,
      contains_secret: event.containsSecret === true,
      expires_at: event.expiresAt || null,
      status: safeText(event.status, 32) || null,
      action: safeText(event.action, 64) || null,
      decision_source: safeText(event.decisionSource, 191) || null,
      ...(type === "agent.interaction.requested" ? {
        approval_request: {
          ...displaySafeToolInput({
          interactionId: safeText(event.interactionId || event.callId, 191),
          kind: safeText(event.kind, 64) || "input",
          title: safeText(event.title, 512),
          prompt: safeText(event.prompt || event.message, 2048),
          payload: {
            tool: safeText(event.tool || event.toolName || event.tool_name, 128),
            display_name: safeText(event.display_name || event.displayName, 256),
            blocked_path: safeText(event.blocked_path || event.blockedPath, 4096),
            tool_input: event.tool_input || event.toolInput || null,
            command: event.command || null,
            cwd: safeText(event.cwd, 4096),
            file_changes: event.file_changes || event.fileChanges || null,
            additional_permissions: event.additional_permissions || event.additionalPermissions || null,
            network_approval_context: event.network_approval_context || event.networkApprovalContext || null,
            default_approval_option: safeText(event.default_approval_option || event.defaultApprovalOption, 128),
          },
          }),
          containsSecret: event.containsSecret === true,
        },
      } : {}),
    } : {},
    metadata: {
      ...(activity ? { activity } : {}),
      ...(safeText(event.kind, 64) ? { kind: safeText(event.kind, 64) } : {}),
      ...(safeText(event.status, 32) ? { status: safeText(event.status, 32) } : {}),
      ...(safeText(event.toolName ?? event.tool_name, 128)
        ? { tool: safeText(event.toolName ?? event.tool_name, 128) }
        : {}),
    },
  };
}

function interactionAttentionKind(kind) {
  return kind === "permission" ? "approval" : "input";
}

function interactionAttentionActions(kind) {
  return kind === "permission"
    ? ["allow", "deny"]
    : ["submit", "cancel"];
}

function collaborationSnapshotSummary(snapshot) {
  if (!snapshot) return null;
  return {
    ...snapshot.run,
    schema_version: snapshot.schema_version,
    revision: snapshot.revision,
    last_sequence: snapshot.last_sequence,
    plan: snapshot.plan,
    tasks: snapshot.tasks,
    agents: Object.fromEntries(
      (snapshot.participants || []).map((participant) => [
        participant.participant_id,
        participant,
      ]),
    ),
    attention: snapshot.attention,
    artifacts: snapshot.artifacts,
    budget: snapshot.budget,
    usage: snapshot.usage,
    final_report: snapshot.final_report,
    capabilities: snapshot.capabilities,
  };
}

export class CollaborationRuntime {
  constructor({
    store,
    coordinator,
    supervisor,
    registry,
    catalog = null,
    relayClient = null,
    capabilityProvider = null,
    approvalSupervisor = null,
    deviceId = "local",
    registrationTimeoutMs = 15_000,
    pollIntervalMs = 100,
    leaseTtlMs = 30 * 60_000,
  }) {
    this.store = store;
    this.coordinator = coordinator;
    this.supervisor = supervisor;
    this.registry = registry;
    this.catalog = catalog;
    this.relayClient = relayClient;
    this.capabilityProvider = capabilityProvider;
    this.approvalSupervisor = approvalSupervisor || new CollaborationApprovalSupervisor();
    this.deviceId = deviceId;
    this.registrationTimeoutMs = registrationTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseTtlMs = Math.max(60_000, Number(leaseTtlMs) || 0);
    this.buffers = new Map();
    this.completedEvents = new Set();
    this.accountBudgetBlocked = false;
    this.queue = Promise.resolve();
    this.outboxFlush = Promise.resolve();
    this.outboxDeliveries = new Map();
    this.outboxRetryTimer = null;
    this.mcpRequests = new Map();
    this.capabilityRequests = new Map();
    this.workspaceTrustRequests = new Map();
    this.workspaceBrowseRequests = new Map();
    this.unsubscribe = registry?.subscribe?.((notification) => this.enqueue(notification)) || (() => {});
  }

  mcpBinding(sessionId) {
    const local = this.store.findAgentBySession(sessionId);
    if (local) {
      const run = this.store.getRun(local.run_id, { includeMessages: false });
      const agent = run?.agents?.[local.role];
      return {
        coordinator: true,
        runId: local.run_id,
        role: local.role,
        taskId: agent?.current_task_id,
        sourceDeviceId: this.deviceId,
      };
    }
    const remote = this.store.findRemoteAssignmentBySession(sessionId);
    if (remote) {
      return {
        coordinator: false,
        runId: remote.run_id,
        role: remote.role,
        taskId: remote.task_id,
        sourceDeviceId: this.deviceId,
        coordinatorDeviceId: remote.source_device_id,
      };
    }
    return null;
  }

  async handleMcpGatewayRequest({ sessionId, action, payload = {} } = {}) {
    const binding = this.mcpBinding(safeText(sessionId, 64));
    if (!binding?.runId || !binding?.role || !binding?.taskId) {
      const error = new Error("This Agent session is not attached to an active collaboration task.");
      error.code = "COLLABORATION_MCP_SESSION_UNAVAILABLE";
      throw error;
    }
    const normalizedAction = safeText(action, 32);
    if (!["list", "delegate", "status"].includes(normalizedAction)) {
      const error = new Error("Unsupported Agent MCP gateway action.");
      error.code = "COLLABORATION_MCP_ACTION_INVALID";
      throw error;
    }
    const requestId = compactId(`mcp-${randomUUID()}`, 64);
    if (binding.coordinator) {
      return this.executeMcpGatewayRequest({
        requestId,
        runId: binding.runId,
        sourceRole: binding.role,
        sourceTaskId: binding.taskId,
        sourceDeviceId: binding.sourceDeviceId,
        action: normalizedAction,
        payload,
      });
    }
    if (!this.relayClient) {
      const error = new Error("OriginRouter virtual network is unavailable.");
      error.code = "COLLABORATION_MCP_RELAY_UNAVAILABLE";
      throw error;
    }
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.mcpRequests.delete(requestId);
        const error = new Error("Agent MCP gateway request timed out.");
        error.code = "COLLABORATION_MCP_TIMEOUT";
        reject(error);
      }, 15_000);
      timer.unref?.();
      this.mcpRequests.set(requestId, { resolve, reject, timer });
    });
    try {
      const sent = await this.relayClient.send("collaboration.mcp.request", {
        protocolVersion: "1",
        requestId,
        sourceDeviceId: this.deviceId,
        targetDeviceId: binding.coordinatorDeviceId,
        runId: binding.runId,
        sourceRole: binding.role,
        sourceTaskId: binding.taskId,
        action: normalizedAction,
        payload,
      });
      const delivery = sent?.data || sent || {};
      if (delivery.accepted === false && !delivery.queued) {
        const error = new Error(delivery.reason || "Agent MCP gateway request was rejected.");
        error.code = safeText(delivery.reason, 96) || "COLLABORATION_MCP_REJECTED";
        throw error;
      }
      return await response;
    } catch (error) {
      const pending = this.mcpRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.mcpRequests.delete(requestId);
      }
      throw error;
    }
  }

  async executeMcpGatewayRequest({
    requestId,
    runId,
    sourceRole,
    sourceTaskId,
    sourceDeviceId,
    action,
    payload = {},
  }) {
    const run = this.store.getRun(runId);
    const source = run?.agents?.[sourceRole];
    const sourceTask = run?.tasks?.find((task) => task.task_id === sourceTaskId);
    if (!run || run.template_id !== ADAPTIVE_TEMPLATE_ID || run.state !== "executing") {
      const error = new Error("Agent MCP tools require an executing adaptive collaboration.");
      error.code = "COLLABORATION_MCP_RUN_UNAVAILABLE";
      throw error;
    }
    if (!source || source.device_id !== sourceDeviceId
        || source.current_task_id !== sourceTaskId || sourceTask?.state !== "active") {
      const error = new Error("The requesting Agent no longer owns the active collaboration task.");
      error.code = "COLLABORATION_MCP_SOURCE_STALE";
      throw error;
    }
    if (action === "list") {
      return {
        run_id: run.run_id,
        source_participant_id: sourceRole,
        participants: Object.entries(run.agents)
          .filter(([role]) => role !== sourceRole)
          .map(([role, agent]) => ({
            participant_id: role,
            display_name: agent.display_name || role,
            runtime: agent.runtime,
            device_id: agent.device_id,
            status: agent.status,
            role_hint: agent.role_hint || "",
          })),
      };
    }
    if (action === "status") {
      const taskId = safeText(payload.task_id ?? payload.taskId, 195);
      const task = run.tasks.find((item) => item.task_id === taskId);
      if (!task || task.parent_task_id !== sourceTaskId) {
        const error = new Error("The delegated collaboration task is unavailable to this Agent.");
        error.code = "COLLABORATION_MCP_TASK_UNAVAILABLE";
        throw error;
      }
      return {
        task_id: task.task_id,
        participant_id: task.participant_id,
        state: task.state,
        result: task.state === "completed" ? task.result_summary : "",
        updated_at: task.updated_at,
      };
    }
    const participantId = safeText(payload.participant_id ?? payload.participantId, 32).toLowerCase();
    const target = run.agents?.[participantId];
    const instructions = safeText(payload.instructions, 16_000);
    if (!target || participantId === sourceRole) {
      const error = new Error("Choose another available collaboration participant.");
      error.code = "COLLABORATION_MCP_TARGET_INVALID";
      throw error;
    }
    if (!instructions) {
      const error = new Error("Delegated Agent instructions are required.");
      error.code = "COLLABORATION_MCP_INSTRUCTIONS_REQUIRED";
      throw error;
    }
    if (target.current_task_id || run.tasks.some((task) => (
      task.participant_id === participantId && task.state === "active"
    ))) {
      const error = new Error("The selected Agent is already working on another collaboration task.");
      error.code = "COLLABORATION_MCP_TARGET_BUSY";
      throw error;
    }
    const activeCount = run.tasks.filter((task) => task.state === "active").length;
    if (payload.wait_requested === true && activeCount >= Number(run.budget.max_concurrency || 1)) {
      const error = new Error("ask_agent requires one free collaboration concurrency slot; increase max concurrency or use delegate_task.");
      error.code = "COLLABORATION_MCP_CONCURRENCY_REQUIRED";
      throw error;
    }
    const task = this.store.addAdaptiveTask(run.run_id, {
      taskKey: compactId(`mcp_${requestId}`, 64),
      parentTaskId: sourceTaskId,
      participantId,
      sourceParticipantId: sourceRole,
      title: `Request from ${sourceRole}`,
      instructions,
      mode: safeText(payload.mode, 32) || "discussion",
      deliverable: safeText(payload.deliverable, 2_000),
    });
    this.store.appendMessage(run.run_id, {
      task_id: sourceTaskId,
      type: "agent.mcp.delegated",
      idempotency_key: `agent-mcp-delegate-${requestId}`,
      sender: { kind: "agent", agent_id: source.agent_id, device_id: source.device_id },
      recipient: { kind: "agent", agent_id: target.agent_id, device_id: target.device_id },
      payload: {
        delegated_task_id: task.task_id,
        source_participant_id: sourceRole,
        target_participant_id: participantId,
        mode: task.kind,
      },
    });
    this.store.recordExecutionEvent(run.run_id, {
      type: "task.handoff",
      taskId: task.task_id,
      participantId: sourceRole,
      summary: `${sourceRole} delegated work to ${participantId}.`,
      payload: {
        delegated_task_id: task.task_id,
        source_participant_id: sourceRole,
        target_participant_id: participantId,
        mode: task.kind,
      },
      metadata: {
        source_participant_id: sourceRole,
        target_participant_id: participantId,
      },
      correlationId: requestId,
      idempotencyKey: `agent-mcp-handoff-${requestId}`,
    });
    await this.dispatchForState(run.run_id);
    const current = this.store.getRun(run.run_id, { includeMessages: false });
    const created = current.tasks.find((item) => item.task_id === task.task_id);
    return {
      task_id: created.task_id,
      participant_id: created.participant_id,
      state: created.state,
      message: created.state === "pending"
        ? "Task queued. Use get_task_result to check progress."
        : "Task dispatched. Use get_task_result to read the response.",
    };
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

  async confirm(runId) {
    const run = this.coordinator.confirm(runId);
    void this.syncRun(runId);
    await this.dispatchForState(runId);
    return this.store.getRun(run.run_id);
  }

  async revisePlan(runId, feedback) {
    const run = this.store.requestAdaptivePlanRevision(runId, feedback);
    void this.syncRun(runId);
    await this.dispatchForState(runId);
    return this.store.getRun(run.run_id);
  }

  async cancel(runId) {
    const before = this.store.getRun(runId);
    const run = this.coordinator.cancel(runId);
    void this.syncRun(runId);
    const remoteCancellations = [];
    for (const [role, agent] of Object.entries(before?.agents || {})) {
      const remote = agent.device_id !== this.deviceId && agent.device_id !== "local";
      if (remote && agent.current_task_id && this.relayClient) {
        const task = before.tasks?.find((item) => item.task_id === agent.current_task_id);
        const assignmentId = compactId(
          before.template_id === ADAPTIVE_TEMPLATE_ID
            ? `assign-${before.run_id}-${role}-${task?.task_key || agent.current_task_id}`
            : `assign-${before.run_id}-${role}`,
          96,
        );
        const deliveryId = compactId(
          `cancel-${before.run_id}-${role}-${agent.fencing_token || 0}`,
          96,
        );
        remoteCancellations.push(
          this.sendRemoteDurable("collaboration.remote.cancel", {
            protocolVersion: "1",
            sourceDeviceId: this.deviceId,
            targetDeviceId: agent.device_id,
            assignmentId,
            runId: before.run_id,
            taskId: agent.current_task_id,
            role,
            attempt: agent.attempt,
            fencingToken: agent.fencing_token,
            reason: "cancelled",
            deliveryId,
          }, {
            outboxId: `cancel:${deliveryId}`,
          }).catch(() => null),
        );
        this.store.updateAgent(runId, role, {
          status: "stopping",
          currentTaskId: "",
        });
        continue;
      }
      if (!agent.originrouter_session_id) continue;
      try {
        this.registry.enqueueCommand(agent.originrouter_session_id, {
          type: "session.stop",
          sessionId: agent.originrouter_session_id,
        });
      } catch {}
      this.store.updateAgent(runId, role, {
        status: "stopping",
        currentTaskId: "",
      });
    }
    await Promise.all(remoteCancellations);
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

  async pause(runId) {
    const before = this.store.getRun(runId, { includeMessages: false });
    const run = this.store.pauseRun(runId);
    const remotePauses = [];
    for (const [role, agent] of Object.entries(before?.agents || {})) {
      if (!agent.current_task_id || !agent.originrouter_session_id && agent.device_id === this.deviceId) continue;
      const remote = agent.device_id !== this.deviceId && agent.device_id !== "local";
      if (remote) {
        const task = before.tasks?.find((item) => item.task_id === agent.current_task_id);
        const assignmentId = compactId(
          before.template_id === ADAPTIVE_TEMPLATE_ID
            ? `assign-${before.run_id}-${role}-${task?.task_key || agent.current_task_id}`
            : `assign-${before.run_id}-${role}`,
          96,
        );
        remotePauses.push(this.sendRemoteDurable("collaboration.remote.pause", {
          protocolVersion: "1",
          sourceDeviceId: this.deviceId,
          targetDeviceId: agent.device_id,
          runId: before.run_id,
          taskId: agent.current_task_id,
          role,
          assignmentId,
          attempt: agent.attempt,
          fencingToken: agent.fencing_token,
          deliveryId: compactId(`pause-${before.run_id}-${role}-${agent.attempt}`, 96),
        }, {
          outboxId: `pause:${before.run_id}:${role}:${agent.attempt}`,
        }).catch(() => null));
      } else if (agent.originrouter_session_id) {
        try {
          this.registry.enqueueCommand(agent.originrouter_session_id, {
            type: "terminal.interrupt",
            sessionId: agent.originrouter_session_id,
          });
        } catch {}
      }
    }
    await Promise.all(remotePauses);
    void this.syncRun(runId);
    return run;
  }

  async resume(runId) {
    const run = this.store.resumeRun(runId);
    void this.syncRun(runId);
    await this.dispatchForState(runId, { recovery: true });
    return this.store.getRun(run.run_id);
  }

  async retry(runId, taskReference = "") {
    if (safeText(taskReference, 195)) {
      const run = this.store.retryAdaptiveTask(runId, taskReference);
      void this.syncRun(runId);
      await this.dispatchForState(runId, { recovery: true });
      return this.store.getRun(run.run_id);
    }
    const run = this.store.retryRun(runId);
    return this.start(run.run_id);
  }

  async capabilitiesForDevice(deviceId) {
    const targetDeviceId = safeText(deviceId, 191);
    if (!targetDeviceId) throw new Error("target device id is required");
    if (targetDeviceId === this.deviceId || targetDeviceId === "local") {
      if (!this.capabilityProvider) throw new Error("local capability provider unavailable");
      return this.capabilityProvider();
    }
    if (!this.relayClient) {
      const error = new Error("OriginRouter virtual network is unavailable");
      error.code = "COLLABORATION_CAPABILITY_RELAY_UNAVAILABLE";
      throw error;
    }
    const requestId = compactId(`capability-${randomUUID()}`, 64);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.capabilityRequests.delete(requestId);
        const error = new Error("remote device capability request timed out");
        error.code = "COLLABORATION_CAPABILITY_TIMEOUT";
        reject(error);
      }, 10_000);
      timer.unref?.();
      this.capabilityRequests.set(requestId, { resolve, reject, timer, targetDeviceId });
    });
    try {
      const sent = await this.relayClient.send("collaboration.capabilities.request", {
        protocolVersion: "1",
        requestId,
        sourceDeviceId: this.deviceId,
        targetDeviceId,
      });
      const delivery = sent?.data || sent || {};
      if (delivery.accepted === false && !delivery.queued) {
        const error = new Error(delivery.reason || "remote capability request was rejected");
        error.code = safeText(delivery.reason, 96) || "COLLABORATION_CAPABILITY_REJECTED";
        throw error;
      }
      return await response;
    } catch (error) {
      const pending = this.capabilityRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.capabilityRequests.delete(requestId);
      }
      throw error;
    }
  }

  async trustWorkspaceOnDevice(deviceId, path) {
    const targetDeviceId = safeText(deviceId, 191);
    const requestedPath = safeText(path, 4096);
    if (!targetDeviceId || !requestedPath) throw new Error("device id and workspace path are required");
    if (targetDeviceId === this.deviceId || targetDeviceId === "local") {
      if (!this.catalog) throw new Error("Agent workspace catalog unavailable");
      return this.catalog.trustWorkspace(requestedPath, { deviceId: this.deviceId });
    }
    if (!this.relayClient) {
      const error = new Error("OriginRouter virtual network is unavailable");
      error.code = "COLLABORATION_WORKSPACE_RELAY_UNAVAILABLE";
      throw error;
    }
    const requestId = compactId(`workspace-trust-${randomUUID()}`, 64);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workspaceTrustRequests.delete(requestId);
        const error = new Error("remote workspace trust request timed out");
        error.code = "COLLABORATION_WORKSPACE_TRUST_TIMEOUT";
        reject(error);
      }, 15_000);
      timer.unref?.();
      this.workspaceTrustRequests.set(requestId, { resolve, reject, timer, targetDeviceId });
    });
    try {
      const sent = await this.relayClient.send("collaboration.workspace.trust.request", {
        protocolVersion: "1",
        requestId,
        sourceDeviceId: this.deviceId,
        targetDeviceId,
        path: requestedPath,
      });
      const delivery = sent?.data || sent || {};
      if (delivery.accepted === false && !delivery.queued) {
        const error = new Error(delivery.reason || "remote workspace trust request was rejected");
        error.code = safeText(delivery.reason, 96) || "COLLABORATION_WORKSPACE_TRUST_REJECTED";
        throw error;
      }
      return await response;
    } catch (error) {
      const pending = this.workspaceTrustRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.workspaceTrustRequests.delete(requestId);
      }
      throw error;
    }
  }

  async browseWorkspacesOnDevice(deviceId, { path = "", query = "", limit = 8 } = {}) {
    const targetDeviceId = safeText(deviceId, 191);
    if (!targetDeviceId) throw new Error("device id is required");
    if (targetDeviceId === this.deviceId || targetDeviceId === "local") {
      return browseAgentWorkspaces({
        path,
        query,
        limit,
        catalog: this.catalog,
        deviceId: this.deviceId,
      });
    }
    if (!this.relayClient) {
      const error = new Error("OriginRouter virtual network is unavailable");
      error.code = "COLLABORATION_WORKSPACE_RELAY_UNAVAILABLE";
      throw error;
    }
    const requestId = compactId(`workspace-browse-${randomUUID()}`, 64);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workspaceBrowseRequests.delete(requestId);
        const error = new Error("remote workspace browse request timed out");
        error.code = "COLLABORATION_WORKSPACE_BROWSE_TIMEOUT";
        reject(error);
      }, 10_000);
      timer.unref?.();
      this.workspaceBrowseRequests.set(requestId, { resolve, reject, timer, targetDeviceId });
    });
    try {
      const sent = await this.relayClient.send("agent.workspace.browse", {
        requestId,
        sourceDeviceId: this.deviceId,
        targetDeviceId,
        path: safeText(path, 4096),
        query: safeText(query, 256),
        limit: Math.max(1, Math.min(20, Number(limit) || 8)),
      });
      const delivery = sent?.data || sent || {};
      if (delivery.accepted === false && !delivery.queued) {
        const error = new Error(delivery.reason || "remote workspace browse request was rejected");
        error.code = safeText(delivery.reason, 96) || "COLLABORATION_WORKSPACE_BROWSE_REJECTED";
        throw error;
      }
      return await response;
    } catch (error) {
      const pending = this.workspaceBrowseRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.workspaceBrowseRequests.delete(requestId);
      }
      throw error;
    }
  }

  blockForAgentRecovery(run, role, error) {
    const agent = run.agents?.[role];
    const taskId = agent?.current_task_id || null;
    this.store.createAttention(run.run_id, {
      taskId,
      participantId: role,
      kind: "agent_recovery",
      title: `${agent?.display_name || role} could not resume its previous session`,
      summary: "The saved Agent identity no longer matches the selected Runtime or workspace. OriginRouter will not silently replace it. Rebuild this member to continue with a fresh native Agent session, or cancel the collaboration.",
      risk: "normal",
      actions: ["rebuild", "cancel"],
      payload: {
        diagnostic_code: safeText(error?.code, 96) || "AGENT_RESUME_FAILED",
        resume_state: run.state,
      },
      idempotencyKey: `agent-recovery:${role}:${agent?.native_session_id || "missing"}`,
    });
    this.store.updateAgent(run.run_id, role, { status: "blocked" });
    this.store.transition(run.run_id, "blocked");
    return this.store.getRun(run.run_id);
  }

  workspaceRoot(agent) {
    return this.catalog?.getWorkspace?.(agent?.workspace_id, {
      deviceId: agent?.device_id || "",
    })?.canonical_path || agent?.workspace_id || process.cwd();
  }

  async deliverInteractionResolution(run, role, taskId, sessionId, interactionId, command, deliveryKey) {
    const agent = run.agents?.[role];
    const remote = agent && agent.device_id !== this.deviceId && agent.device_id !== "local";
    if (!remote) {
      this.registry.enqueueCommand(sessionId, command);
      return;
    }
    await this.sendRemoteDurable("collaboration.remote.interaction.resolve", {
      protocolVersion: "1",
      sourceDeviceId: this.deviceId,
      targetDeviceId: agent.device_id,
      runId: run.run_id,
      taskId,
      role,
      sessionId,
      interactionId,
      command,
      deliveryId: compactId(deliveryKey, 96),
    }, {
      outboxId: `interaction:${compactId(deliveryKey, 160)}`,
    });
  }

  async supervisePermissionRequest({ run, role, taskId, sessionId, request, createdAt }) {
    const interactionId = safeText(request?.interactionId, 191);
    const agent = run.agents?.[role];
    if (!interactionId || !agent) return false;
    const evidence = request?.payload || {};
    if (![evidence.tool, evidence.command, evidence.tool_input, evidence.file_changes,
      evidence.additional_permissions, evidence.network_approval_context, evidence.blocked_path]
      .some((value) => value && (typeof value !== "object" || Object.keys(value).length > 0))) {
      return false;
    }
    let decision;
    try {
      decision = await this.approvalSupervisor.evaluate({
        request,
        agent,
        run,
        workspaceRoot: this.workspaceRoot(agent),
      });
    } catch (error) {
      decision = {
        effect: "ask",
        reason: safeText(error?.code || error?.message, 256) || "supervisor_evaluation_failed",
        layers: [],
      };
    }
    if (decision.effect === "ask") return false;
    const command = {
      type: "agent.interaction.resolve",
      sessionId,
      interactionId,
      responseId: compactId(`supervisor-${run.run_id}-${interactionId}`, 191),
      kind: "permission",
      action: decision.action,
      response: decision.response || { remember_for_session: false },
      decisionSource: "originrouter-session-supervisor",
    };
    await this.deliverInteractionResolution(
      run,
      role,
      taskId,
      sessionId,
      interactionId,
      command,
      `supervisor-${run.run_id}-${interactionId}`,
    );
    this.store.recordExecutionEvent(run.run_id, {
      type: "agent.interaction.auto_resolved",
      taskId,
      participantId: role,
      sessionId,
      summary: decision.effect === "allow"
        ? "OriginRouter approved the Agent request under the active Session policy."
        : "OriginRouter denied the Agent request under the active Session policy.",
      payload: {
        interaction_id: interactionId,
        action: decision.action,
        reason: decision.reason,
        policy_layers: decision.layers,
      },
      idempotencyKey: `supervisor-resolution:${sessionId}:${interactionId}`,
      createdAt,
    });
    return true;
  }

  async resolveAttention(runId, attentionId, input = {}) {
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run) throw new Error("collaboration run not found");
    const item = this.store.listAttention(runId, { status: "" })
      .find((candidate) => candidate.attention_id === attentionId);
    if (!item) throw new Error("collaboration attention item not found");
    if (item.status !== "pending") return { item, duplicate: true };
    const action = safeText(input.action || input.resolution, 64).toLowerCase();
    if (!item.actions.includes(action)) {
      const error = new Error(`unsupported attention action '${action || "(empty)"}'`);
      error.code = "COLLABORATION_ATTENTION_ACTION_INVALID";
      throw error;
    }
    const sessionId = safeText(item.payload?.session_id, 64);
    const interactionId = safeText(item.payload?.interaction_id, 191);
    if (item.kind === "agent_recovery") {
      if (action === "cancel") {
        const resolved = this.store.resolveAttention(runId, attentionId, {
          ...input,
          resolution: action,
        });
        await this.cancel(runId);
        return resolved;
      }
      const role = item.participant_id;
      this.store.updateAgent(runId, role, {
        status: "idle",
        nativeSessionId: "",
        originrouterSessionId: "",
        conversationId: "",
      });
      const resolved = this.store.resolveAttention(runId, attentionId, {
        ...input,
        resolution: action,
      });
      const resumeState = safeText(item.payload?.resume_state, 64) || "executing";
      this.store.transition(runId, resumeState);
      if (run.template_id === ADAPTIVE_TEMPLATE_ID && item.task_id) {
        const task = run.tasks.find((candidate) => candidate.task_id === item.task_id);
        if (!task) throw new Error("Agent recovery task was not found");
        this.store.updateAdaptiveTask(runId, task.task_key, { state: "active" });
        const refreshed = this.store.getRun(runId);
        await this.dispatch(
          refreshed,
          role,
          task.task_key === "__planner__"
            ? buildPlannerPrompt(refreshed, { recovery: true })
            : taskPrompt(refreshed, task),
          {
            taskId: task.task_id,
            taskKey: task.task_key,
            phase: task.task_key === "__planner__" ? "plan_design" : task.kind,
            retry: true,
            resetAgentIdentity: true,
          },
        );
      } else {
        await this.dispatchForState(runId, { recovery: true, resetAgentIdentity: true });
      }
      return resolved;
    }
    if (["approval", "input"].includes(item.kind)) {
      if (!sessionId || !interactionId) {
        const error = new Error("attention item is missing its Agent interaction binding");
        error.code = "COLLABORATION_ATTENTION_BINDING_MISSING";
        throw error;
      }
      const command = {
        type: "agent.interaction.resolve",
        sessionId,
        interactionId,
        responseId: safeText(input.response_id ?? input.responseId, 191)
          || compactId(`attention-${item.attention_id}-${item.revision}`, 191),
        kind: safeText(item.payload?.kind, 64) || null,
        action,
        response: {
          ...(input.response && typeof input.response === "object" ? input.response : {}),
          ...(item.kind === "approval" ? { remember_for_session: false } : {}),
        },
        decisionSource: safeText(input.resolved_by ?? input.resolvedBy, 191) || "originrouter-user",
      };
      await this.deliverInteractionResolution(
        run,
        item.participant_id,
        item.task_id,
        sessionId,
        interactionId,
        command,
        `attention-${item.attention_id}-${item.revision}`,
      );
    }
    const resolved = this.store.resolveAttention(runId, attentionId, {
      ...input,
      resolution: action,
    });
    this.store.recordExecutionEvent(runId, {
      type: item.kind === "approval" ? "approval.resolved" : "interaction.resolved",
      taskId: item.task_id,
      participantId: item.participant_id,
      sessionId,
      summary: item.kind === "approval"
        ? `Agent permission ${action === "allow" ? "approved" : "denied"}.`
        : "Agent input was submitted.",
      payload: { attention_id: item.attention_id, action },
      idempotencyKey: `attention-resolved:${item.attention_id}:${item.revision}`,
    });
    return resolved;
  }

  async recover() {
    await this.flushOutbox();
    for (const item of this.store.listActiveRuns()) {
      const run = this.store.getRun(item.run_id);
      if (!run || run.state === "created" || TERMINAL_STATES.has(run.state)) continue;
      if (run.template_id === ADAPTIVE_TEMPLATE_ID) {
        void this.dispatchForState(run.run_id, { recovery: true })
          .catch((error) => this.fail(run.run_id, error));
        continue;
      }
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

  async dispatchForState(runId, { recovery = false, resetAgentIdentity = false } = {}) {
    const run = this.store.getRun(runId);
    if (!run || TERMINAL_STATES.has(run.state)) return run;
    void this.syncRun(runId);
    if (run.template_id === ADAPTIVE_TEMPLATE_ID) {
      return this.dispatchAdaptive(run, { recovery, resetAgentIdentity });
    }
    const role = expectedRole(run);
    if (!role) return run;
    const prompt = this.promptFor(run, role, { recovery });
    if (!prompt) return run;
    await this.dispatch(run, role, prompt, { resetAgentIdentity });
    return this.store.getRun(runId);
  }

  async dispatchAdaptive(run, { recovery = false, resetAgentIdentity = false } = {}) {
    if (recovery) run = this.store.resetAdaptiveActiveTasks(run.run_id);
    if (run.state === "designing") {
      const role = run.planner_role;
      const plannerTask = run.tasks.find((task) => task.task_key === "__planner__");
      if (!plannerTask || !run.agents[role]) throw new Error("collaboration Planner is unavailable");
      if (run.agents[role].current_task_id === plannerTask.task_id && !recovery) return run;
      this.store.updateAdaptiveTask(run.run_id, "__planner__", { state: "active" });
      await this.dispatch(
        this.store.getRun(run.run_id),
        role,
        buildPlannerPrompt(run, { recovery }),
        {
          taskId: plannerTask.task_id,
          taskKey: "__planner__",
          phase: "plan_design",
          retry: recovery,
          resetAgentIdentity,
        },
      );
      return this.store.getRun(run.run_id);
    }
    if (run.state !== "executing") return run;
    const tasks = this.store.runnableAdaptiveTasks(run.run_id);
    if (tasks.length === 0) {
      const current = this.store.getRun(run.run_id);
      const remaining = current.tasks.filter((task) => task.task_key !== "__planner__" && task.state !== "completed");
      if (remaining.length === 0) {
        return this.store.transition(run.run_id, "completed");
      }
      return current;
    }
    await Promise.all(tasks.map(async (task) => {
      this.store.updateAdaptiveTask(run.run_id, task.task_key, { state: "active" });
      const current = this.store.getRun(run.run_id);
      await this.dispatch(current, task.participant_id, taskPrompt(current, task), {
        taskId: task.task_id,
        taskKey: task.task_key,
        phase: task.kind,
        retry: recovery,
        resetAgentIdentity,
      });
    }));
    return this.store.getRun(run.run_id);
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

  async dispatch(run, role, prompt, {
    taskId = null,
    taskKey = null,
    phase = null,
    retry = false,
    resetAgentIdentity = false,
  } = {}) {
    let agent = run.agents[role];
    if (!agent) throw new Error(`missing collaboration role: ${role}`);
    const effectiveTaskId = taskId || run.task_ids[0];
    const effectiveTaskKey = taskKey || run.state;
    const effectivePhase = phase || run.state;
    const retrySuffix = retry ? `:retry-${Number(agent.attempt || 0) + 1}` : "";
    const turnKey = `${effectiveTaskKey}:${run.counters.plan_revisions || 0}:${run.counters.rework_rounds || 0}${retrySuffix}`;
    const messageKey = `dispatch-${role}-${turnKey}`;
    agent = this.store.issueAgentLease(run.run_id, role, {
      dispatchKey: messageKey,
      ttlMs: this.leaseTtlMs,
    });
    this.store.appendMessage(run.run_id, {
      task_id: effectiveTaskId,
      type: "agent.message",
      idempotency_key: messageKey,
      sender: { kind: "coordinator", device_id: this.deviceId },
      recipient: { kind: "agent", agent_id: agent.agent_id, device_id: agent.device_id },
      payload: { phase: effectivePhase, content: prompt },
    });
    this.buffers.set(`${run.run_id}:${role}`, []);
    if (agent.device_id !== this.deviceId && agent.device_id !== "local") {
      if (!this.relayClient) throw new Error("collaboration relay is unavailable");
      const assignmentId = compactId(
        run.template_id === ADAPTIVE_TEMPLATE_ID
          ? `assign-${run.run_id}-${role}-${effectiveTaskKey}`
          : `assign-${run.run_id}-${role}`,
        96,
      );
      const deliveryId = compactId(`delivery-${run.run_id}-${role}-${turnKey}`, 96);
      const payload = {
        protocolVersion: "1",
        sourceDeviceId: this.deviceId,
        targetDeviceId: agent.device_id,
        deliveryId,
        assignmentId,
        runId: run.run_id,
        taskId: effectiveTaskId,
        role,
        phase: effectivePhase,
        attempt: agent.attempt,
        fencingToken: agent.fencing_token,
        leaseId: agent.lease_id,
        leaseExpiresAt: agent.lease_expires_at,
        runtime: agent.runtime,
        workspaceId: agent.workspace_id,
        provider: agent.provider,
        model: agent.model,
        permissionProfile: "manual",
        nativeSessionId: agent.native_session_id || null,
        conversationId: agent.conversation_id || null,
        resetAgentIdentity,
        prompt,
      };
      let result;
      try {
        result = await this.sendRemoteDurable("collaboration.remote.dispatch", payload, {
          outboxId: `dispatch:${deliveryId}`,
        });
      } catch (error) {
        if (agent.native_session_id && isAgentResumeBindingError(error)) {
          this.blockForAgentRecovery(run, role, error);
          return;
        }
        if (!retryableDeliveryError(error)) throw error;
        this.store.updateAgent(run.run_id, role, { status: "waiting_device", currentTaskId: effectiveTaskId });
        return;
      }
      const data = result?.data || result || {};
      if (data.accepted === false && !data.queued) {
        const error = new Error(data.reason || "remote collaboration dispatch rejected");
        error.code = String(data.reason || "COLLABORATION_REMOTE_DISPATCH_REJECTED");
        throw error;
      }
      this.store.updateAgent(run.run_id, role, {
        status: data.queued ? "waiting_device" : "dispatched",
        currentTaskId: effectiveTaskId,
      });
      return;
    }
    let sessionId = agent.originrouter_session_id;
    let active = sessionId && this.registry.list().some((session) => (
      session.session_id === sessionId && session.status === "running"
    ));
    if (!active) {
      sessionId = compactId(`collab-${role}-${randomUUID()}`);
      const conversationId = agent.conversation_id || compactId(`collab-${run.run_id}-${role}`, 96);
      let launch;
      try {
        launch = await this.supervisor.start({
          launchId: compactId(`launch-${run.run_id}-${role}-${randomUUID()}`, 96),
          sessionId,
          conversationId,
          runId: run.run_id,
          agentType: agent.runtime,
          workspaceId: agent.workspace_id,
          provider: agent.provider,
          model: agent.model,
          permissionProfile: "manual",
          ...(agent.native_session_id ? {
            resumeConversationId: conversationId,
            nativeSessionId: agent.native_session_id,
          } : {}),
          title: `${run.objective.slice(0, 120)} · ${agent.display_name || role}`,
          startedBy: "collaboration-runtime",
        });
      } catch (error) {
        if (agent.native_session_id && isAgentResumeBindingError(error)) {
          this.blockForAgentRecovery(run, role, error);
          return;
        }
        throw error;
      }
      this.store.updateAgent(run.run_id, role, {
        status: "starting",
        originrouterSessionId: launch.sessionId,
        conversationId: launch.conversationId,
      });
      await this.waitForSession(launch.sessionId);
      active = true;
    }
    if (!active) throw new Error(`collaboration Agent ${role} did not become ready`);
    if (["planning", "plan_design", "read_only", "discussion"].includes(effectivePhase)) {
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
    this.store.updateAgent(run.run_id, role, { status: "running", currentTaskId: effectiveTaskId });
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
    this.store.touchAgentLease(binding.run_id, binding.role, {
      ttlMs: this.leaseTtlMs,
    });
    const event = notification.payload || {};
    const currentRun = this.store.getRun(binding.run_id, { includeMessages: false });
    const currentTaskId = currentRun?.agents?.[binding.role]?.current_task_id || "";
    const projectedEvent = executionEventProjection(event);
    this.store.recordExecutionEvent(binding.run_id, {
      eventId: `execution-${notification.sessionId}-${event.eventId || event.localSequence}`,
      taskId: currentTaskId,
      participantId: binding.role,
      sessionId: notification.sessionId,
      ...projectedEvent,
      createdAt: event.createdAt,
    });
    if (event.type === "agent.interaction.requested") {
      const interactionId = safeText(event.interactionId || event.callId, 191);
      if (interactionId) {
        const kind = safeText(event.kind, 64) || "input";
        if (kind === "permission" && await this.supervisePermissionRequest({
          run: currentRun,
          role: binding.role,
          taskId: currentTaskId,
          sessionId: notification.sessionId,
          request: projectedEvent.payload.approval_request,
          createdAt: event.createdAt,
        })) return;
        const containsSecret = event.containsSecret === true;
        this.store.createAttention(binding.run_id, {
          taskId: currentTaskId,
          participantId: binding.role,
          kind: interactionAttentionKind(kind),
          title: safeText(event.title, 256)
            || (kind === "permission" ? "Agent permission required" : "Agent needs your input"),
          summary: containsSecret
            ? "The Agent is waiting for a sensitive response. Open the request to continue."
            : safeText(event.prompt || event.message, 2048)
              || `The ${binding.role} Agent is waiting for ${kind.replaceAll("_", " ")}.`,
          risk: kind === "permission" ? "normal" : "low",
          actions: interactionAttentionActions(kind),
          payload: {
            interaction_id: interactionId,
            session_id: notification.sessionId,
            kind,
            source: safeText(event.source, 64) || null,
            contains_secret: containsSecret,
          },
          expiresAt: event.expiresAt || null,
          idempotencyKey: `interaction:${notification.sessionId}:${interactionId}`,
          createdAt: event.createdAt,
        });
      }
      return;
    }
    if (event.type === "agent.interaction.result") {
      const interactionId = safeText(event.interactionId || event.callId, 191);
      const terminalResult = ["applied", "expired", "failed", "canceled", "cancelled"]
        .includes(safeText(event.status, 32).toLowerCase());
      if (interactionId && terminalResult) {
        const attention = this.store.findAttentionByIdempotency(
          binding.run_id,
          `interaction:${notification.sessionId}:${interactionId}`,
        );
        if (attention?.status === "pending") {
          this.store.resolveAttention(binding.run_id, attention.attention_id, {
            expectedRevision: attention.revision,
            resolvedBy: safeText(event.decisionSource, 191) || "agent-runtime",
            resolution: safeText(event.action || event.status, 64) || "resolved",
          });
        }
      }
      return;
    }
    if (FAILED_EVENTS.has(event.type)) {
      const error = new Error(safeText(event.error || event.reason, 2048)
        || "Collaboration Agent command failed.");
      error.code = safeText(event.code, 96) || "COLLABORATION_AGENT_COMMAND_FAILED";
      await this.fail(binding.run_id, error);
      return;
    }
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

  async handleControlOperation(operation, input = {}) {
    const runId = safeText(input.run_id ?? input.runId, 195);
    if (operation === "list_runs") {
      if (input.category || input.page || input.page_size || input.pageSize) {
        const page = this.store.listRunPage({
          category: safeText(input.category, 32) || "all",
          page: input.page,
          pageSize: input.page_size ?? input.pageSize,
          includeArchived: input.archived === true,
        });
        return {
          ...page,
          runs: page.runs.map((run) =>
            collaborationSnapshotSummary(this.store.getSnapshot(run.run_id))),
        };
      }
      return {
        runs: this.store.listRuns({ limit: input.limit || 200 })
          .map((run) => collaborationSnapshotSummary(this.store.getSnapshot(run.run_id))),
      };
    }
    if (operation === "create") {
      return {
        run: this.coordinator.create({
          ...(input.request || {}),
          coordinator_device_id: this.deviceId,
        }),
      };
    }
    if (!runId) throw new Error("collaboration run_id is required");
    if (operation === "snapshot") {
      const snapshot = this.store.getSnapshot(runId);
      if (!snapshot) throw new Error("collaboration run not found");
      return { snapshot };
    }
    if (operation === "diagnostics") {
      const diagnostics = this.store.getDiagnostics(runId);
      if (!diagnostics) throw new Error("collaboration run not found");
      return { diagnostics };
    }
    if (operation === "events") {
      const afterSequence = Math.max(0, Number(input.after_sequence ?? input.afterSequence) || 0);
      const page = this.store.listExecutionEventPage(runId, {
        participantId: safeText(input.participant_id ?? input.participantId, 32),
        afterSequence,
        visibility: safeText(input.visibility, 96),
        limit: input.limit || 200,
      });
      if (!page) throw new Error("collaboration run not found");
      return page;
    }
    if (operation === "start") return { run: await this.start(runId) };
    if (operation === "confirm") return { run: await this.confirm(runId) };
    if (operation === "replan") {
      return { run: await this.revisePlan(runId, input.feedback) };
    }
    if (operation === "pause") return { run: await this.pause(runId) };
    if (operation === "resume") return { run: await this.resume(runId) };
    if (operation === "cancel") return { run: await this.cancel(runId) };
    if (operation === "retry") {
      return { run: await this.retry(runId, safeText(input.task_id ?? input.taskId, 195)) };
    }
    if (operation === "budget") return { run: await this.updateBudget(runId, input.budget || {}) };
    if (operation === "archive") return { run: this.store.archiveRun(runId, true) };
    if (operation === "delete") {
      return { deleted: this.store.deleteRun(runId), run_id: runId };
    }
    if (operation === "resolve_attention") {
      return this.resolveAttention(
        runId,
        safeText(input.attention_id ?? input.attentionId, 195),
        input.resolution || {},
      );
    }
    throw new Error(`unsupported collaboration control operation '${safeText(operation, 64)}'`);
  }

  async handleRelayEvent(payload = {}) {
    if (payload.type === "agent.workspace.browse") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      let page = null;
      let errorPayload = null;
      try {
        page = await browseAgentWorkspaces({
          path: payload.path,
          query: payload.query,
          limit: payload.limit,
          catalog: this.catalog,
          deviceId: this.deviceId,
        });
      } catch (error) {
        errorPayload = {
          error: safeText(error?.message, 2048) || "workspace browse failed",
          reason: safeText(error?.code, 96) || "workspace_browse_failed",
        };
      }
      await this.relayClient?.send?.("agent.workspace.page", {
        requestId: safeText(payload.requestId, 64),
        sourceDeviceId: this.deviceId,
        targetDeviceId: safeText(payload.sourceDeviceId, 191),
        ...(errorPayload || page || {}),
      });
      return true;
    }
    if (payload.type === "agent.workspace.page") {
      const requestId = safeText(payload.requestId, 64);
      const pending = this.workspaceBrowseRequests.get(requestId);
      if (!pending) return false;
      clearTimeout(pending.timer);
      this.workspaceBrowseRequests.delete(requestId);
      if (payload.error) {
        const error = new Error(safeText(payload.error, 2048) || "remote workspace browse failed");
        error.code = safeText(payload.reason, 96) || "COLLABORATION_WORKSPACE_BROWSE_FAILED";
        pending.reject(error);
      } else {
        pending.resolve({
          current_path: safeText(payload.current_path, 4096),
          parent_path: safeText(payload.parent_path, 4096),
          query: safeText(payload.query, 256),
          entries: Array.isArray(payload.entries) ? payload.entries.slice(0, 20) : [],
          truncated: payload.truncated === true,
        });
      }
      return true;
    }
    if (payload.type === "collaboration.control.request") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      let data = null;
      let errorPayload = null;
      try {
        data = await this.handleControlOperation(
          safeText(payload.operation, 64),
          payload.input || {},
        );
      } catch (error) {
        errorPayload = {
          code: safeText(error?.code, 96) || "COLLABORATION_CONTROL_REJECTED",
          message: safeText(error?.message, 2048) || "collaboration control request failed",
        };
      }
      await this.relayClient?.send?.("collaboration.control.response", {
        protocolVersion: "1",
        requestId: safeText(payload.requestId, 64),
        sourceDeviceId: this.deviceId,
        targetDeviceId: safeText(payload.sourceDeviceId, 191),
        ...(errorPayload ? { error: errorPayload } : { data }),
      });
      return true;
    }
    if (payload.type === "collaboration.capabilities.request") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      let capabilities = null;
      let errorPayload = null;
      try {
        if (!this.capabilityProvider) throw new Error("capability provider unavailable");
        capabilities = await this.capabilityProvider();
      } catch (error) {
        errorPayload = {
          code: safeText(error?.code, 96) || "COLLABORATION_CAPABILITY_UNAVAILABLE",
          message: safeText(error?.message, 2048) || "remote capabilities unavailable",
        };
      }
      await this.relayClient?.send?.("collaboration.capabilities.response", {
        protocolVersion: "1",
        requestId: safeText(payload.requestId, 64),
        sourceDeviceId: this.deviceId,
        targetDeviceId: safeText(payload.sourceDeviceId, 191),
        ...(errorPayload ? { error: errorPayload } : { capabilities }),
      });
      return true;
    }
    if (payload.type === "collaboration.capabilities.response") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const requestId = safeText(payload.requestId, 64);
      const pending = this.capabilityRequests.get(requestId);
      if (!pending) return true;
      clearTimeout(pending.timer);
      this.capabilityRequests.delete(requestId);
      if (payload.error) {
        const error = new Error(safeText(payload.error.message, 2048) || "remote capabilities unavailable");
        error.code = safeText(payload.error.code, 96) || "COLLABORATION_CAPABILITY_UNAVAILABLE";
        pending.reject(error);
      } else {
        const capabilities = payload.capabilities || {};
        capabilities.freshness = {
          ...(capabilities.freshness || {}),
          source: "account_e2ee",
          stale: false,
          received_at: new Date().toISOString(),
        };
        pending.resolve(capabilities);
      }
      return true;
    }
    if (payload.type === "collaboration.workspace.trust.request") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      let workspace = null;
      let errorPayload = null;
      try {
        if (!this.catalog) throw new Error("Agent workspace catalog unavailable");
        workspace = this.catalog.trustWorkspace(safeText(payload.path, 4096), {
          deviceId: this.deviceId,
        });
      } catch (error) {
        errorPayload = {
          code: safeText(error?.code, 96) || "COLLABORATION_WORKSPACE_TRUST_FAILED",
          message: safeText(error?.message, 2048) || "workspace could not be trusted",
        };
      }
      await this.relayClient?.send?.("collaboration.workspace.trust.response", {
        protocolVersion: "1",
        requestId: safeText(payload.requestId, 64),
        sourceDeviceId: this.deviceId,
        targetDeviceId: safeText(payload.sourceDeviceId, 191),
        ...(errorPayload ? { error: errorPayload } : { workspace }),
      });
      return true;
    }
    if (payload.type === "collaboration.workspace.trust.response") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const requestId = safeText(payload.requestId, 64);
      const pending = this.workspaceTrustRequests.get(requestId);
      if (!pending) return true;
      clearTimeout(pending.timer);
      this.workspaceTrustRequests.delete(requestId);
      if (payload.error) {
        const error = new Error(safeText(payload.error.message, 2048) || "workspace could not be trusted");
        error.code = safeText(payload.error.code, 96) || "COLLABORATION_WORKSPACE_TRUST_FAILED";
        pending.reject(error);
      } else {
        pending.resolve(payload.workspace || {});
      }
      return true;
    }
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
        const roles = activeRoles(before);
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
          for (const role of roles) {
            const agent = before.agents[role];
            if (!agent?.originrouter_session_id) continue;
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
    if (payload.type === "collaboration.mcp.request") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const requestId = safeText(payload.requestId, 64);
      let result = null;
      let errorPayload = null;
      try {
        result = await this.executeMcpGatewayRequest({
          requestId,
          runId: safeText(payload.runId, 195),
          sourceRole: safeText(payload.sourceRole, 32),
          sourceTaskId: safeText(payload.sourceTaskId, 195),
          sourceDeviceId: safeText(payload.sourceDeviceId, 191),
          action: safeText(payload.action, 32),
          payload: payload.payload || {},
        });
      } catch (error) {
        errorPayload = {
          code: safeText(error?.code, 96) || "COLLABORATION_MCP_FAILED",
          message: safeText(error?.message, 2048) || "Agent MCP gateway request failed.",
        };
      }
      await this.relayClient?.send?.("collaboration.mcp.response", {
        protocolVersion: "1",
        requestId,
        sourceDeviceId: this.deviceId,
        targetDeviceId: safeText(payload.sourceDeviceId, 191),
        runId: safeText(payload.runId, 195),
        ...(errorPayload ? { error: errorPayload } : { result }),
      });
      return true;
    }
    if (payload.type === "collaboration.mcp.response") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const requestId = safeText(payload.requestId, 64);
      const pending = this.mcpRequests.get(requestId);
      if (!pending) return true;
      clearTimeout(pending.timer);
      this.mcpRequests.delete(requestId);
      if (payload.error) {
        const error = new Error(safeText(payload.error.message, 2048) || "Agent MCP gateway request failed.");
        error.code = safeText(payload.error.code, 96) || "COLLABORATION_MCP_FAILED";
        pending.reject(error);
      } else {
        pending.resolve(payload.result || {});
      }
      return true;
    }
    if (!String(payload.type || "").startsWith("collaboration.remote.")) return false;
    if (payload.type === "collaboration.remote.dispatch") {
      try {
        await this.receiveRemoteDispatch(payload);
      } catch (error) {
        const deliveryId = safeText(payload.deliveryId, 96);
        await this.sendRemoteDurable("collaboration.remote.error", {
          protocolVersion: "1",
          sourceDeviceId: this.deviceId,
          targetDeviceId: safeText(payload.sourceDeviceId, 191),
          assignmentId: safeText(payload.assignmentId, 195),
          runId: safeText(payload.runId, 195),
          taskId: safeText(payload.taskId, 195),
          role: safeText(payload.role, 32),
          attempt: Math.max(1, Math.floor(Number(payload.attempt) || 0)),
          fencingToken: Math.max(1, Math.floor(Number(payload.fencingToken) || 0)),
          deliveryId,
          code: safeText(error?.code || "remote_dispatch_failed", 96),
          message: safeText(error?.message || "Remote collaboration dispatch failed.", 2048),
        }, {
          outboxId: `error:${deliveryId}:${compactId(error?.code || "remote_dispatch_failed", 64)}`,
        });
      }
      return true;
    }
    if (payload.type === "collaboration.remote.result") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const run = this.store.getRun(payload.runId);
      if (!run || !run.task_ids.includes(payload.taskId)) return true;
      const role = safeText(payload.role, 32);
      if (run.template_id === ADAPTIVE_TEMPLATE_ID) {
        if (run.agents?.[role]?.current_task_id !== payload.taskId) return true;
      } else if (expectedRole(run) !== role) return true;
      if (!this.acceptsFencing(run, role, payload)) return true;
      if (payload.nativeSessionId || payload.conversationId) {
        this.store.updateAgent(run.run_id, role, {
          status: "idle",
          nativeSessionId: payload.nativeSessionId,
          conversationId: payload.conversationId,
          currentTaskId: payload.taskId,
        });
      }
      try {
        await this.handleTurnCompleted(
          run.run_id,
          role,
          safeText(payload.output),
          safeText(payload.completionId, 160) || compactId(`remote-${payload.deliveryId || randomUUID()}`, 160),
        );
      } catch (error) {
        // A remote result can immediately unlock a task assigned to this
        // device.  Launch failures for that follow-up task must become a
        // terminal collaboration error instead of escaping to the daemon's
        // generic relay logger and leaving the task falsely marked active.
        await this.fail(run.run_id, error);
      }
      return true;
    }
    if (payload.type === "collaboration.remote.event") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const run = this.store.getRun(payload.runId, { includeMessages: false });
      const role = safeText(payload.role, 32);
      if (!run || !run.agents[role] || !run.task_ids.includes(payload.taskId)) return true;
      if (!this.acceptsFencing(run, role, payload)) return true;
      this.store.recordExecutionEvent(run.run_id, {
        eventId: `remote-execution-${safeText(payload.eventId, 160)}`,
        taskId: payload.taskId,
        participantId: role,
        sessionId: payload.sessionId,
        type: payload.event?.type,
        summary: payload.event?.summary,
        detail: payload.event?.detail,
        payload: payload.event?.payload || {},
        metadata: payload.event?.metadata || {},
        createdAt: payload.createdAt,
      });
      if (payload.event?.type === "agent.interaction.requested") {
        const interactionId = safeText(payload.event?.payload?.interaction_id, 191);
        if (interactionId) {
          const kind = safeText(payload.event?.payload?.kind, 64) || "input";
          if (kind === "permission" && await this.supervisePermissionRequest({
            run,
            role,
            taskId: payload.taskId,
            sessionId: safeText(payload.sessionId, 64),
            request: payload.event?.payload?.approval_request,
            createdAt: payload.createdAt,
          })) return true;
          this.store.createAttention(run.run_id, {
            taskId: payload.taskId,
            participantId: role,
            kind: interactionAttentionKind(kind),
            title: kind === "permission" ? "Agent permission required" : "Agent needs your input",
            summary: payload.event?.payload?.contains_secret
              ? "The remote Agent is waiting for a sensitive response. Open the request to continue."
              : safeText(payload.event?.detail || payload.event?.summary, 2048),
            risk: kind === "permission" ? "normal" : "low",
            actions: interactionAttentionActions(kind),
            payload: {
              interaction_id: interactionId,
              session_id: safeText(payload.sessionId, 64),
              kind,
              source: safeText(payload.event?.payload?.source, 64) || null,
              contains_secret: payload.event?.payload?.contains_secret === true,
            },
            expiresAt: payload.event?.payload?.expires_at || null,
            idempotencyKey: `interaction:${safeText(payload.sessionId, 64)}:${interactionId}`,
            createdAt: payload.createdAt,
          });
        }
      }
      if (payload.event?.type === "agent.interaction.result") {
        const interactionId = safeText(payload.event?.payload?.interaction_id, 191);
        const terminalResult = ["applied", "expired", "failed", "canceled", "cancelled"]
          .includes(safeText(payload.event?.payload?.status, 32).toLowerCase());
        if (interactionId && terminalResult) {
          const attention = this.store.findAttentionByIdempotency(
            run.run_id,
            `interaction:${safeText(payload.sessionId, 64)}:${interactionId}`,
          );
          if (attention?.status === "pending") {
            this.store.resolveAttention(run.run_id, attention.attention_id, {
              expectedRevision: attention.revision,
              resolvedBy: safeText(payload.event?.payload?.decision_source, 191) || "agent-runtime",
              resolution: safeText(payload.event?.payload?.action || payload.event?.payload?.status, 64),
            });
          }
        }
      }
      return true;
    }
    if (payload.type === "collaboration.remote.interaction.resolve") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const assignment = this.store.findRemoteAssignmentBySession(payload.sessionId);
      if (!assignment
          || assignment.run_id !== safeText(payload.runId, 195)
          || assignment.role !== safeText(payload.role, 32)) {
        const error = new Error("remote Agent interaction binding is unavailable");
        error.code = "COLLABORATION_REMOTE_INTERACTION_STALE";
        throw error;
      }
      this.registry.enqueueCommand(assignment.originrouter_session_id, {
        ...(payload.command || {}),
        type: "agent.interaction.resolve",
        sessionId: assignment.originrouter_session_id,
        interactionId: safeText(payload.interactionId, 191),
      });
      return true;
    }
    if (payload.type === "collaboration.remote.pause") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const assignment = this.store.getRemoteAssignment(payload.assignmentId)
        || this.store.findRemoteAssignmentBySession(payload.sessionId);
      if (!assignment
          || assignment.run_id !== safeText(payload.runId, 195)
          || assignment.role !== safeText(payload.role, 32)) return true;
      if (assignment.originrouter_session_id) {
        try {
          this.registry.enqueueCommand(assignment.originrouter_session_id, {
            type: "terminal.interrupt",
            sessionId: assignment.originrouter_session_id,
          });
        } catch {}
      }
      this.store.updateRemoteAssignment(assignment.assignment_id, { status: "paused" });
      return true;
    }
    if (payload.type === "collaboration.remote.usage") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const run = this.store.getRun(payload.runId, { includeMessages: false });
      const role = safeText(payload.role, 32);
      if (!run || !run.agents[role] || !run.task_ids.includes(payload.taskId)) return true;
      if (!this.acceptsFencing(run, role, payload)) return true;
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
        const deliveryId = compactId(`budget-cancel-${run.run_id}-${role}-${run.agents[role].fencing_token}`, 96);
        await this.sendRemoteDurable("collaboration.remote.cancel", {
          protocolVersion: "1",
          sourceDeviceId: this.deviceId,
          targetDeviceId: run.agents[role].device_id,
          assignmentId: safeText(payload.assignmentId, 195),
          runId: run.run_id,
          taskId: run.task_ids[0],
          role,
          attempt: run.agents[role].attempt,
          fencingToken: run.agents[role].fencing_token,
          reason: "budget_exhausted",
          deliveryId,
        }, {
          outboxId: `cancel:${deliveryId}`,
        });
      }
      return true;
    }
    if (payload.type === "collaboration.remote.cancel") {
      if (safeText(payload.targetDeviceId, 191) !== this.deviceId) return true;
      const budgetExhausted = safeText(payload.reason, 96) === "budget_exhausted";
      if (!budgetExhausted) this.store.recordRemoteCancellation(payload);
      const assignment = this.store.getRemoteAssignment(payload.assignmentId);
      if (!assignment || assignment.run_id !== payload.runId) return true;
      if (payload.fencingToken != null
          && Number(payload.fencingToken) !== Number(assignment.fencing_token || 0)) return true;
      if (assignment.originrouter_session_id) {
        try {
          this.registry.enqueueCommand(assignment.originrouter_session_id, {
            type: budgetExhausted ? "terminal.interrupt" : "session.stop",
            sessionId: assignment.originrouter_session_id,
          });
        } catch {}
      }
      this.store.updateRemoteAssignment(assignment.assignment_id, {
        status: budgetExhausted ? "budget_exhausted" : "cancelled",
      });
      return true;
    }
    if (payload.type === "collaboration.remote.error") {
      if (safeText(payload.targetDeviceId, 191) === this.deviceId && payload.runId) {
        const run = this.store.getRun(payload.runId, { includeMessages: false });
        const role = safeText(payload.role, 32);
        if (!run || !this.acceptsFencing(run, role, payload)) return true;
        const error = Object.assign(
          new Error(safeText(payload.message, 2048) || "Remote collaboration Agent failed."),
          { code: safeText(payload.code, 96) },
        );
        if (run.agents?.[role]?.native_session_id && isAgentResumeBindingError(error)) {
          this.blockForAgentRecovery(run, role, error);
        } else {
          await this.fail(payload.runId, error);
        }
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
    if (this.store.isRemoteAssignmentCancelled(payload)) return;
    const accepted = this.store.upsertRemoteAssignment({
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
      nativeSessionId: payload.nativeSessionId,
      conversationId: payload.conversationId,
      resetAgentIdentity: payload.resetAgentIdentity,
      deliveryId: payload.deliveryId,
      attempt: payload.attempt,
      fencingToken: payload.fencingToken,
      leaseId: payload.leaseId,
      leaseExpiresAt: payload.leaseExpiresAt,
    });
    if (accepted.stale || accepted.duplicate) return;
    let assignment = accepted.assignment;
    const bufferKey = `remote:${assignment.assignment_id}`;
    this.buffers.set(bufferKey, []);
    let sessionId = assignment.originrouter_session_id;
    let active = sessionId && this.registry.list().some((session) => (
      session.session_id === sessionId && session.status === "running"
    ));
    if (!active) {
      sessionId = compactId(`collab-remote-${assignment.role}-${randomUUID()}`);
      this.relayClient?.bindRoute?.(sessionId, [
        assignment.assignment_id,
        assignment.run_id,
        assignment.source_device_id,
      ]);
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
        permissionProfile: "manual",
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
    this.relayClient?.bindRoute?.(sessionId, [
      assignment.assignment_id,
      assignment.run_id,
      assignment.source_device_id,
    ]);
    if (this.store.isRemoteAssignmentCancelled(assignment)) {
      try {
        this.registry.enqueueCommand(sessionId, { type: "session.stop", sessionId });
      } catch {}
      this.store.updateRemoteAssignment(assignment.assignment_id, { status: "cancelled" });
      return;
    }
    if (!active) throw new Error("remote collaboration Agent did not become ready");
    this.registry.enqueueCommand(sessionId, {
      type: "agent.mode.set",
      sessionId,
      mode: ["planning", "plan_design", "read_only", "discussion"].includes(payload.phase) ? "plan" : "default",
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
    assignment = this.store.touchRemoteAssignmentLease(assignment.assignment_id, {
      ttlMs: this.leaseTtlMs,
    });
    const event = notification.payload || {};
    const projectedEvent = executionEventProjection(event);
    await this.sendRemoteDurable("collaboration.remote.event", {
      protocolVersion: "1",
      sourceDeviceId: this.deviceId,
      targetDeviceId: assignment.source_device_id,
      assignmentId: assignment.assignment_id,
      runId: assignment.run_id,
      taskId: assignment.task_id,
      role: assignment.role,
      attempt: assignment.attempt,
      fencingToken: assignment.fencing_token,
      eventId: `${notification.sessionId}-${event.eventId || event.localSequence}`,
      sessionId: notification.sessionId,
      createdAt: event.createdAt,
      event: projectedEvent,
    }, {
      outboxId: `event:${compactId(`${assignment.assignment_id}-${event.eventId || event.localSequence}`, 160)}`,
    });
    if (FAILED_EVENTS.has(event.type)) {
      const message = safeText(event.error || event.reason, 2048)
        || "Remote collaboration Agent command failed.";
      this.store.updateRemoteAssignment(assignment.assignment_id, { status: "failed" });
      await this.sendRemoteDurable("collaboration.remote.error", {
        protocolVersion: "1",
        sourceDeviceId: this.deviceId,
        targetDeviceId: assignment.source_device_id,
        assignmentId: assignment.assignment_id,
        runId: assignment.run_id,
        taskId: assignment.task_id,
        role: assignment.role,
        attempt: assignment.attempt,
        fencingToken: assignment.fencing_token,
        deliveryId: compactId(`failed-${assignment.assignment_id}-${randomUUID()}`, 96),
        code: safeText(event.code, 96) || "COLLABORATION_AGENT_COMMAND_FAILED",
        message,
      }, {
        outboxId: `error:${compactId(`${assignment.assignment_id}-${assignment.fencing_token}-command`, 160)}`,
      });
      return;
    }
    if (event.type === "agent.usage") {
      const usageId = `${notification.sessionId}-${event.eventId || event.localSequence}`;
      await this.sendRemoteDurable("collaboration.remote.usage", {
        protocolVersion: "1",
        sourceDeviceId: this.deviceId,
        targetDeviceId: assignment.source_device_id,
        assignmentId: assignment.assignment_id,
        runId: assignment.run_id,
        taskId: assignment.task_id,
        role: assignment.role,
        attempt: assignment.attempt,
        fencingToken: assignment.fencing_token,
        usageId,
        sampledTokens: Math.max(0, Math.floor(Number(event.sampledTokens) || 0)),
        amountMicros: event.amountMicros == null ? null : Math.max(0, Math.floor(Number(event.amountMicros) || 0)),
        currency: safeText(event.currency, 3).toUpperCase(),
        costSource: safeText(event.costSource, 32),
      }, {
        outboxId: `usage:${compactId(usageId, 160)}`,
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
    await this.sendRemoteDurable("collaboration.remote.result", {
      protocolVersion: "1",
      sourceDeviceId: this.deviceId,
      targetDeviceId: latest.source_device_id,
      assignmentId: latest.assignment_id,
      runId: latest.run_id,
      taskId: latest.task_id,
      role: latest.role,
      phase: latest.phase,
      attempt: latest.attempt,
      fencingToken: latest.fencing_token,
      completionId,
      output,
      nativeSessionId: latest.native_session_id,
      conversationId: latest.conversation_id,
    }, {
      outboxId: `result:${compactId(completionId, 160)}`,
    });
    // A remote assignment is one turn. Preserve its native session id for a
    // later resumed assignment, but release the managed wrapper once the
    // durable result has reached the source device.
    try {
      this.registry.enqueueCommand(notification.sessionId, {
        type: "session.stop",
        sessionId: notification.sessionId,
      });
    } catch {}
  }

  acceptsFencing(run, role, payload) {
    const agent = run?.agents?.[role];
    if (!agent) return false;
    const hasAttempt = payload.attempt != null;
    const hasToken = payload.fencingToken != null;
    // Protocol v1 peers deployed before fencing support do not send these
    // fields. Preserve rolling-upgrade compatibility while retaining the
    // existing run/task/role checks performed by each caller.
    if (!hasAttempt && !hasToken) return true;
    if (!hasAttempt || !hasToken) return false;
    return Number(payload.fencingToken || 0) === Number(agent.fencing_token || 0)
      && Number(payload.attempt || 0) === Number(agent.attempt || 0);
  }

  async sendRemoteDurable(type, payload, { outboxId } = {}) {
    if (!this.relayClient) throw new Error("collaboration relay is unavailable");
    const item = this.store.enqueueOutbox({
      outboxId,
      runId: payload.runId,
      assignmentId: payload.assignmentId,
      messageType: type,
      targetDeviceId: payload.targetDeviceId,
      payload,
    });
    if (item.state === "delivered") return { accepted: true, duplicate: true };
    return this.deliverOutbox(item);
  }

  async deliverOutbox(item) {
    const current = this.outboxDeliveries.get(item.outbox_id);
    if (current) return current;
    const operation = this._deliverOutbox(item)
      .finally(() => this.outboxDeliveries.delete(item.outbox_id));
    this.outboxDeliveries.set(item.outbox_id, operation);
    return operation;
  }

  async _deliverOutbox(item) {
    this.store.markOutboxAttempt(item.outbox_id);
    try {
      const result = await this.relayClient.send(item.message_type, item.payload);
      const delivery = result?.data || result || {};
      if (delivery.accepted === false && !delivery.queued) {
        const error = new Error(delivery.reason || "collaboration relay rejected message");
        error.code = safeText(delivery.reason, 96) || "COLLABORATION_RELAY_REJECTED";
        throw error;
      }
      this.store.markOutboxDelivered(item.outbox_id);
      this.applyOutboxDelivery(item, delivery);
      return result;
    } catch (error) {
      const reason = error?.code || error?.message || "delivery_failed";
      if (retryableDeliveryError(error)) {
        const latest = this.store.markOutboxFailure(item.outbox_id, reason);
        this.scheduleOutboxRetry(latest?.attempts || 1);
      } else {
        this.store.markOutboxFailed(item.outbox_id, reason);
      }
      throw error;
    }
  }

  scheduleOutboxRetry(attempts) {
    if (this.outboxRetryTimer) return;
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(6, Math.max(0, attempts - 1))));
    this.outboxRetryTimer = setTimeout(() => {
      this.outboxRetryTimer = null;
      void this.flushOutbox();
    }, delayMs);
    this.outboxRetryTimer.unref?.();
  }

  applyOutboxDelivery(item, delivery) {
    if (item.message_type !== "collaboration.remote.dispatch") return;
    const run = this.store.getRun(item.run_id, { includeMessages: false });
    const role = safeText(item.payload?.role, 32);
    if (!run?.agents?.[role]) return;
    this.store.updateAgent(run.run_id, role, {
      status: delivery.queued || delivery.reason === "queued"
        ? "waiting_device"
        : "dispatched",
    });
  }

  async flushOutbox() {
    this.outboxFlush = this.outboxFlush.catch(() => {}).then(async () => {
      const items = this.store.listPendingOutbox({ limit: 500 });
      let delivered = 0;
      for (const item of items) {
        try {
          await this.deliverOutbox(item);
          delivered += 1;
        } catch {}
      }
      return { pending: items.length - delivered, delivered };
    });
    return this.outboxFlush;
  }

  async handleTurnCompleted(runId, role, output, completionKey) {
    let run = this.store.getRun(runId);
    if (!run || TERMINAL_STATES.has(run.state)) return;
    if (run.template_id === ADAPTIVE_TEMPLATE_ID) {
      await this.handleAdaptiveTurnCompleted(run, role, output, completionKey);
      return;
    }
    if (expectedRole(run) !== role) return;
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
        run = this.coordinator.receive(runId, {
          ...base,
          type: "verification.passed",
          idempotency_key: `auto-verification-${completionKey}`,
          sender: { kind: "coordinator", device_id: this.deviceId },
        }).run;
        this.stopLocalRunSessions(run);
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
        if (run.state === "completed") this.stopLocalRunSessions(run);
        void this.syncRun(runId);
      }
    }
  }

  async handleAdaptiveTurnCompleted(run, role, output, completionKey) {
    const agent = run.agents?.[role];
    if (!agent?.current_task_id) return;
    const task = run.tasks.find((item) => item.task_id === agent.current_task_id);
    if (!task) return;
    const base = {
      task_id: task.task_id,
      sender: { kind: "agent", agent_id: agent.agent_id, device_id: agent.device_id },
      recipient: { kind: "coordinator", device_id: this.deviceId },
      payload: { content: output || "Agent completed without a textual report." },
    };
    if (run.state === "designing" && task.task_key === "__planner__" && role === run.planner_role) {
      let plan;
      try {
        plan = parsePlannerOutput(output, { participantIds: Object.keys(run.agents) });
      } catch (error) {
        const invalid = new Error(`The Planner returned a plan that could not be validated: ${error.message}`);
        invalid.code = "COLLABORATION_PLAN_INVALID";
        throw invalid;
      }
      this.store.appendMessage(run.run_id, {
        ...base,
        type: "plan.submitted",
        idempotency_key: `adaptive-plan-${completionKey}`,
      });
      this.store.updateAgent(run.run_id, role, { status: "idle", currentTaskId: "" });
      this.store.setAdaptivePlan(run.run_id, plan);
      void this.syncRun(run.run_id);
      return;
    }
    if (run.state !== "executing" || task.task_key === "__planner__") return;
    this.store.appendMessage(run.run_id, {
      ...base,
      type: "task.completed",
      idempotency_key: `adaptive-task-${task.task_key}-${completionKey}`,
    });
    this.store.updateAdaptiveTask(run.run_id, task.task_key, {
      state: "completed",
      resultSummary: output || "Completed without a written summary.",
    });
    this.store.updateAgent(run.run_id, role, { status: "idle", currentTaskId: "" });
    const current = this.store.getRun(run.run_id);
    const remaining = current.tasks.filter((item) => item.task_key !== "__planner__" && item.state !== "completed");
    if (remaining.length === 0) {
      const completed = this.store.transition(run.run_id, "completed");
      this.stopLocalRunSessions(completed);
      void this.syncRun(run.run_id);
      return;
    }
    await this.dispatchForState(run.run_id);
  }

  stopLocalRunSessions(run) {
    for (const agent of Object.values(run?.agents || {})) {
      if (!agent.originrouter_session_id) continue;
      try {
        this.registry.enqueueCommand(agent.originrouter_session_id, {
          type: "session.stop",
          sessionId: agent.originrouter_session_id,
        });
      } catch {}
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
    if (!this.relayClient) return false;
    const run = this.store.getRun(runId, { includeMessages: false });
    if (!run) return false;
    try {
      await this.relayClient.send("collaboration.run.project", {
        sourceDeviceId: this.deviceId,
        runId: run.run_id,
        templateId: run.template_id,
        workflowTemplateId: run.workflow_template_id,
        workspaceMode: run.workspace_mode,
        resolvedWorkspaceMode: run.resolved_workspace_mode,
        coordinatorRuntime: run.coordinator_runtime,
        planningSource: run.planning_source,
        riskTier: run.risk_tier,
        objectivePreview: "",
        state: run.state,
        taskTitle: "",
        contentRedacted: true,
        budget: run.budget,
        usage: run.usage,
        counters: run.counters,
        createdAt: Math.floor(new Date(run.created_at).getTime() / 1000),
        finishedAt: run.finished_at ? Math.floor(new Date(run.finished_at).getTime() / 1000) : null,
      });
      return true;
    } catch {
      // Collaboration projection is best-effort. Local state remains
      // canonical, and an expired relay login must never terminate the daemon
      // that owns Agent history, control, and E2EE routing.
      return false;
    }
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

  close() {
    this.unsubscribe();
    if (this.outboxRetryTimer) clearTimeout(this.outboxRetryTimer);
    this.outboxRetryTimer = null;
    for (const pending of this.mcpRequests.values()) {
      clearTimeout(pending.timer);
      const error = new Error("Agent MCP gateway stopped.");
      error.code = "COLLABORATION_MCP_STOPPED";
      pending.reject(error);
    }
    this.mcpRequests.clear();
    for (const pending of this.capabilityRequests.values()) {
      clearTimeout(pending.timer);
      const error = new Error("collaboration capability discovery stopped");
      error.code = "COLLABORATION_CAPABILITY_STOPPED";
      pending.reject(error);
    }
    this.capabilityRequests.clear();
    for (const pending of this.workspaceTrustRequests.values()) {
      clearTimeout(pending.timer);
      const error = new Error("collaboration workspace trust stopped");
      error.code = "COLLABORATION_WORKSPACE_TRUST_STOPPED";
      pending.reject(error);
    }
    this.workspaceTrustRequests.clear();
    for (const pending of this.workspaceBrowseRequests.values()) {
      clearTimeout(pending.timer);
      const error = new Error("collaboration workspace browser stopped");
      error.code = "COLLABORATION_WORKSPACE_BROWSE_STOPPED";
      pending.reject(error);
    }
    this.workspaceBrowseRequests.clear();
  }
}
