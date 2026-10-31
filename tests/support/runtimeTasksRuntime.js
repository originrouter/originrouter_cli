// Socket fixture for App -> server -> CLI runtime-task tests. The CLI half of
// originrouter_server/tests/support/runtime_tasks_server.py.
//
// Production code, wired the way daemon.js wires it: the device E2EE identity
// and its registration, the directory cache, the relay WebSocket client and
// the E2EE transport over it, the relay dispatch chain, SessionManager's
// runtime-task responder, the registry, the runtime-task store, the
// supervisor, the judge client and the escalation reporter. No Agent runs: the
// test drives the session by appending the events a runtime would.
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-rt-e2e-"));
process.env.ORIGINROUTER_HOME = stateDir;
const serverBase = process.env.RT_SERVER_BASE;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(serverBase || "")) throw new Error("loopback server required");
process.env.ORIGINROUTER_SERVER_BASE_URL = serverBase;
const deviceId = process.env.RT_CLI_DEVICE;
const sessionId = process.env.RT_SESSION_ID;

const { writeCodingAuth } = await import("../../src/persistence/codingAuth.js");
const { ensureDeviceE2eeIdentity, readDeviceE2eeIdentity } = await import("../../src/crypto/deviceE2eeIdentity.js");
const { registerCliDeviceE2eeIdentity, getCliDeviceE2eeDirectory } = await import("../../src/security/deviceE2eeClient.js");
const { storeDeviceE2eeDirectoryCache, ensureDeviceE2eeDirectoryCacheMigrated } = await import("../../src/security/deviceE2eeDirectoryCache.js");
const { DeviceE2eeRelayTransport } = await import("../../src/security/deviceE2eeRelayTransport.js");
const { RelayClient } = await import("../../src/relay/relayClient.js");
const { ensureFreshAccessToken } = await import("../../src/runtime/oauthTokenRefresher.js");
const { ExternalAgentRegistry } = await import("../../src/local/externalAgentRegistry.js");
const { ExternalAgentRelayRouter } = await import("../../src/daemon/externalAgentRelayRouter.js");
const { SessionManager } = await import("../../src/daemon/sessionManager.js");
const { createRelayDispatch } = await import("../../src/daemon/relayDispatch.js");
const { RuntimeTaskStore } = await import("../../src/runtime/runtimeTaskStore.js");
const { RuntimeSupervisor } = await import("../../src/runtime/runtimeSupervisor.js");
const { SupervisorJudgeClient } = await import("../../src/runtime/supervisorJudgeClient.js");
const { reportSupervisorEscalation } = await import("../../src/agent/bridgeReporter.js");

// The test server's bearer tokens name the device.
const token = `or_at_rt-e2e:${deviceId}`;
const access = { token, expiresAt: Date.now() + 3_600_000, scopes: ["control.read", "control.write", "ai.invoke", "relay.connect"] };
writeCodingAuth(stateDir, {
  kind: "oauth", clientId: "originrouter_cli", source: "originrouter_cli",
  deviceId, sessionId: "or_ses_rt-e2e-cli", refreshToken: "or_rt_rt-e2e",
  refreshExpiresAt: Date.now() + 86_400_000, tokenEndpoint: `${serverBase}/oauth/token`,
  revocationEndpoint: `${serverBase}/oauth/revoke`,
  accessTokens: { ai: access, control: access, coding: access, relay: access, memory: access },
});
const credential = await ensureFreshAccessToken({ stateDir });

// Identity, registration and directory: daemon.js syncDeviceE2eeIdentity.
ensureDeviceE2eeIdentity(stateDir, { deviceId, accountScope: credential?.accountScope || null });
const identity = readDeviceE2eeIdentity(stateDir, { accountScope: credential?.accountScope || null });
const registered = await registerCliDeviceE2eeIdentity({
  controlBaseUrl: serverBase, accessToken: token, identity: identity.public_identity,
});
if (registered.trust_status !== "trusted") throw new Error(`CLI identity is ${registered.trust_status}`);

const relayClient = new RelayClient({ relayUrl: serverBase, deviceId, authToken: token });
const deviceE2eeRelay = new DeviceE2eeRelayTransport({
  relayClient,
  localIdentity: identity,
  localIdentityProvider: () => readDeviceE2eeIdentity(stateDir, { accountScope: credential?.accountScope || null }),
  stateDir,
  controlBaseUrl: serverBase,
  credentialProvider: () => ensureFreshAccessToken({ stateDir }),
});

const registry = new ExternalAgentRegistry();
registry.register({ sessionId, agent: "claude", cwd: stateDir });
const runtimeTaskStore = new RuntimeTaskStore({ stateDir, aiJudgeAvailable: true });
const judge = new SupervisorJudgeClient({ stateDir, endpoint: `${serverBase}/ai/v1/supervisor/judge` });
const supervisor = new RuntimeSupervisor({
  registry,
  store: runtimeTaskStore,
  judge: (request) => judge.judge(request),
  onEscalated: (escalation) => reportSupervisorEscalation(escalation, { stateDir }),
  settleMs: 200,
}).start();
const sessionManager = new SessionManager({
  relayClient: deviceE2eeRelay,
  deviceId,
  defaultExecutor: null,
  runtimeTaskStore,
  runtimeSupervisor: supervisor,
  stateDir,
});
const dispatch = createRelayDispatch({
  // Collaboration owns no runtime-task type; the chain still runs through
  // the real ExternalAgentRelayRouter and SessionManager.
  collaborationRuntime: { async handleRelayEvent() { return false; } },
  externalAgentRelayRouter: new ExternalAgentRelayRouter({ registry, relayClient: deviceE2eeRelay }),
  sessionManager,
});

const directory = await getCliDeviceE2eeDirectory({ controlBaseUrl: serverBase, accessToken: token });
storeDeviceE2eeDirectoryCache(stateDir, directory, {
  namespace: ensureDeviceE2eeDirectoryCacheMigrated(stateDir, credential),
});

const errors = [];
let opened;
const open = new Promise((resolve) => { opened = resolve; });
// daemon.js's relay loop, verbatim in what it does with a frame.
void relayClient.connectEvents((payload) => {
  void (async () => {
    let routed = payload;
    if (payload?.protocol === "e2ee-v2") {
      routed = await deviceE2eeRelay.handleInbound(payload);
      if (!routed) return;
    } else if (deviceE2eeRelay.rejectsPlaintext(payload)) {
      errors.push(`rejected plaintext ${payload?.type}`);
      return;
    }
    await dispatch(routed);
  })().catch((error) => errors.push(error.code || error.message));
}, { onOpen: () => opened() }).catch((error) => errors.push(`relay: ${error.message}`));
await open;

const control = http.createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (value) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (req.url === "/test/events" && req.method === "POST") {
      // Refreshing first lets the App's key, registered after this process
      // started, be known before its first envelope arrives.
      for (const event of JSON.parse(body).events) registry.appendEvent(sessionId, event);
      return send({ ok: true });
    }
    if (req.url === "/test/refresh-directory") {
      await deviceE2eeRelay.refreshDirectory();
      return send({ ok: true });
    }
    if (req.url === "/test/state") {
      return send({
        commands: registry.commandsAfter(sessionId, 0).commands,
        events: registry.eventsAfter(0).events.filter((item) => item.type.startsWith("agent.supervisor.")),
        cards: runtimeTaskStore.cards(),
        log: runtimeTaskStore.log({ limit: 50 }),
        errors,
      });
    }
    res.writeHead(404).end();
  } catch (error) {
    res.writeHead(500).end(String(error?.stack || error));
  }
});
await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ port: control.address().port, deviceId }));
