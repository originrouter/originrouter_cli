import { normalizeProviderModels, hasRemoteEnabledModels, remoteShareModelEntries } from "../config/providerModels.js";
import { DEFAULT_REMOTE_SHARE_PROXY_PORT } from "../constants.js";
import { readConfig, writeConfig } from "../persistence/state.js";
import { sendError, sendOk } from "./localApiHttp.js";

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

export function remoteShareProviders(config, providerNames) {
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

export async function handleRemoteShareStatus(ctx, res) {
  return sendOk(res, await handleRemoteShareStatusPayload(ctx));
}

export async function handleRemoteShareControl(ctx, res, action, body) {
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
