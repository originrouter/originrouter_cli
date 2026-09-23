function safeText(value, maxLen = 512) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  if (!text) return "";
  return text.slice(0, maxLen);
}

function safeLocalControlProviders(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const providers = [];
  for (const item of value.slice(0, 128)) {
    if (!item || typeof item !== "object") continue;
    const name = safeText(item.name, 64);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const provider = {
      name,
      type: safeText(item.type, 32) || "proxy",
      litellmProvider: safeText(item.litellmProvider, 64),
      model: safeText(item.model, 512),
      target: safeText(item.target, 32),
      deviceId: safeText(item.deviceId, 128),
    };
    const modelIds = new Set();
    const models = [];
    for (const raw of Array.isArray(item.models) ? item.models.slice(0, 256) : []) {
      const object = raw && typeof raw === "object" ? raw : null;
      const id = safeText(object ? object.id : raw, 512);
      if (!id || modelIds.has(id)) continue;
      modelIds.add(id);
      const enabled = object ? object.enabled !== false : true;
      models.push({
        id,
        enabled,
        remoteEnabled: enabled && object?.remoteEnabled === true,
        ...(object?.pricing && typeof object.pricing === "object"
          ? { pricing: object.pricing }
          : {}),
      });
    }
    if (models.length > 0) provider.models = models;
    providers.push(provider);
  }
  return providers;
}

function safeLocalControlRoutes(value) {
  if (!Array.isArray(value)) return [];
  const routes = [];
  for (const item of value.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const agent = safeText(item.agent, 32);
    const slot = safeText(item.slot, 32);
    const provider = safeText(item.provider, 64);
    if (!agent || !slot || !provider) continue;
    routes.push({
      agent,
      slot,
      provider,
      model: safeText(item.model, 256),
    });
  }
  return routes;
}

function safeAgentBudgetPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const positive = (input) => {
    const number = Number(input);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
  };
  return {
    daily_token_limit: positive(value.daily_token_limit),
    weekly_token_limit: positive(value.weekly_token_limit),
    daily_amount_limit_micros: positive(value.daily_amount_limit_micros),
    weekly_amount_limit_micros: positive(value.weekly_amount_limit_micros),
    currency: /^[A-Z]{3}$/.test(String(value.currency || "").toUpperCase())
      ? String(value.currency).toUpperCase()
      : "USD",
    enforcement: value.enforcement === "warn" ? "warn" : "block",
  };
}

function safeAgentBudgets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const status = (entry) => ({
    policy: safeAgentBudgetPolicy(entry?.policy),
    daily: {
      sampled_tokens: Math.max(0, Number(entry?.daily?.sampled_tokens) || 0),
      amount_micros: Math.max(0, Number(entry?.daily?.amount_micros) || 0),
    },
    weekly: {
      sampled_tokens: Math.max(0, Number(entry?.weekly?.sampled_tokens) || 0),
      amount_micros: Math.max(0, Number(entry?.weekly?.amount_micros) || 0),
    },
    warning: entry?.warning === true,
    exhausted: entry?.exhausted === true,
    blocked: entry?.blocked === true,
  });
  return {
    device: status(value.device),
    agents: {
      claude: status(value.agents?.claude),
      codex: status(value.agents?.codex),
    },
  };
}

function safeCompatibilityStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const patches = Array.isArray(value.patches) ? value.patches.slice(0, 128).map((patch) => ({
    id: safeText(patch?.id, 256),
    name: safeText(patch?.name, 128),
    description: safeText(patch?.description, 1024),
    version: safeText(patch?.version, 32),
    phase: safeText(patch?.phase, 16),
    required: patch?.required === true,
    failure_mode: safeText(patch?.failure_mode, 16),
    match: patch?.match && typeof patch.match === "object" ? patch.match : {},
    enabled: patch?.enabled !== false,
  })).filter((patch) => patch.id) : [];
  const operation = value.last_operation && typeof value.last_operation === "object"
    ? {
        id: safeText(value.last_operation.id, 128),
        action: safeText(value.last_operation.action, 16),
        state: safeText(value.last_operation.state, 16),
        started_at: safeText(value.last_operation.started_at, 64),
        completed_at: safeText(value.last_operation.completed_at, 64),
        message: safeText(value.last_operation.message, 512),
      }
    : null;
  return {
    engine_version: safeText(value.engine_version, 32),
    source: safeText(value.source, 16),
    bundle_id: safeText(value.bundle_id, 256),
    revision: Math.max(0, Number.parseInt(String(value.revision || 0), 10) || 0),
    generated_at: safeText(value.generated_at, 64),
    automatic_updates: value.automatic_updates === true,
    last_checked_at: safeText(value.last_checked_at, 64),
    latest_revision: Math.max(0, Number.parseInt(String(value.latest_revision || 0), 10) || 0),
    update_available: value.update_available === true,
    can_rollback: value.can_rollback === true,
    enabled_patch_count: patches.filter((patch) => patch.enabled).length,
    patches,
    last_operation: operation,
  };
}

