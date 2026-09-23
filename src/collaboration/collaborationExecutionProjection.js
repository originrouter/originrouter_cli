import { displaySafeToolInput } from "../runtime/displaySafeToolInput.js";
import {
  interactionApprovalOptionsProjection,
  interactionFormFieldsProjection,
  interactionQuestionsProjection,
} from "./collaborationRuntimeProjections.js";

function safeText(value, maxLength = 16_384) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function executionEventProjection(event = {}) {
  const type = safeText(event.type, 96) || "agent.activity";
  const activity = safeText(event.activity, 64);
  const interactionPayload = event.payload && typeof event.payload === "object"
    ? event.payload
    : {};
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
  const facts = {
    activity,
    provider: safeText(event.provider, 191) || undefined,
    model: safeText(event.model, 191) || undefined,
    provider_type: safeText(event.providerType || event.provider_type, 32) || undefined,
    status: safeText(event.status, 32) || undefined,
    tool: safeText(event.tool || event.toolName || event.tool_name, 128) || undefined,
    call_id: safeText(event.callId || event.call_id, 191) || undefined,
    lifecycle_id: safeText(event.lifecycleId || event.lifecycle_id, 195) || undefined,
    is_error: event.isError ?? event.is_error,
    duration_ms: event.durationMs ?? event.duration_ms,
    num_turns: event.numTurns ?? event.num_turns,
    stop_reason: safeText(event.stopReason || event.stop_reason, 64) || undefined,
    retry: event.retry,
    retry_count: event.retryCount ?? event.retry_count,
    verification_passed: event.verificationPassed ?? event.verification_passed,
    task_completed: event.taskCompleted ?? event.task_completed,
    task_failed: event.taskFailed ?? event.task_failed,
    retry_attempt: event.retryAttempt ?? event.retry_attempt,
    response_id: safeText(event.responseId || event.response_id, 255) || undefined,
    gateway_response_ids: Array.isArray(event.gatewayResponseIds || event.gateway_response_ids)
      ? (event.gatewayResponseIds || event.gateway_response_ids)
      : ((event.gatewayResponseId || event.gateway_response_id) ? [event.gatewayResponseId || event.gateway_response_id] : undefined),
    token_usage: event.tokenUsage || event.token_usage,
    sampled_tokens: event.sampledTokens ?? event.sampled_tokens,
    amount_micros: event.amountMicros ?? event.amount_micros,
    currency: safeText(event.currency, 3).toUpperCase() || undefined,
    cost_source: safeText(event.costSource || event.cost_source, 64) || undefined,
    agent_id: safeText(event.agentId || event.agent_id, 195) || undefined,
    parent_agent_id: safeText(event.parentAgentId || event.parent_agent_id, 195) || undefined,
    delegation_id: safeText(event.delegationId || event.delegation_id || event.parentToolUseId, 195) || undefined,
    delegation_depth: event.delegationDepth ?? event.delegation_depth,
    delegation_detected: event.delegationDetected ?? event.delegation_detected,
    task_role: safeText(event.taskRole || event.task_role, 64) || undefined,
    task_kind: safeText(event.taskKind || event.task_kind, 96) || undefined,
    model_tier: safeText(event.modelTier || event.model_tier, 64) || undefined,
    decision: safeText(event.decision, 64) || undefined,
    risk_level: safeText(event.riskLevel || event.risk_level, 32) || undefined,
    confidence: event.confidence,
  };
  const metadata = event.metadata && typeof event.metadata === "object"
    ? Object.fromEntries(Object.entries(event.metadata).filter(([key, value]) => (
      [
        "from_model", "to_model", "model_provider_id", "model", "provider",
        "reasoning_effort", "service_tier", "wire_api", "response_id",
        "gateway_response_id",
      ].includes(key)
      && ["string", "number", "boolean"].includes(typeof value)
    )))
    : {};
  const projectedPayload = Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  return {
    type,
    summary,
    detail,
    visibility: ["summary", "detail", "diagnostic", "audit_only"].includes(
      event.visibility,
    )
      ? event.visibility
      : undefined,
    payload: type.startsWith("agent.interaction.") ? {
      ...projectedPayload,
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
            tool: safeText(interactionPayload.tool || event.tool || event.toolName || event.tool_name, 128),
            display_name: safeText(interactionPayload.display_name || event.display_name || event.displayName, 256),
            blocked_path: safeText(interactionPayload.blocked_path || event.blocked_path || event.blockedPath, 4096),
            tool_input: interactionPayload.tool_input || event.tool_input || event.toolInput || null,
            command: interactionPayload.command || event.command || null,
            cwd: safeText(interactionPayload.cwd || event.cwd, 4096),
            file_changes: interactionPayload.file_changes || event.file_changes || event.fileChanges || null,
            additional_permissions: interactionPayload.additional_permissions || event.additional_permissions || event.additionalPermissions || null,
            network_approval_context: interactionPayload.network_approval_context || event.network_approval_context || event.networkApprovalContext || null,
            default_approval_option: safeText(interactionPayload.default_approval_option || event.default_approval_option || event.defaultApprovalOption, 128),
            questions: interactionQuestionsProjection(interactionPayload.questions),
            form_fields: interactionFormFieldsProjection(interactionPayload.schema),
            url: safeText(interactionPayload.url, 4096),
            plan: safeText(interactionPayload.plan, 65_536),
            approval_options: interactionApprovalOptionsProjection(interactionPayload.approval_options),
          },
          }),
          containsSecret: event.containsSecret === true,
        },
      } : {}),
    } : {
      ...projectedPayload,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    },
    metadata: {
      ...(activity ? { activity } : {}),
      ...(safeText(event.lifecycleId || event.lifecycle_id, 195)
        ? { lifecycle_id: safeText(event.lifecycleId || event.lifecycle_id, 195) }
        : {}),
      ...(safeText(event.kind, 64) ? { kind: safeText(event.kind, 64) } : {}),
      ...(safeText(event.status, 32) ? { status: safeText(event.status, 32) } : {}),
      ...(safeText(event.toolName ?? event.tool_name, 128)
        ? { tool: safeText(event.toolName ?? event.tool_name, 128) }
        : {}),
    },
  };
}
