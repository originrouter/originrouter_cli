import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";

const DEFAULT_ENDPOINT = "https://app.easytransnote.com/ai/v1/ai-audit/reviews";

export class AiOperationReviewer {
  constructor({
    stateDir,
    endpoint = process.env.ORIGINROUTER_AI_AUDIT_URL || DEFAULT_ENDPOINT,
    fetchFn = globalThis.fetch,
    onTelemetry = null,
  } = {}) {
    this.stateDir = stateDir;
    this.endpoint = endpoint;
    this.fetchFn = fetchFn;
    this.onTelemetry = onTelemetry;
  }

  async review({ session, event, analysis }) {
    const startedAt = Date.now();
    const credential = await ensureFreshAccessToken({
      stateDir: this.stateDir,
      resource: OAUTH_RESOURCES.AI,
      fetchFn: this.fetchFn,
    });
    const token = accessTokenFor(credential, OAUTH_RESOURCES.AI)?.token;
    if (!token) throw new Error("AI audit access token is unavailable");
    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: "1",
        review_id: `aor_${String(event?.callId || event?.id || Date.now()).replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 160)}`,
        agent: { type: String(session?.agent || "unknown").slice(0, 32) },
        context: {
          workspace: String(session?.cwd || "").slice(0, 4096),
          task_title: String(session?.title || "").slice(0, 512),
        },
        operation: analysis,
        policy: {
          advisory_only: true,
          cannot_suppress_deterministic_high_risk: true,
          fallback_to_deterministic_record: true,
        },
      }),
      // The backend may aggregate for 5s and perform up to three independent
      // model attempts before deterministic fallback. This remains detached
      // from Agent execution, so a longer transport budget does not block it.
      signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json().catch(() => ({}));
    const jobId = payload?.data?.job_id;
    if (!response.ok || !jobId) {
      const { aiClientError } = await import("./aiClientErrors.js");
      throw await aiClientError(response, "AI_OPERATION_REVIEW_FAILED", "AI audit reviewer", payload);
    }
    const resultUrl = `${this.endpoint.replace(/\/$/, "")}/${encodeURIComponent(jobId)}`;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const poll = await this.fetchFn(resultUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      const result = await poll.json().catch(() => ({}));
      if (!poll.ok) throw new Error(`AI audit result failed (${poll.status})`);
      if (result?.data?.state !== "completed") continue;
      const review = result?.data?.review;
      if (!review || typeof review.record !== "boolean") break;
      await Promise.resolve(this.onTelemetry?.({
        type: "ai.operation_review.completed",
        provider: "originrouter",
        model: result?.data?.model || review.model,
        responseId: result?.data?.response_id || review.response_id,
        durationMs: Date.now() - startedAt,
        payload: {
          success: true,
          task_kind: "sensitive_operation_audit",
          decision: review.record ? "record" : "ignore",
          risk_level: review.risk,
          confidence: review.confidence,
        },
      }, {
        runId: session?.runId || session?.run_id,
        sessionId: session?.sessionId || session?.session_id,
        idempotencyKey: `ai:${session?.runId || session?.run_id || ""}:${session?.sessionId || session?.session_id || ""}:ai.operation_review.completed:${event?.callId || event?.id || jobId}`,
      })).catch(() => {});
      return review;
    }
    throw new Error("AI audit reviewer timed out");
  }
}
