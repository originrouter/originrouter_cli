// Stage 3: Daemon local HTTP API.
//
// Bound to 127.0.0.1 by default. The browser-facing control surface for OriginRouter
// local sessions. Read paths delegate to existing modules; write paths call
// sessionManager.handleEvent() directly — the same entry point the daemon
// already uses when handling events from the relay.
//
// Wire summary:
//
//   browser  →  local API  →  sessionManager.handleEvent()
//                                     ↓
//                              executor.write / executor.interrupt /
//                              adapter.resolvePermission
//
// We do NOT route control writes through the relay (i.e. relayClient.send):
// relayClient.send broadcasts to SSE clients, which would loop back through
// connectEvents and cost a round trip for nothing. The local API runs in the
// same process as the session manager.

import http from "node:http";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  ROUTE_AGENTS,
} from "../config/routes.js";
import { LITELLM_PROVIDERS } from "../proxy/litellmCatalog.js";
import { assessRegisteredWorkspaceForUnattended } from "../runtime/unattendedWorkspaceReadiness.js";
import { discoverProviderModels } from "../proxy/modelDiscovery.js";
import { probeProviderModel } from "../proxy/modelProbe.js";
import {
  remoteShareModelEntries,
} from "../config/providerModels.js";
import { getStateDir, readConfig, readProxyState, writeConfig } from "../persistence/state.js";
import { DEFAULT_RELAY_URL } from "../constants.js";
import { cachedUpdateStatus } from "../update/checker.js";
import { detectInstallContext } from "../update/installContext.js";
import {
  AGENT_AUTONOMY_SCOPES,
  normalizeAutonomyScopes,
} from "../runtime/agentAutonomyPolicy.js";
import {
  deployApprovalPolicyBundle,
  listApprovalPolicyRevisions,
  readApprovalPolicy,
  rollbackApprovalPolicy,
} from "../runtime/approvalPolicyStore.js";
import {
  approvalPolicyCapabilities,
  evaluateApprovalRequest,
  validateApprovalPolicy,
} from "../runtime/approvalPolicy.js";
import { aiReviewPolicyFromPayload } from "../runtime/aiReviewPolicy.js";
import {
  AGENT_DETAIL_PROFILES,
  agentDetailDefaultFromConfig,
  setAgentDetailDefault,
} from "../runtime/agentDetailProfile.js";
import { ExternalAgentRegistry } from "./externalAgentRegistry.js";
import { LocalAuditStore } from "../persistence/localAuditStore.js";
import { ProxyRequestStore } from "../persistence/proxyRequestStore.js";
import { buildAuditEvidenceBundle } from "../inquiry/auditEvidenceAdapter.js";
import { AiAuditQueryPlanner } from "../runtime/aiAuditQueryPlanner.js";
import { AgentBudgetStore } from "../agent/agentBudgetStore.js";
import { CollaborationStore } from "../collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../collaboration/planImplementVerifyCoordinator.js";
import { browseAgentWorkspaces } from "../daemon/workspaceBrowser.js";
import { buildCollaborationCapabilities } from "../collaboration/collaborationCapabilities.js";
import { normalizeCollaborationCreateRequest } from "../collaboration/createRunRequest.js";
import {
  httpHost,
  readJsonBody,
  requireAuth,
  sendError,
  sendOk,
} from "./localApiHttp.js";
import {
  flattenCollaborationSnapshot,
  placeholderProxyStatus,
  projectSession,
} from "./localApiProjections.js";
import {
  handleRouteClear,
  handleRoutesList,
  handleRoutesShow,
  handleRoutesUpdate,
  handleRouteSlot,
} from "./localApiRoutes.js";
import {
  handleProviderAdd,
  handleProviderModelDiscovery,
  handleProviderModelProbe,
  handleProviderRemove,
  handleProviderShow,
  handleProviderUpdate,
  handleProvidersList,
  handleProvidersUse,
  handleSessionsList,
} from "./localApiProviders.js";
import {
  handleRemoteShareControl,
  handleRemoteShareStatus,
  remoteShareProviders,
} from "./localApiRemoteShare.js";
import { handleSessionControl } from "./localApiSessionControl.js";
import { handleProxyControl } from "./localApiProxyControl.js";

export { projectSession } from "./localApiProjections.js";

// Exported so CLI subcommands (e.g. `local api set-host`) can apply
// the same gating as the runtime auth layer. Keep the set in lock-
// step with the bind-address check in `startLocalApi` above.
export const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

// Bearer-token regex: case-insensitive 64 hex chars.
const BEARER_RE = /^Bearer\s+([a-f0-9]{64})$/i;
// Hard cap on the log-tail response body so a runaway proxy log doesn't OOM
// the local API process.
const LOG_TAIL_MAX_BYTES = 1_048_576; // 1 MiB
const LOG_TAIL_MAX_LINES = 2000;
const LOG_TAIL_DEFAULT_LINES = 200;

// Hard-coded placeholder for proxy status. Stage 4 will swap this for a real
// LiteLLM process probe. Keeping it as an injected function (not a module-level
// constant) so tests can override.
// ---------- Lifecycle ----------

