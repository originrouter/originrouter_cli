import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { displaySafeToolInput } from "./displaySafeToolInput.js";
import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";

const DEFAULT_ENDPOINT = "https://chat.originrouter.com/api/v1/ai-approval/review";

function safeValue(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, child]) => [
      String(key).slice(0, 128), safeValue(child, depth + 1),
    ]));
  }
  if (typeof value === "string") return value.slice(0, 8192);
  if (["number", "boolean"].includes(typeof value)) return value;
  return String(value).slice(0, 1024);
}

export class AiApprovalReviewer {
  constructor({
    stateDir,
    endpoint = process.env.ORIGINROUTER_AI_APPROVAL_URL || DEFAULT_ENDPOINT,
    fetchFn = globalThis.fetch,
  }) {
    this.stateDir = stateDir;
    this.endpoint = endpoint;
    this.fetchFn = fetchFn;
  }

  async review({ request, classification, runtime, workspaceRoot }) {
    if (request?.containsSecret) return { decision: "escalate", reason: "secret_input", risk: "high", confidence: 1 };
    const credential = await ensureFreshAccessToken({
      stateDir: this.stateDir,
      resource: OAUTH_RESOURCES.AI,
      fetchFn: this.fetchFn,
    });
    const token = accessTokenFor(credential, OAUTH_RESOURCES.AI)?.token;
    if (!token) throw Object.assign(new Error("OriginRouter AI access token is unavailable"), { code: "AI_APPROVAL_AUTH_REQUIRED" });
    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol_version: "1",
        review_id: `air_${String(request.interactionId || Date.now()).replace(/[^a-zA-Z0-9._~-]/g, "_").slice(0, 160)}`,
        agent: { runtime: String(runtime || request.runtime || "unknown").slice(0, 32) },
        interaction: {
          kind: request.kind,
          title: String(request.title || "").slice(0, 512),
          prompt: String(request.prompt || "").slice(0, 2048),
          scope: classification?.scope || null,
          classification_reason: classification?.reason || null,
          contains_secret: Boolean(request.containsSecret),
          payload: safeValue(displaySafeToolInput(request.payload || {})),
        },
        context: {
          workspace: String(workspaceRoot || "").slice(0, 1024),
        },
        policy: {
          high_risk_requires_user: true,
          allow_single_request_only: true,
          fallback_to_user_on_error: true,
        },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`AI approval reviewer HTTP ${response.status}`), { code: "AI_APPROVAL_REVIEW_FAILED" });
    }
    const payload = await response.json();
    const review = payload?.data?.review;
    if (!review || !["allow", "deny", "escalate"].includes(review.decision)) {
      throw Object.assign(new Error("AI approval reviewer returned an invalid decision"), { code: "AI_APPROVAL_INVALID_RESPONSE" });
    }
    return review;
  }
}
