import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";

const DEFAULT_ENDPOINT = "https://app.easytransnote.com/ai/v1/collaboration/configurations";

function clientError(code, message) {
  return Object.assign(new Error(message), { code });
}

export class CollaborationConfigurationClient {
  constructor({
    stateDir,
    endpoint = process.env.ORIGINROUTER_COLLABORATION_CONFIGURATION_URL || DEFAULT_ENDPOINT,
    fetchFn = globalThis.fetch,
  } = {}) {
    this.stateDir = stateDir;
    this.endpoint = endpoint.replace(/\/$/, "");
    this.fetchFn = fetchFn;
  }

  async request(path = "", { method = "GET", body } = {}) {
    const credential = await ensureFreshAccessToken({
      stateDir: this.stateDir,
      resource: OAUTH_RESOURCES.AI,
      fetchFn: this.fetchFn,
    });
    const token = accessTokenFor(credential, OAUTH_RESOURCES.AI)?.token;
    if (!token) throw clientError("COLLABORATION_CONFIGURATION_AUTH_REQUIRED", "OriginRouter AI access token is unavailable.");
    let response;
    try {
      response = await this.fetchFn(`${this.endpoint}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw clientError("COLLABORATION_CONFIGURATION_UNAVAILABLE", "The server collaboration planner is unavailable.");
    }
    const payload = await response.json().catch(() => ({}));
    const configuration = payload?.data?.configuration;
    if (!response.ok || !configuration || typeof configuration !== "object") {
      throw clientError(
        payload?.detail?.code || "COLLABORATION_CONFIGURATION_FAILED",
        payload?.detail?.message || `The server collaboration planner failed (HTTP ${response.status}).`,
      );
    }
    return configuration;
  }

  create(body) { return this.request("", { method: "POST", body }); }
  get(configurationId) { return this.request(`/${encodeURIComponent(configurationId)}`); }
  answer(configurationId, body) { return this.request(`/${encodeURIComponent(configurationId)}/answers`, { method: "POST", body }); }
  toolResults(configurationId, body) { return this.request(`/${encodeURIComponent(configurationId)}/tool-results`, { method: "POST", body }); }
  cancel(configurationId, body) { return this.request(`/${encodeURIComponent(configurationId)}/cancel`, { method: "POST", body }); }
}
