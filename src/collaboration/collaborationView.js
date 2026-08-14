const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "expired"]);

const RUN_STATE_MAP = Object.freeze({
  created: { state: "created", phase: "preparing" },
  designing: { state: "planning", phase: "plan_design" },
  researching: { state: "planning", phase: "research" },
  decomposing: { state: "planning", phase: "decomposition" },
  planning: { state: "planning", phase: "planning" },
  awaiting_plan_confirmation: { state: "awaiting_confirmation", phase: "plan_review" },
  awaiting_plan_review: { state: "awaiting_confirmation", phase: "plan_review" },
  plan_approved: { state: "queued", phase: "implementation" },
  executing: { state: "running", phase: "execution" },
  implementing: { state: "running", phase: "implementation" },
  awaiting_verification: { state: "running", phase: "verification" },
  revision_requested: { state: "running", phase: "plan_revision" },
  rework_requested: { state: "running", phase: "rework" },
  waiting_approval: { state: "blocked", phase: "execution", blockedReason: "approval_required" },
  waiting_input: { state: "blocked", phase: "execution", blockedReason: "input_required" },
  waiting_device: { state: "blocked", phase: "execution", blockedReason: "device_unavailable" },
  budget_exhausted: { state: "paused", phase: "execution", pauseReason: "budget_exhausted" },
  paused: { state: "paused", phase: "execution", pauseReason: "user_requested" },
  blocked: { state: "blocked", phase: "execution", blockedReason: "retry_required" },
  completed: { state: "completed", phase: "completed" },
  failed: { state: "failed", phase: "failed" },
  cancelled: { state: "cancelled", phase: "cancelled" },
  expired: { state: "expired", phase: "expired" },
});

const EVENT_DEFAULTS = Object.freeze({
  "run.created": ["run", "info", "summary"],
  "run.planning_started": ["run", "info", "summary"],
  "run.plan_ready": ["run", "success", "summary"],
  "run.confirmed": ["run", "info", "summary"],
  "run.started": ["run", "info", "summary"],
  "run.paused": ["run", "warning", "summary"],
  "run.resumed": ["run", "info", "summary"],
  "run.blocked": ["run", "warning", "summary"],
  "run.completed": ["run", "success", "summary"],
  "run.failed": ["run", "error", "summary"],
  "run.cancel_requested": ["run", "warning", "summary"],
  "run.cancelled": ["run", "warning", "summary"],
  "run.recovered": ["run", "info", "summary"],
  "run.retry_created": ["run", "info", "summary"],
  "plan.generated": ["plan", "success", "summary"],
  "plan.validation_failed": ["plan", "error", "summary"],
  "plan.confirmed": ["plan", "success", "summary"],
  "task.ready": ["task", "info", "detail"],
  "task.assigned": ["task", "info", "summary"],
  "task.started": ["task", "info", "summary"],
  "task.progress": ["task", "info", "summary"],
  "task.completed": ["task", "success", "summary"],
  "task.failed": ["task", "error", "summary"],
  "task.retry_scheduled": ["task", "info", "summary"],
  "task.cancelled": ["task", "warning", "summary"],
  "task.delegated": ["task", "info", "summary"],
  "task.handoff": ["task", "info", "summary"],
  "approval.requested": ["approval", "warning", "summary"],
  "approval.resolved": ["approval", "info", "summary"],
  "interaction.requested": ["interaction", "warning", "summary"],
  "interaction.resolved": ["interaction", "info", "summary"],
  "budget.warning": ["budget", "warning", "summary"],
  "budget.exhausted": ["budget", "error", "summary"],
  "device.waiting": ["device", "warning", "summary"],
  "device.reconnected": ["device", "info", "summary"],
  "artifact.created": ["artifact", "success", "summary"],
  "agent.session_ready": ["agent", "info", "detail"],
  "agent.activity": ["agent", "info", "detail"],
  "agent.tool_started": ["agent", "info", "detail"],
  "agent.tool_completed": ["agent", "info", "detail"],
  "agent.usage": ["agent", "info", "diagnostic"],
});

