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
import { timingSafeEqual } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  addProvider,
  applyProviderUpdate,
  listProviders,
  removeProvider,
  setClaudeRouteFromProvider,
  showProvider,
  takeUpdateWarnings,
} from "../config/providers.js";
import {
  ROUTE_AGENTS,
  ROUTE_DEFS,
  clearRoute,
  getAgentRoutes,
  getAllRoutes,
  getRoutes,
  hashRoutes,
  replaceAgentRoutes,
  setRoute,
} from "../config/routes.js";
import { LITELLM_PROVIDERS } from "../proxy/litellmCatalog.js";
import { discoverProviderModels } from "../proxy/modelDiscovery.js";
import { probeProviderModel } from "../proxy/modelProbe.js";
import {
  enabledProviderModelEntries,
  hasRemoteEnabledModels,
  normalizeProviderModels,
  remoteShareModelEntries,
} from "../config/providerModels.js";
import { readApiToken } from "../persistence/authToken.js";
import { getStateDir, readConfig, readProxyState, writeConfig } from "../persistence/state.js";
import { DEFAULT_RELAY_URL, DEFAULT_REMOTE_SHARE_PROXY_PORT } from "../constants.js";
import {
  AGENT_AUTONOMY_SCOPES,
  normalizeAutonomyScopes,
} from "../runtime/agentAutonomyPolicy.js";
import {
  deployApprovalPolicyBundle,
  readApprovalPolicy,
} from "../runtime/approvalPolicyStore.js";
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
import { CollaborationStore } from "../collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../collaboration/planImplementVerifyCoordinator.js";
import { browseAgentWorkspaces } from "../daemon/workspaceBrowser.js";

// Exported so CLI subcommands (e.g. `local api set-host`) can apply
// the same gating as the runtime auth layer. Keep the set in lock-
// step with the bind-address check in `startLocalApi` above.
export const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function httpHost(address) {
  return String(address).includes(":") && !String(address).startsWith("[")
    ? `[${address}]`
    : address;
}

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
function placeholderProxyStatus() {
  return {
    state: "not-installed",
    port: null,
    version: null,
    pid: null,
    currentProvider: null,
    note: "LiteLLM proxy control lands in Stage 4.",
  };
}

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
    proxyRequestStore,
    collaborationStore,
    collaborationCoordinator,
    collaborationRuntime: ctx.collaborationRuntime || null,
    agentCatalog: ctx.agentCatalog || null,
    managedAgentSupervisor: ctx.managedAgentSupervisor || null,
    deviceE2eeLocalGateway: ctx.deviceE2eeLocalGateway || null,
    externalAgentRegistry:
      ctx.externalAgentRegistry ||
      new ExternalAgentRegistry({ catalog: ctx.agentCatalog || null }),
    startedAt: ctx.startedAt || new Date().toISOString(),
    pid: ctx.pid || process.pid,
    version: ctx.version || "0.1.0",
    relayUrl: ctx.relayUrl || DEFAULT_RELAY_URL,
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
      resolve();
    })),
  };
}

// ---------- Request body parsing ----------

function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error(`invalid JSON: ${err.message}`)); }
    });
    req.on("error", reject);
  });
}

// ---------- Response helpers ----------

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    ...extraHeaders,
  });
  res.end(payload);
}
function sendOk(res, data) { sendJson(res, 200, { ok: true, ...data }); }
function sendError(res, status, error, { reason, wwwAuth } = {}) {
  const body = { ok: false, error };
  if (reason) body.reason = reason;
  const headers = {};
  if (wwwAuth) headers["WWW-Authenticate"] = 'Bearer realm="originrouter-local"';
  sendJson(res, status, body, headers);
}

// ---------- Auth (Stage 6) ----------

// DANGER: dev-only escape hatch. When set, ALL write requests pass without a
// token. Used by tests that boot the local API in isolation (without a
// daemon). Production code paths must NOT set this.
const DEV_INSECURE = process.env.ORIGINROUTER_DEV_INSECURE === "1";

