import { randomUUID } from "node:crypto";

import { ADAPTIVE_TEMPLATE_ID, normalizeParticipants } from "./adaptivePlan.js";

const SUPERVISOR_PERMISSION_PROFILES = new Set([
  "manual", "guarded", "ai_review", "custom", "unrestricted",
]);
const FORBIDDEN_KEYS = /token|secret|password|authorization|cookie|api[_-]?key|service[_-]?key|environment|env_dump/i;
const SAFE_USAGE_KEYS = new Set([
  "token_limit", "token_budget", "sampled_tokens", "sampledTokens",
  "token_usage", "tokenUsage", "input_tokens", "inputTokens",
  "output_tokens", "outputTokens", "reasoning_tokens", "reasoningTokens",
  "cached_input_tokens", "cachedInputTokens", "total_tokens", "totalTokens",
  "cache_read_input_tokens", "cacheReadInputTokens", "cache_write_input_tokens", "cacheWriteInputTokens",
  "cache_write_5m_input_tokens", "cacheWrite5mInputTokens", "cache_write_1h_input_tokens", "cacheWrite1hInputTokens",
  "fencing_token", "fencingToken", "contains_secret", "containsSecret",
]);

export function safeText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function iso(value = null) {
  const numeric = typeof value === "number" ? value : null;
  const normalized = numeric != null && Number.isFinite(numeric) && Math.abs(numeric) < 1e12
    ? numeric * 1000
    : value;
  const date = normalized == null ? new Date() : new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function telemetryTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return {
    input_tokens: value.input_tokens ?? value.inputTokens,
    output_tokens: value.output_tokens ?? value.outputTokens,
    reasoning_tokens: value.reasoning_tokens ?? value.reasoningTokens,
    cache_read_input_tokens: value.cache_read_input_tokens
      ?? value.cacheReadInputTokens
      ?? value.cached_input_tokens
      ?? value.cachedInputTokens,
    cache_write_input_tokens: value.cache_write_input_tokens ?? value.cacheWriteInputTokens,
    cache_write_5m_input_tokens: value.cache_write_5m_input_tokens ?? value.cacheWrite5mInputTokens,
    cache_write_1h_input_tokens: value.cache_write_1h_input_tokens ?? value.cacheWrite1hInputTokens,
  };
}

export function assertNoSecretFields(value) {
  if (Array.isArray(value)) {
    for (const child of value) assertNoSecretFields(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_USAGE_KEYS.has(key) && FORBIDDEN_KEYS.test(key)) {
      const error = new Error(`forbidden_collaboration_field:${key}`);
      error.code = "forbidden_collaboration_field";
      throw error;
    }
    assertNoSecretFields(child);
  }
}

export function normalizeRole(role, name) {
  if (!role || typeof role !== "object") throw new Error(`${name} role is required`);
  const runtime = safeText(role.runtime, 32).toLowerCase();
  if (!["claude", "codex"].includes(runtime)) throw new Error(`${name} runtime must be claude or codex`);
  const deviceId = safeText(role.device_id ?? role.deviceId, 191);
  if (!deviceId) throw new Error(`${name} device_id is required`);
  const responsibilities = [...new Set((Array.isArray(role.responsibilities) ? role.responsibilities : [])
    .map((item) => safeText(item, 64)).filter(Boolean))];
  if (responsibilities.length === 0) throw new Error(`${name} responsibilities are required`);
  return {
    agent_id: safeText(role.agent_id ?? role.agentId, 195) || id("agent"),
    role: name,
    runtime,
    device_id: deviceId,
    workspace_id: safeText(role.workspace_id ?? role.workspaceId, 191),
    provider: safeText(role.provider, 191),
    model: safeText(role.model, 191),
    permission_profile: safeText(role.permission_profile ?? role.permissionProfile, 64),
    approval_policy_id: safeText(role.approval_policy_id ?? role.approvalPolicyId, 64),
    native_session_id: safeText(role.native_session_id ?? role.nativeSessionId, 191),
    conversation_id: safeText(role.conversation_id ?? role.conversationId, 96),
    responsibilities,
    display_name: safeText(role.display_name ?? role.displayName, 80) || name,
    role_hint: safeText(role.role_hint ?? role.roleHint, 2000),
    planner: role.planner === true,
  };
}

