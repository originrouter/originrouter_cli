import { parseJson } from "./collaborationStorePrimitives.js";
import { eventPresentation } from "./collaborationView.js";

export function publicConfigurationSession(row) {
  if (!row) return null;
  return {
    configuration_id: row.configuration_id,
    state: row.state,
    objective: row.objective,
    coordinator_device_id: row.coordinator_device_id,
    coordinator_runtime: row.coordinator_runtime,
    request: parseJson(row.request_json, {}),
    capability_snapshot: parseJson(row.capability_snapshot_json, { devices: [] }),
    server_configuration_id: row.server_configuration_id || null,
    server_revision: Number(row.server_revision || 0),
    tool_requests: parseJson(row.tool_requests_json, []),
    server_proposal: parseJson(row.server_proposal_json, {}),
    conversation_id: row.conversation_id || null,
    native_session_id: row.native_session_id || null,
    agent_session_id: row.agent_session_id || null,
    turn_count: Number(row.turn_count || 0),
    questions: parseJson(row.questions_json, []),
    proposal: parseJson(row.proposal_json, null),
    planning_source: row.planning_source || (row.state === "fallback_ready" ? "local_fallback" : "server_model"),
    fallback_reason: row.fallback_reason || null,
    model_error: row.model_error || null,
    planner_invocation: parseJson(row.planner_invocation_json, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at || null,
  };
}

export function publicMessage(row) {
  return {
    protocol_version: "1", message_id: row.message_id, run_id: row.run_id,
    task_id: row.task_id, correlation_id: row.correlation_id, type: row.type,
    sequence: Number(row.sequence), created_at: row.created_at,
    idempotency_key: row.idempotency_key, sender: parseJson(row.sender_json, {}),
    recipient: parseJson(row.recipient_json, {}), payload: parseJson(row.payload_json, {}),
    parent_message_id: row.parent_message_id, causation_id: row.causation_id,
    artifact_refs: parseJson(row.artifact_refs_json, []), evidence_refs: parseJson(row.evidence_refs_json, []),
    requires_ack: Boolean(row.requires_ack), acknowledged_at: row.acknowledged_at,
    sensitivity: row.sensitivity,
  };
}

export function publicExecutionEvent(row) {
  return {
    schema_version: Number(row.schema_version || 1),
    event_id: row.event_id,
    sequence: Number(row.sequence || 0),
    run_id: row.run_id,
    task_id: row.task_id || null,
    participant_id: row.participant_id || null,
    session_id: row.session_id || null,
    attempt: Number(row.attempt || 0),
    type: row.type,
    category: row.category || eventPresentation(row.type).category,
    severity: row.severity || "info",
    visibility: row.visibility || "detail",
    summary: row.summary,
    detail: row.detail,
    payload: parseJson(row.payload_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    correlation_id: row.correlation_id || null,
    causation_id: row.causation_id || null,
    idempotency_key: row.idempotency_key || null,
    created_at: row.created_at,
    recorded_at: row.recorded_at || row.created_at,
  };
}

export function publicAttention(row) {
  return {
    attention_id: row.attention_id,
    kind: row.kind,
    status: row.status,
    run_id: row.run_id,
    task_id: row.task_id || null,
    participant_id: row.participant_id || null,
    title: row.title,
    summary: row.summary,
    risk: row.risk,
    actions: parseJson(row.actions_json, []),
    payload: parseJson(row.payload_json, {}),
    revision: Number(row.revision || 1),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at || null,
    resolved_at: row.resolved_at || null,
    resolved_by: row.resolved_by || null,
    resolution: row.resolution || null,
    derived: false,
  };
}