// Constant-time compare on equal-length buffers. `timingSafeEqual` throws if
// the lengths differ, so we length-check first.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}

// Returns { ok: true } on success, or { ok: false, status, error, reason }.
// Only health/static discovery and the proof-based E2EE bootstrap are public.

function requireAuth(req, ctx) {
  if (DEV_INSECURE) return { ok: true };
  const url = req.url || "/";
  const path = url.split("?")[0];
  if (["/local/e2ee/session", "/local/e2ee/messages"].includes(path)) {
    return { ok: true };
  }
  const publicRead = (req.method === "GET" || req.method === "HEAD")
    && [
      "/local/auth/challenge",
      "/local/e2ee/challenge",
      "/catalog/litellm-providers",
    ].includes(path);
  const needsAuth = req.method !== "OPTIONS" && !publicRead;
  if (!needsAuth) return { ok: true };
  const header = req.headers.authorization;
  if (!header) {
    return { ok: false, status: 401, error: "unauthorized", reason: "missing" };
  }
  const m = BEARER_RE.exec(header);
  if (!m) {
    return { ok: false, status: 401, error: "unauthorized", reason: "malformed" };
  }
  const stored = readApiToken(ctx.apiTokenPath ? dirnameOf(ctx.apiTokenPath) : getStateDir());
  if (!stored) {
    return { ok: false, status: 503, error: "auth-not-initialized", reason: "auth-not-initialized" };
  }
  if (!safeEqual(m[1], stored)) {
    return { ok: false, status: 401, error: "unauthorized", reason: "invalid" };
  }
  return { ok: true };
}

function dirnameOf(p) {
  // Lightweight dirname to avoid pulling another helper.
  const i = String(p).lastIndexOf("/");
  return i < 0 ? "." : String(p).slice(0, i);
}

// ---------- Dispatch ----------

