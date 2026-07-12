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
  setRoute,
} from "../config/routes.js";
import { LITELLM_PROVIDERS } from "../proxy/litellmCatalog.js";
import { readApiToken } from "../persistence/authToken.js";
import { getStateDir, readConfig, readProxyState, writeConfig } from "../persistence/state.js";
import { DEFAULT_RELAY_URL } from "../constants.js";

// Exported so CLI subcommands (e.g. `local api set-host`) can apply
// the same gating as the runtime auth layer. Keep the set in lock-
// step with the bind-address check in `startLocalApi` above.
export const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || "").toLowerCase());
}

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
  const liveCtx = {
    bindAddress,
    isLoopback,
    allowLanControl: lanAllowed,
    configProvider: ctx.configProvider || (() => readConfig()),
    getProxyStatus: ctx.getProxyStatus || placeholderProxyStatus,
    startProxy: ctx.startProxy,
    stopProxy: ctx.stopProxy,
    restartProxy: ctx.restartProxy,
    sessionManager: ctx.sessionManager,
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
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
// Public methods (GET, HEAD, OPTIONS) always pass. The `/proxy/logs` path is
// an exception: it requires auth even on GET because the log file may contain
// user PII / API keys.
const AUTH_REQUIRED_GET_PATHS = new Set([
  "/proxy/logs",
]);

function requireAuth(req, ctx) {
  if (DEV_INSECURE) return { ok: true };
  const url = req.url || "/";
  const path = url.split("?")[0];
  const isAuthRequiredGetPath = AUTH_REQUIRED_GET_PATHS.has(path)
    || path === "/routes"
    || path.startsWith("/routes/");
  const needsAuth = !(req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS")
    || isAuthRequiredGetPath;
  if (!needsAuth) return { ok: true };
  if (isLoopbackAddress(req.socket?.remoteAddress)) return { ok: true };
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
    if (req.method === "GET" && pathname === "/proxy/logs") {
      return handleProxyLogs(ctx, res, url);
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
    if (req.method === "GET" && pathname === "/sessions") {
      return sendOk(res, { sessions: handleSessionsList(ctx) });
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
    // Stage 5: real probe (was a hardcoded "not-installed" stub in Stage 3+4).
    proxy: await ctx.getProxyStatus(),
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
    next = setRoute(config, "codex", "main", { provider: name, model: target.model });
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
  let next = config;
  try {
    if ("main" in body) {
      if (body.main === null) {
        next = clearRoute(next, agent, "main");
      } else {
        next = setRoute(next, agent, "main", body.main);
      }
    }
    if ("small" in body) {
      if (body.small === null) {
        next = clearRoute(next, agent, "small");
      } else {
        next = setRoute(next, agent, "small", body.small);
      }
    }
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
