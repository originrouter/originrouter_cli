import process from "node:process";
import { reportLocalControlRuntime } from "../agent/bridgeReporter.js";
import { syncAgentActivityCatalog } from "../agent/agentActivityCatalogSync.js";
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_EXECUTOR,
  DEFAULT_LOCAL_API_PORT,
  DEFAULT_RELAY_URL,
  DEFAULT_REMOTE_SHARE_PROXY_PORT,
  VERSION,
} from "../constants.js";
import { startLocalApi } from "../local/localApi.js";
import { DeviceE2eeLocalGateway } from "../local/deviceE2eeLocalGateway.js";
import { ProxyManager } from "../proxy/manager.js";
import { apiTokenPath, ensureApiToken } from "../persistence/authToken.js";
import {
  ensureDevice,
  ensureStateDir,
  readConfig,
  readLocalApiConfig,
  writeDaemonState,
} from "../persistence/state.js";
import {
  buildAgentRelayPlan,
  normalizeAgentRelayMode,
  relayModeDescription,
} from "../relay/agentRelayPolicy.js";
import { RelayClient } from "../relay/relayClient.js";
import { parseOptions } from "../utils/options.js";
import { SessionManager } from "./sessionManager.js";
import { agentDetailDefaultFromConfig } from "../runtime/agentDetailProfile.js";
import { getAllRoutes } from "../config/routes.js";
import { normalizeProviderForRead } from "../config/providers.js";
import { remoteShareModelEntries } from "../config/providerModels.js";
import { LocalAuditStore } from "../persistence/localAuditStore.js";
import { AgentCatalog } from "../persistence/agentCatalog.js";
import { readSessions } from "../persistence/sessionLog.js";
import { ExternalAgentRegistry } from "../local/externalAgentRegistry.js";
import { ManagedAgentSupervisor } from "./managedAgentSupervisor.js";
import { CollaborationStore } from "../collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../collaboration/planImplementVerifyCoordinator.js";
import { CollaborationRuntime } from "../collaboration/collaborationRuntime.js";
import { ExternalAgentRelayRouter } from "./externalAgentRelayRouter.js";
import { ensureRemoteCodingIdentity } from "../crypto/remoteCodingE2ee.js";
import {
  ensureDeviceE2eeIdentity,
  readDeviceE2eeIdentity,
  resetDeviceE2eeIdentityForEpoch,
} from "../crypto/deviceE2eeIdentity.js";
import {
  getCliDeviceE2eeDirectory,
  getCliDeviceE2eeStatus,
  registerCliDeviceE2eeIdentity,
} from "../security/deviceE2eeClient.js";
import { storeDeviceE2eeDirectoryCache } from "../security/deviceE2eeDirectoryCache.js";
import { DeviceE2eeRelayTransport } from "../security/deviceE2eeRelayTransport.js";
import { ensureFreshAccessToken } from "../runtime/oauthTokenRefresher.js";

function httpHost(address) {
  return String(address).includes(":") && !String(address).startsWith("[")
    ? `[${address}]`
    : address;
}

function parsePort(value, label) {
  if (value == null || value === "") return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `${label} must be an integer in [0, 65535] (got '${value}')`,
    );
  }
  return parsed;
}

function buildProxyBaseUrl(status) {
  if (!status || status.state !== "running" || !status.port) return "";
  return `http://${httpHost(status.host || "127.0.0.1")}:${status.port}`;
}

function localControlProviderSnapshot(config) {
  return Object.entries(config?.providers || {}).map(([key, provider]) => {
    const normalized = normalizeProviderForRead(provider, {
      legacyRemoteEnabled: (config.remoteShare?.providers || []).includes(key),
    }) || {};
    return {
      name: normalized.name || key,
      type: normalized.type || "proxy",
      litellmProvider: normalized.litellmProvider || "",
      model: normalized.type === "proxy" ? "" : (normalized.model || ""),
      models: normalized.models || [],
      target: normalized.target || "",
      deviceId: normalized.deviceId || "",
    };
  });
}

