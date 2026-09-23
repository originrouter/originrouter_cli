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
  setRoute,
} from "../config/routes.js";
import {
  enabledProviderModelEntries,
  hasRemoteEnabledModels,
  normalizeProviderModels,
  remoteShareModelEntries,
} from "../config/providerModels.js";
import { readConfig, writeConfig } from "../persistence/state.js";
import { sendError, sendOk } from "./localApiHttp.js";
import { projectRoutesForApi, projectSession } from "./localApiProjections.js";
import { saveRoutesAndMaybeRestartProxy } from "./localApiRoutes.js";

export function handleProvidersList(ctx) {
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

export function handleProviderShow(ctx, name) {
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

export function handleSessionsList(ctx) {
  if (!ctx.sessionManager || !ctx.sessionManager.sessions) return [];
  return Array.from(ctx.sessionManager.sessions.values()).map(projectSession);
}


export function syncRemoteShareProviderSelection(config, providerName) {
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


export async function handleProviderModelDiscovery(ctx, res, body) {
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

export async function handleProviderModelProbe(ctx, res, body) {
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

export async function handleProvidersUse(ctx, res, body) {
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

export function handleProviderAdd(ctx, res, body) {
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

export function handleProviderUpdate(ctx, res, name, body) {
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

export async function handleProviderRemove(ctx, res, name) {
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