export async function startLocalApi(ctx, { port = 0, apiTokenPath: apiTokenPathOpt, allowLan = false } = {}) {
  const bindAddress = ctx.bindAddress || "127.0.0.1";
  const lanAllowed = Boolean(ctx.allowLanControl || allowLan);
  const isLoopback = LOOPBACK_ADDRESSES.has(bindAddress);
  if (!isLoopback && !lanAllowed) {
    throw new Error(`non-loopback bindAddress requires --allow-lan (got "${bindAddress}")`);
  }

  // Wrap the caller-supplied ctx so that live fields (`localApiPort`,
  // `relayConnected`) are read fresh on every request rather than snapshotted
  // at start time. The daemon patches `localApiPort` onto the returned
  // handle immediately after binding, so the handler sees the bound port on
  // its first request.
  const auditStore = ctx.auditStore || new LocalAuditStore();
  const ownsAgentBudgetStore = !ctx.agentBudgetStore;
  const agentBudgetStore = ctx.agentBudgetStore || new AgentBudgetStore();
  const ownsProxyRequestStore = !ctx.proxyRequestStore;
  const proxyRequestStore = ctx.proxyRequestStore || new ProxyRequestStore();
  const collaborationStore = ctx.collaborationStore || new CollaborationStore();
  const collaborationCoordinator = ctx.collaborationCoordinator
    || new PlanImplementVerifyCoordinator({ store: collaborationStore });
  const liveCtx = {
    bindAddress,
    isLoopback,
    allowLanControl: lanAllowed,
    configProvider: ctx.configProvider || (() => readConfig()),
    getProxyStatus: ctx.getProxyStatus || placeholderProxyStatus,
    startProxy: ctx.startProxy,
    stopProxy: ctx.stopProxy,
    restartProxy: ctx.restartProxy,
    getRemoteShareProxyStatus: ctx.getRemoteShareProxyStatus || placeholderProxyStatus,
    startRemoteShareProxy: ctx.startRemoteShareProxy,
    stopRemoteShareProxy: ctx.stopRemoteShareProxy,
    restartRemoteShareProxy: ctx.restartRemoteShareProxy,
    discoverProviderModels: ctx.discoverProviderModels || discoverProviderModels,
    sessionManager: ctx.sessionManager,
    auditStore,
    agentBudgetStore,
    proxyRequestStore,
    collaborationStore,
    collaborationCoordinator,
    collaborationRuntime: ctx.collaborationRuntime || null,
    agentCatalog: ctx.agentCatalog || null,
    managedAgentSupervisor: ctx.managedAgentSupervisor || null,
    deviceE2eeLocalGateway: ctx.deviceE2eeLocalGateway || null,
    localPairingManager: ctx.localPairingManager || null,
    externalAgentRegistry:
      ctx.externalAgentRegistry ||
      new ExternalAgentRegistry({ catalog: ctx.agentCatalog || null }),
    startedAt: ctx.startedAt || new Date().toISOString(),
    pid: ctx.pid || process.pid,
    version: ctx.version || "0.1.0",
    relayUrl: ctx.relayUrl || DEFAULT_RELAY_URL,
    stateDir: ctx.stateDir || getStateDir(),
    relayConnected: ctx.relayConnected || (() => false),
    get deviceId() {
      return typeof ctx.deviceId === "function"
        ? ctx.deviceId()
        : (ctx.deviceId || "local-dev");
    },
    // Stage 6: token file path. The dispatch reads the file on every request
    // (not snapshotted) so a `token rotate` takes effect without a restart.
    // Priority: ctx.apiTokenPath > startLocalApi({ apiTokenPath }) > env
    // ORIGINROUTER_API_TOKEN_PATH > default <stateDir>/local-api.token.
    apiTokenPath: ctx.apiTokenPath
      || apiTokenPathOpt
      || (process.env.ORIGINROUTER_API_TOKEN_PATH
            ? resolvePath(process.env.ORIGINROUTER_API_TOKEN_PATH)
            : resolvePath(getStateDir(), "local-api.token")),
    // Defaults to undefined; the daemon sets this on the returned handle.
    get localApiPort() { return ctx.localApiPort; },
  };

  const server = http.createServer((req, res) => dispatch(liveCtx, req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindAddress, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actualPort = server.address().port;

  return {
    port: actualPort,
    bindAddress,
    server,
    close: () => new Promise((resolve) => server.close(() => {
      if (ownsProxyRequestStore) proxyRequestStore.close();
      if (ownsAgentBudgetStore) agentBudgetStore.close();
      resolve();
    })),
  };
}

// ---------- Dispatch ----------

async function dispatch(ctx, req, res) {
  // CORS preflight short-circuit.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }

  // Stage 6 auth gate. Runs AFTER the OPTIONS preflight (browsers don't send
  // Authorization on preflight) and BEFORE the URL parse. Public reads (GET
  // /local/status, /local/auth/challenge) pass; everything else requires a
  // matching bearer token.
  const auth = requireAuth(req, ctx);
  if (!auth.ok) {
    return sendError(res, auth.status, auth.error, { reason: auth.reason, wwwAuth: true });
  }

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  try {
    // Static routes first.
    if (req.method === "GET" && pathname === "/local/status") {
      return sendOk(res, await handleLocalStatus(ctx));
    }
    if (req.method === "GET" && pathname === "/compatibility") {
      return sendOk(res, { compatibility: ctx.sessionManager.compatibilityStatus() });
    }
    const compatibilityAction = pathname.match(/^\/compatibility\/(check|update|rollback)$/);
    if (req.method === "POST" && compatibilityAction) {
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await ctx.sessionManager.runCompatibilityAction(
        compatibilityAction[1],
        String(body.operation_id || `compat-${Date.now()}`),
      );
      if (!result.ok) return sendError(res, 409, result.error, { compatibility: result.compatibility });
      return sendOk(res, result);
    }
    const compatibilityPatch = pathname.match(/^\/compatibility\/patches\/([^/]+)$/);
    if (req.method === "PATCH" && compatibilityPatch) {
      const body = await readJsonBody(req);
      if (typeof body.enabled !== "boolean") {
        return sendError(res, 400, "enabled must be a boolean");
      }
      const result = await ctx.sessionManager.setCompatibilityPatchEnabled(
        decodeURIComponent(compatibilityPatch[1]),
        body.enabled,
        String(body.operation_id || `compat-${Date.now()}`),
      );
      if (!result.ok) {
        return sendError(res, 409, result.error, {
          compatibility: result.compatibility,
        });
      }
      return sendOk(res, result);
    }
    if (req.method === "GET" && pathname === "/local/auth/challenge") {
      return sendOk(res, {
        authRequired: true,
        tokenFile: ctx.apiTokenPath,
      });
    }
    if (req.method === "POST" && pathname === "/local/pair/tickets") {
      if (!ctx.localPairingManager) {
        return sendError(res, 503, "local pairing is unavailable", {
          reason: "pairing_unavailable",
        });
      }
      const rawHost = String(ctx.bindAddress || "127.0.0.1");
      const host = rawHost === "0.0.0.0" || rawHost === "::"
        ? "127.0.0.1"
        : rawHost;
      try {
        return sendOk(res, ctx.localPairingManager.issue({
          endpoint: `http://${httpHost(host)}:${req.socket.localPort}`,
        }));
      } catch (error) {
        return sendError(res, Number(error.status || 400), error.message, {
          reason: error.code || "pair_issue_failed",
        });
      }
    }
    if (req.method === "POST" && pathname === "/local/pair/redeem") {
      if (!ctx.localPairingManager) {
        return sendError(res, 503, "local pairing is unavailable", {
          reason: "pairing_unavailable",
        });
      }
      // Native clients do not send Origin. Refusing browser-originated calls
      // keeps arbitrary pages from probing the short-lived pairing surface.
      if (req.headers.origin) {
        return sendError(res, 403, "browser pairing requests are not allowed", {
          reason: "pair_browser_origin_rejected",
        });
      }
      const body = await readJsonBody(req, 16 * 1024)
        .catch((error) => ({ __error: error.message }));
      if (body.__error) {
        return sendError(res, 400, body.__error, {
          reason: "pair_request_invalid",
        });
      }
      try {
        return sendOk(res, ctx.localPairingManager.redeem({
          ticket: body.ticket,
          appEphemeralPublicKey: body.app_ephemeral_public_key,
          requestNonce: body.request_nonce,
          sourceAddress: req.socket.remoteAddress,
        }));
      } catch (error) {
        return sendError(res, Number(error.status || 400), error.message, {
          reason: error.code || "pair_redeem_failed",
        });
      }
    }
    if (req.method === "GET" && pathname === "/local/e2ee/challenge") {
      if (!ctx.deviceE2eeLocalGateway) {
        return sendError(res, 503, "local E2EE gateway unavailable");
      }
      try {
        return sendOk(res, ctx.deviceE2eeLocalGateway.createChallenge({
          appDeviceId: url.searchParams.get("app_device_id"),
          appKeyId: url.searchParams.get("app_key_id"),
        }));
      } catch (error) {
        return sendError(res, 400, error.message, {
          reason: error.code || "local_e2ee_challenge_failed",
        });
      }
    }
    if (req.method === "POST" && pathname === "/local/e2ee/session") {
      if (!ctx.deviceE2eeLocalGateway) {
        return sendError(res, 503, "local E2EE gateway unavailable");
      }
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        return sendOk(res, ctx.deviceE2eeLocalGateway.authorize({
          challengeId: body.challenge_id,
          appIdentity: body.app_identity,
          authMethod: body.auth_method,
          hmacProof: body.proof,
          deviceProof: body.device_proof,
        }));
      } catch (error) {
        return sendError(res, 403, error.message, {
          reason: error.code || "local_e2ee_authorization_failed",
        });
      }
    }
    if (req.method === "POST" && pathname === "/local/e2ee/messages") {
      if (!ctx.deviceE2eeLocalGateway) {
        return sendError(res, 503, "local E2EE gateway unavailable");
      }
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const envelope = await ctx.deviceE2eeLocalGateway.handleEnvelope(
          body.envelope,
          { localPort: req.socket.localPort },
        );
        return sendOk(res, { envelope });
      } catch (error) {
        return sendError(res, 400, error.message, {
          reason: error.code || "local_e2ee_message_failed",
        });
      }
    }
    if (req.method === "GET" && pathname === "/proxy/logs") {
      return handleProxyLogs(ctx, res, url);
    }
    if (req.method === "GET" && pathname === "/proxy/requests") {
      return handleProxyRequests(ctx, res, url);
    }
    if (req.method === "GET" && pathname === "/providers") {
      return sendOk(res, { providers: handleProvidersList(ctx) });
    }
    if (req.method === "GET" && pathname === "/collaboration/local/capabilities") {
      return sendOk(res, {
        capabilities: buildCollaborationCapabilities({
          config: ctx.configProvider(),
          agentCatalog: ctx.agentCatalog,
          agentBudgetStore: ctx.agentBudgetStore,
          deviceId: ctx.deviceId,
          version: ctx.version,
        }),
      });
    }
    const remoteCapabilitiesMatch = pathname.match(
      /^\/collaboration\/devices\/([^/]+)\/capabilities$/,
    );
    if (req.method === "GET" && remoteCapabilitiesMatch) {
      if (!ctx.collaborationRuntime) return sendError(res, 503, "collaboration runtime unavailable");
      try {
        const deviceId = decodeURIComponent(remoteCapabilitiesMatch[1]);
        return sendOk(res, {
          capabilities: await ctx.collaborationRuntime.capabilitiesForDevice(deviceId),
        });
      } catch (error) {
        return sendError(res, 503, error.message || "remote capabilities unavailable", {
          reason: error.code || "collaboration_capabilities_unavailable",
        });
      }
    }
    const collaborationWorkspaceTrustMatch = pathname.match(
      /^\/collaboration\/devices\/([^/]+)\/workspaces\/trust$/,
    );
    const collaborationWorkspaceBrowseMatch = pathname.match(
      /^\/collaboration\/devices\/([^/]+)\/workspaces\/browse$/,
    );
    if (req.method === "GET" && collaborationWorkspaceBrowseMatch) {
      if (!ctx.collaborationRuntime) return sendError(res, 503, "collaboration runtime unavailable");
      try {
        const deviceId = decodeURIComponent(collaborationWorkspaceBrowseMatch[1]);
        return sendOk(res, await ctx.collaborationRuntime.browseWorkspacesOnDevice(deviceId, {
          path: url.searchParams.get("path") || "",
          query: url.searchParams.get("query") || "",
          limit: url.searchParams.get("limit") || 8,
        }));
      } catch (error) {
        return sendError(res, 400, error.message || "workspace browse failed", {
          reason: error.code || "collaboration_workspace_browse_failed",
        });
      }
    }
    if (req.method === "POST" && collaborationWorkspaceTrustMatch) {
      if (!ctx.collaborationRuntime) return sendError(res, 503, "collaboration runtime unavailable");
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const deviceId = decodeURIComponent(collaborationWorkspaceTrustMatch[1]);
        return sendOk(res, {
          workspace: await ctx.collaborationRuntime.trustWorkspaceOnDevice(deviceId, body.path),
        });
      } catch (error) {
        return sendError(res, 400, error.message || "workspace could not be trusted", {
          reason: error.code || "collaboration_workspace_trust_failed",
        });
      }
    }
    if (req.method === "GET" && pathname === "/approval-policies/capabilities") {
      return sendOk(res, { capabilities: approvalPolicyCapabilities() });
    }
    if (req.method === "POST" && pathname === "/approval-policies/validate") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      const policy = body.policy || body.content || body;
      const validation = validateApprovalPolicy(policy);
      return sendOk(res, validation);
    }
    if (req.method === "POST" && pathname === "/approval-policies/simulate") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const policy = body.policy || body.content;
        const request = body.request;
        if (!policy || !request) return sendError(res, 400, "policy and request are required");
        const result = evaluateApprovalRequest(request, policy, {
          workspace: body.workspace || process.cwd(),
          stateDir: getStateDir(),
        });
        return sendOk(res, {
          effect: result.effect,
          policy_id: result.policyId,
          revision: result.revision,
          declarations: result.declarations,
          decisions: result.decisions.map((decision) => ({
            action: decision.atom.action,
            risk: decision.atom.risk,
            confidence: decision.atom.confidence,
            effect: decision.effect,
            matched_rules: decision.matchedRules,
            fallback: decision.fallback,
            resource_kind: decision.atom.resource?.kind || null,
          })),
        });
      } catch (error) {
        return sendError(res, 400, error.message, {
          reason: error.code || "approval_policy_simulation_failed",
        });
      }
    }
    const policyRevisionsMatch = pathname.match(/^\/approval-policies\/([a-z0-9._-]+)\/revisions$/);
    if (policyRevisionsMatch && req.method === "GET") {
      try {
        return sendOk(res, {
          revisions: listApprovalPolicyRevisions(policyRevisionsMatch[1], {
            stateDir: getStateDir(),
          }),
        });
      } catch (error) {
        return sendError(res, 400, error.message, {
          reason: error.code || "approval_policy_revision_list_failed",
        });
      }
    }
    const policyRollbackMatch = pathname.match(/^\/approval-policies\/([a-z0-9._-]+)\/rollback$/);
    if (policyRollbackMatch && req.method === "POST") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const restored = rollbackApprovalPolicy(
          policyRollbackMatch[1],
          body.revision,
          {
            stateDir: getStateDir(),
            expectedRevision: body.expected_revision || body.expectedRevision || null,
          },
        );
        return sendOk(res, { policy: restored.summary });
      } catch (error) {
        return sendError(res, error.code === "APPROVAL_POLICY_REVISION_CONFLICT" ? 409 : 400, error.message, {
          reason: error.code || "approval_policy_rollback_failed",
        });
      }
    }
    // Stage 7: catalog endpoint is intentionally public (no auth required).
    // Static data, no secrets, browser cold-start dependency. Documented in
    // agent-protocol.md §9.
    if (req.method === "GET" && pathname === "/catalog/litellm-providers") {
      return sendOk(res, { providers: LITELLM_PROVIDERS });
    }
    if (req.method === "POST" && pathname === "/catalog/litellm-models") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return handleProviderModelDiscovery(ctx, res, body);
    }
    if (req.method === "POST" && pathname === "/catalog/litellm-model-test") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return handleProviderModelProbe(ctx, res, body);
    }
    // Stage 7.5: routes endpoints. ALL require bearer token (Stage 6
    // deny-by-default; routes are user state, not a static catalog).
    if (req.method === "GET" && pathname === "/routes") {
      return handleRoutesList(ctx, res);
    }
    if (pathname === "/agent-budgets") {
      if (req.method === "GET") {
        return sendOk(res, { budgets: ctx.agentBudgetStore.snapshot() });
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        try {
          return sendOk(res, { budgets: ctx.agentBudgetStore.setPolicies(body) });
        } catch (error) {
          return sendError(res, 400, error.message || "invalid Agent budget policy");
        }
      }
      return sendError(res, 405, `method ${req.method} not allowed on /agent-budgets`);
    }
    const routesAgentMatch = pathname.match(/^\/routes\/([a-z]+)$/);
    if (routesAgentMatch) {
      const agent = decodeURIComponent(routesAgentMatch[1]);
      if (!ROUTE_AGENTS.includes(agent)) {
        return sendError(res, 400, `unknown route agent '${agent}'`);
      }
      if (req.method === "GET") return handleRoutesShow(ctx, res, agent);
      if (req.method === "PUT") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        return handleRoutesUpdate(ctx, res, agent, body);
      }
      return sendError(res, 405, `method ${req.method} not allowed on /routes/${agent}`);
    }
    const routeSlotMatch = pathname.match(/^\/routes\/([a-z]+)\/(main|small)$/);
    if (routeSlotMatch) {
      const agent = decodeURIComponent(routeSlotMatch[1]);
      const slot  = routeSlotMatch[2];
      if (!ROUTE_AGENTS.includes(agent)) {
        return sendError(res, 400, `unknown route agent '${agent}'`);
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        return handleRouteSlot(ctx, res, agent, slot, body);
      }
      if (req.method === "DELETE") {
        return handleRouteClear(ctx, res, agent, slot);
      }
      return sendError(res, 405, `method ${req.method} not allowed on /routes/${agent}/${slot}`);
    }
    if (req.method === "POST" && pathname === "/providers/use") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return handleProvidersUse(ctx, res, body);
    }
    if (req.method === "POST" && pathname === "/providers") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return handleProviderAdd(ctx, res, body);
    }
    if (req.method === "GET" && pathname === "/proxy/status") {
      return sendOk(res, await ctx.getProxyStatus());
    }
    if (req.method === "GET" && pathname === "/updates/status") {
      return sendOk(res, cachedUpdateStatus({
        stateDir: ctx.stateDir || getStateDir(),
        config: readConfig(),
        installContext: detectInstallContext(),
      }));
    }
    if (req.method === "POST" && (pathname === "/proxy/start" || pathname === "/proxy/stop" || pathname === "/proxy/restart")) {
      const action = pathname.slice("/proxy/".length); // start | stop | restart
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return handleProxyControl(ctx, res, action, body);
    }
    if (req.method === "GET" && pathname === "/remote-share/status") {
      return handleRemoteShareStatus(ctx, res);
    }
    if (req.method === "POST" && (
      pathname === "/remote-share/start"
      || pathname === "/remote-share/stop"
      || pathname === "/remote-share/restart"
    )) {
      const action = pathname.slice("/remote-share/".length);
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return handleRemoteShareControl(ctx, res, action, body);
    }
    if (req.method === "GET" && pathname === "/sessions") {
      return sendOk(res, { sessions: handleSessionsList(ctx) });
    }
    if (req.method === "GET" && pathname === "/agent/local/sessions") {
      return sendOk(res, { sessions: ctx.externalAgentRegistry.list() });
    }
    if (req.method === "POST" && pathname === "/agent/local/mcp-gateway") {
      if (!ctx.collaborationRuntime) {
        return sendError(res, 503, "Agent MCP gateway unavailable", {
          reason: "collaboration_mcp_unavailable",
        });
      }
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      const sessionId = String(body.session_id || "").trim().slice(0, 64);
      try {
        const result = await ctx.collaborationRuntime.handleMcpGatewayRequest({
          sessionId,
          action: body.action,
          payload: body.payload || {},
        });
        if (body.action === "delegate" && result?.task_id) {
          ctx.auditStore?.append(sessionId, {
            category: "collaboration",
            correlationId: result.task_id,
            phase: "delegated",
            actionKind: "agent_mcp_delegate",
            title: "Agent delegated work through OriginRouter MCP",
            summary: `Delegated to ${String(result.participant_id || "participant").slice(0, 32)}`,
            risk: "normal",
            outcome: result.state || "pending",
            decisionSource: "agent_mcp_gateway",
            tool: "originrouter.delegate_task",
            commandPreview: "",
            cwd: "",
            target: String(result.participant_id || "").slice(0, 32),
            detail: { task_id: result.task_id, state: result.state },
            createdAt: new Date().toISOString(),
          });
        }
        return sendOk(res, result);
      } catch (error) {
        return sendError(res, 409, error.message || "Agent MCP gateway request failed", {
          reason: error.code || "collaboration_mcp_failed",
        });
      }
    }
    if (pathname === "/collaboration/local/runs") {
      if (req.method === "GET") {
        if (url.searchParams.has("category") || url.searchParams.has("page")) {
          const page = ctx.collaborationStore.listRunPage({
            category: url.searchParams.get("category") || "all",
            page: url.searchParams.get("page"),
            pageSize: url.searchParams.get("page_size"),
            includeArchived: url.searchParams.get("archived") === "true",
          });
          return sendOk(res, {
            ...page,
            runs: page.runs.map((run) =>
              flattenCollaborationSnapshot(ctx.collaborationStore.getSnapshot(run.run_id)),
            ),
          });
        }
        const runs = ctx.collaborationStore.listRuns({ limit: url.searchParams.get("limit") })
          .map((run) => flattenCollaborationSnapshot(
            ctx.collaborationStore.getSnapshot(run.run_id),
          ));
        return sendOk(res, { runs });
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        try {
          return sendOk(res, {
            run: ctx.collaborationRuntime
              ? (await ctx.collaborationRuntime.handleControlOperation("create", { request: body })).run
              : ctx.collaborationCoordinator.create(normalizeCollaborationCreateRequest(body, {
                coordinatorDeviceId: body.coordinator_device_id || "local",
              })),
          });
        } catch (error) {
          return sendError(res, 400, error.message || "invalid collaboration run", {
            reason: error.code || "invalid_collaboration_run",
          });
        }
      }
      return sendError(res, 405, `method ${req.method} not allowed`);
    }
    const configurationMatch = pathname.match(
      /^\/collaboration\/local\/configurations(?:\/([^/]+)(?:\/(answer|accept|cancel))?)?$/,
    );
    if (configurationMatch) {
      if (!ctx.collaborationRuntime) return sendError(res, 503, "collaboration runtime unavailable");
      const configurationId = configurationMatch[1] ? decodeURIComponent(configurationMatch[1]) : "";
      const action = configurationMatch[2] || "";
      if (!configurationId && req.method === "POST") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        try {
          const result = await ctx.collaborationRuntime.handleControlOperation("configuration_create", { request: body });
          return sendOk(res, result);
        } catch (error) {
          return sendError(res, 400, error.message || "collaboration configuration failed", { reason: error.code || "configuration_failed" });
        }
      }
      if (configurationId && !action && req.method === "GET") {
        try {
          return sendOk(res, await ctx.collaborationRuntime.handleControlOperation("configuration_get", { configuration_id: configurationId }));
        } catch (error) {
          return sendError(res, 404, error.message || "configuration not found", { reason: error.code || "configuration_not_found" });
        }
      }
      if (configurationId && action && req.method === "POST") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        const operation = `configuration_${action}`;
        try {
          return sendOk(res, await ctx.collaborationRuntime.handleControlOperation(operation, {
            configuration_id: configurationId,
            answers: body.answers || {},
          }));
        } catch (error) {
          return sendError(res, 409, error.message || "configuration action failed", { reason: error.code || "configuration_action_failed" });
        }
      }
      return sendError(res, 405, `method ${req.method} not allowed`);
    }
    const collaborationSessionMatch = pathname.match(
      /^\/collaboration\/local\/sessions\/([^/]+)$/,
    );
    if (collaborationSessionMatch && req.method === "GET") {
      const sessionId = decodeURIComponent(collaborationSessionMatch[1]);
      if (!/^aws_[a-z0-9]+$/i.test(sessionId)) {
        return sendError(res, 400, "a Workspace Session ID is required", {
          reason: "collaboration_workspace_session_id_required",
        });
      }
      const session = ctx.collaborationStore.getWorkspaceSession(sessionId);
      if (!session || session.workspace_session_id !== sessionId) {
        return sendError(res, 404, "Workspace Session not found", {
          reason: "collaboration_workspace_session_not_found",
        });
      }
      const latestSnapshot = session.latest_run_id
        ? ctx.collaborationStore.getSnapshot(session.latest_run_id)
        : null;
      return sendOk(res, {
        session,
        latest_snapshot: latestSnapshot,
      });
    }
    const collaborationEventsMatch = pathname.match(
      /^\/collaboration\/local\/runs\/([^/]+)\/events$/,
    );
    if (collaborationEventsMatch && req.method === "GET") {
      const runId = decodeURIComponent(collaborationEventsMatch[1]);
      const run = ctx.collaborationStore.getRun(runId, { includeMessages: false });
      if (!run) return sendError(res, 404, "collaboration run not found");
      const afterSequence = Math.max(0, Number(url.searchParams.get("after_sequence")) || 0);
      return sendOk(res, ctx.collaborationStore.listExecutionEventPage(runId, {
        participantId: url.searchParams.get("participant_id") || "",
        taskId: url.searchParams.get("task_id") || "",
        afterSequence,
        visibility: url.searchParams.get("visibility") || "",
        limit: url.searchParams.get("limit"),
      }));
    }
    const collaborationSnapshotMatch = pathname.match(
      /^\/collaboration\/local\/runs\/([^/]+)\/snapshot$/,
    );
    if (collaborationSnapshotMatch && req.method === "GET") {
      const runId = decodeURIComponent(collaborationSnapshotMatch[1]);
      const snapshot = ctx.collaborationStore.getSnapshot(runId);
      return snapshot
        ? sendOk(res, { snapshot })
        : sendError(res, 404, "collaboration run not found");
    }
    const collaborationDiagnosticsMatch = pathname.match(
      /^\/collaboration\/local\/runs\/([^/]+)\/diagnostics$/,
    );
    if (collaborationDiagnosticsMatch && req.method === "GET") {
      const runId = decodeURIComponent(collaborationDiagnosticsMatch[1]);
      const diagnostics = ctx.collaborationStore.getDiagnostics(runId);
      return diagnostics
        ? sendOk(res, { diagnostics })
        : sendError(res, 404, "collaboration run not found");
    }
    const collaborationAttentionMatch = pathname.match(
      /^\/collaboration\/local\/runs\/([^/]+)\/attention\/([^/]+)\/resolve$/,
    );
    if (collaborationAttentionMatch && req.method === "POST") {
      const runId = decodeURIComponent(collaborationAttentionMatch[1]);
      const attentionId = decodeURIComponent(collaborationAttentionMatch[2]);
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        return sendOk(
          res,
          ctx.collaborationRuntime
            ? await ctx.collaborationRuntime.resolveAttention(runId, attentionId, body)
            : ctx.collaborationStore.resolveAttention(runId, attentionId, body),
        );
      } catch (error) {
        const status = error.code === "COLLABORATION_ATTENTION_REVISION_CONFLICT"
          ? 409
          : error.code === "COLLABORATION_ATTENTION_ACTION_INVALID"
            ? 400
            : 404;
        return sendError(res, status, error.message, {
          reason: error.code || "collaboration_attention_resolution_failed",
        });
      }
    }
    const collaborationArchiveMatch = pathname.match(
      /^\/collaboration\/local\/runs\/([^/]+)\/archive$/,
    );
    if (collaborationArchiveMatch && req.method === "POST") {
      const runId = decodeURIComponent(collaborationArchiveMatch[1]);
      try {
        return sendOk(
          res,
          ctx.collaborationRuntime
            ? await ctx.collaborationRuntime.handleControlOperation("archive", { run_id: runId })
            : { run: ctx.collaborationStore.archiveRun(runId, true) },
        );
      } catch (error) {
        return sendError(res, 409, error.message || "collaboration run could not be archived");
      }
    }
    const collaborationMatch = pathname.match(
      /^\/collaboration\/local\/runs\/([^/]+)(?:\/(start|confirm|replan|begin-planning|begin-implementation|pause|resume|retry|cancel|messages|budget|approval))?$/,
    );
    if (collaborationMatch) {
      const runId = decodeURIComponent(collaborationMatch[1]);
      const action = collaborationMatch[2] || "";
      if (req.method === "GET" && !action) {
        const run = ctx.collaborationStore.getRun(runId);
        return run ? sendOk(res, { run }) : sendError(res, 404, "collaboration run not found");
      }
      if (req.method === "GET" && action === "messages") {
        const run = ctx.collaborationStore.getRun(runId, { includeMessages: false });
        if (!run) return sendError(res, 404, "collaboration run not found");
        return sendOk(res, {
          messages: ctx.collaborationStore.listMessages(runId, {
            after: url.searchParams.get("after"),
            limit: url.searchParams.get("limit"),
          }),
        });
      }
      if (req.method === "DELETE" && !action) {
        try {
          const result = ctx.collaborationRuntime
            ? await ctx.collaborationRuntime.handleControlOperation("delete", { run_id: runId })
            : { deleted: ctx.collaborationStore.deleteRun(runId), run_id: runId };
          return result.deleted
            ? sendOk(res, result)
            : sendError(res, 404, "collaboration run not found");
        } catch (error) {
          return sendError(res, 409, error.message || "collaboration run could not be deleted");
        }
      }
      if (req.method !== "POST" || !action) {
        return sendError(res, 405, `method ${req.method} not allowed`);
      }
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const result = action === "start"
          ? { run: ctx.collaborationRuntime
              ? await ctx.collaborationRuntime.start(runId)
              : ctx.collaborationCoordinator.start(runId) }
          : action === "confirm"
            ? { run: ctx.collaborationRuntime
                ? await ctx.collaborationRuntime.confirm(runId)
                : ctx.collaborationCoordinator.confirm(runId) }
          : action === "replan"
            ? { run: ctx.collaborationRuntime
                ? await ctx.collaborationRuntime.revisePlan(runId, body.feedback)
                : ctx.collaborationStore.requestAdaptivePlanRevision(runId, body.feedback) }
          : action === "begin-planning"
            ? { run: ctx.collaborationCoordinator.beginPlanning(runId) }
            : action === "begin-implementation"
              ? { run: ctx.collaborationCoordinator.beginImplementation(runId) }
              : action === "cancel"
                ? { run: ctx.collaborationRuntime
                    ? await ctx.collaborationRuntime.cancel(runId)
                    : ctx.collaborationCoordinator.cancel(runId) }
                : action === "pause"
                  ? { run: ctx.collaborationRuntime
                      ? await ctx.collaborationRuntime.pause(runId)
                      : ctx.collaborationStore.pauseRun(runId) }
                  : action === "resume"
                    ? { run: ctx.collaborationRuntime
                        ? await ctx.collaborationRuntime.resume(runId)
                        : ctx.collaborationStore.resumeRun(runId) }
                    : action === "retry"
                      ? { run: ctx.collaborationRuntime
                          ? await ctx.collaborationRuntime.retry(runId, body.task_id || body.taskId)
                          : (body.task_id || body.taskId
                              ? ctx.collaborationStore.retryAdaptiveTask(runId, body.task_id || body.taskId)
                              : ctx.collaborationStore.retryRun(runId)) }
                : action === "budget"
                  ? { run: ctx.collaborationRuntime
                      ? await ctx.collaborationRuntime.updateBudget(runId, body)
                      : ctx.collaborationStore.updateBudget(runId, body) }
                  : action === "approval"
                    ? { run: ctx.collaborationRuntime
                        ? await ctx.collaborationRuntime.updateSupervisorApproval(runId, body)
                        : ctx.collaborationStore.updateSupervisorApproval(runId, body) }
                  : ctx.collaborationCoordinator.receive(runId, body);
        return sendOk(res, result);
      } catch (error) {
        return sendError(res, 409, error.message || "collaboration action rejected", {
          reason: error.code || "collaboration_action_rejected",
        });
      }
    }
    if (req.method === "GET" && pathname === "/agent/catalog/status") {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      return sendOk(res, { catalog: ctx.agentCatalog.status() });
    }
    if (req.method === "GET" && pathname === "/agent/catalog/conversations") {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      const pageSize = url.searchParams.get("page_size");
      const view = url.searchParams.get("view");
      if (pageSize || view === "history" || view === "archived") {
        return sendOk(res, ctx.agentCatalog.listConversationPage({
          collection: view || "history",
          search: url.searchParams.get("search") || "",
          agent: url.searchParams.get("agent") || "",
          deviceId: url.searchParams.get("device_id") || "",
          workspaceId: url.searchParams.get("workspace_id") || "",
          page: url.searchParams.get("page"),
          pageSize,
          autoArchiveDays: url.searchParams.get("auto_archive_days"),
        }));
      }
      return sendOk(res, {
        conversations: ctx.agentCatalog.listConversations({
          search: url.searchParams.get("search") || "",
          agent: url.searchParams.get("agent") || "",
          deviceId: url.searchParams.get("device_id") || "",
          workspaceId: url.searchParams.get("workspace_id") || "",
          status: url.searchParams.get("status") || "",
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          includeArchived: url.searchParams.get("archived") === "true",
        }),
      });
    }
    const catalogArchiveMatch = pathname.match(
      /^\/agent\/catalog\/conversations\/([^/]+)\/(archive|restore)$/,
    );
    if (req.method === "POST" && catalogArchiveMatch) {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      const conversationId = decodeURIComponent(catalogArchiveMatch[1]);
      const conversation = ctx.agentCatalog.setConversationArchived(
        conversationId,
        catalogArchiveMatch[2] === "archive",
      );
      if (!conversation) return sendError(res, 404, "agent conversation not found");
      return sendOk(res, { conversation });
    }
    const catalogRenameMatch = pathname.match(
      /^\/agent\/catalog\/conversations\/([^/]+)\/rename$/,
    );
    if (req.method === "PUT" && catalogRenameMatch) {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      const conversation = ctx.agentCatalog.renameConversation(
        decodeURIComponent(catalogRenameMatch[1]),
        body.title,
      );
      if (!conversation) return sendError(res, 404, "agent conversation not found");
      return sendOk(res, { conversation });
    }
    if (req.method === "GET" && pathname === "/agent/catalog/workspaces") {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      return sendOk(res, {
        workspaces: ctx.agentCatalog.listWorkspaces({
          search: url.searchParams.get("search") || "",
          deviceId: url.searchParams.get("device_id") || "",
          limit: url.searchParams.get("limit"),
        }),
      });
    }
    if (req.method === "GET" && pathname === "/agent/catalog/workspaces/browse") {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      try {
        const page = await browseAgentWorkspaces({
          path: url.searchParams.get("path") || "",
          query: url.searchParams.get("query") || "",
          limit: url.searchParams.get("limit"),
          catalog: ctx.agentCatalog,
          deviceId: ctx.deviceId,
        });
        return sendOk(res, page);
      } catch (error) {
        return sendError(res, 400, error.message || "workspace browse failed", {
          reason: error.code || "workspace_browse_failed",
        });
      }
    }
    if (req.method === "POST" && pathname === "/agent/catalog/workspaces/trust") {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const workspace = ctx.agentCatalog.trustWorkspace(body.path, {
          deviceId: ctx.deviceId,
        });
        return sendOk(res, {
          workspace: {
            ...workspace,
            unattended_execution: assessRegisteredWorkspaceForUnattended(workspace),
          },
        });
      } catch (error) {
        return sendError(res, 400, error.message || "workspace trust failed", {
          reason: error.code || "workspace_trust_failed",
        });
      }
    }
    if (req.method === "POST" && pathname === "/agent/catalog/workspaces/authorize") {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const workspace = ctx.agentCatalog.authorizeWorkspaceForUnattended(body.path, {
          deviceId: ctx.deviceId,
        });
        return sendOk(res, {
          workspace: {
            ...workspace,
            unattended_execution: assessRegisteredWorkspaceForUnattended(workspace),
          },
        });
      } catch (error) {
        return sendError(res, 400, error.message || "workspace authorization failed", {
          reason: error.code || "workspace_authorization_failed",
        });
      }
    }
    if (req.method === "POST" && pathname === "/agent/local/launch") {
      if (!ctx.managedAgentSupervisor) {
        return sendError(res, 503, "managed Agent launcher unavailable");
      }
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        const result = await ctx.managedAgentSupervisor.start(body);
        return sendOk(res, { launch: result });
      } catch (error) {
        return sendError(
          res,
          ["WORKSPACE_NOT_FOUND", "WORKSPACE_NOT_TRUSTED"].includes(error.code)
            ? 409
            : 400,
          error.message || "Agent launch failed",
          { reason: error.code || "launch_failed" },
        );
      }
    }
    const catalogConversationMatch = pathname.match(
      /^\/agent\/catalog\/conversations\/([^/]+)$/,
    );
    if (req.method === "GET" && catalogConversationMatch) {
      if (!ctx.agentCatalog) return sendError(res, 503, "agent catalog unavailable");
      const conversationId = decodeURIComponent(catalogConversationMatch[1]);
      const conversation = ctx.agentCatalog.getConversation(conversationId);
      if (!conversation) return sendError(res, 404, "agent conversation not found");
      return sendOk(res, { conversation });
    }
    if (pathname === "/agent/local/settings/detail") {
      if (req.method === "GET") {
        const config = readConfig();
        return sendOk(res, {
          profile: agentDetailDefaultFromConfig(config),
          available_profiles: AGENT_DETAIL_PROFILES,
        });
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        try {
          const next = setAgentDetailDefault(readConfig(), body.profile);
          writeConfig(next);
          return sendOk(res, {
            profile: agentDetailDefaultFromConfig(next),
            available_profiles: AGENT_DETAIL_PROFILES,
          });
        } catch (error) {
          return sendError(res, 400, error.message || "invalid agent detail profile");
        }
      }
      return sendError(res, 405, `method ${req.method} not allowed`);
    }
    if (req.method === "GET" && pathname === "/agent/local/events") {
      return sendOk(res, ctx.externalAgentRegistry.eventsAfter(url.searchParams.get("after")));
    }
    if (req.method === "POST" && pathname === "/agent/local/sessions/register") {
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return sendOk(res, { session: ctx.externalAgentRegistry.register(body) });
    }

    const localInquiryMatch = pathname.match(
      /^\/agent\/local\/sessions\/([^/]+)\/inquiries\/(approval|change)\/query$/,
    );
    if (localInquiryMatch) {
      if (req.method !== "POST") {
        return sendError(res, 405, `method ${req.method} not allowed`);
      }
      const sessionId = decodeURIComponent(localInquiryMatch[1]);
      const domain = localInquiryMatch[2];
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      try {
        let queryPlan = null;
        try {
          queryPlan = await new AiAuditQueryPlanner({
            stateDir: ctx.stateDir || getStateDir(),
            onTelemetry: (fact, context) => ctx.sessionManager?.enqueueAiTelemetryFact?.(fact, context),
          }).plan({
            queryId: body.query_id,
            domain,
            query: body.query,
            telemetryContext: {
              runId: body.runId || body.run_id,
              sessionId,
            },
          });
        } catch {}
        const evidenceBundle = buildAuditEvidenceBundle({
          auditStore: ctx.auditStore,
          sessionId,
          request: { ...body, domain, query_plan: queryPlan },
        });
        ctx.sessionManager?.enqueueAiTelemetryFact?.({
          type: "audit.evidence.answered",
          provider: "originrouter",
          payload: {
            success: true,
            task_kind: "evidence_qa",
            evidence_ref_count: evidenceBundle.evidence?.length || 0,
            status: evidenceBundle.abstained ? "abstained" : "answered",
            metadata: { mode: domain },
          },
        }, {
          runId: body.runId || body.run_id,
          sessionId,
          idempotencyKey: `ai:${body.runId || body.run_id}:${sessionId}:audit.evidence.answered:${body.query_id || "unknown"}`,
        });
        return sendOk(res, { evidence_bundle: evidenceBundle });
      } catch (error) {
        return sendError(res, 400, error.message || "invalid inquiry request", {
          reason: error.code || "invalid_inquiry_request",
        });
      }
    }

    const localAgentMatch = pathname.match(
      /^\/agent\/local\/sessions\/([^/]+)\/(update|unregister|events|commands|history|audit|message|interrupt|stop|interaction|mode|autonomy)$/,
    );
    if (localAgentMatch) {
      const sessionId = decodeURIComponent(localAgentMatch[1]);
      const action = localAgentMatch[2];
      try {
        if (req.method === "GET" && action === "commands") {
          return sendOk(
            res,
            ctx.externalAgentRegistry.commandsAfter(
              sessionId,
              url.searchParams.get("after"),
            ),
          );
        }
        if (req.method === "GET" && action === "history") {
          return sendOk(
            res,
            ctx.externalAgentRegistry.history(sessionId, {
              beforeCursor: url.searchParams.get("before"),
              limit: url.searchParams.get("limit"),
            }),
          );
        }
        if (req.method === "GET" && action === "audit") {
          return sendOk(
            res,
            ctx.auditStore.list(sessionId, {
              category: url.searchParams.get("category") || "",
              beforeCursor: url.searchParams.get("before"),
              limit: url.searchParams.get("limit"),
            }),
          );
        }
        if (req.method !== "POST") {
          return sendError(res, 405, `method ${req.method} not allowed`);
        }
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        if (action === "update") {
          return sendOk(res, { session: ctx.externalAgentRegistry.update(sessionId, body) });
        }
        if (action === "unregister") {
          ctx.externalAgentRegistry.unregister(sessionId, body);
          return sendOk(res, { sessionId, status: body.status || "stopped" });
        }
        if (action === "events") {
          const sequence = ctx.externalAgentRegistry.appendEvent(sessionId, body.event || {});
          let session = { sessionId };
          try { session = ctx.externalAgentRegistry.require(sessionId); } catch {}
          ctx.auditStore?.appendEvent({
            sessionId,
            cwd: session.cwd || session.workspace || "",
            agent: session.agent || session.agentType || "",
            runtime: session.runtime || "",
            title: session.title || "",
            runId: session.run_id || session.runId || "",
          }, body.event || {});
          return sendOk(res, { sessionId, sequence });
        }
        if (action === "message") {
          const message = String(body.message || "").trim();
          if (!message || message.length > 8192) return sendError(res, 400, "invalid agent message");
          const command = ctx.externalAgentRegistry.enqueueCommand(sessionId, {
            type: "agent.message",
            sessionId,
            message,
            messageId: body.messageId,
          });
          return sendOk(res, {
            session_id: sessionId,
            accepted: true,
            request_id: command.commandId,
          });
        }
        if (action === "interrupt") {
          ctx.externalAgentRegistry.enqueueCommand(sessionId, {
            type: "terminal.interrupt",
            sessionId,
          });
          return sendOk(res, { session_id: sessionId, action, accepted: true });
        }
        if (action === "stop") {
          ctx.externalAgentRegistry.enqueueCommand(sessionId, {
            type: "session.stop",
            sessionId,
          });
          return sendOk(res, { session_id: sessionId, action, accepted: true });
        }
        if (action === "interaction") {
          const command = ctx.externalAgentRegistry.enqueueCommand(sessionId, {
            ...body,
            type: "agent.interaction.resolve",
            sessionId,
          });
          return sendOk(res, {
            session_id: sessionId,
            accepted: true,
            request_id: command.commandId,
          });
        }
        if (action === "mode") {
          const mode = String(body.mode || "").trim();
          if (!mode || mode.length > 32) return sendError(res, 400, "invalid agent mode");
          const command = ctx.externalAgentRegistry.enqueueCommand(sessionId, {
            type: "agent.mode.set",
            sessionId,
            mode,
            requestId: body.requestId,
          });
          return sendOk(res, {
            session_id: sessionId,
            accepted: true,
            request_id: command.commandId,
          });
        }
        if (action === "autonomy") {
          const profile = String(body.profile || "").trim();
          if (!['manual', 'guarded', 'ai_review', 'unrestricted', 'custom'].includes(profile)) {
            return sendError(res, 400, "invalid agent autonomy profile");
          }
          const rawScopes = Array.isArray(body.allowedScopes)
            ? body.allowedScopes
            : Array.isArray(body.allowed_scopes)
              ? body.allowed_scopes
              : [];
          const knownScopes = new Set(AGENT_AUTONOMY_SCOPES.map((item) => item.id));
          if (rawScopes.some((scope) => !knownScopes.has(String(scope || "")))) {
            return sendError(res, 400, "invalid agent autonomy scope");
          }
          const allowedScopes = profile === "custom"
            ? normalizeAutonomyScopes(rawScopes)
            : [];
          let approvalPolicy = null;
          let aiReviewPolicy = null;
          if (profile === "custom") {
            const bundle = body.policyBundle || body.policy_bundle;
            const policyId = String(body.policyId || body.policy_id || "").trim();
            approvalPolicy = bundle
              ? deployApprovalPolicyBundle(bundle, { stateDir: getStateDir() })
              : policyId
                ? readApprovalPolicy(policyId, { stateDir: getStateDir() })
                : null;
            const expectedRevision = String(
              body.policyRevision || body.policy_revision || "",
            ).replace(/^sha256:/, "").trim();
            if (approvalPolicy && expectedRevision && approvalPolicy.revision !== expectedRevision) {
              return sendError(res, 409, "approval policy revision is not installed on this device");
            }
          }
          if (profile === "ai_review") {
            aiReviewPolicy = aiReviewPolicyFromPayload(body);
          }
          const command = ctx.externalAgentRegistry.enqueueCommand(sessionId, {
            type: "agent.autonomy.set",
            sessionId,
            profile,
            allowedScopes: approvalPolicy ? [] : allowedScopes,
            ...(approvalPolicy
              ? {
                  policyId: approvalPolicy.policy.id,
                  policyRevision: approvalPolicy.revision,
                }
              : {}),
            ...(aiReviewPolicy ? { aiReviewPolicy } : {}),
            requestId: body.requestId,
          });
          return sendOk(res, {
            session_id: sessionId,
            accepted: true,
            request_id: command.commandId,
          });
        }
      } catch (error) {
        const status = error?.code === "SESSION_NOT_FOUND" ? 404 : 409;
        return sendError(res, status, error.message || "local agent request failed");
      }
    }

    // /providers/:name (single segment) — GET | PUT | DELETE.
    const providerMatch = pathname.match(/^\/providers\/([^/]+)$/);
    if (providerMatch) {
      const name = decodeURIComponent(providerMatch[1]);
      if (req.method === "GET") {
        try {
          return sendOk(res, { provider: handleProviderShow(ctx, name) });
        } catch (err) {
          return sendError(res, 404, err.message);
        }
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        return handleProviderUpdate(ctx, res, name, body);
      }
      if (req.method === "DELETE") {
        return handleProviderRemove(ctx, res, name);
      }
    }

    // /sessions/:id/{permission,input,interrupt,interaction}
    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)\/(permission|input|interrupt|interaction)$/);
    if (req.method === "POST" && sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const action = sessionMatch[2];
      const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
      if (body.__error) return sendError(res, 400, body.__error);
      return handleSessionControl(ctx, res, sessionId, action, body);
    }

    return sendError(res, 404, `unknown route: ${req.method} ${pathname}`);
  } catch (err) {
    console.error(`[local-api] ${err.stack || err.message}`);
    return sendError(res, 500, err.message || "internal error");
  }
}