function compactText(value, maxLen = 512) {
  return safeText(value, maxLen).replace(/\s+/g, " ");
}

export function redactAgentActivityText(value, maxLen = 4096) {
  return compactText(value, maxLen)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]")
    .replace(/\b(?:sk[-_]|or_at_|or_rt_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._~-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export function normalizeAgentActivityEventType(event = {}) {
  const type = String(event.type || event.eventType || "").trim();
  return ({
    agent_message: "agent.text",
    user_message: "user.text",
    task_started: "agent.task.started",
    "agent.task.completed": "agent.task.complete",
  })[type] || type;
}

export function shouldSyncAgentActivitySnapshot(event = {}) {
  return ["user.text", "agent.text", "agent.task.complete"].includes(
    normalizeAgentActivityEventType(event),
  );
}

export function updateAgentActivitySnapshot(snapshot, event = {}) {
  const target = snapshot && typeof snapshot === "object" ? snapshot : {};
  const normalizedType = normalizeAgentActivityEventType(event);
  let text = redactAgentActivityText(
    event.text || event.message || event.content || event.result || event.detail
      || event.summary || event.reason,
    normalizedType === "agent.task.complete" ? 4096 : 1024,
  );
  if (
    normalizedType === "agent.task.complete"
    && (!text || /^(?:complete|completed|done|success)$/i.test(text))
  ) {
    text = target.lastAgentPreview || "";
  }
  if (!text) return target;
  if (normalizedType === "user.text") {
    if (!target.firstPromptPreview) target.firstPromptPreview = text;
    target.lastMessagePreview = text;
  } else if (normalizedType === "agent.text") {
    target.lastMessagePreview = text;
    target.lastAgentPreview = text;
  } else if (["agent.task.started", "agent.task.complete"].includes(normalizedType)) {
    target.summary = text;
  }
  return target;
}

function safeIsoTimestamp(value) {
  if (value == null || value === "") return "";
  const normalized = typeof value === "number" && value > 0 && value < 1e12
    ? value * 1000
    : value;
  const parsed = normalized instanceof Date ? normalized : new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return "";
  return parsed.toISOString();
}

function approvalInteractionId(event) {
  return safeText(event?.interactionId || event?.callId || event?.id, 191);
}

function approvalCommandPreview(event) {
  const input = event?.input;
  if (!input || typeof input !== "object") return "";
  const candidate = input.command
    || input.cmd
    || input.file_path
    || input.path
    || input.description;
  return compactText(candidate, 512);
}

function approvalRiskLevel(event) {
  const tool = String(event?.tool || event?.action || "").trim().toLowerCase();
  const preview = approvalCommandPreview(event).toLowerCase();
  if (
    ["bash", "shell", "write", "edit", "apply_patch", "delete", "computer"].some(
      (item) => tool.includes(item),
    )
    || /(^|\s)(sudo|rm|chmod|chown|kill|shutdown|reboot)(\s|$)/.test(preview)
  ) {
    return "high";
  }
  if (["read", "glob", "grep", "search", "list", "fetch"].some((item) => tool.includes(item))) {
    return "low";
  }
  return "medium";
}

function displaySummaryForAgentEvent(event) {
  const type = String(event?.type || "");
  const tool = compactText(event?.tool || event?.name || event?.action, 64);
  if (type === "agent.ready") return "Agent is ready";
  if (type === "agent.thinking") return "Agent is thinking";
  if (type === "agent.text") return "Assistant response received";
  if (type === "user.text") return "User message received";
  if (type === "token_count") return "Token usage updated";
  if (type === "agent.mode.status") return "Agent mode updated";
  if (type === "agent.autonomy.status") return "Unattended execution updated";
  if (type === "agent.interaction.auto_resolved") return "Blocking action continued automatically";
  if (type === "agent.task.started") return "Task started";
  if (type === "agent.task.complete") return "Task completed";
  if (type === "agent.task.aborted") return "Task aborted";
  if (type === "agent.tool_call.start") return tool ? `Started ${tool}` : "Tool started";
  if (type === "agent.tool_call.end") return tool ? `Finished ${tool}` : "Tool finished";
  if (type === "agent.adapter.status") return "Agent runtime status changed";
  if (type === "plan.updated") return "Execution plan updated";
  if (type === "review.started") return "Review started";
  if (type === "review.completed") return "Review completed";
  if (type.startsWith("agent.subagent.")) {
    return compactText(event?.summary, 512) || "Subagent status updated";
  }
  if (type === "agent.activity") {
    return compactText(event?.summary || event?.message || event?.activity, 512) || "Agent activity updated";
  }
  if (type === "agent.session.start") return "Agent session started";
  return "Agent update";
}

function projectRuntimeEvent({ eventType, event, summary, riskLevel }) {
  if (eventType === "session.started") {
    return {
      eventType: "session_started",
      status: "running",
      summary: "Agent session started",
      currentStep: "Running",
    };
  }
  if (eventType === "session.exited") {
    const signal = String(event?.signal ?? "").trim().toUpperCase();
    const stoppedBySignal = ["SIGHUP", "SIGINT", "SIGTERM", "1", "2", "15"]
      .includes(signal);
    const succeeded = Number(event?.code ?? 0) === 0 && !event?.signal;
    return {
      // A process ending is a session lifecycle fact, not evidence that a
      // user-requested task produced a result. Task completion is projected
      // below from the structured Agent event and is the only completion that
      // may become a user notification.
      eventType: "session_terminated",
      status: stoppedBySignal ? "stopped" : succeeded ? "completed" : "failed",
      summary: stoppedBySignal
        ? "Agent session stopped"
        : succeeded
          ? "Agent session completed"
          : "Agent session exited with an error",
      detail: event?.signal
        ? `signal=${compactText(event.signal, 32)}`
        : `exit_code=${Number(event?.code ?? 1)}`,
      currentStep: stoppedBySignal ? "Stopped" : succeeded ? "Completed" : "Failed",
    };
  }
  if (eventType === "session.error") {
    return {
      // The wrapper always follows this diagnostic with session.exited. Keep
      // the diagnostic visible without creating a second terminal outcome.
      eventType: "session_runtime_error",
      status: "running",
      summary: "Agent runtime reported an error",
      detail: "",
      currentStep: "Failed",
    };
  }
  if (eventType !== "agent.event") {
    return {
      eventType: safeText(eventType, 64),
      status: "running",
      summary: compactText(summary, 512) || "Agent update",
      currentStep: compactText(summary, 255) || "Running",
    };
  }

  if (["diagnostic", "status", "internal", "audit_only"].includes(event?.visibility)) {
    return null;
  }

  const rawNestedType = safeText(event?.type, 64);
  const nestedType = ({
    "agent.task.completed": "agent.task.complete",
    agent_message: "agent.text",
    task_started: "agent.task.started",
    exec_command_begin: "agent.tool_call.start",
    exec_command_end: "agent.tool_call.end",
    patch_apply_begin: "agent.tool_call.start",
    patch_apply_end: "agent.tool_call.end",
  })[rawNestedType] || rawNestedType;
  if (!nestedType) return null;
  if (
    nestedType === "agent.interaction.requested"
    && event?.payload
    && ["confirm", "questions", "form", "url"].includes(event?.kind)
  ) {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    return {
      eventType: "interaction_requested",
      status: "waiting_input",
      summary: "Agent input required",
      currentStep: "Waiting for input",
      interactionId,
      action: safeText(event.kind, 32),
    };
  }
  if (nestedType === "agent.permission.request.detected" || nestedType === "agent.interaction.requested") {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    const tool = compactText(event?.tool || event?.kind || "permission", 64);
    return {
      eventType: "approval_requested",
      status: "waiting_approval",
      summary: tool ? `Permission required for ${tool}` : "Agent permission required",
      currentStep: "Waiting for approval",
      interactionId,
      action: tool || "permission_request",
      riskLevel: riskLevel || approvalRiskLevel(event),
      commandPreview: "",
    };
  }
  if (nestedType === "agent.permission.resolved") {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    const resolutionReason = String(event?.reason || "").toLowerCase();
    const expired = /(timeout|abort|cleanup|stopped|session ended)/.test(
      resolutionReason,
    );
    return {
      eventType: expired ? "approval_expired" : "approval_applied",
      status: "running",
      summary: expired ? "Approval request expired" : "Approval applied on device",
      detail: compactText(event?.reason, 512),
      currentStep: expired ? "Approval expired" : "Running",
      interactionId,
    };
  }
  if (nestedType === "agent.permission.resolve.error") {
    return {
      eventType: "approval_failed",
      // This is an operation-level delivery failure. The long-lived Agent
      // process remains online until a session.failed/session.exited event
      // says otherwise.
      status: "running",
      summary: "Approval could not be applied on device",
      detail: "",
      currentStep: "Approval delivery failed",
      interactionId: approvalInteractionId(event),
    };
  }
  if ([
    "agent.interaction.applied",
    "agent.interaction.expired",
    "agent.interaction.failed",
    "agent.interaction.canceled",
  ].includes(nestedType)) {
    const interactionId = approvalInteractionId(event);
    if (!interactionId) return null;
    const suffix = nestedType.split(".").at(-1);
    return {
      eventType: `interaction_${suffix}`,
      status: "running",
      summary: `Interaction ${suffix}`,
      detail: compactText(event?.reason, 512),
      currentStep: suffix === "failed" ? "Interaction failed" : "Running",
      interactionId,
    };
  }

  const displaySafeEventTypes = new Set([
    "agent.session.start",
    "agent.text",
    "agent.thinking",
    "user.text",
    "token_count",
    "agent.mode.status",
    "agent.autonomy.status",
    "agent.interaction.auto_resolved",
    "agent.ready",
    "agent.task.started",
    "agent.tool_call.start",
    "agent.tool_call.end",
    "agent.task.complete",
    "agent.task.aborted",
    "agent.task.failed",
    "agent.adapter.status",
    "agent.activity",
    "plan.updated",
    "review.started",
    "review.completed",
    "agent.subagent.started",
    "agent.subagent.interacted",
    "agent.subagent.interrupted",
    "agent.subagent.completed",
  ]);
  if (!displaySafeEventTypes.has(nestedType)) return null;

  // A task is one conversational turn. Completing or interrupting it does
  // not close the long-lived Claude/Codex session.
  const status = "running";
  const displayEvent = { ...event, type: nestedType };
  return {
    eventType: nestedType,
    status,
    summary: displaySummaryForAgentEvent(displayEvent),
    detail: compactText(event?.detail || event?.message || event?.reason, 512),
    currentStep: displaySummaryForAgentEvent(displayEvent),
    mode: nestedType === "agent.mode.status" ? safeText(event?.mode, 32) : "",
    modeControl: nestedType === "agent.mode.status" ? safeText(event?.modeControl, 16) : "",
    availableModes: nestedType === "agent.mode.status"
      ? (Array.isArray(event?.availableModes) ? event.availableModes : [])
        .slice(0, 16)
        .map((item) => typeof item === "string"
          ? { id: safeText(item, 32), label: safeText(item, 64) }
          : {
              id: safeText(item?.id, 32),
              label: safeText(item?.label || item?.id, 64),
              description: safeText(item?.description, 256),
            })
        .filter((item) => item.id)
      : [],
  };
}

function safeRemoteShareCatalog(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const catalog = [];
  for (const item of value.slice(0, 256)) {
    const provider = safeText(item?.provider, 640);
    if (!provider || seen.has(provider)) continue;
    seen.add(provider);
    catalog.push({ provider, model: safeText(item?.model, 512) });
  }
  return catalog;
}

function stripAnsi(text) {
  return String(text || "").replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

export {
  compactText,
  projectRuntimeEvent,
  safeAgentBudgetPolicy,
  safeAgentBudgets,
  safeCompatibilityStatus,
  safeIsoTimestamp,
  safeLocalControlProviders,
  safeLocalControlRoutes,
  safeRemoteShareCatalog,
  safeText,
  stripAnsi,
};
