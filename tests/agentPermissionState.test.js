import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import { createAgentPermissionStateTracker } from "../src/runtime/agentPermissionStateTracker.js";
import { resolvePersistedPermissionConfiguration } from "../src/runtime/agentAutonomyConfiguration.js";
import { compileApprovalPolicy, protectedApprovalPolicy } from "../src/runtime/approvalPolicy.js";
import { ManagedAgentSupervisor } from "../src/daemon/managedAgentSupervisor.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";
import { buildRuntimeEventEnvelope } from "../src/agent/bridgeReporter.js";

test("permission state survives exit, catalog restart and a new runtime", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "or-permission-state-"));
  try {
    const metadata = { stateDir, sessionId: "session-1", conversationId: "conversation-1", agent: "claude", cwd: stateDir };
    const first = createAgentPermissionStateTracker(metadata, { now: () => 100 });
    assert.equal(first.capture({ profile: "unrestricted" }), 100);
    let catalog = new AgentCatalog({ stateDir });
    catalog.finishSession("session-1", { status: "stopped" });
    assert.equal(catalog.getConversation("conversation-1").permission_profile, "unrestricted");
    assert.equal(catalog.listConversationPage({ autoArchiveDays: 0 }).conversations[0].permission_revision, 100);
    catalog.close();
    // A clock moving backwards does not reuse an older configuration version.
    const second = createAgentPermissionStateTracker({ ...metadata, sessionId: "session-2" }, { now: () => 50 });
    assert.equal(second.capture({ profile: "unrestricted" }), 101);
    assert.equal(second.capture({ profile: "manual" }, { changed: true }), 102);
    catalog = new AgentCatalog({ stateDir });
    assert.equal(catalog.getConversationPermissionState("conversation-1").profile, "manual");
    assert.equal(catalog.saveConversationPermissionState("session-1", { profile: "unrestricted", revision: 100 }), false);
    catalog.close();
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("resume inherits the immutable configuration and an explicit selection overrides it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "or-permission-resume-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({ sessionId: "old-session", conversationId: "conversation-1", agent: "claude", deviceId: "device-1",
      nativeSessionId: "native-1", cwd: stateDir, workspaceTrusted: true, status: "stopped" });
    const policy = compileApprovalPolicy({ ...protectedApprovalPolicy(), id: "saved-policy" });
    const saved = { profile: "custom", revision: 100, allowedScopes: [],
      policyBundle: { id: policy.policy.id, revision: policy.revision, content: policy.policy }, aiReviewPolicy: null };
    catalog.saveConversationPermissionState("old-session", saved);
    assert.equal(resolvePersistedPermissionConfiguration(saved).approvalPolicy.revision, policy.revision);
    const spawned = [];
    const supervisor = new ManagedAgentSupervisor({ catalog, deviceId: "device-1", relayUrl: "https://example.test", spawnFn(command, args, options) {
      const child = new EventEmitter(); child.pid = 1234; child.unref = () => {};
      spawned.push({ args, options }); queueMicrotask(() => child.emit("spawn")); return child;
    } });
    const request = { agentType: "claude", workspaceId: catalog.listWorkspaces()[0].workspace_id,
      resumeConversationId: "conversation-1", nativeSessionId: "native-1", inheritPermission: true, permissionProfile: "manual" };
    await supervisor.start({ ...request, launchId: "launch-1", sessionId: "new-session-1", runId: "run-1" });
    assert.equal(spawned[0].args[spawned[0].args.indexOf("--originrouter-autonomy") + 1], "custom");
    assert.equal(spawned[0].options.env.ORIGINROUTER_PERMISSION_CONVERSATION_ID, "conversation-1");
    await supervisor.start({ ...request, inheritPermission: false, launchId: "launch-2", sessionId: "new-session-2", runId: "run-2" });
    assert.equal(spawned[1].args[spawned[1].args.indexOf("--originrouter-autonomy") + 1], "manual");
    assert.equal(spawned[1].options.env.ORIGINROUTER_PERMISSION_CONVERSATION_ID, "");
  } finally { catalog.close(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("the Server receives a versioned projection without full policy contents", () => {
  const event = { type: "agent.autonomy.status", autonomyProfile: "custom", autonomyRevision: 20,
    autonomyControl: "supported", approvalPolicy: { id: "saved-policy", revision: "a".repeat(64) },
    policyBundle: { content: "private rules" } };
  const envelope = buildRuntimeEventEnvelope({ sessionId: "session-1", agentType: "claude", eventType: "agent.event", event });
  assert.equal(envelope.autonomy_status.autonomyRevision, 20);
  assert.equal(envelope.autonomy_status.autonomyProfile, "custom");
  assert.equal(JSON.stringify(envelope).includes("private rules"), false);
});

test("permission persistence preserves workspace and runtime ownership", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "or-permission-owner-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    catalog.upsertSession({ sessionId: "session-1", conversationId: "conversation-1", agent: "claude",
      deviceId: "device-1", nativeSessionId: "native-1", cwd: stateDir, workspaceTrusted: true,
      runtime: "claude-sdk", pid: 1234, status: "running" });
    const before = catalog.getConversation("conversation-1");
    const tracker = createAgentPermissionStateTracker({ stateDir, sessionId: "session-1", conversationId: "conversation-1", agent: "claude", cwd: stateDir });
    tracker.capture({ profile: "unrestricted" });
    const after = catalog.getConversation("conversation-1");
    assert.equal(after.workspace_id, before.workspace_id);
    assert.equal(after.native_session_id, "native-1");
    assert.equal(after.runs[0].device_id, "device-1");
    assert.equal(after.runs[0].pid, 1234);
    assert.equal(after.runs[0].runtime, "claude-sdk");
  } finally { catalog.close(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("a registry reconnect or an old status cannot replace confirmed permissions", () => {
  const registry = new ExternalAgentRegistry();
  registry.register({ sessionId: "session-1", agent: "claude", autonomyProfile: "manual" });
  registry.appendEvent("session-1", { type: "agent.autonomy.status", eventId: "new", autonomyProfile: "unrestricted", autonomyRevision: 20 });
  registry.register({ sessionId: "session-1", agent: "claude", autonomyProfile: "manual" });
  registry.appendEvent("session-1", { type: "agent.autonomy.status", eventId: "old", autonomyProfile: "manual", autonomyRevision: 19 });
  assert.equal(registry.list()[0].autonomy_profile, "unrestricted");
  assert.equal(registry.controlSnapshot("session-1").autonomy.autonomyRevision, 20);
  registry.appendEvent("session-1", { type: "agent.autonomy.status", eventId: "manual-now", autonomyProfile: "manual", autonomyRevision: 21 });
  assert.equal(registry.list()[0].autonomy_profile, "manual");
});

test("a native conversation switch binds the current permission to the new conversation", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "or-permission-switch-"));
  const catalog = new AgentCatalog({ stateDir });
  try {
    const metadata = { stateDir, sessionId: "session-1", conversationId: "temporary-1", agent: "claude", cwd: stateDir };
    const tracker = createAgentPermissionStateTracker(metadata, { now: () => 100 });
    tracker.capture({ profile: "unrestricted" });
    catalog.upsertSession({ ...metadata, sessionId: "old-native-run", conversationId: "claude:native-1", status: "stopped" });
    catalog.saveConversationPermissionState("old-native-run", { profile: "manual", revision: 200 });
    assert.equal(tracker.capture({ profile: "unrestricted" }, { conversationId: "claude:native-1" }), 201);
    assert.equal(catalog.getConversationPermissionState("claude:native-1").profile, "unrestricted");
    tracker.capture({ profile: "manual" }, { changed: true, conversationId: "claude:native-1" });
    assert.equal(catalog.getConversationPermissionState("claude:native-1").revision, 202);
    assert.equal(catalog.getConversationPermissionState("temporary-1").profile, "unrestricted");
  } finally { catalog.close(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("AI review instructions survive storage restart without loading a mutable template", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "or-permission-ai-"));
  try {
    const template = { allowed_scopes: ["read_tools"], applicability: {}, instructions: "Allow reads.",
      name: "Audit", protocol_version: "1", template_id: "ait_audit_template" };
    const snapshot = { ...template, version: 1,
      content_hash: createHash("sha256").update(JSON.stringify(template)).digest("hex") };
    const tracker = createAgentPermissionStateTracker({ stateDir, sessionId: "session-1",
      conversationId: "conversation-1", agent: "claude", cwd: stateDir });
    tracker.capture({ profile: "ai_review", aiReviewPolicy: snapshot });
    const catalog = new AgentCatalog({ stateDir });
    try {
      catalog.finishSession("session-1", { status: "stopped" });
      const restored = resolvePersistedPermissionConfiguration(catalog.getConversationPermissionState("conversation-1"));
      assert.equal(restored.profile, "ai_review");
      assert.deepEqual(restored.aiReviewPolicy, snapshot);
    } finally { catalog.close(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