// ---------- Read handlers ----------

async function handleLocalStatus(ctx) {
  const startedAt = ctx.startedAt;
  const uptimeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  return {
    daemon: {
      pid: ctx.pid,
      version: ctx.version,
      deviceId: ctx.deviceId,
      startedAt,
      uptimeSeconds,
      port: ctx.localApiPort,
      bindAddress: ctx.bindAddress,
      baseUrl: `http://${httpHost(ctx.bindAddress)}:${ctx.localApiPort}`,
      authMode: "bearer",
      lanEnabled: !ctx.isLoopback,
    },
    relay: {
      url: ctx.relayUrl,
      connected: ctx.relayConnected(),
      authState: typeof ctx.relayAuthState === "function" ? ctx.relayAuthState() : undefined,
      authError: typeof ctx.relayAuthError === "function" ? ctx.relayAuthError() : undefined,
    },
    e2ee: ctx.deviceE2eeLocalGateway?.identityStatus(ctx.deviceId),
    // Independent runtimes: agent routes and explicitly shared remote access.
    proxy: await ctx.getProxyStatus(),
    remoteShare: await handleRemoteShareStatusPayload(ctx),
    agentDetail: {
      profile: agentDetailDefaultFromConfig(readConfig()),
      availableProfiles: AGENT_DETAIL_PROFILES,
    },
    compatibility: ctx.sessionManager?.compatibilityStatus?.(),
    updates: cachedUpdateStatus({
      stateDir: ctx.stateDir || getStateDir(),
      config: readConfig(),
      installContext: detectInstallContext(),
    }),
  };
}

