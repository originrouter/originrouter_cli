import { ADAPTIVE_TEMPLATE_ID } from "./adaptivePlan.js";

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

export function safeText(value, maxLength = 16_384) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function compactId(value, maxLength = 64) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, maxLength);
}

export function isAgentResumeBindingError(error) {
  return AGENT_RESUME_BINDING_CODES.has(safeText(error?.code, 96));
}

export function expectedRole(run) {
  if (["researching", "awaiting_plan_review"].includes(run.state)) return "lead";
  if (["planning", "implementing"].includes(run.state)) return "worker";
  if (run.state === "awaiting_verification") return run.agents.verifier ? "verifier" : "lead";
  return null;
}

export function activeRoles(run) {
  if (run?.template_id === ADAPTIVE_TEMPLATE_ID) {
    return Object.entries(run.agents || {})
      .filter(([, agent]) => agent.current_task_id)
      .map(([role]) => role);
  }
  const role = expectedRole(run);
  return role ? [role] : [];
}

export function latestContent(run, types, predicate = () => true) {
  const wanted = new Set(types);
  return [...(run.messages || [])].reverse()
    .find((message) => wanted.has(message.type) && predicate(message))?.payload?.content || "";
}

export function decision(text, positiveMarkers, negativeMarkers) {
  const normalized = String(text || "").toUpperCase();
  if (positiveMarkers.some((marker) => normalized.includes(marker))) return true;
  if (negativeMarkers.some((marker) => normalized.includes(marker))) return false;
  return false;
}

export function retryableDeliveryError(error) {
  const code = safeText(error?.code, 96);
  if (FATAL_DELIVERY_CODES.has(code)) return false;
  return !/forbidden|invalid.*(payload|assignment|message)/i.test(
    `${code} ${safeText(error?.message, 256)}`,
  );
}
