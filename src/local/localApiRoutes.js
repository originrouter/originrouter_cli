import {
  ROUTE_AGENTS,
  ROUTE_DEFS,
  clearRoute,
  getAgentRoutes,
  getAllRoutes,
  hashRoutes,
  replaceAgentRoutes,
  setRoute,
} from "../config/routes.js";
import { readConfig, writeConfig } from "../persistence/state.js";
import { sendError, sendOk } from "./localApiHttp.js";
import { projectRoutesForApi } from "./localApiProjections.js";

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

export function handleRoutesList(ctx, res) {
  const config = ctx.configProvider();
  // Stage 8.0: walk all configured agents. Aliases use the canonical
  // per-agent nested shape.
  const out = { routes: {}, aliases: {} };
  for (const agent of ROUTE_AGENTS) {
    out.routes[agent] = projectRoutesForApi(getAgentRoutes(config, agent), agent);
    out.aliases[agent] = { ...ROUTE_DEFS[agent].aliases };
  }
  return sendOk(res, out);
}

export function handleRoutesShow(ctx, res, agent) {
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
export async function saveRoutesAndMaybeRestartProxy(ctx, nextConfig, prevConfig) {
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
export async function handleRoutesUpdate(ctx, res, agent, body) {
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

export async function handleRouteSlot(ctx, res, agent, slot, body) {
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

export async function handleRouteClear(ctx, res, agent, slot) {
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
