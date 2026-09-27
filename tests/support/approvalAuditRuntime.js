// Socket audit fixture. Uses production local API, relay router, wrapper bridge,
// native Claude permission hook, reviewer and policy engine. No tool executes.
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-approval-audit-"));
process.env.ORIGINROUTER_HOME = stateDir;
const { startLocalApi } = await import("../../src/local/localApi.js");
const { ensureApiToken } = await import("../../src/persistence/authToken.js");
const { writeCodingAuth } = await import("../../src/persistence/codingAuth.js");
const { ExternalAgentRegistry } = await import("../../src/local/externalAgentRegistry.js");
const { ExternalAgentRelayRouter } = await import("../../src/daemon/externalAgentRelayRouter.js");
const { LocalAgentBridgeClient } = await import("../../src/local/localAgentBridgeClient.js");
const { PendingInteractionRegistry } = await import("../../src/runtime/pendingInteractionRegistry.js");
const { startClaudeHookServer } = await import("../../src/adapters/claude/hookServer.js");
const { normalizePtyInteraction } = await import("../../src/local/agentSessionPrimitives.js");
const { permissionEventToInteraction } = await import("../../src/runtime/agentInteractionContract.js");
const { resolveWithAutonomy, buildAutonomyStatusEvent } = await import("../../src/runtime/agentAutonomyPolicy.js");
const { resolveAgentAutonomyConfiguration } = await import("../../src/runtime/agentAutonomyConfiguration.js");
const { AiApprovalReviewer } = await import("../../src/runtime/aiApprovalReviewer.js");
const serverBase = process.env.AUDIT_SERVER_BASE;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(serverBase || "")) throw new Error("loopback server required");
const sessionId = "audit-session";
const token = ensureApiToken(stateDir);
const access = { token: "or_at_audit", expiresAt: Date.now() + 3600000, scopes: ["approval.review"] };
writeCodingAuth(stateDir, {
  kind: "oauth", clientId: "originrouter_cli", source: "originrouter_cli",
  deviceId: "audit-cli", sessionId: "or_ses_audit", refreshToken: "or_rt_audit",
  refreshExpiresAt: Date.now() + 86400000, tokenEndpoint: serverBase + "/oauth/token",
  revocationEndpoint: serverBase + "/oauth/revoke",
  accessTokens: { ai: access, control: access, coding: access, relay: access },
});
const registry = new ExternalAgentRegistry();
const local = await startLocalApi({ stateDir, externalAgentRegistry: registry,
  sessionManager: { sessions: new Map(), list: () => [] } }, { port: 0 });
let configuration = resolveAgentAutonomyConfiguration({ profile: "manual" }, { stateDir });
let hook;
const wrapper = new LocalAgentBridgeClient({ stateDir, sessionId, pollIntervalMs: 20,
  endpointProvider: () => ({ baseUrl: `http://127.0.0.1:${local.port}`, token }),
  onCommand: async (command) => {
    if (command.type === "agent.autonomy.set") {
      let accepted = true, reason = null;
      try { configuration = resolveAgentAutonomyConfiguration(command, { stateDir, currentPolicy: configuration.approvalPolicy }); }
      catch (error) { accepted = false; reason = error.message; }
      await wrapper.sendEvent({ ...buildAutonomyStatusEvent({ ...configuration,
        provider: "claude", runtime: "claude-pty", requestId: command.requestId, accepted, reason }), sessionId });
    } else if (command.type === "agent.interaction.resolve") {
      pending.resolve(command);
    }
  },
});
const pending = new PendingInteractionRegistry({
  onRequested: (request) => wrapper.sendEvent({ ...request, type: "agent.interaction.requested" }),
  onResult: (result) => wrapper.sendEvent({ ...result, sessionId, type: "agent.interaction.result" }),
});
const reviewer = new AiApprovalReviewer({ stateDir, endpoint: serverBase + "/ai/v1/ai-approval/review" });
hook = await startClaudeHookServer({ onPermissionRequest: (callId, event) => {
  const captured = configuration;
  const request = normalizePtyInteraction(permissionEventToInteraction(event, { sessionId }), sessionId);
  void resolveWithAutonomy({ ...captured, request, workspaceRoot: stateDir, stateDir,
    aiReviewer: reviewer, runtime: "claude-pty", isCurrent: () => configuration === captured,
    requestInteraction: (item) => pending.request(item),
    onAutoResolved: ({ resolved }) => wrapper.sendEvent({ ...resolved, sessionId, type: "agent.interaction.auto_resolved" }),
  }).then(async (resolved) => {
    hook.resolvePermission({ callId, decision: resolved.action === "allow" ? "approved" : "denied" });
    if (!resolved.autoResolved) await pending.markResult(request.interactionId, "applied", { responseId: resolved.responseId });
  }).catch((error) => {
    console.error(error);
    hook.resolvePermission({ callId, decision: "denied" });
  });
} });
let forwarding = Promise.resolve();
const relay = new ExternalAgentRelayRouter({ registry, relayClient: {
  send: async (type, payload) => {
    const response = await fetch(serverBase + "/test/runtime-event", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, ...payload }) });
    if (!response.ok) throw new Error(`event HTTP ${response.status}: ${await response.text()}`);
  },
} });
registry.subscribe((notification) => {
  forwarding = forwarding.then(() => relay.forwardRegistryNotification(notification)).catch(console.error);
});
const control = http.createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const accepted = req.url === "/test/relay" && await relay.handle(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accepted }));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
await fetch(serverBase + "/test/configure", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cli_base: `http://127.0.0.1:${control.address().port}` }) });
await wrapper.start({ agentType: "claude", title: "Approval audit", runtime: "claude-pty", cwd: stateDir, status: "running" });
await wrapper.sendEvent({ ...buildAutonomyStatusEvent({ ...configuration, provider: "claude", runtime: "claude-pty" }), sessionId });
console.log(JSON.stringify({ port: local.port, hookPort: hook.port, token, workspace: stateDir }));
process.on("SIGTERM", async () => {
  wrapper.close(); hook.stop(); control.close(); await local.close();
  // Only this fixture's newly generated private temporary directory.
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(0);
});
