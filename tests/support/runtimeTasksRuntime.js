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
import { generateKeyPairSync, randomBytes } from "node:crypto";
import ssh2 from "ssh2";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const { ScheduledTaskStore } = await import("../../src/runtime/scheduledTaskStore.js");
const { ScheduledTaskScheduler } = await import("../../src/runtime/scheduledTaskScheduler.js");
const { RemoteEnvironmentService } = await import("../../src/remoteEnvironment/remoteEnvironmentService.js");
const { sshHostFingerprint } = await import("../../src/remoteEnvironment/sshConnectionManager.js");
const { SupervisorJudgeClient } = await import("../../src/runtime/supervisorJudgeClient.js");
const { DeviceToolApprovalBroker } = await import("../../src/mcp/deviceToolApprovalBroker.js");
const { DeviceToolService } = await import("../../src/mcp/deviceToolService.js");
const { PendingInteractionRegistry } = await import("../../src/runtime/pendingInteractionRegistry.js");
const { createDeviceToolApprovalHandler } = await import("../../src/runtime/deviceToolApproval.js");
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
registry.register({ sessionId, agent: "claude", runtime: "claude-sdk", supportsRuntimeRecovery: true, supportsDeviceTools: true, cwd: stateDir });
const runtimeTaskStore = new RuntimeTaskStore({ stateDir, aiJudgeAvailable: true });
const judge = new SupervisorJudgeClient({ stateDir, endpoint: `${serverBase}/ai/v1/supervisor/judge` });
const supervisor = new RuntimeSupervisor({
  registry,
  store: runtimeTaskStore,
  judge: (request) => judge.judge(request),
  onEscalated: (escalation) => reportSupervisorEscalation(escalation, { stateDir }),
  settleMs: 200,
}).start();
const scheduledTaskStore = new ScheduledTaskStore({ stateDir });
const scheduledLaunches = [];
const scheduledTaskScheduler = new ScheduledTaskScheduler({
  store: scheduledTaskStore, registry, runtimeSupervisor: supervisor,
  supervisor: { async start(request) { scheduledLaunches.push(request); return { accepted: true }; } },
});
// Optionally use the production headless vault with an isolated key. Other
// tests keep the memory vault to avoid depending on a platform credential store.
const useHeadlessVault = process.env.RT_USE_HEADLESS_VAULT === "1";
if (useHeadlessVault) {
  const keyPath = join(stateDir, "test-vault-key");
  writeFileSync(keyPath, randomBytes(32), {mode: 0o600});
  process.env.ORIGINROUTER_SSH_VAULT_KEY_FILE = keyPath;
  process.on("SIGTERM", () => {
    rmSync(stateDir, {recursive: true, force: true});
    process.exit(0);
  });
}
const remoteSecrets = new Map();
const memoryVault = {
  put:async (key, value) => remoteSecrets.set(key, value),
  get:async (key) => remoteSecrets.get(key),
  remove:async (key) => remoteSecrets.delete(key),
};
const remoteEnvironmentService = new RemoteEnvironmentService({
  stateDir, ...(useHeadlessVault ? {} : {vault: memoryVault}),
});
const sessionManager = new SessionManager({
  relayClient: deviceE2eeRelay,
  deviceId,
  defaultExecutor: null,
  runtimeTaskStore,
  runtimeSupervisor: supervisor,
  scheduledTaskScheduler,
  remoteEnvironmentService,
  stateDir,
});
const router = new ExternalAgentRelayRouter({ registry, relayClient: deviceE2eeRelay });
const broker = new DeviceToolApprovalBroker({registry, accountProvider: () => stateDir});
const deviceTools = new DeviceToolService({registry, broker, scheduled: scheduledTaskScheduler,
  remote: remoteEnvironmentService, accountProvider: () => stateDir});
