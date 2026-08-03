import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManagedAgentSupervisor } from "../src/daemon/managedAgentSupervisor.js";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-managed-launch-"));
const catalog = new AgentCatalog({ stateDir });
catalog.upsertSession({
  sessionId: "seed-session",
  agent: "codex",
  deviceId: "device-1",
  cwd: stateDir,
  workspaceTrusted: true,
  status: "completed",
});
const workspace = catalog.listWorkspaces()[0];
const spawns = [];
let child;
const supervisor = new ManagedAgentSupervisor({
  catalog,
  deviceId: "device-1",
  relayUrl: "https://relay.example.test",
  nodePath: "/usr/bin/node",
  binPath: "/opt/originrouter/bin/originrouter.js",
  spawnFn(command, args, options) {
    child = new EventEmitter();
    child.pid = 4321;
    child.unref = () => {};
    spawns.push({ command, args, options });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  },
});

const launched = await supervisor.start({
  launchId: "launch-1",
  sessionId: "session-1",
  conversationId: "conversation-1",
  runId: "run-1",
  agentType: "codex",
  workspaceId: workspace.workspace_id,
  initialMessage: "Fix the checkout callback.",
  provider: "originrouter-cloud",
  model: "gpt-codex",
  permissionProfile: "guarded",
});
assert.equal(launched.accepted, true);
assert.equal(launched.pid, 4321);
assert.equal(spawns.length, 1);
assert.equal(spawns[0].command, "/usr/bin/node");
assert.equal(spawns[0].options.cwd, workspace.canonical_path);
assert.ok(spawns[0].args.includes("codex-app-server"));
assert.ok(spawns[0].args.includes("--originrouter-conversation"));
assert.ok(spawns[0].args.includes("--originrouter-workspace"));
assert.ok(spawns[0].args.includes(workspace.workspace_id));
assert.ok(spawns[0].args.includes("--originrouter-title"));
assert.ok(spawns[0].args.includes("Fix the checkout callback."));

const duplicate = await supervisor.start({
  launchId: "launch-1",
  sessionId: "session-1",
  agentType: "codex",
  workspaceId: workspace.workspace_id,
});
assert.equal(duplicate.duplicate, true);
assert.equal(spawns.length, 1);

await assert.rejects(
  supervisor.start({
    launchId: "launch-2",
    sessionId: "session-2",
    agentType: "claude",
    workspaceId: "/unregistered/workspace",
  }),
  (error) => error.code === "WORKSPACE_NOT_FOUND",
);

child.emit("exit", 0, null);
assert.equal(catalog.getConversation("conversation-1").status, "completed");

catalog.updateSession("session-1", { nativeSessionId: "thread-native-1" });
const resumed = await supervisor.start({
  launchId: "launch-resume-1",
  sessionId: "session-resume-1",
  conversationId: "conversation-1",
  resumeConversationId: "conversation-1",
  nativeSessionId: "thread-native-1",
  runId: "run-resume-1",
  agentType: "codex",
  workspaceId: workspace.workspace_id,
  initialMessage: "Continue from the previous thread.",
  permissionProfile: "manual",
});
assert.equal(resumed.conversationId, "conversation-1");
assert.ok(spawns[1].args.includes("--resume"));
assert.ok(spawns[1].args.includes("thread-native-1"));

await assert.rejects(
  supervisor.start({
    launchId: "launch-resume-invalid",
    sessionId: "session-resume-invalid",
    conversationId: "conversation-1",
    resumeConversationId: "conversation-1",
    nativeSessionId: "wrong-thread",
    runId: "run-resume-invalid",
    agentType: "codex",
    workspaceId: workspace.workspace_id,
  }),
  (error) => error.code === "RESUME_SESSION_MISMATCH",
);

const restartedSupervisor = new ManagedAgentSupervisor({
  catalog,
  deviceId: "device-1",
  relayUrl: "https://relay.example.test",
  spawnFn() {
    throw new Error("persistent duplicate must not spawn a second process");
  },
});
const persistedDuplicate = await restartedSupervisor.start({
  launchId: "launch-resume-1",
  sessionId: "session-resume-1",
  conversationId: "conversation-1",
  runId: "run-resume-1",
  agentType: "codex",
  workspaceId: workspace.workspace_id,
  resumeConversationId: "conversation-1",
  nativeSessionId: "thread-native-1",
});
assert.equal(persistedDuplicate.duplicate, true);
assert.equal(persistedDuplicate.conversationId, "conversation-1");

const inheritedChild = join(workspace.canonical_path, "inherited-child");
mkdirSync(inheritedChild);
const inheritedLaunch = await supervisor.start({
  launchId: "launch-inherited-child",
  sessionId: "session-inherited-child",
  conversationId: "conversation-inherited-child",
  runId: "run-inherited-child",
  agentType: "codex",
  workspaceId: inheritedChild,
  permissionProfile: "guarded",
});
assert.equal(inheritedLaunch.accepted, true);
assert.equal(inheritedLaunch.workspacePath, inheritedChild);
assert.notEqual(inheritedLaunch.workspaceId, workspace.workspace_id);
assert.equal(spawns.at(-1).options.cwd, inheritedChild);
assert.equal(catalog.getWorkspace(inheritedChild, { deviceId: "device-1" }).trusted, true);

await supervisor.start({
  launchId: "launch-cancelled",
  sessionId: "session-cancelled",
  conversationId: "conversation-cancelled",
  runId: "run-cancelled",
  agentType: "claude",
  workspaceId: workspace.workspace_id,
});
catalog.finishSession("session-cancelled", { status: "stopped" });
child.emit("exit", 0, null);
const cancelledRun = catalog
  .getConversation("conversation-cancelled")
  .runs.find((item) => item.originrouter_session_id === "session-cancelled");
assert.equal(cancelledRun.status, "stopped");
catalog.close();

console.log("managed Agent supervisor tests ok");
