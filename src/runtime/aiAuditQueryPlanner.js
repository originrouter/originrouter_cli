import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";

const DEFAULT_ENDPOINT = "https://app.easytransnote.com/ai/v1/ai-audit/query-plan";

export class AiAuditQueryPlanner {
  constructor({ stateDir, endpoint = process.env.ORIGINROUTER_AI_AUDIT_QUERY_URL || DEFAULT_ENDPOINT, fetchFn = globalThis.fetch } = {}) {
    this.stateDir = stateDir;
    this.endpoint = endpoint;
    this.fetchFn = fetchFn;
  }

  async plan({ queryId, domain, query }) {
    const credential = await ensureFreshAccessToken({
      stateDir: this.stateDir,
      resource: OAUTH_RESOURCES.AI,
      fetchFn: this.fetchFn,
    });
    const token = accessTokenFor(credential, OAUTH_RESOURCES.AI)?.token;
    if (!token) throw new Error("AI audit query access token is unavailable");
    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ protocol_version: "1", query_id: queryId, domain, query }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({}));
    const plan = payload?.data?.plan;
    if (!response.ok || !plan || !Array.isArray(plan.terms)) throw new Error("AI audit query planning failed");
    return plan;
  }
}