const interactions = new PendingInteractionRegistry({
  onRequested: async (event) => registry.appendEvent(sessionId, event),
  onResult: async (event) => registry.appendEvent(sessionId, {type: "agent.interaction.result", ...event}),
});
const handler = createDeviceToolApprovalHandler({sessionId, provider: "claude", runtime: "claude-sdk", revision: () => 1,
  requestInteraction: (request, signal) => interactions.request(request, signal),
  markApplied: (result) => interactions.markResult(result.interactionId, "applied", {responseId: result.responseId}),
  sendResult: async (event) => registry.notify("device_tool_approval_result", sessionId, event),
});
let deviceToolResult = null;
registry.subscribe((notification) => {
  if (notification.type === "command") {
    const cmd = notification.payload;
    if (cmd.type === "agent.device_tool.approval") handler.start(cmd);
    if (cmd.type === "agent.device_tool.cancel") handler.cancel(cmd.requestId);
    if (cmd.type === "agent.interaction.resolve") interactions.resolve(cmd);
  }
  if (notification.type === "event" && notification.payload?.type?.startsWith("agent.interaction.")) {
    void router.forwardRegistryNotification(notification).catch((error) => errors.push(error.message));
  }
});
const dispatch = createRelayDispatch({
  // Collaboration owns no runtime-task type; the chain still runs through
  // the real ExternalAgentRelayRouter and SessionManager.
  collaborationRuntime: { async handleRelayEvent() { return false; } },
  externalAgentRelayRouter: router,
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
const relayEvent = (payload) => {
  void (async () => {
    let routed = payload;
    if (payload?.protocol === "e2ee-v2") {
      routed = await deviceE2eeRelay.handleInbound(payload);
      if (!routed) return;
    } else if (deviceE2eeRelay.rejectsPlaintext(payload)) {
      errors.push(`rejected plaintext ${payload?.type}`);
      return;
    }
    if (routed.type === "agent.control.subscribe") routed = {...routed, type: "agent.interactions.snapshot.request"};
    await dispatch(routed);
  })().catch((error) => errors.push(error.code || error.message));
};
void relayClient.connectEvents(relayEvent, { onOpen: () => opened() }).catch((error) => errors.push(`relay: ${error.message}`));
await open;

// Loopback-only SSH fixture: implements a fixed directory probe and echoes a
// single test command. It cannot execute arbitrary commands on this machine.
const sshKey = generateKeyPairSync("rsa", {modulusLength:2048,
  privateKeyEncoding:{type:"pkcs1",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}}).privateKey;
const sshCommands = [];
const sshServer = new ssh2.Server({hostKeys:[sshKey]}, (connection) => {
  connection.on("error", () => {});
  connection.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.username === "e2e-user" && ctx.password === "e2e-ssh-password") ctx.accept();
    else ctx.reject();
  });
  connection.on("ready", () => connection.on("session", (accept) => {
    accept().on("exec", (acceptExec, _reject, info) => {
      sshCommands.push(info.command);
      const stream = acceptExec();
      if (info.command === "pwd -P") { stream.write("/fixture\n"); stream.exit(0); }
      else if (info.command.includes("printf e2e-approved-command")) { stream.write("e2e-approved-command"); stream.exit(0); }
      else { stream.stderr.write("unsupported fixture command"); stream.exit(1); }
      stream.end();
    });
  }));
});
await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));
const sshInfo = {host:"127.0.0.1",port:sshServer.address().port,username:"e2e-user",
  fingerprint:sshHostFingerprint(ssh2.utils.parseKey(sshKey).getPublicSSH())};

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
    if (req.url === "/test/observation" && req.method === "POST") {
      registry.notify("observation", sessionId, JSON.parse(body));
      return send({ ok: true });
    }
    if (req.url === "/test/recovery-result" && req.method === "POST") {
      registry.notify("recovery_result", sessionId, JSON.parse(body));
      return send({ ok: true });
    }
    if (req.url === "/test/device-tool" && req.method === "POST") {
      deviceToolResult = {pending: true};
      const parsed = JSON.parse(body);
      const operation = parsed._operation || "scheduled.save";
      delete parsed._operation;
      void deviceTools.handle(sessionId, operation, parsed).then(
        (value) => { deviceToolResult = {value}; },
        (error) => { deviceToolResult = {error: error.code || error.message}; },
      );
      return send({ok: true});
    }
    if (req.url === "/test/ssh-info") return send(sshInfo);
    if (req.url === "/test/open-ssh" && req.method === "POST") {
      return send(await remoteEnvironmentService.manager.open(sessionId, JSON.parse(body).id));
    }
    if (req.url === "/test/relay-offline" && req.method === "POST") {
      relayClient.disconnect();
      return send({ok: true});
    }
    if (req.url === "/test/relay-online" && req.method === "POST") {
      // Keep the transport's existing object identity: it holds this client.
      relayClient._aborted = false;
      await new Promise((resolve, reject) => {
        relayClient.connectEvents(relayEvent, {onOpen: resolve}).catch(reject);
      });
      return send({ok: true});
    }
    if (req.url === "/test/refresh-directory") {
      await deviceE2eeRelay.refreshDirectory();
      return send({ ok: true });
    }
    if (req.url === "/test/state") {
      const vaultDir = join(stateDir, "remote-environment-secrets");
      const vaultFiles = useHeadlessVault && existsSync(vaultDir)
        ? readdirSync(vaultDir).filter((name) => name.endsWith(".json")) : [];
      return send({
        commands: registry.commandsAfter(sessionId, 0).commands,
        events: registry.eventsAfter(0).events.filter((item) => item.type.startsWith("agent.supervisor.")),
        cards: runtimeTaskStore.cards(),
        log: runtimeTaskStore.log({ limit: 50 }),
        recovery: runtimeTaskStore.recoveryFor(sessionId),
        scheduledLaunches,
        deviceToolResult,
        scheduledTasks: scheduledTaskStore.list(),
        sshCommands,
        vaultFileCount: useHeadlessVault ? vaultFiles.length : null,
        vaultHasTestPassword: useHeadlessVault && vaultFiles.some((name) =>
          readFileSync(join(vaultDir, name), "utf8").includes("e2e-ssh-password")),
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
