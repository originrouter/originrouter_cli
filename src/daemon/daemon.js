import process from "node:process";
import { reportLocalControlRuntime } from "../agent/bridgeReporter.js";
import { DEFAULT_DEVICE_ID, DEFAULT_EXECUTOR, DEFAULT_LOCAL_API_PORT, DEFAULT_RELAY_URL, DEFAULT_REMOTE_SHARE_PROXY_PORT, VERSION } from "../constants.js";
import { startLocalApi } from "../local/localApi.js";
import { ProxyManager } from "../proxy/manager.js";
import { apiTokenPath, ensureApiToken } from "../persistence/authToken.js";
import { ensureDevice, ensureStateDir, readConfig, readLocalApiConfig, writeDaemonState } from "../persistence/state.js";
import { buildRelayClientOptions } from "../relay/relayAuthBootstrap.js";
import { RelayClient } from "../relay/relayClient.js";
import { parseOptions } from "../utils/options.js";
import { SessionManager } from "./sessionManager.js";
import { agentDetailDefaultFromConfig } from "../runtime/agentDetailProfile.js";

function httpHost(address) {
  return String(address).includes(":") && !String(address).startsWith("[")
    ? `[${address}]`
    : address;
}

function parsePort(value, label) {
  if (value == null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${label} must be an integer in [0, 65535] (got '${value}')`);
  }
  return parsed;
}

function buildProxyBaseUrl(status) {
  if (!status || status.state !== "running" || !status.port) return "";
  return `http://${httpHost(status.host || "127.0.0.1")}:${status.port}`;
}

async function tryBuildRelayClientOptions({
  stateDir,
  relayUrl,
  fallbackDeviceId,
  forceAuth = false,
}) {
  try {
    return {
      ok: true,
      options: await buildRelayClientOptions({
        stateDir,
        relayUrl,
        fallbackDeviceId,
        forceAuth,
      }),
    };
  } catch (err) {
    return {
      ok: false,
      code: err?.code || "unknown",
    };
  }
}

export async function startDaemon(args) {
  const { options } = parseOptions(args);
  const stateDir = ensureStateDir();
  const localApiConfig = readLocalApiConfig();

  // Stage 6: ensure the bearer token file exists before binding the API.
  // If the file is missing, the local API would 503 every write — better
  // to mint a token up front so the daemon starts in a usable state.
  const apiToken = ensureApiToken(stateDir);
  const apiTokenFile = process.env.ORIGINROUTER_API_TOKEN_PATH || apiTokenPath(stateDir);

  const relayUrl = options.relay || process.env.ORIGINROUTER_RELAY || DEFAULT_RELAY_URL;
  const device = ensureDevice(options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID);
  const executor = DEFAULT_EXECUTOR;
  const bindAddress = options.bind || process.env.ORIGINROUTER_LOCAL_BIND || localApiConfig.bindAddress || "127.0.0.1";
  const allowLanControl = Boolean(
    options.allowLan
      || process.env.ORIGINROUTER_ALLOW_LAN === "1"
      || localApiConfig.allowLan === true,
  );

  // The daemon is a local-first service. It must be able to boot and expose
  // the Local API before the user logs in. Relay auth is acquired in the
  // background loop below; when `originrouter login` writes fresh credentials,
  // the next loop iteration picks them up and connects the remote bridge.
  let effectiveDeviceId = device.deviceId;
  let relayAuthState = "pending";
  let relayAuthError = null;
  const relayClient = new RelayClient({
    relayUrl,
    deviceId: effectiveDeviceId,
    authToken: null,
  });

  // Stage 4: ProxyManager owns the LiteLLM proxy lifecycle. The session
  // manager passes proxy status into buildAgentProviderEnv; the local API
  // exposes start/stop/restart endpoints that call the manager directly.
  const proxyManager = new ProxyManager({
    stateDir,
  });
  const remoteShareProxyManager = new ProxyManager({
    stateDir,
    stateKey: "remote-share-proxy",
  });
  const sessionManager = new SessionManager({
    relayClient,
    deviceId: effectiveDeviceId,
    defaultExecutor: executor,
    proxyManager,
    remoteShareProxyManager,
  });

  // Stage 3 + Stage 4 + Stage 6: start the local 127.0.0.1-only HTTP API.
  // Stage 6: pass `apiTokenPath` so dispatch can validate the bearer header
  // on every write.
  const startedAt = new Date().toISOString();
  let relayConnected = false;
  const localApiCtx = {
    sessionManager,
    configProvider: () => readConfig(),
    startedAt,
    pid: process.pid,
    version: VERSION,
    relayUrl,
    deviceId: () => effectiveDeviceId,
    relayConnected: () => relayConnected,
    relayAuthState: () => relayAuthState,
    relayAuthError: () => relayAuthError,
    bindAddress,
    allowLanControl,
    getProxyStatus: () => proxyManager.status(),
    startProxy: ({ provider, providerName, mode, port }) => proxyManager.start({ providerName: providerName || provider, mode, port }),
    stopProxy: () => proxyManager.stop(),
    restartProxy: ({ provider, providerName, mode, port }) => proxyManager.restart({ providerName: providerName || provider, mode, port }),
    getRemoteShareProxyStatus: () => remoteShareProxyManager.status(),
    startRemoteShareProxy: ({ providerNames, port }) => remoteShareProxyManager.start({
      providerNames,
      mode: "share",
      port,
    }),
    stopRemoteShareProxy: () => remoteShareProxyManager.stop(),
    restartRemoteShareProxy: ({ providerNames, port }) => remoteShareProxyManager.restart({
      providerNames,
      mode: "share",
      port,
    }),
  };
  const configuredLocalPort = parsePort(process.env.ORIGINROUTER_LOCAL_PORT, "ORIGINROUTER_LOCAL_PORT")
    ?? parsePort(localApiConfig.port, "local-api.json port");
  const requestedLocalPort = options.localPort ?? configuredLocalPort ?? DEFAULT_LOCAL_API_PORT;
  let localApi;
  try {
    localApi = await startLocalApi(localApiCtx, {
      port: requestedLocalPort,
      apiTokenPath: apiTokenFile,
      allowLan: allowLanControl,
    });
  } catch (err) {
    if (options.localPort == null && configuredLocalPort == null && requestedLocalPort === DEFAULT_LOCAL_API_PORT && err?.code === "EADDRINUSE") {
      console.warn(`[daemon] local API port ${DEFAULT_LOCAL_API_PORT} is busy; retrying with an OS-assigned port`);
      localApi = await startLocalApi(localApiCtx, {
        port: 0,
        apiTokenPath: apiTokenFile,
        allowLan: allowLanControl,
      });
    } else {
      throw err;
    }
  }
  // Patch the bound port onto the live ctx so /local/status reports it.
  localApiCtx.localApiPort = localApi.port;
  // We don't actually need the token here — startLocalApi reads the file —
  // but capturing it for the URL print below is convenient.
  void apiToken;

  // Stage 6: graceful shutdown on SIGTERM/SIGINT. Stops the proxy, closes
  // the local API, then exits. The proxy process is spawned `detached`, so
  // it survives daemon exit unless we explicitly stop it. We do — leaving
  // a running proxy after `kill originrouter-daemon` is surprising.
  let shuttingDown = false;
  let heartbeatTimer = null;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] received ${signal}, shutting down…`);
    try { await sessionManager.shutdown(signal); } catch (e) { console.error(`[daemon] session stop: ${e.message}`); }
    try { await proxyManager.stop(); } catch (e) { console.error(`[daemon] proxy stop: ${e.message}`); }
    try { await remoteShareProxyManager.stop(); } catch (e) { console.error(`[daemon] remote share proxy stop: ${e.message}`); }
    try { await localApi.close(); } catch (e) { console.error(`[daemon] local api close: ${e.message}`); }
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  const localApiState = () => ({
    localApiPort: localApi.port,
    localApiBindAddress: localApi.bindAddress,
    localApiBaseUrl: `http://${httpHost(localApi.bindAddress)}:${localApi.port}`,
    localApiTokenPath: apiTokenFile,
    localApiAuthMode: "bearer",
    localApiLanEnabled: !["127.0.0.1", "::1", "localhost"].includes(localApi.bindAddress),
    localApiDefaultPort: DEFAULT_LOCAL_API_PORT,
  });

  const reportLocalControlHeartbeat = async () => {
    const proxyStatus = await proxyManager.status().catch(() => null);
    const remoteShareStatus = await remoteShareProxyManager.status().catch(() => null);
    const config = readConfig();
    const remoteShareProviderNames = remoteShareStatus?.currentProviders?.length
      ? remoteShareStatus.currentProviders
      : config.remoteShare?.providers || [];
    const remoteShareCatalog = remoteShareProviderNames
      .map((name) => config.providers?.[name])
      .filter((provider) => provider?.type === "proxy" && provider?.engine === "litellm")
      .map((provider) => ({ provider: provider.name, model: provider.model || "" }));
    return reportLocalControlRuntime({
      cliRunning: true,
      cliVersion: VERSION,
      cliUptimeSeconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
      proxyRunning: Boolean(proxyStatus && proxyStatus.state === "running"),
      proxyBaseUrl: buildProxyBaseUrl(proxyStatus),
      remoteShareRunning: Boolean(remoteShareStatus && remoteShareStatus.state === "running"),
      remoteShareBaseUrl: buildProxyBaseUrl(remoteShareStatus),
      remoteShareCatalog,
      agentDetailProfile: agentDetailDefaultFromConfig(config),
    }, { stateDir }).catch(() => ({ ok: false, error: "request_failed" }));
  };
  heartbeatTimer = setInterval(() => {
    if (!relayConnected) return;
    reportLocalControlHeartbeat().catch(() => {});
  }, 20_000);
  heartbeatTimer.unref?.();

  writeDaemonState({
    pid: process.pid,
    relayUrl,
    deviceId: effectiveDeviceId,
    executor,
    ...localApiState(),
    version: VERSION,
    status: "starting",
  });

  console.log("[daemon] starting");
  console.log(`[daemon] relay: ${relayUrl}`);
  console.log(`[daemon] device: ${effectiveDeviceId}`);
  console.log(`[daemon] executor: ${executor}`);
  console.log(`[daemon] local API: http://${httpHost(localApi.bindAddress)}:${localApi.port}`);
  console.log(`[daemon] local API auth: bearer token (${apiTokenFile})`);
  if (localApiState().localApiLanEnabled) {
    console.warn("[daemon] LAN control is enabled. Keep the bearer token private and avoid exposing this port to the public internet.");
  }
  console.log(`[daemon] proxy manager: ${await proxyManager.status().then((s) => `${s.state}${s.port ? ` (port ${s.port})` : ""}`)}`);
  console.log(`[daemon] remote share proxy: ${await remoteShareProxyManager.status().then((s) => `${s.state}${s.port ? ` (port ${s.port})` : ""}`)}`);

  const configuredRemoteShare = readConfig().remoteShare;
  if (configuredRemoteShare?.enabled && configuredRemoteShare.providers?.length) {
    remoteShareProxyManager.start({
      mode: "share",
      providerNames: configuredRemoteShare.providers,
      port: configuredRemoteShare.port || DEFAULT_REMOTE_SHARE_PROXY_PORT,
    }).then((result) => {
      if (!result.ok) console.error(`[daemon] remote share restore failed: ${result.error}`);
    }).catch((error) => {
      console.error(`[daemon] remote share restore failed: ${error.message}`);
    });
  }

  for (;;) {
    try {
      const relayOptionsResult = await tryBuildRelayClientOptions({
        stateDir,
        relayUrl,
        fallbackDeviceId: device.deviceId,
        forceAuth: true,
      });
      if (!relayOptionsResult.ok) {
        relayConnected = false;
        relayAuthState = "unavailable";
        relayAuthError = relayOptionsResult.code;
        writeDaemonState({
          pid: process.pid, relayUrl, deviceId: effectiveDeviceId, executor,
          ...localApiState(), version: VERSION,
          status: "local-only", relayAuthError,
        });
        console.error(`[daemon] relay auth unavailable: code=${relayAuthError}`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      const relayOptions = relayOptionsResult.options;
      relayAuthState = relayOptions.authState || "on";
      relayAuthError = null;
      relayClient.deviceId = relayOptions.deviceId;
      relayClient.setAuthToken(relayOptions.authToken);
      effectiveDeviceId = relayOptions.deviceId;
      localApiCtx.deviceId = effectiveDeviceId;
      sessionManager.deviceId = effectiveDeviceId;

      await relayClient.connectEvents(
        (payload) => sessionManager.handleEvent(payload),
        {
          onOpen: () => {
            relayConnected = true;
            writeDaemonState({
              pid: process.pid, relayUrl, deviceId: effectiveDeviceId, executor,
              ...localApiState(), version: VERSION, status: "connected",
            });
            reportLocalControlHeartbeat().catch(() => {});
          },
          onClose: () => {
            relayConnected = false;
          },
        },
      );
      writeDaemonState({
        pid: process.pid, relayUrl, deviceId: effectiveDeviceId, executor,
        ...localApiState(), version: VERSION, status: "reconnecting",
      });
    } catch (error) {
      relayConnected = false;
      console.error(`[daemon] ${error.message}`);
      // Stage 9.5 — re-acquire a fresh token before reconnecting. BOTH
      // relayClient.deviceId and relayClient.authToken must be updated;
      // updating only the token would leave a stale deviceId and the
      // relay would return 403 device_mismatch.
      try {
        const relayOptions = await buildRelayClientOptions({
          stateDir,
          relayUrl,
          fallbackDeviceId: device.deviceId,
          forceAuth: true,
        });
        relayClient.deviceId = relayOptions.deviceId;
        relayClient.setAuthToken(relayOptions.authToken);
        effectiveDeviceId = relayOptions.deviceId;
        localApiCtx.deviceId = effectiveDeviceId;
        sessionManager.deviceId = effectiveDeviceId;
        relayAuthState = relayOptions.authState || "on";
        relayAuthError = null;
      } catch (reErr) {
        relayAuthState = "unavailable";
        relayAuthError = reErr?.code || "unknown";
        console.error(`[daemon] relay auth re-acquire failed: code=${reErr?.code || "unknown"}`);
      }
      writeDaemonState({
        pid: process.pid, relayUrl, deviceId: effectiveDeviceId, executor,
        ...localApiState(), version: VERSION,
        status: "reconnecting", error: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