function text(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function runViewState(legacyState) {
  return RUN_STATE_MAP[text(legacyState, 64)] || {
    state: "blocked",
    phase: "unknown",
    blockedReason: "unsupported_state",
  };
}

export function taskViewState(task, completedKeys = new Set()) {
  const current = text(task?.state, 64);
  if (current === "active") return "running";
  if (current !== "pending") return current || "pending";
  const dependencies = Array.isArray(task?.depends_on) ? task.depends_on : [];
  return dependencies.every((dependency) => completedKeys.has(dependency)) ? "ready" : "pending";
}

export function eventPresentation(type, overrides = {}) {
  const normalizedType = text(type, 96) || "agent.activity";
  const fallbackCategory = normalizedType.split(".")[0] || "agent";
  const [category, severity, visibility] = EVENT_DEFAULTS[normalizedType]
    || [fallbackCategory, "info", normalizedType.startsWith("agent.") ? "detail" : "summary"];
  return {
    category: text(overrides.category, 32) || category,
    severity: ["info", "success", "warning", "error"].includes(overrides.severity)
      ? overrides.severity
      : severity,
    visibility: ["summary", "detail", "diagnostic", "audit_only"].includes(overrides.visibility)
      ? overrides.visibility
      : visibility,
  };
}

export function derivedAttentionItems(run) {
  const items = [];
  const runId = text(run?.run_id, 195);
  if (run?.state === "awaiting_plan_confirmation") {
    items.push({
      attention_id: `derived:${runId}:plan_confirmation`,
      kind: "plan_confirmation",
      status: "pending",
      run_id: runId,
      task_id: null,
      participant_id: run.planner_role || null,
      title: "Collaboration plan needs confirmation",
      summary: "Review the proposed plan before execution starts.",
      risk: "normal",
      actions: ["confirm", "revise", "cancel"],
      created_at: run.updated_at,
      expires_at: null,
      resolved_at: null,
      resolved_by: null,
      derived: true,
    });
  }
  if (run?.state === "budget_exhausted" || run?.account_budget_blocked) {
    items.push({
      attention_id: `derived:${runId}:budget`,
      kind: "budget",
      status: "pending",
      run_id: runId,
      task_id: null,
      participant_id: null,
      title: "Collaboration budget exhausted",
      summary: "Further work is paused until the applicable budget is changed or becomes available.",
      risk: "normal",
      actions: ["view_budget", "cancel"],
      created_at: run.updated_at,
      expires_at: null,
      resolved_at: null,
      resolved_by: null,
      derived: true,
    });
  }
  return items;
}

export function buildFinalReport(run) {
  const tasks = (run?.tasks || []).filter((task) => task.task_key !== "__planner__");
  const completed = tasks.filter((task) => task.state === "completed");
  const incomplete = tasks.filter((task) => task.state !== "completed");
  const participants = Object.entries(run?.agents || {}).map(([participantId, agent]) => ({
    participant_id: participantId,
    display_name: agent.display_name || participantId,
    runtime: agent.runtime,
    device_id: agent.device_id,
    model: agent.model || null,
    completed_tasks: completed.filter((task) => task.participant_id === participantId).map((task) => task.task_key || task.task_id),
  }));
  return {
    schema_version: 1,
    outcome: run?.state || "failed",
    summary: run?.state === "completed"
      ? `Completed ${completed.length} of ${tasks.length} collaboration tasks.`
      : `${completed.length} of ${tasks.length} collaboration tasks completed before the run ${run?.state || "ended"}.`,
    completed_tasks: completed.map((task) => ({
      task_id: task.task_key || task.task_id,
      title: task.title,
      participant_id: task.participant_id,
      result: task.result_summary || task.summary || "Completed without a written summary.",
    })),
    failed_or_skipped_tasks: incomplete.map((task) => ({
      task_id: task.task_key || task.task_id,
      title: task.title,
      participant_id: task.participant_id,
      state: task.state,
      result: task.result_summary || task.summary || "",
    })),
    participant_contributions: participants,
    verification_result: tasks.some((task) => task.kind === "verify")
      ? (tasks.filter((task) => task.kind === "verify").every((task) => task.state === "completed") ? "passed" : "incomplete")
      : "not_requested",
    artifacts: (run?.artifacts || []).map((artifact) => ({
      artifact_id: artifact.artifact_id,
      kind: artifact.kind,
      display_name: artifact.display_name,
      locator: artifact.locator || "",
    })),
    workspace_change_warning: run?.state === "completed"
      ? null
      : "The workspace may contain changes from tasks that ran before this collaboration ended.",
    usage: run?.usage || {},
    duration: {
      started_at: run?.started_at || run?.created_at || null,
      finished_at: run?.finished_at || null,
    },
    recommended_next_actions: run?.state === "failed" ? ["Review the failed task and retry with a new collaboration run."] : [],
    created_at: run?.finished_at || run?.updated_at || new Date().toISOString(),
  };
}

export function isTerminalRunState(state) {
  return TERMINAL_RUN_STATES.has(state);
}