export function normalizeSessionTeam(input = {}) {
  const participants = normalizeParticipants(input.participants).map((participant) => ({
    participant_id: participant.participant_id,
    display_name: participant.display_name,
    runtime: participant.runtime,
    device_id: participant.device_id,
    workspace_id: participant.workspace_id,
    provider: participant.provider,
    model: participant.model,
    permission_profile: participant.permission_profile,
    approval_policy_id: participant.approval_policy_id,
    native_session_id: participant.native_session_id,
    conversation_id: participant.conversation_id,
    role_hint: participant.role_hint,
    planner: participant.planner,
  }));
  const team = {
    version: 1,
    participants,
    coordinator_runtime: safeText(input.coordinator_runtime ?? input.coordinatorRuntime, 16),
    workspace_mode: safeText(input.workspace_mode ?? input.workspaceMode, 32),
    resolved_workspace_mode: safeText(input.resolved_workspace_mode ?? input.resolvedWorkspaceMode, 32),
    workflow_template_id: safeText(input.workflow_template_id ?? input.workflowTemplateId, 64) || "adaptive",
    preferences: safeText(input.preferences, 16_000),
    coordination_prompt: safeText(input.coordination_prompt ?? input.coordinationPrompt, 16_000),
    supervisor_permission_profile: safeText(input.supervisor_permission_profile ?? input.session_permission_profile, 64) || "guarded",
    supervisor_policy_id: safeText(input.supervisor_policy_id ?? input.session_policy_id, 64),
    budget: {
      token_limit: input.budget?.token_limit == null ? null : Math.max(1, Number(input.budget.token_limit)),
      amount_limit_micros: input.budget?.amount_limit_micros == null ? null : Math.max(1, Number(input.budget.amount_limit_micros)),
      currency: input.budget?.currency ? safeText(input.budget.currency, 3).toUpperCase() : null,
      max_concurrency: Math.max(1, Math.min(16, Number(input.budget?.max_concurrency ?? Math.min(4, participants.length)))),
    },
  };
  if (!SUPERVISOR_PERMISSION_PROFILES.has(team.supervisor_permission_profile)) {
    throw new Error(`unsupported Session approval profile '${team.supervisor_permission_profile}'`);
  }
  if (team.supervisor_permission_profile === "custom" && !team.supervisor_policy_id) {
    throw new Error("Rules Session approval requires a policy ID");
  }
  if (team.supervisor_permission_profile !== "custom") team.supervisor_policy_id = "";
  assertNoSecretFields(team);
  return team;
}

export function publicWorkspaceSession(row) {
  if (!row) return null;
  return {
    workspace_session_id: row.workspace_session_id,
    team_revision: Number(row.team_revision || 0),
    team: parseJson(row.team_json, null),
    coordinator_device_id: row.coordinator_device_id || null,
    supervisor_permission_profile: row.supervisor_permission_profile || "guarded",
    supervisor_policy_id: row.supervisor_policy_id || null,
    latest_run_id: row.latest_run_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRun(row) {
  if (!row) return null;
  return {
    protocol_version: "1",
    schema_version: Number(row.schema_version || 1),
    revision: Number(row.revision || 0),
    template_id: row.template_id,
    template_version: row.template_version,
    run_id: row.run_id,
    workspace_session_id: row.workspace_session_id || null,
    continued_from_run_id: row.continued_from_run_id || null,
    team_revision: Number(row.team_revision || 0),
    session_continuation: Boolean(row.session_continuation),
    supervisor_permission_profile: row.supervisor_permission_profile || "guarded",
    supervisor_policy_id: row.supervisor_policy_id || null,
    conversation_id: row.conversation_id,
    objective: row.objective,
    preferences: row.preferences || "",
    coordination_prompt: row.coordination_prompt || "",
    workflow_template_id: row.workflow_template_id || "plan_implement_verify",
    workspace_mode: row.workspace_mode || "",
    resolved_workspace_mode: row.resolved_workspace_mode || "",
    coordinator_runtime: row.coordinator_runtime || "",
    planning_source: row.planning_source || "local",
    risk_tier: row.risk_tier || "green",
    planner_role: row.planner_role || "lead",
    plan_status: row.plan_status || (row.template_id === ADAPTIVE_TEMPLATE_ID ? "draft" : "confirmed"),
    plan_revision: Number(row.plan_revision || 0),
    plan_revision_feedback: row.plan_revision_feedback || "",
    plan: parseJson(row.plan_json, null),
    state: row.state,
    phase: row.phase || null,
    pause_reason: row.pause_reason || null,
    blocked_reason: row.blocked_reason || null,
    retry_of_run_id: row.retry_of_run_id || null,
    coordinator_device_id: row.coordinator_device_id || null,
    gates: parseJson(row.gates_json, {}),
    budget: parseJson(row.budget_json, {}),
    usage: parseJson(row.usage_json, {}),
    counters: parseJson(row.counters_json, {}),
    account_budget_blocked: Boolean(row.account_budget_blocked),
    resume_state: row.resume_state || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    archived_at: row.archived_at || null,
    final_report: parseJson(row.final_report_json, null),
    last_event_sequence: Number(row.last_event_sequence || 0),
  };
}
