import process from "node:process";
import { DEFAULT_DEVICE_ID, DEFAULT_EXECUTOR, DEFAULT_RELAY_URL, VERSION } from "../constants.js";
import { startLocalApi } from "../local/localApi.js";
import { ProxyManager } from "../proxy/manager.js";
import { ensureApiToken } from "../persistence/authToken.js";
import { ensureDevice, ensureStateDir, readConfig, writeDaemonState } from "../persistence/state.js";
import { buildRelayClientOptions } from "../relay/relayAuthBootstrap.js";
import { RelayClient } from "../relay/relayClient.js";
import { parseOptions } from "../utils/options.js";
import { SessionManager } from "./sessionManager.js";

export async function startDaemon(args) {
  const { options } = parseOptions(args);
  const stateDir = ensureStateDir();

  // Stage 6: ensure the bearer token file exists before binding the API.
  // If the file is missing, the local API would 503 every write — better
  // to mint a token up front so the daemon starts in a usable state.
  const apiToken = ensureApiToken(stateDir);

  const relayUrl = options.relay || process.env.ORIGINROUTER_RELAY || DEFAULT_RELAY_URL;
  const device = ensureDevice(options.device || process.env.ORIGINROUTER_DEVICE || DEFAULT_DEVICE_ID);
  const executor = DEFAULT_EXECUTOR;

  // Stage 9.5 — when ORIGINROUTER_RELAY_AUTH=on, acquire a Surety token
  // at boot using coding-key.json. The token's deviceId may differ from
  // the constructor deviceId (e.g. when device.json is "local-dev" but
  // coding-key.json is "prod-originrouter-worker-foo"); the effective
  // deviceId is the one Surety issued the token for. SessionManager and
  // all envelope payloads must use the effective deviceId.
  let relayClient;
  let effectiveDeviceId;
  try {
    const relayOptions = await buildRelayClientOptions({
      stateDir,
      relayUrl,
      fallbackDeviceId: device.deviceId,
    });
    relayClient = new RelayClient(relayOptions);
    effectiveDeviceId = relayOptions.deviceId;
  } catch (err) {
    console.error(`[daemon] relay auth bootstrap failed: code=${err?.code || "unknown"}`);
    throw err;
  }

  // Stage 4: ProxyManager owns the LiteLLM proxy lifecycle. The session
  // manager passes proxy status into buildAgentProviderEnv; the local API
  // exposes start/stop/restart endpoints that call the manager directly.
  const proxyManager = new ProxyManager({
    stateDir,
  });
  const sessionManager = new SessionManager({
    relayClient,
    deviceId: effectiveDeviceId,
    defaultExecutor: executor,
    proxyManager,
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
    deviceId: effectiveDeviceId,
    relayConnected: () => relayConnected,
    getProxyStatus: () => proxyManager.status(),
    startProxy: ({ provider, providerName, mode, port }) => proxyManager.start({ providerName: providerName || provider, mode, port }),
    stopProxy: () => proxyManager.stop(),
    restartProxy: ({ provider, providerName, mode, port }) => proxyManager.restart({ providerName: providerName || provider, mode, port }),
  };
  const localApi = await startLocalApi(localApiCtx, {
    port: options.localPort ?? 0,
    apiTokenPath: process.env.ORIGINROUTER_API_TOKEN_PATH,
  });
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
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[daemon] received ${signal}, shutting down…`);
    try { await proxyManager.stop(); } catch (e) { console.error(`[daemon] proxy stop: ${e.message}`); }
    try { await localApi.close(); } catch (e) { console.error(`[daemon] local api close: ${e.message}`); }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  writeDaemonState({
    pid: process.pid,
    relayUrl,
    deviceId: effectiveDeviceId,
    executor,
    localApiPort: localApi.port,
    version: VERSION,
    status: "starting",
  });

  console.log("[daemon] starting");
  console.log(`[daemon] relay: ${relayUrl}`);
  console.log(`[daemon] device: ${effectiveDeviceId}`);
  console.log(`[daemon] executor: ${executor}`);
  console.log(`[daemon] local API: http://127.0.0.1:${localApi.port}`);
  console.log(`[daemon] proxy manager: ${await proxyManager.status().then((s) => `${s.state}${s.port ? ` (port ${s.port})` : ""}`)}`);

  for (;;) {
    try {
      await relayClient.connectEvents((payload) => sessionManager.handleEvent(payload));
      relayConnected = true;
      writeDaemonState({
        pid: process.pid, relayUrl, deviceId: effectiveDeviceId, executor,
        localApiPort: localApi.port, version: VERSION, status: "connected",
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
        });
        relayClient.deviceId = relayOptions.deviceId;
        relayClient.setAuthToken(relayOptions.authToken);
        effectiveDeviceId = relayOptions.deviceId;
        localApiCtx.deviceId = effectiveDeviceId;
      } catch (reErr) {
        console.error(`[daemon] relay auth re-acquire failed: code=${reErr?.code || "unknown"}`);
      }
      writeDaemonState({
        pid: process.pid, relayUrl, deviceId: effectiveDeviceId, executor,
        localApiPort: localApi.port, version: VERSION,
        status: "reconnecting", error: error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
