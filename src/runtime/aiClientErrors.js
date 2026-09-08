// Shared error enrichment for OriginRouter AI runtime clients.
//
// The AI advanced features (approval/audit review, inquiry, collaboration
// planning) are gated to Go-and-above memberships server-side. A free account
// gets HTTP 403 with `{"detail": {"code": "membership_required"}}`. These
// calls intentionally degrade gracefully (fallback_to_user_on_error), but the
// thrown error should still tell the user WHY, instead of a bare "HTTP 403".

export async function aiClientError(response, fallbackCode, fallbackLabel, parsedPayload = null) {
  let detail = "";
  let code = null;
  try {
    const payload = parsedPayload ?? await response.json();
    code = payload?.detail?.code ?? payload?.code ?? null;
    const text = payload?.detail?.message ?? payload?.message ?? payload?.detail;
    if (typeof text === "string") detail = `: ${text}`;
  } catch {
    // body was empty or not JSON — keep the status-only message
  }
  let message = `${fallbackLabel} HTTP ${response.status}`;
  if (code === "membership_required" || (response.status === 403 && code === "feature_requires_plan_upgrade")) {
    message = `${fallbackLabel} requires an OriginRouter Go (or higher) membership. Visit https://originrouter.com/console to upgrade. (membership_required)`;
  } else if (code) {
    message = `${fallbackLabel} HTTP ${response.status} [${code}]${detail}`;
  }
  return Object.assign(new Error(message), { code: fallbackCode, statusCode: response.status, errorCode: code });
}
