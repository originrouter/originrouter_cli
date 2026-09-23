import { closeSync, openSync, readSync, statSync } from "node:fs";

import { remoteShareModelEntries } from "../config/providerModels.js";
import { remoteShareProviders } from "./localApiRemoteShare.js";
import { AGENT_DETAIL_PROFILES, agentDetailDefaultFromConfig } from "../runtime/agentDetailProfile.js";
import { cachedUpdateStatus } from "../update/checker.js";
import { detectInstallContext } from "../update/installContext.js";
import { getStateDir, readConfig, readProxyState } from "../persistence/state.js";
import { httpHost, sendError, sendOk } from "./localApiHttp.js";

const LOG_TAIL_MAX_BYTES = 1_048_576;
const LOG_TAIL_MAX_LINES = 2000;
const LOG_TAIL_DEFAULT_LINES = 200;

export async function handleLocalStatus(ctx) {
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

export function handleProxyLogs(ctx, res, url) {
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
  if (st.size > LOG_TAIL_MAX_BYTES) lines.shift();
  const tailLines = lines.slice(-tail);
  return sendOk(res, { path: logPath, lines: tailLines.length, content: tailLines.join("\n") });
}

export function handleProxyRequests(ctx, res, url) {
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
