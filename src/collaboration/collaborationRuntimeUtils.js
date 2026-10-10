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

/**
 * Whether an inbound relay frame names a device other than this one.
 *
 * The envelope's `target_device_id` already decided delivery, and it is the
 * only authority: the CLI refuses group envelopes outright
 * (`_handleInboundSerial` in deviceE2eeRelayTransport.js — "the CLI publishes
 * group envelopes; it does not consume them"), so every frame that reaches a
 * handler was addressed here pairwise. A payload that *also* carries a
 * `targetDeviceId` is adding a second, narrower selector. When it names a peer,
 * this frame is not ours to act on — dispatch frames persist an assignment and
 * launch an Agent, so that check is a real interlock and stays.
 *
 * The field being *absent* means nothing at all. The App puts the target in the
 * relay's addressing argument and never in the payload, and under E2EE the
 * payload is sealed ciphertext, so an absent field cannot be read as "sent to
 * someone else". Reading it that way is what silently dropped every remote
 * workspace browse: no response, no log, a 30-second timeout on the phone.
 *
 * Mismatches now log, which is what a sender bug or a relay routing bug looks
 * like, and which nothing here ever surfaced before.
 */
export function isForeignRelayFrame(payload, deviceId, warn = console.warn) {
  const named = safeText(payload?.targetDeviceId, 191);
  if (!named || named === deviceId) return false;
  warn(
    `[agent-relay] ${safeText(payload?.type, 96) || "message"} names device ${named}`
    + ` but was delivered to ${deviceId}; not acting on it`,
  );
  return true;
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
