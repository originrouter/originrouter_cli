import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";

const DEFAULT_ENDPOINT = "https://app.easytransnote.com/ai/v1/collaboration/advice";
const MODES = new Set([
  "auto",
  "solo",
  "build_review",
  "plan_build_verify",
  "parallel_research",
  "review_panel",
  "remote_ops",
]);

function capabilitiesFor(device) {
  return device.capabilities || device.cachedCapabilities || {};
}

export function collaborationCapabilitySummary(devices = []) {
  const eligible = devices.filter(
    (device) => device.local === true || device.trustStatus === "trusted",
  );
  const local = eligible.find((device) => device.local === true);
  const remotes = devices.filter((device) => device.local !== true && device.trustStatus === "trusted");
  const runtimes = (device) => (capabilitiesFor(device).runtimes || [])
    .filter((runtime) => runtime.available && ["codex", "claude"].includes(runtime.id))
    .map((runtime) => runtime.id);
  const unique = (values) => [...new Set(values)].sort();
  return {
    local_runtimes: unique(local ? runtimes(local) : []),
    trusted_remote_count: remotes.length,
    online_remote_count: remotes.filter((device) => device.online === true).length,
    remote_runtimes: unique(remotes.flatMap(runtimes)),
    trusted_workspace_count: eligible.reduce(
      (count, device) => count + (capabilitiesFor(device).trusted_workspaces || []).length,
      0,
    ),
    configured_route_count: eligible.reduce((count, device) => {
      const routes = capabilitiesFor(device).resolved_routes || {};
      return count + Object.values(routes).reduce(
        (routeCount, slots) => routeCount + Object.values(slots || {}).filter(Boolean).length,
        0,
      );
    }, 0),
  };
}

export async function requestCollaborationAdvice({
  objective,
  requestedMode = "auto",
  coordinator = "codex",
  devices = [],
}, {
  stateDir,
  endpoint = process.env.ORIGINROUTER_COLLABORATION_ADVICE_URL || DEFAULT_ENDPOINT,
  fetchFn = globalThis.fetch,
} = {}) {
  const credential = await ensureFreshAccessToken({
    stateDir,
    resource: OAUTH_RESOURCES.AI,
    fetchFn,
  });
  const token = accessTokenFor(credential, OAUTH_RESOURCES.AI)?.token;
  if (!token) {
    throw Object.assign(new Error("OriginRouter AI access token is unavailable."), {
      code: "COLLABORATION_ADVICE_AUTH_REQUIRED",
    });
  }
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol_version: "1",
      objective: String(objective || "").slice(0, 16_000),
      requested_mode: requestedMode,
      coordinator,
      capability_summary: collaborationCapabilitySummary(devices),
      policy: {
        advisory_only: true,
        cannot_authorize_actions: true,
        local_policy_is_authoritative: true,
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => ({}));
  const advice = payload?.data?.advice;
  if (!response.ok || !advice || !MODES.has(advice.recommended_mode)) {
    throw Object.assign(new Error(`Collaboration advice failed (HTTP ${response.status}).`), {
      code: payload?.detail?.code || "COLLABORATION_ADVICE_FAILED",
    });
  }
  if (!["green", "yellow", "red"].includes(advice.risk_tier)) {
    throw Object.assign(new Error("Collaboration advice returned an invalid risk tier."), {
      code: "COLLABORATION_ADVICE_INVALID_RESPONSE",
    });
  }
  return advice;
}