async function handleRemoteShareStatusPayload(ctx) {
  const config = readConfig();
  const configured = config.remoteShare || {};
  const status = await ctx.getRemoteShareProxyStatus();
  const providerNames = Array.isArray(status.currentProviders) && status.currentProviders.length > 0
    ? status.currentProviders
    : configured.providers || [];
  const catalog = remoteShareProviders(config, providerNames)
    .flatMap((provider) => remoteShareModelEntries(provider))
    .map(({ provider, model, sourceProvider, pricing }) => ({
      provider,
      model,
      sourceProvider,
      pricing,
    }));
  return {
    ...status,
    enabled: configured.enabled === true,
    providers: providerNames,
    catalog,
    e2eePolicy: "required",
    e2eeSupported: true,
  };
}

// ---------- Stage 6: proxy log tail ----------

function handleProxyLogs(ctx, res, url) {
  // ?tail=N — default 200, max 2000. 1 MiB cap on the read.
  const tailParam = url.searchParams.get("tail");
  let tail = LOG_TAIL_DEFAULT_LINES;
  if (tailParam != null) {
    const n = Number.parseInt(tailParam, 10);
    if (!Number.isFinite(n) || n < 1) {
      return sendError(res, 400, "tail must be a positive integer");
    }
    tail = Math.min(n, LOG_TAIL_MAX_LINES);
  }
  const state = readProxyState();
  if (!state || !state.logPath) {
    return sendError(res, 404, "no proxy log path recorded; is the proxy running?");
  }
  const logPath = state.logPath;
  let st;
  try { st = statSync(logPath); }
  catch (err) { return sendError(res, 500, `cannot stat log: ${err.message}`); }
  if (!st.isFile()) return sendError(res, 404, "log path is not a regular file");

  let text;
  try {
    // Cap at 1 MiB: if the file is larger, read only the last 1 MiB.
    const size = Math.min(st.size, LOG_TAIL_MAX_BYTES);
    const start = st.size - size;
    const buf = Buffer.alloc(size);
    const fd = openSync(logPath, "r");
    try { readSync(fd, buf, 0, size, start); }
    finally { closeSync(fd); }
    text = buf.toString("utf8");
  } catch (err) {
    return sendError(res, 500, `cannot read log: ${err.message}`);
  }
  const lines = text.split("\n");
  // If we truncated, drop the partial first line.
  if (st.size > LOG_TAIL_MAX_BYTES) lines.shift();
  const tailLines = lines.slice(-tail);
  return sendOk(res, { path: logPath, lines: tailLines.length, content: tailLines.join("\n") });
}

function handleProxyRequests(ctx, res, url) {
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit != null && !/^\d+$/.test(rawLimit)) {
    return sendError(res, 400, "limit must be a positive integer");
  }
  const limit = rawLimit == null ? undefined : Number(rawLimit);
  if (limit != null && limit < 1) {
    return sendError(res, 400, "limit must be a positive integer");
  }
  try {
    return sendOk(res, ctx.proxyRequestStore.listPage({
      limit,
      cursor: url.searchParams.get("cursor"),
      status: url.searchParams.get("status") || "",
      query: url.searchParams.get("q") || "",
    }));
  } catch (error) {
    return sendError(res, 400, error?.message || "invalid request query");
  }
}