async function dispatch(ctx, req, res) {
  // CORS preflight short-circuit.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
    if (req.method === "GET" && pathname === "/local/auth/challenge") {
      return sendOk(res, {
        authRequired: true,
        tokenFile: ctx.apiTokenPath,
      });
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
    if (pathname === "/collaboration/local/runs") {
      if (req.method === "GET") {
        const runs = ctx.collaborationStore.listRuns({ limit: url.searchParams.get("limit") })
          .map((run) => ctx.collaborationStore.getRun(run.run_id));
        return sendOk(res, { runs });
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req).catch((err) => ({ __error: err.message }));
        if (body.__error) return sendError(res, 400, body.__error);
        try {
          return sendOk(res, { run: ctx.collaborationCoordinator.create(body) });
        } catch (error) {
          return sendError(res, 400, error.message || "invalid collaboration run");
        }
      }
      return sendError(res, 405, `method ${req.method} not allowed`);
    }
    const collaborationMatch = pathname.match(
      /^\/collaboration\/local\/runs\/([^/]+)(?:\/(start|begin-planning|begin-implementation|cancel|messages|budget))?$/,
    );
    if (collaborationMatch) {
      const runId = decodeURIComponent(collaborationMatch[1]);
      const action = collaborationMatch[2] || "";
      if (req.method === "GET" && !action) {
        const run = ctx.collaborationStore.getRun(runId);
        return run ? sendOk(res, { run }) : sendError(res, 404, "collaboration run not found");
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
          : action === "begin-planning"
            ? { run: ctx.collaborationCoordinator.beginPlanning(runId) }
            : action === "begin-implementation"
              ? { run: ctx.collaborationCoordinator.beginImplementation(runId) }
              : action === "cancel"
                ? { run: ctx.collaborationRuntime
                    ? await ctx.collaborationRuntime.cancel(runId)
                    : ctx.collaborationCoordinator.cancel(runId) }
                : action === "budget"
                  ? { run: ctx.collaborationRuntime
                      ? await ctx.collaborationRuntime.updateBudget(runId, body)
                      : ctx.collaborationStore.updateBudget(runId, body) }
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
        return sendOk(res, { workspace });
      } catch (error) {
        return sendError(res, 400, error.message || "workspace trust failed", {
          reason: error.code || "workspace_trust_failed",
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
        const evidenceBundle = buildAuditEvidenceBundle({
          auditStore: ctx.auditStore,
          sessionId,
          request: { ...body, domain },
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

function handleProvidersList(ctx) {
  const config = ctx.configProvider();
  const providers = listProviders(config);
  // Augment each entry with the `current` map so the browser knows which
  // providers are active for which agent without a second round-trip.
  // Stage 7.8+: Claude is route-owned, so derive it from routes.claude
  // instead of the legacy currentProvider.claude field.
  const current = config.currentProvider || {};
  const routes = getRoutes(config);
  // Stage 8.0: Codex is route-owned. The legacy currentProvider.codex
  // field is preserved on disk but no longer drives `originrouter codex`;
  // for the doctor view we still fall back to it so existing users see
  // their saved selection until they migrate to `route set codex.main`.
  const codexRoute = getAgentRoutes(config, "codex");
  for (const p of providers) {
    p.current = {
      claude: (routes.main?.provider === p.name || routes.small?.provider === p.name) ? p.name : null,
      codex:  codexRoute.main?.provider === p.name
                ? p.name
                : current.codex === p.name ? p.name : null,
    };
  }
  return providers;
}

function handleProviderShow(ctx, name) {
  const config = ctx.configProvider();
  const provider = showProvider(config, name); // throws on unknown
  const current = config.currentProvider || {};
  const routes = getRoutes(config);
  const codexRoute = getAgentRoutes(config, "codex");
  provider.current = {
    claude: (routes.main?.provider === name || routes.small?.provider === name) ? name : null,
    codex:  codexRoute.main?.provider === name
              ? name
              : current.codex === name ? name : null,
  };
  return provider;
}

function handleSessionsList(ctx) {
  if (!ctx.sessionManager || !ctx.sessionManager.sessions) return [];
  return Array.from(ctx.sessionManager.sessions.values()).map(projectSession);
}

// ---------- Write handler (single dispatch over the 3 session actions) ----------

async function handleSessionControl(ctx, res, sessionId, action, body) {
  if (!ctx.sessionManager) {
    return sendError(res, 503, "session manager not available");
  }
  if (!ctx.sessionManager.sessions.has(sessionId)) {
    return sendError(res, 404, `unknown session '${sessionId}'`);
  }

  let payload;
  if (action === "input") {
    if (typeof body.data !== "string") {
      return sendError(res, 400, "body.data must be a string");
    }
    payload = { type: "terminal.input", sessionId, data: body.data };
  } else if (action === "interrupt") {
    payload = { type: "terminal.interrupt", sessionId };
  } else if (action === "permission") {
    if (!body.callId || typeof body.callId !== "string") {
      return sendError(res, 400, "body.callId is required");
    }
    if (!body.decision || typeof body.decision !== "string") {
      return sendError(res, 400, "body.decision is required");
    }
    payload = {
      type: "agent.permission.resolve",
      sessionId,
      callId: body.callId,
      decision: body.decision,
      data: body.data,
    };
  } else if (action === "interaction") {
    // Stage 8.9: agent.interaction.resolve route. Accepts
    // interactionId + decision (required) and forwards the new
    // envelope into the local session. The legacy /permission
    // route above stays unchanged.
    if (!body.interactionId || typeof body.interactionId !== "string") {
      return sendError(res, 400, "body.interactionId is required");
    }
    if (!body.decision || typeof body.decision !== "string") {
      return sendError(res, 400, "body.decision is required");
    }
    payload = {
      type: "agent.interaction.resolve",
      sessionId,
      interactionId: body.interactionId,
      // Belt-and-suspenders: callers may pass callId too, but
      // interactionId is the canonical field for the new envelope.
      callId: body.callId || body.interactionId,
      decision: body.decision,
      value: body.value,
      data: body.data,
      reason: body.reason,
    };
  } else {
    return sendError(res, 400, `unknown action '${action}'`);
  }

  try {
    ctx.sessionManager.handleEvent(payload);
  } catch (err) {
    return sendError(res, 500, err.message || "handleEvent threw");
  }
  return sendOk(res, { sessionId, action });
}

// ---------- Proxy write handlers (start | stop | restart) ----------

async function handleProxyControl(ctx, res, action, body) {
  if (action === "stop") {
    if (typeof ctx.stopProxy !== "function") {
      return sendError(res, 503, "proxy manager not wired into daemon");
    }
    const result = await ctx.stopProxy();
    if (!result.ok) return sendError(res, 500, result.error || "stop failed");
    return sendOk(res, result);
  }
  // Stage 7.5: start/restart default to routes mode. Passing a provider is
  // still accepted as a debug/provider-mode escape hatch.
  const provider = typeof body.provider === "string" && body.provider ? body.provider : null;
  let port = Number.parseInt(body.port, 10);
  if (action === "restart" && !Number.isFinite(port)) {
    try {
      const status = await ctx.getProxyStatus();
      const currentPort = Number.parseInt(status?.port, 10);
      if (status?.state === "running" && Number.isFinite(currentPort)) {
        port = currentPort;
      }
    } catch {}
  }
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    return sendError(res, 400, `body.port must be an integer in [1024, 65535]`);
  }
  const fn = action === "start" ? ctx.startProxy : ctx.restartProxy;
  if (typeof fn !== "function") {
    return sendError(res, 503, `proxy ${action} not wired into daemon`);
  }
  const result = await fn(provider
    ? { mode: "provider", provider, port }
    : { mode: "route", port });
  if (!result.ok) return sendError(res, 409, result.error || `${action} failed`);
  return sendOk(res, result);
}

function remoteShareProvider(config, providerName) {
  if (!providerName) return null;
  const raw = config.providers?.[providerName];
  if (!raw) return null;
  const provider = normalizeProviderModels(raw, {
    strict: false,
    legacyRemoteEnabled: (config.remoteShare?.providers || []).includes(providerName),
  });
  return provider.type === "proxy"
    && provider.engine === "litellm"
    && remoteShareModelEntries(provider).length > 0
    ? provider
    : null;
}

function remoteShareProviders(config, providerNames) {
  if (!Array.isArray(providerNames)) return [];
  return providerNames
    .map((name) => remoteShareProvider(config, name))
    .filter(Boolean);
}

function writeRemoteShareConfig({ enabled, providers, port, e2eePolicy }) {
  const config = readConfig();
  const next = {
    ...config,
    remoteShare: {
      enabled: Boolean(enabled),
      providers: providers || config.remoteShare?.providers || [],
      port: port || config.remoteShare?.port || DEFAULT_REMOTE_SHARE_PROXY_PORT,
      e2eePolicy: "required",
    },
  };
  writeConfig(next);
  return next.remoteShare;
}

function syncRemoteShareProviderSelection(config, providerName) {
  const current = new Set(config.remoteShare?.providers || []);
  const provider = config.providers?.[providerName];
  if (provider && hasRemoteEnabledModels(provider)) current.add(providerName);
  else current.delete(providerName);
  return {
    ...config,
    remoteShare: {
      ...(config.remoteShare || {}),
      providers: [...current],
    },
  };
}

async function handleRemoteShareStatus(ctx, res) {
  return sendOk(res, await handleRemoteShareStatusPayload(ctx));
}

async function handleRemoteShareControl(ctx, res, action, body) {
  if (action === "stop") {
    if (typeof ctx.stopRemoteShareProxy !== "function") {
      return sendError(res, 503, "remote share proxy manager not wired into daemon");
    }
    const result = await ctx.stopRemoteShareProxy();
    if (!result.ok) return sendError(res, 500, result.error || "stop failed");
    const configured = writeRemoteShareConfig({ enabled: false });
    return sendOk(res, { ...result, ...configured });
  }

  const config = readConfig();
  const providerNames = [...new Set(
    (Array.isArray(body.providers) ? body.providers : config.remoteShare?.providers || [])
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  )];
  if (providerNames.length === 0) {
    return sendError(res, 400, "remote share requires at least one local LiteLLM provider");
  }
  const providers = remoteShareProviders(config, providerNames);
  if (providers.length !== providerNames.length) {
    return sendError(res, 400, "remote share contains an unknown Provider or one with no remotely enabled model");
  }
  const parsedPort = Number.parseInt(body.port || config.remoteShare?.port || DEFAULT_REMOTE_SHARE_PROXY_PORT, 10);
  if (!Number.isFinite(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
    return sendError(res, 400, "body.port must be an integer in [1024, 65535]");
  }
  const fn = action === "start"
    ? ctx.startRemoteShareProxy
    : ctx.restartRemoteShareProxy;
  if (typeof fn !== "function") {
    return sendError(res, 503, `remote share ${action} not wired into daemon`);
  }
  const result = await fn({ providerNames, port: parsedPort });
  if (!result.ok) return sendError(res, 409, result.error || `${action} failed`);
  const configured = writeRemoteShareConfig({
    enabled: true,
    providers: providerNames,
    port: parsedPort,
    e2eePolicy: "required",
  });
  return sendOk(res, {
    ...result,
    ...configured,
    catalog: providers
      .flatMap((provider) => remoteShareModelEntries(provider))
      .map(({ provider, model, sourceProvider, pricing }) => ({
        provider,
        model,
        sourceProvider,
        pricing,
      })),
  });
}

async function handleProviderModelDiscovery(ctx, res, body) {
  const existingName = typeof body.existingName === "string"
    ? body.existingName.trim()
    : "";
  const config = ctx.configProvider();
  const existing = existingName ? config.providers?.[existingName] : null;
  if (existingName && !existing) {
    return sendError(res, 404, `unknown provider '${existingName}'`);
  }
  const draft = { ...(existing || {}) };
  for (const key of ["litellmProvider", "baseUrl", "apiKey", "authToken"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) draft[key] = value.trim();
  }
  try {
    const result = await ctx.discoverProviderModels(draft);
    return sendOk(res, result);
  } catch (error) {
    return sendError(res, 422, error?.message || "model discovery failed");
  }
}

async function handleProviderModelProbe(ctx, res, body) {
  const existingName = typeof body.existingName === "string"
    ? body.existingName.trim()
    : "";
  const config = ctx.configProvider();
  const existing = existingName ? config.providers?.[existingName] : null;
  if (existingName && !existing) {
    return sendError(res, 404, `unknown provider '${existingName}'`);
  }
  const draft = { ...(existing || {}) };
  for (const key of ["litellmProvider", "baseUrl", "apiKey", "authToken"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) draft[key] = value.trim();
  }
  try {
    return sendOk(res, await probeProviderModel(draft, body.model));
  } catch (error) {
    return sendError(res, 422, error?.message || "model verification failed");
  }
}

// ---------- /providers/use ----------

async function handleProvidersUse(ctx, res, body) {
  const { name, agent } = body;
  if (!name || typeof name !== "string") {
    return sendError(res, 400, "body.name is required");
  }
  if (agent !== "claude" && agent !== "codex") {
    return sendError(res, 400, "body.agent must be 'claude' or 'codex'");
  }

  let config;
  try { config = ctx.configProvider(); }
  catch (err) { return sendError(res, 500, `readConfig failed: ${err.message}`); }

  const target = (config.providers || {})[name];
  if (!target) {
    return sendError(res, 404, `unknown provider '${name}'`);
  }

  if (agent === "claude") {
    // Stage 7.6: write routes directly. No force flag. No current-provider
    // update for claude (routes is the source of truth).
    let routeUpdate;
    try { routeUpdate = setClaudeRouteFromProvider(config, name); }
    catch (err) { return sendError(res, 400, err.message); }
    const result = await saveRoutesAndMaybeRestartProxy(ctx, routeUpdate.next, config);
    if (!result.ok) return sendError(res, 500, result.error);
    return sendOk(res, {
      setProvider: name,
      setAgent: agent,
      routes: { [agent]: projectRoutesForApi(result.routes[agent], agent) },
      proxy: result.proxy,
    });
  }

  // Stage 8.0: codex is route-mode only. `provider use --agent codex`
  // (and POST /providers/use { agent: "codex" }) writes routes.codex.main
  // and goes through the route-mode proxy restart path. No legacy
  // currentProvider.codex write.
  let next;
  try {
    const model = enabledProviderModelEntries(target)[0]?.id;
    if (!model) throw new Error(`provider '${name}' has no enabled model`);
    next = setRoute(config, "codex", "main", { provider: name, model });
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const result = await saveRoutesAndMaybeRestartProxy(ctx, next, config);
  if (!result.ok) return sendError(res, 500, result.error);
  return sendOk(res, {
    setProvider: name,
    setAgent: agent,
    routes: { [agent]: projectRoutesForApi(result.routes[agent], agent) },
    proxy: result.proxy,
  });
}

// ---------- /providers (POST add) ----------

function handleProviderAdd(ctx, res, body) {
  let config;
  try { config = ctx.configProvider(); }
  catch (err) { return sendError(res, 500, `readConfig failed: ${err.message}`); }

  let next;
  try { next = addProvider(config, body); }
  catch (err) {
    // addProvider's errors are 400-class (validation) or 409 (duplicate name).
    const status = /already exists/.test(err.message) ? 409 : 400;
    return sendError(res, status, err.message);
  }

  next = syncRemoteShareProviderSelection(next, body.name);
  try { writeConfig(next); }
  catch (err) { return sendError(res, 500, `writeConfig failed: ${err.message}`); }

  return sendOk(res, { provider: showProvider(next, body.name) });
}

// ---------- /providers/:name (PUT update) ----------

function handleProviderUpdate(ctx, res, name, body) {
  let config;
  try { config = ctx.configProvider(); }
  catch (err) { return sendError(res, 500, `readConfig failed: ${err.message}`); }

  let next;
  try { next = applyProviderUpdate(config, name, body); }
  catch (err) {
    // applyProviderUpdate throws on unknown name (404) or validation (400).
    const status = /unknown provider/.test(err.message) ? 404 : 400;
    return sendError(res, status, err.message);
  }

  // Collect the smallFastModel-on-litellm warnings before writeConfig strips
  // the side-channel field.
  const warnings = takeUpdateWarnings(next);

  next = syncRemoteShareProviderSelection(next, name);
  try { writeConfig(next); }
  catch (err) { return sendError(res, 500, `writeConfig failed: ${err.message}`); }

  return sendOk(res, {
    provider: showProvider(next, name),
    warnings,
  });
}

// ---------- /providers/:name (DELETE remove) ----------

async function handleProviderRemove(ctx, res, name) {
  let config;
  try { config = ctx.configProvider(); }
  catch (err) { return sendError(res, 500, `readConfig failed: ${err.message}`); }

  let next;
  try { next = removeProvider(config, name); }
  catch (err) { return sendError(res, 404, err.message); }

  // Stage 8.0: clear any routes.<agent>.<slot> that point at the removed
  // provider (claude.main, claude.small, codex.main, future slots), then
  // go through the route-mode proxy restart path. If the proxy is running
  // in route mode and the deleted provider was a route target, restart
  // the proxy on the new (possibly empty) routes hash.
  const prevAll = getAllRoutes(config);
  const clearedSlots = [];
  for (const agent of ROUTE_AGENTS) {
    for (const slot of ROUTE_DEFS[agent].slots) {
      if (prevAll[agent][slot]?.provider === name) {
        next = clearRoute(next, agent, slot);
        clearedSlots.push(`${agent}.${slot}`);
      }
    }
  }
  next = syncRemoteShareProviderSelection(next, name);

  const result = await saveRoutesAndMaybeRestartProxy(ctx, next, config);
  if (!result.ok) return sendError(res, 500, result.error);

  // Project each agent's routes into the response.
  const projected = {};
  for (const agent of ROUTE_AGENTS) {
    projected[agent] = projectRoutesForApi(result.routes[agent], agent);
  }
  return sendOk(res, {
    removed: name,
    clearedSlots,
    routes: projected,
    proxy: result.proxy,
  });
}

// ---------- /routes (Stage 7.5) ----------

// Read the current proxy status snapshot. The local API holds `getProxyStatus`
// as an injected function (the daemon wires it to proxyManager.status()).
// We always project the same shape so the UI doesn't have to special-case
// states. We do NOT call restart here — restart is conditional and lives in
// handleRoutesUpdate.
async function snapshotProxyForApi(ctx) {
  let status;
  try {
    status = await ctx.getProxyStatus();
  } catch (err) {
    status = { state: "stopped", port: null, mode: null, routesHash: null, aliases: null };
  }
  return {
    state: status.state || "stopped",
    port: status.port || null,
    mode: status.mode || null,
    currentRouteHash: status.routesHash || null,
    aliases: status.aliases || null,
    logPath: status.logPath || null,
    needsRestart: false,
  };
}

function projectRoutesForApi(routes, agent = "claude") {
  // Project every slot defined for the agent, with missing slots becoming
  // null. Older agents (Claude) return { main, small }; Codex returns
  // just { main } because that's all ROUTE_DEFS.codex.slots contains.
  const def = ROUTE_DEFS[agent];
  const slots = def ? def.slots : ["main", "small"];
  const out = {};
  for (const slot of slots) out[slot] = (routes && routes[slot]) || null;
  return out;
}

function handleRoutesList(ctx, res) {
  const config = ctx.configProvider();
  // Stage 8.0: walk all configured agents. Per-agent nested aliases are
  // the new canonical shape; the flat `aliases.main` / `aliases.small`
  // fields are KEPT for backward compat with the local-console.html
  // normalizeRoutesPayload() which reads those flat keys.
  const out = { routes: {}, aliases: {} };
  for (const agent of ROUTE_AGENTS) {
    out.routes[agent] = projectRoutesForApi(getAgentRoutes(config, agent), agent);
    out.aliases[agent] = { ...ROUTE_DEFS[agent].aliases };
  }
  out.aliases = {
    ...out.aliases.claude, // flat: main, small
    ...out.aliases,
  };
  return sendOk(res, out);
}

function handleRoutesShow(ctx, res, agent) {
  const config = ctx.configProvider();
  const agentRoutes = getAgentRoutes(config, agent);
  return sendOk(res, {
    agent,
    routes: projectRoutesForApi(agentRoutes, agent),
    routesHash: hashRoutes(getAllRoutes(config)),
  });
}

// Shared save-and-maybe-restart helper used by:
//   - POST /providers/use       (claude: writes routes from provider)
//   - PUT  /routes/claude       (full route set replacement)
//   - POST /routes/claude/main  (single slot set)
//   - POST /routes/claude/small (single slot set)
//   - DELETE /routes/claude/small
//
// All five endpoints share the same proxy-restart contract:
//   - if proxy is running in route mode AND hash changed → auto-restart
//   - if proxy is stopped / not-installed → just persist, no auto-start
//   - if restart fails → response carries needsRestart: true + logPath
async function saveRoutesAndMaybeRestartProxy(ctx, nextConfig, prevConfig) {
  try { writeConfig(nextConfig); }
  catch (err) { return { ok: false, error: `writeConfig failed: ${err.message}` }; }
  // Stage 8.0: hash the all-agent shape so a Codex-only change also
  // triggers the proxy restart. The renderer and the proxy manager
  // hash the same all-agent shape; this matches.
  const routes = getAllRoutes(nextConfig);
  const prev = getAllRoutes(prevConfig);
  const proxyInfo = await snapshotProxyForApi(ctx);
  const newHash = hashRoutes(routes);
  const prevHash = hashRoutes(prev);
  const needsRestart = proxyInfo.state === "running"
    && proxyInfo.mode === "route"
    && newHash !== prevHash;
  if (needsRestart && typeof ctx.restartProxy === "function") {
    try {
      const result = await ctx.restartProxy({ mode: "route", port: proxyInfo.port });
      if (result && result.ok) {
        proxyInfo.state = "running";
        proxyInfo.currentRouteHash = newHash;
        proxyInfo.needsRestart = false;
      } else {
        proxyInfo.needsRestart = true;
        proxyInfo.state = "stopped";
        if (result && result.error) proxyInfo.error = result.error;
      }
    } catch (err) {
      proxyInfo.needsRestart = true;
      proxyInfo.state = "stopped";
      proxyInfo.error = err.message;
    }
  }
  return { ok: true, routes, proxy: proxyInfo };
}

// PUT /routes/<agent>: replace the agent's full route set with the body.
// Body shape: { main?: { provider, model? }, small?: { provider, model? } }.
async function handleRoutesUpdate(ctx, res, agent, body) {
  if (!body || typeof body !== "object") {
    return sendError(res, 400, "body must be an object { main?, small? }");
  }

  const config = ctx.configProvider();
  let next;
  try {
    next = replaceAgentRoutes(config, agent, body);
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  const result = await saveRoutesAndMaybeRestartProxy(ctx, next, config);
  if (!result.ok) return sendError(res, 500, result.error);
  return sendOk(res, {
    routes: { [agent]: projectRoutesForApi(result.routes[agent], agent) },
    proxy: result.proxy,
  });
}

async function handleRouteSlot(ctx, res, agent, slot, body) {
  if (!body || typeof body !== "object" || !body.provider) {
    return sendError(res, 400, "body.provider is required");
  }
  const config = ctx.configProvider();
  let next;
  try {
    next = setRoute(config, agent, slot, { provider: body.provider, model: body.model });
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const result = await saveRoutesAndMaybeRestartProxy(ctx, next, config);
  if (!result.ok) return sendError(res, 500, result.error);
  return sendOk(res, {
    routes: { [agent]: projectRoutesForApi(result.routes[agent], agent) },
    proxy: result.proxy,
  });
}

async function handleRouteClear(ctx, res, agent, slot) {
  const config = ctx.configProvider();
  let next;
  try {
    next = clearRoute(config, agent, slot);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const result = await saveRoutesAndMaybeRestartProxy(ctx, next, config);
  if (!result.ok) return sendError(res, 500, result.error);
  return sendOk(res, {
    routes: { [agent]: projectRoutesForApi(result.routes[agent], agent) },
    proxy: result.proxy,
  });
}

// ---------- Projection ----------

// JSON-safe view of an internal session. Strips adapter/executor instances,
// scanTimer handles, and other non-serializable fields.
export function projectSession(session) {
  return {
    sessionId: session.id || session.sessionId,
    agent: session.agent,
    command: session.command,
    args: session.args,
    status: session.status,
    cwd: session.cwd,
    pid: session.pid,
    executor: session.executorKind,
    startedAt: session.startedAt || session.createdAt,
  };
}