function localControlRouteSnapshot(config) {
  const routes = getAllRoutes(config);
  const result = [];
  for (const [agent, slots] of Object.entries(routes)) {
    for (const [slot, route] of Object.entries(slots || {})) {
      if (!route?.provider) continue;
      result.push({
        agent,
        slot,
        provider: route.provider,
        model: route.model || "",
      });
    }
  }
  return result;
}

async function tryBuildRelayClientOptions({
  stateDir,
  relayUrl,
  fallbackDeviceId,
  mode,
}) {
  try {
    const plan = await buildAgentRelayPlan({
      stateDir,
      relayUrl,
      fallbackDeviceId,
      mode,
    });
    if (!plan.enabled) {
      return { ok: false, code: plan.reason, plan };
    }
    return {
      ok: true,
      options: plan,
      plan,
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
  const apiTokenFile =
    process.env.ORIGINROUTER_API_TOKEN_PATH || apiTokenPath(stateDir);

  const relayUrl =
    options.relay ||
    process.env.ORIGINROUTER_RELAY ||
    localApiConfig.relayUrl ||
    DEFAULT_RELAY_URL;
  const relayMode = normalizeAgentRelayMode(
    options.relayMode || localApiConfig.relayMode,
    relayUrl,
  );
  const device = ensureDevice(
    options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID,
  );
  const executor = DEFAULT_EXECUTOR;
  const bindAddress =
    options.bind ||
    process.env.ORIGINROUTER_LOCAL_BIND ||
    localApiConfig.bindAddress ||
    "127.0.0.1";
  const allowLanControl = Boolean(
    options.allowLan ||
    process.env.ORIGINROUTER_ALLOW_LAN === "1" ||
    localApiConfig.allowLan === true,
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
  let deviceE2eeEpoch = readDeviceE2eeIdentity(stateDir)?.public_identity?.epoch || 1;
  try {
    const credential = await ensureFreshAccessToken({ stateDir });
    const accessToken = credential?.accessTokens?.control?.token;
    if (accessToken) {
      const status = await getCliDeviceE2eeStatus({
        controlBaseUrl: relayUrl,
        accessToken,
      });
      deviceE2eeEpoch = Number(status?.policy?.epoch || deviceE2eeEpoch);
    }
  } catch {}
  const storedDeviceE2eeIdentity = readDeviceE2eeIdentity(stateDir);
  let deviceE2eeIdentity;
  if (!storedDeviceE2eeIdentity) {
    deviceE2eeIdentity = ensureDeviceE2eeIdentity(stateDir, {
      deviceId: effectiveDeviceId,
      epoch: deviceE2eeEpoch,
    });
  } else if (
    storedDeviceE2eeIdentity.public_identity.device_id !== effectiveDeviceId
    || storedDeviceE2eeIdentity.public_identity.epoch !== deviceE2eeEpoch
  ) {
    deviceE2eeIdentity = resetDeviceE2eeIdentityForEpoch(stateDir, {
      deviceId: effectiveDeviceId,
      epoch: deviceE2eeEpoch,
    });
  } else {
    deviceE2eeIdentity = storedDeviceE2eeIdentity;
  }
  const deviceE2eeRelay = new DeviceE2eeRelayTransport({
    relayClient,
    localIdentity: deviceE2eeIdentity,
    localIdentityProvider: () => readDeviceE2eeIdentity(stateDir),
    stateDir,
    controlBaseUrl: relayUrl,
    credentialProvider: () => ensureFreshAccessToken({ stateDir }),
  });
  const deviceE2eeLocalGateway = new DeviceE2eeLocalGateway({
    stateDir,
    localIdentity: deviceE2eeIdentity,
    localIdentityProvider: () => readDeviceE2eeIdentity(stateDir),
    apiTokenPath: apiTokenFile,
  });
  const auditStore = new LocalAuditStore({ stateDir });
  const collaborationStore = new CollaborationStore({ stateDir });
  const collaborationCoordinator = new PlanImplementVerifyCoordinator({
    store: collaborationStore,
  });
  const agentCatalog = new AgentCatalog({ stateDir });
  agentCatalog.migrateLegacySessions(readSessions());
  let agentActivitySyncInFlight = null;
  let lastAgentActivitySyncError = null;
  const syncAgentActivityHistory = () => {
    if (agentActivitySyncInFlight) return agentActivitySyncInFlight;
    agentActivitySyncInFlight = syncAgentActivityCatalog({
      catalog: agentCatalog,
      stateDir,
    })
      .then((result) => {
        if (result.ok) {
          if (result.synced > 0) {
            console.log(
              `[agent-activity] synced ${result.synced} display-safe conversation summaries`,
            );
          }
          lastAgentActivitySyncError = null;
        } else if (result.error !== lastAgentActivitySyncError) {
          lastAgentActivitySyncError = result.error;
          console.error(`[agent-activity] sync deferred: ${result.error}`);
        }
        return result;
      })
      .catch((error) => {
        const code = error?.code || error?.message || "unknown";
        if (code !== lastAgentActivitySyncError) {
          lastAgentActivitySyncError = code;
          console.error(`[agent-activity] sync deferred: ${code}`);
        }
        return { ok: false, error: code };
      })
      .finally(() => {
        agentActivitySyncInFlight = null;
      });
    return agentActivitySyncInFlight;
  };
  const externalAgentRegistry = new ExternalAgentRegistry({
    catalog: agentCatalog,
  });
  const externalAgentRelayRouter = new ExternalAgentRelayRouter({
    registry: externalAgentRegistry,
    relayClient: deviceE2eeRelay,
  });
  const managedAgentSupervisor = new ManagedAgentSupervisor({
    catalog: agentCatalog,
    deviceId: effectiveDeviceId,
    relayUrl,
  });
  const collaborationRuntime = new CollaborationRuntime({
    store: collaborationStore,
    coordinator: collaborationCoordinator,
    supervisor: managedAgentSupervisor,
    registry: externalAgentRegistry,
    catalog: agentCatalog,
    relayClient,
    deviceId: effectiveDeviceId,
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
  const remoteCodingIdentity = ensureRemoteCodingIdentity(stateDir);
  const sessionManager = new SessionManager({
    relayClient: deviceE2eeRelay,
    deviceId: effectiveDeviceId,
    defaultExecutor: executor,
    proxyManager,
    remoteShareProxyManager,
    remoteCodingIdentity,
    auditStore,
    agentCatalog,
    managedAgentSupervisor,
  });

  // Stage 3 + Stage 4 + Stage 6: start the local 127.0.0.1-only HTTP API.
  // Stage 6: pass `apiTokenPath` so dispatch can validate the bearer header
  // on every write.
  const startedAt = new Date().toISOString();
  let relayConnected = false;
  externalAgentRegistry.subscribe((notification) => {
    if (!relayConnected) return;
    void externalAgentRelayRouter
      .forwardRegistryNotification(notification)
      .catch((error) => {
        console.error(`[external-agent-relay] ${error.message}`);
      });
  });
  const localApiCtx = {
    sessionManager,
    auditStore,
    collaborationStore,
    collaborationCoordinator,
    collaborationRuntime,
    agentCatalog,
    managedAgentSupervisor,
    externalAgentRegistry,
    deviceE2eeLocalGateway,
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
    startProxy: ({ provider, providerName, mode, port }) =>
      proxyManager.start({
        providerName: providerName || provider,
        mode,
        port,
      }),
    stopProxy: () => proxyManager.stop(),
    restartProxy: ({ provider, providerName, mode, port }) =>
      proxyManager.restart({
        providerName: providerName || provider,
        mode,
        port,
      }),
    getRemoteShareProxyStatus: () => remoteShareProxyManager.status(),
    startRemoteShareProxy: ({ providerNames, port }) =>
      remoteShareProxyManager.start({
        providerNames,
        mode: "share",
        port,
      }),
    stopRemoteShareProxy: () => remoteShareProxyManager.stop(),
    restartRemoteShareProxy: ({ providerNames, port }) =>
      remoteShareProxyManager.restart({
        providerNames,
        mode: "share",
        port,
      }),
  };
  const configuredLocalPort =
    parsePort(process.env.ORIGINROUTER_LOCAL_PORT, "ORIGINROUTER_LOCAL_PORT") ??
    parsePort(localApiConfig.port, "local-api.json port");
  const requestedLocalPort =
    options.localPort ?? configuredLocalPort ?? DEFAULT_LOCAL_API_PORT;
  let localApi;
  try {
    localApi = await startLocalApi(localApiCtx, {
      port: requestedLocalPort,
      apiTokenPath: apiTokenFile,
      allowLan: allowLanControl,
    });
  } catch (err) {
    if (
      options.localPort == null &&
      configuredLocalPort == null &&
      requestedLocalPort === DEFAULT_LOCAL_API_PORT &&
      err?.code === "EADDRINUSE"
    ) {
      console.warn(
        `[daemon] local API port ${DEFAULT_LOCAL_API_PORT} is busy; retrying with an OS-assigned port`,
      );
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
  void collaborationRuntime.recover().catch((error) => {
    console.error(`[daemon] collaboration recovery: ${error.message}`);
  });
  // We don't actually need the token here — startLocalApi reads the file —
  // but capturing it for the URL print below is convenient.
  void apiToken;

  // Stage 6: graceful shutdown on SIGTERM/SIGINT. Stops the proxy, closes
  // the local API, then exits. The proxy process is spawned `detached`, so
  // it survives daemon exit unless we explicitly stop it. We do — leaving
  // a running proxy after `kill originrouter-daemon` is surprising.
  let shuttingDown = false;
  let heartbeatTimer = null;
  let agentActivitySyncTimer = null;
  let deviceE2eeRefreshTimer = null;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] received ${signal}, shutting down…`);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (agentActivitySyncTimer) clearInterval(agentActivitySyncTimer);
    if (deviceE2eeRefreshTimer) clearInterval(deviceE2eeRefreshTimer);
    try {
      await sessionManager.shutdown(signal);
    } catch (e) {
      console.error(`[daemon] session stop: ${e.message}`);
    }
    try {
      await proxyManager.stop();
    } catch (e) {
      console.error(`[daemon] proxy stop: ${e.message}`);
    }
    try {
      await remoteShareProxyManager.stop();
    } catch (e) {
      console.error(`[daemon] remote share proxy stop: ${e.message}`);
    }
    try {
      await localApi.close();
    } catch (e) {
      console.error(`[daemon] local api close: ${e.message}`);
    }
    try {
      collaborationRuntime.close();
    } catch (e) {
      console.error(`[daemon] collaboration runtime close: ${e.message}`);
    }
    try {
      collaborationStore.close();
    } catch (e) {
      console.error(`[daemon] collaboration store close: ${e.message}`);
    }
    try {
      agentCatalog.close();
    } catch (e) {
      console.error(`[daemon] agent catalog close: ${e.message}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  const localApiState = () => ({
    relayMode,
    localApiPort: localApi.port,
    localApiBindAddress: localApi.bindAddress,
    localApiBaseUrl: `http://${httpHost(localApi.bindAddress)}:${localApi.port}`,
    localApiTokenPath: apiTokenFile,
    localApiAuthMode: "bearer",
    localApiLanEnabled: !["127.0.0.1", "::1", "localhost"].includes(
      localApi.bindAddress,
    ),
    localApiDefaultPort: DEFAULT_LOCAL_API_PORT,
  });

  const reportLocalControlHeartbeat = async () => {
    const proxyStatus = await proxyManager.status().catch(() => null);
    const remoteShareStatus = await remoteShareProxyManager
      .status()
      .catch(() => null);
    const config = readConfig();
    const remoteShareProviderNames = remoteShareStatus?.currentProviders?.length
      ? remoteShareStatus.currentProviders
      : config.remoteShare?.providers || [];
    const remoteShareCatalog = remoteShareProviderNames
      .map((name) => config.providers?.[name])
      .filter(
        (provider) =>
          provider?.type === "proxy" && provider?.engine === "litellm",
      )
      .flatMap((provider) => remoteShareModelEntries(provider, {
        legacyRemoteEnabled: true,
      }));
    return reportLocalControlRuntime(
      {
        cliRunning: true,
        cliVersion: VERSION,
        cliUptimeSeconds: Math.floor(
          (Date.now() - Date.parse(startedAt)) / 1000,
        ),
        proxyRunning: Boolean(proxyStatus && proxyStatus.state === "running"),
        proxyBaseUrl: buildProxyBaseUrl(proxyStatus),
        remoteShareRunning: Boolean(
          remoteShareStatus && remoteShareStatus.state === "running",
        ),
        remoteShareBaseUrl: buildProxyBaseUrl(remoteShareStatus),
        remoteShareCatalog,
        remoteShareE2eePolicy: "required",
        remoteShareE2eePublicKey: remoteCodingIdentity.publicKey,
        agentDetailProfile: agentDetailDefaultFromConfig(config),
        providers: localControlProviderSnapshot(config),
        routes: localControlRouteSnapshot(config),
      },
      { stateDir },
    ).catch(() => ({ ok: false, error: "request_failed" }));
  };
  let registeredDeviceE2eeKeyId = null;
  const activateDeviceE2eeIdentity = (identity, reason = "state changed") => {
    const previous = deviceE2eeIdentity?.public_identity;
    deviceE2eeIdentity = identity;
    const relayChanged = deviceE2eeRelay.setLocalIdentity(identity);
    const localChanged = deviceE2eeLocalGateway.setLocalIdentity(identity);
    if (relayChanged || localChanged) {
      registeredDeviceE2eeKeyId = null;
      console.log(
        `[device-e2ee] activated ${identity.public_identity.device_id} `
        + `${identity.public_identity.key_id} (${reason}; previous `
        + `${previous?.device_id || "none"} ${previous?.key_id || "none"})`,
      );
    }
    return identity;
  };
  const currentDeviceE2eeIdentity = ({ deviceId, epoch } = {}) => {
    const stored = readDeviceE2eeIdentity(stateDir);
    if (!stored) {
      return activateDeviceE2eeIdentity(ensureDeviceE2eeIdentity(stateDir, {
        deviceId: deviceId || effectiveDeviceId,
        epoch: epoch || 1,
      }), "identity initialized");
    }
    if (deviceId && stored.public_identity.device_id !== deviceId) {
      return activateDeviceE2eeIdentity(resetDeviceE2eeIdentityForEpoch(stateDir, {
        deviceId,
        epoch: epoch || stored.public_identity.epoch,
      }), "authenticated device changed");
    }
    if (epoch && stored.public_identity.epoch !== epoch) {
      return activateDeviceE2eeIdentity(resetDeviceE2eeIdentityForEpoch(stateDir, {
        deviceId: deviceId || stored.public_identity.device_id,
        epoch,
      }), "account epoch changed");
    }
    return activateDeviceE2eeIdentity(stored, "identity file changed");
  };
  const syncDeviceE2eeIdentity = async ({ deviceId = effectiveDeviceId } = {}) => {
    const credential = await ensureFreshAccessToken({ stateDir });
    const accessToken = credential?.accessTokens?.control?.token;
    if (!accessToken) return;
    const authenticatedDeviceId = credential.deviceId || deviceId;
    const status = await getCliDeviceE2eeStatus({
      controlBaseUrl: relayUrl,
      accessToken,
    });
    const identity = currentDeviceE2eeIdentity({
      deviceId: authenticatedDeviceId,
      epoch: Number(status?.policy?.epoch || deviceE2eeIdentity.public_identity.epoch),
    });
    const keyId = identity.public_identity.key_id;
    if (registeredDeviceE2eeKeyId !== keyId) {
      const registered = await registerCliDeviceE2eeIdentity({
        controlBaseUrl: relayUrl,
        accessToken,
        identity: identity.public_identity,
      });
      registeredDeviceE2eeKeyId = registered.key_id;
      if (registered.trust_status === "pending") {
        console.warn("[daemon] device E2EE identity is waiting for approval in the App");
      }
    }
    const directory = await getCliDeviceE2eeDirectory({
      controlBaseUrl: relayUrl,
      accessToken,
    });
    storeDeviceE2eeDirectoryCache(stateDir, directory, {
      namespace: credential.sessionId,
    });
  };
  sessionManager.onLocalControlChanged = async () => {
    if (!relayConnected) return;
    await reportLocalControlHeartbeat();
  };
  heartbeatTimer = setInterval(() => {
    if (!relayConnected) return;
    reportLocalControlHeartbeat().catch(() => {});
  }, 20_000);
  heartbeatTimer.unref?.();
  agentActivitySyncTimer = setInterval(() => {
    if (!relayConnected) return;
    void syncAgentActivityHistory();
  }, 5 * 60_000);
  agentActivitySyncTimer.unref?.();
  deviceE2eeRefreshTimer = setInterval(() => {
    if (!relayConnected) return;
    syncDeviceE2eeIdentity().catch((error) => {
      console.error(`[device-e2ee] directory refresh: ${error.code || error.message}`);
    });
  }, 15 * 60_000);
  deviceE2eeRefreshTimer.unref?.();

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
  console.log(`[daemon] relay mode: ${relayMode}`);
  console.log(`[daemon] device: ${effectiveDeviceId}`);
  console.log(`[daemon] executor: ${executor}`);
  console.log(
    `[daemon] local API: http://${httpHost(localApi.bindAddress)}:${localApi.port}`,
  );
  console.log(`[daemon] local API auth: bearer token (${apiTokenFile})`);
  if (localApiState().localApiLanEnabled) {
    console.warn(
      "[daemon] LAN control is enabled. Keep the bearer token private and avoid exposing this port to the public internet.",
    );
  }
  console.log(
    `[daemon] proxy manager: ${await proxyManager.status().then((s) => `${s.state}${s.port ? ` (port ${s.port})` : ""}`)}`,
  );
  console.log(
    `[daemon] remote share proxy: ${await remoteShareProxyManager.status().then((s) => `${s.state}${s.port ? ` (port ${s.port})` : ""}`)}`,
  );

  const configuredRemoteShare = readConfig().remoteShare;
  if (
    configuredRemoteShare?.enabled &&
    configuredRemoteShare.providers?.length
  ) {
    remoteShareProxyManager
      .start({
        mode: "share",
        providerNames: configuredRemoteShare.providers,
        port: configuredRemoteShare.port || DEFAULT_REMOTE_SHARE_PROXY_PORT,
      })
      .then((result) => {
        if (!result.ok)
          console.error(
            `[daemon] remote share restore failed: ${result.error}`,
          );
      })
      .catch((error) => {
        console.error(`[daemon] remote share restore failed: ${error.message}`);
      });
  }

  if (relayMode === "local") {
    relayAuthState = "disabled";
    relayAuthError = null;
    writeDaemonState({
      pid: process.pid,
      relayUrl,
      deviceId: effectiveDeviceId,
      executor,
      ...localApiState(),
      version: VERSION,
      status: "local-only",
      relayMode,
    });
    console.log(
      "[daemon] Relay disabled; local and LAN control remain available.",
    );
    while (!shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    return;
  }

  for (;;) {
    try {
      const relayOptionsResult = await tryBuildRelayClientOptions({
        stateDir,
        relayUrl,
        fallbackDeviceId: device.deviceId,
        mode: relayMode,
      });
      if (!relayOptionsResult.ok) {
        relayConnected = false;
        relayAuthState = "unavailable";
        relayAuthError = relayOptionsResult.code;
        writeDaemonState({
          pid: process.pid,
          relayUrl,
          deviceId: effectiveDeviceId,
          executor,
          ...localApiState(),
          version: VERSION,
          status: "local-only",
          relayAuthError,
        });
        console.error(
          `[daemon] Relay unavailable (${relayModeDescription(relayOptionsResult.plan)}): code=${relayAuthError}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      const relayOptions = relayOptionsResult.options;
      relayAuthState = relayOptions.authState || "on";
      relayAuthError = null;
      relayClient.deviceId = relayOptions.deviceId;
      relayClient.setAuthToken(relayOptions.authToken);
      effectiveDeviceId = relayOptions.deviceId;
      currentDeviceE2eeIdentity({ deviceId: effectiveDeviceId });
      localApiCtx.deviceId = effectiveDeviceId;
      sessionManager.deviceId = effectiveDeviceId;
      managedAgentSupervisor.deviceId = effectiveDeviceId;
      collaborationRuntime.deviceId = effectiveDeviceId;

      await relayClient.connectEvents(
        (payload) => {
          void (async () => {
            let routed = payload;
            if (payload?.protocol === "e2ee-v2") {
              routed = await deviceE2eeRelay.handleInbound(payload);
              if (!routed) return;
            } else if (deviceE2eeRelay.rejectsPlaintext(payload)) {
              console.error(`[device-e2ee] rejected plaintext ${payload?.type || "message"}`);
              return;
            }
            if ([
              "device.key.changed",
              "device.revoked",
              "device.approved",
              "device.policy.changed",
              "account.epoch.changed",
            ].includes(routed.type)) {
              if (routed.type === "account.epoch.changed") {
                await syncDeviceE2eeIdentity();
              } else {
                await deviceE2eeRelay.refreshDirectory({ clearSessions: true });
              }
              deviceE2eeLocalGateway.clearTrustSessions();
              return;
            }
            if (routed.type === "agent.control.subscribe") {
              routed = {
                ...routed,
                type: "agent.interactions.snapshot.request",
              };
            }
            const collaborationHandled = await collaborationRuntime
              .handleRelayEvent(routed);
            if (collaborationHandled) return;
            const externalHandled = await externalAgentRelayRouter.handle(routed);
            if (!externalHandled) sessionManager.handleEvent(routed);
          })().catch((error) => {
            console.error(`[device-relay] ${error.code || error.message}`);
          });
        },
        {
          onOpen: () => {
            relayConnected = true;
            writeDaemonState({
              pid: process.pid,
              relayUrl,
              deviceId: effectiveDeviceId,
              executor,
              ...localApiState(),
              version: VERSION,
              status: "connected",
            });
            reportLocalControlHeartbeat().catch(() => {});
            syncDeviceE2eeIdentity().catch((error) => {
              console.error(`[daemon] device E2EE registration: ${error.code || error.message}`);
            });
            void syncAgentActivityHistory();
            void collaborationRuntime
              .refreshAccountBudgetStatus()
              .catch((error) => {
                console.error(`[collaboration-budget] ${error.message}`);
              });
          },
          onClose: () => {
            relayConnected = false;
            deviceE2eeRelay.clearSessions();
          },
          onAlive: () => {
            if (!relayConnected) return;
            writeDaemonState({
              pid: process.pid,
              relayUrl,
              deviceId: effectiveDeviceId,
              executor,
              ...localApiState(),
              version: VERSION,
              status: "connected",
            });
          },
        },
      );
      writeDaemonState({
        pid: process.pid,
        relayUrl,
        deviceId: effectiveDeviceId,
        executor,
        ...localApiState(),
        version: VERSION,
        status: "reconnecting",
      });
    } catch (error) {
      relayConnected = false;
      console.error(`[daemon] ${error.message}`);
      // Stage 9.5 — re-acquire a fresh token before reconnecting. BOTH
      // relayClient.deviceId and relayClient.authToken must be updated;
      // updating only the token would leave a stale deviceId and the
      // relay would return 403 device_mismatch.
      try {
        const relayOptions = await buildAgentRelayPlan({
          stateDir,
          relayUrl,
          fallbackDeviceId: device.deviceId,
          mode: relayMode,
        });
        if (!relayOptions.enabled) {
          const error = new Error(relayOptions.reason || "relay_auth_unavailable");
          error.code = relayOptions.reason || "relay_auth_unavailable";
          throw error;
        }
        relayClient.deviceId = relayOptions.deviceId;
        relayClient.setAuthToken(relayOptions.authToken);
        effectiveDeviceId = relayOptions.deviceId;
        currentDeviceE2eeIdentity({ deviceId: effectiveDeviceId });
        localApiCtx.deviceId = effectiveDeviceId;
        sessionManager.deviceId = effectiveDeviceId;
        relayAuthState = relayOptions.authState || "on";
        relayAuthError = null;
      } catch (reErr) {
        relayAuthState = "unavailable";
        relayAuthError = reErr?.code || "unknown";
        console.error(
          `[daemon] relay auth re-acquire failed: code=${reErr?.code || "unknown"}`,
        );
      }
      writeDaemonState({
        pid: process.pid,
        relayUrl,
        deviceId: effectiveDeviceId,
        executor,
        ...localApiState(),
        version: VERSION,
        status: "reconnecting",
        error: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
