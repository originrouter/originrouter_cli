import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentCatalog } from "../src/persistence/agentCatalog.js";
import {
  ExternalAgentRegistry,
  isCollaborationSessionPayload,
} from "../src/local/externalAgentRegistry.js";

assert.equal(isCollaborationSessionPayload({ runId: "acr_run-1" }), true);
assert.equal(isCollaborationSessionPayload({ sessionId: "collab-remote-1" }), true);
assert.equal(isCollaborationSessionPayload({ startedBy: "collaboration-runtime" }), true);
assert.equal(isCollaborationSessionPayload({ sessionId: "agent-1", runId: "run-1" }), false);

let now = 1_000_000;
const registry = new ExternalAgentRegistry({ now: () => now });
registry.register({
  sessionId: "claude-local-1",
  agent: "claude",
  deviceId: "device-local",
  deviceName: "MacBook",
});

const command = registry.enqueueCommand("claude-local-1", {
  type: "agent.message",
  message: "hello",
});
const queued = registry.commandsAfter("claude-local-1", 0);
assert.equal(queued.commands.length, 1);
assert.equal(queued.commands[0].commandId, command.commandId);

registry.appendEvent("claude-local-1", { type: "agent.text", text: "reply" });
registry.appendEvent("claude-local-1", {
  type: "agent.text",
  text: "reported once",
  eventId: "stable-event-1",
});
registry.appendEvent("claude-local-1", {
  type: "agent.text",
  text: "duplicate retry",
  eventId: "stable-event-1",
});
registry.appendEvent("claude-local-1", {
  type: "agent.interaction.requested",
  interactionId: "interaction-1",
  kind: "questions",
});
registry.appendEvent("claude-local-1", {
  type: "agent.mode.status",
  mode: "plan",
  modeControl: "supported",
  availableModes: [{ id: "default", label: "Default" }, { id: "plan", label: "Plan" }],
});
registry.appendEvent("claude-local-1", {
  type: "agent.autonomy.status",
  autonomyProfile: "guarded",
  autonomyControl: "supported",
  availableAutonomyProfiles: [
    { id: "manual", label: "Manual" },
    { id: "guarded", label: "Guarded" },
  ],
  allowedAutonomyScopes: ["workspace_edits"],
  availableAutonomyScopes: [
    { id: "workspace_edits", label: "Workspace file edits", risk: "normal" },
    { id: "destructive_commands", label: "Destructive commands", risk: "high" },
  ],
  approvalPolicyCapabilities: {
    versions: [1, 2],
    latest_version: 2,
    registry_hash: "a".repeat(64),
  },
});
const events = registry.eventsAfter(0);
assert.equal(events.events.length, 5);
assert.equal(events.events[0].text, "reply");
assert.equal(
  events.events.filter((event) => event.eventId === "stable-event-1").length,
  1,
);
assert.ok(events.cursor > 0);
assert.equal(events.latestCursor, events.cursor);
assert.match(events.streamId, /^local_stream_/);
assert.notEqual(
  new ExternalAgentRegistry().eventsAfter(0).streamId,
  events.streamId,
);
assert.equal(registry.list()[0].pending_approval_count, 1);
assert.equal(registry.list()[0].session_kind, "interactive");
assert.equal(registry.list()[0].status, "waiting_input");
assert.equal(registry.list()[0].current_step, "Waiting for input");
assert.equal(registry.list()[0].mode, "plan");
assert.equal(registry.list()[0].autonomy_profile, "guarded");
assert.equal(registry.list()[0].autonomy_control, "supported");
assert.deepEqual(registry.list()[0].allowed_autonomy_scopes, ["workspace_edits"]);
assert.equal(registry.list()[0].available_autonomy_scopes.length, 2);
assert.deepEqual(registry.list()[0].approval_policy_capabilities.versions, [1, 2]);
const aiStatus = {
  type: "agent.autonomy.status", autonomyProfile: "ai_review", accepted: true,
  requestId: "apply-ai-1",
  aiReviewPolicy: { templateId: "ait_daily_tests", name: "Daily tests", version: 2, contentHash: "b".repeat(64) },
};
registry.appendEvent("claude-local-1", aiStatus);
assert.deepEqual(registry.list()[0].ai_review_policy, aiStatus.aiReviewPolicy);
for (let i = 0; i < 510; i++) registry.appendEvent("claude-local-1", { type: "agent.activity", summary: `activity ${i}` });
assert.equal(registry.controlSnapshot("claude-local-1").autonomy.requestId, "apply-ai-1");
assert.equal(registry.controlSnapshot("claude-local-1").controlResults[0].requestId, "apply-ai-1");
registry.appendEvent("claude-local-1", { type: "agent.autonomy.status", autonomyProfile: "manual", aiReviewPolicy: null, approvalPolicy: null });
assert.equal(registry.list()[0].ai_review_policy, null);
registry.appendEvent("claude-local-1", {
  type: "agent.interaction.result",
  interactionId: "interaction-1",
  status: "applied",
});
assert.equal(registry.list()[0].pending_approval_count, 0);
assert.equal(registry.list()[0].status, "running");

registry.appendEvent("claude-local-1", {
  type: "agent.interaction.requested",
  interactionId: "permission-1",
  kind: "permission",
});
assert.equal(registry.list()[0].status, "waiting_approval");
assert.equal(registry.list()[0].current_step, "Waiting for approval");
registry.appendEvent("claude-local-1", {
  type: "agent.interaction.result",
  interactionId: "permission-1",
  status: "applied",
});
assert.equal(registry.list()[0].status, "running");

registry.appendEvent("claude-local-1", {
  type: "agent.task.complete",
});
assert.equal(registry.list()[0].current_step, "Ready");
registry.appendEvent("claude-local-1", {
  type: "agent.interaction.result", interactionId: "permission-1", status: "expired",
});
assert.equal(registry.list()[0].turn_state, "idle");
assert.equal(registry.list()[0].current_step, "Ready");
registry.appendEvent("claude-local-1", {
  type: "agent.permission.resolved", callId: "permission-1", reason: "timeout",
});
assert.equal(registry.list()[0].turn_state, "idle");

const commandStream = registry.commandsAfter("claude-local-1").streamId;
assert.ok(commandStream);
registry.register({ sessionId: "claude-local-1", agent: "claude" });
assert.equal(registry.commandsAfter("claude-local-1").streamId, commandStream);
const restartedRegistry = new ExternalAgentRegistry();
restartedRegistry.register({ sessionId: "claude-local-1", agent: "claude" });
assert.notEqual(restartedRegistry.commandsAfter("claude-local-1").streamId, commandStream);
{
  const lateSubscriber = new ExternalAgentRegistry();
  lateSubscriber.register({ sessionId: "late-subscriber", agent: "claude" });
  lateSubscriber.appendEvent("late-subscriber", {
    type: "agent.interaction.requested", interactionId: "long-lived-permission", kind: "permission",
  });
  for (let n = 0; n < 550; n++) lateSubscriber.appendEvent("late-subscriber", {
    type: "agent.activity", summary: `background-${n}`,
  });
  assert.equal(lateSubscriber.controlSnapshot("late-subscriber").interactions.length, 1);
  lateSubscriber.appendEvent("late-subscriber", {
    type: "agent.interaction.result", interactionId: "long-lived-permission", status: "canceled",
  });
  assert.equal(lateSubscriber.controlSnapshot("late-subscriber").interactions.length, 0);
}

registry.register({
  sessionId: "collab-worker-1",
  runId: "acr_run-1",
  startedBy: "collaboration-runtime",
  agent: "claude",
});
assert.equal(registry.isCollaborationSession("collab-worker-1"), true);
{
  const isolated = new ExternalAgentRegistry();
  isolated.register({ sessionId: "visible", agent: "claude" });
  // An explicit kind must work without relying on the session-id prefix.
  isolated.register({ sessionId: "hidden", agent: "codex", sessionKind: "collaboration" });
  isolated.register({ sessionId: "hidden", agent: "codex", sessionKind: "interactive" });
  assert.equal(isolated.isCollaborationSession("hidden"), true,
    "re-registration cannot move a worker out of its collaboration run");
  const notifications = [];
  const unsubscribe = isolated.subscribe((event) => notifications.push(event));
  isolated.appendEvent("visible", { type: "agent.text", text: "ordinary" });
  isolated.appendEvent("hidden", {
    type: "agent.interaction.requested", interactionId: "approval", kind: "permission",
  });
  const publicPage = isolated.eventsAfter(0, { includeCollaboration: false });
  assert.deepEqual(publicPage.events.map((event) => event.sessionId), ["visible"]);
  assert.equal(publicPage.cursor, publicPage.latestCursor);
  assert.equal(isolated.eventsAfter(publicPage.cursor, { includeCollaboration: false }).events.length, 0);
  assert.equal(isolated.eventsAfter(0).events.length, 2);
  assert.equal(notifications.length, 2, "coordinator still receives worker notifications");
  assert.equal(isolated.controlSnapshot("hidden").interactions.length, 1);
  isolated.enqueueCommand("hidden", { type: "agent.interaction.resolve", interactionId: "approval" });
  assert.equal(isolated.commandsAfter("hidden").commands.length, 1);
  isolated.appendEvent("visible", { type: "agent.text", text: "next ordinary" });
  assert.equal(isolated.eventsAfter(publicPage.cursor, { includeCollaboration: false }).events[0].text, "next ordinary");
  unsubscribe();
}
assert.equal(registry.list({ includeCollaboration: false }).some(
  (session) => session.session_id === "collab-worker-1",
), false);
assert.equal(registry.list().some(
  (session) => session.session_id === "collab-worker-1"
    && session.session_kind === "collaboration",
), true);
registry.appendEvent("claude-local-1", {
  type: "agent.activity",
  activity: "rate_limit",
  summary: "Codex rate limit status changed",
});
assert.equal(registry.list()[0].current_step, "Ready");
registry.appendEvent("claude-local-1", {
  type: "agent.activity",
  activity: "mcp_status",
  summary: "Codex MCP server status changed",
});
assert.equal(registry.list()[0].current_step, "Ready");

registry.appendEvent("claude-local-1", {
  type: "agent.interaction.requested",
  interactionId: "old-conversation-input",
  kind: "questions",
});
registry.update("claude-local-1", {
  conversationId: "claude:native-session-2",
  nativeSessionId: "native-session-2",
  transcriptPath: "/tmp/native-session-2.jsonl",
});
assert.equal(registry.eventsAfter(0).events.length, 0);
assert.equal(registry.list()[0].pending_approval_count, 0);
assert.equal(registry.list()[0].conversation_id, "claude:native-session-2");
assert.equal(registry.list()[0].native_session_id, "native-session-2");
assert.equal(registry.list()[0].current_step, "Running locally");

registry.appendEvent("claude-local-1", {
  type: "agent.text",
  text: "new conversation",
});
registry.register({
  sessionId: "claude-local-1",
  agent: "claude",
  conversationId: "claude:native-session-3",
  nativeSessionId: "native-session-3",
  transcriptPath: "/tmp/native-session-3.jsonl",
});
assert.equal(registry.eventsAfter(0).events.length, 0);
assert.equal(registry.list()[0].conversation_id, "claude:native-session-3");
assert.equal(registry.list()[0].native_session_id, "native-session-3");

now += 91_000;
assert.equal(registry.list()[0].status, "stopped");

{
  // An online-but-idle Agent must never report an active turn: `status`
  // describes the long-lived process, so treating it as turn activity opened
  // the App with a stop button and flickered against every refresh.
  let clock = 5_000_000;
  const turns = new ExternalAgentRegistry({ now: () => clock });
  turns.register({ sessionId: "turn-1", agent: "claude" });
  assert.equal(turns.list()[0].status, "running");
  assert.equal(turns.list()[0].turn_state, "idle");

  turns.appendEvent("turn-1", { type: "agent.task.started" });
  assert.equal(turns.list()[0].turn_state, "running");

  // The snapshot must agree with the session projection. Publishing the raw
  // latch alongside a gated projection is what made the App alternate.
  const active = turns.controlSnapshot("turn-1");
  assert.equal(active.turn_state, active.session.turn_state);
  assert.equal(active.turn_state, "running");

  // An interrupted turn is terminal even though the process stays online.
  turns.appendEvent("turn-1", { type: "agent.task.aborted" });
  assert.equal(turns.list()[0].status, "running");
  assert.equal(turns.list()[0].turn_state, "idle");
  const idle = turns.controlSnapshot("turn-1");
  assert.equal(idle.turn_state, idle.session.turn_state);
  assert.equal(idle.turn_state, "idle");

  // A thinking block is content inside an assistant message, not a turn
  // boundary. The SDK's result message can land before it, so the CLI emits
  // `agent.task.started → task_result_ready → agent.thinking → agent.text`
  // within one turn. Reading that trailing thinking as a fresh turn start
  // re-latched a finished turn to "running" and left the App offering a stop
  // button for an idle Agent. It may EXTEND a turn, never open one.
  turns.appendEvent("turn-1", { type: "agent.thinking" });
  assert.equal(turns.list()[0].turn_state, "idle");

  // ...but it must extend a turn that is genuinely still open.
  turns.appendEvent("turn-1", { type: "agent.task.started" });
  assert.equal(turns.list()[0].turn_state, "running");
  turns.appendEvent("turn-1", { type: "agent.thinking" });
  assert.equal(turns.list()[0].turn_state, "running");
  turns.appendEvent("turn-1", { type: "agent.task.aborted" });
  assert.equal(turns.list()[0].turn_state, "idle");

  // Re-registration is a fresh attach: a turn that ended while the App was
  // away must not be resurrected as an active turn.
  turns.appendEvent("turn-1", { type: "agent.thinking" });
  assert.equal(turns.list()[0].turn_state, "idle");
  turns.register({ sessionId: "turn-1", agent: "claude" });
  assert.equal(turns.list()[0].turn_state, "idle");

  // A process that is gone cannot own a turn.
  turns.appendEvent("turn-1", { type: "agent.task.started" });
  assert.equal(turns.list()[0].turn_state, "running");
  clock += 91_000;
  assert.equal(turns.list()[0].status, "stopped");
  assert.equal(turns.list()[0].turn_state, "idle");
}

{
  // The process's own end ends the turn, and it says so in the tail.
  //
  // The App's transcript reads the tail, and the tail used to stop at the
  // last thing the run said. When the process died the App's last word was
  // still `agent.task.started`, so it kept a turn latched as open and showed
  // the **stop** button for a session with nothing left to stop.
  let clock = 6_000_000;
  const exits = new ExternalAgentRegistry({ now: () => clock });
  exits.register({ sessionId: "exit-1", agent: "claude" });
  exits.appendEvent("exit-1", { type: "agent.task.started" });
  assert.equal(exits.list()[0].turn_state, "running");

  exits.appendEvent("exit-1", { type: "session.exited", code: 0 });
  assert.equal(exits.list()[0].turn_state, "idle");

  // The same for a runtime that reported an error.
  exits.appendEvent("exit-1", { type: "agent.task.started" });
  assert.equal(exits.list()[0].turn_state, "running");
  exits.appendEvent("exit-1", { type: "session.error", message: "boom" });
  assert.equal(exits.list()[0].turn_state, "idle");

  // And the fact itself is in the tail, where the App reads it.
  const tail = exits.eventsAfter(0);
  const types = tail.events.map((event) => event.type);
  assert.ok(types.includes("session.exited"));
  assert.ok(types.includes("session.error"));
}

{
  // An unregister ends the process, not the run. The row stays so the
  // durable facts it still names — above all the transcript — remain
  // answerable; what goes is everything only a live process could consume.
  let clock = 7_000_000;
  const retained = new ExternalAgentRegistry({ now: () => clock });
  retained.register({
    sessionId: "done-1",
    agent: "claude",
    transcriptPath: "/tmp/done-1.jsonl",
  });
  retained.appendEvent("done-1", { type: "agent.text", text: "bye" });
  retained.enqueueCommand("done-1", { type: "agent.message", message: "queued" });
  retained.appendEvent("done-1", {
    type: "agent.interaction.requested",
    interactionId: "ask-1",
    kind: "permission",
  });
  assert.equal(retained.unregister("done-1"), true);

  assert.equal(retained.has("done-1"), true, "the run is still known");
  const stoppedRow = retained.list().find((row) => row.session_id === "done-1");
  assert.equal(stoppedRow.status, "stopped");
  assert.equal(stoppedRow.attached, false);
  assert.equal(stoppedRow.pending_approval_count, 0,
    "a dead process holds no pending approvals");
  assert.throws(() => retained.commandsAfter("done-1"), /not active/);
  assert.throws(() => retained.enqueueCommand("done-1", { type: "agent.message" }),
    /not active/);
  // `require` — the read gate — still passes. The transcript file itself is a
  // filesystem concern, so a missing path must surface as a file error, not
  // as "this daemon never heard of the session".
  // `require` — the read gate — still passes. A transcript that is gone
  // from disk reads as an empty page, not as "this daemon never heard of
  // the session".
  assert.equal(retained.history("done-1").messages.length, 0);
  assert.equal(
    retained.controlSnapshot("done-1").session.status,
    "stopped",
  );

  // Registering the same session id again is the merge path a reconnected
  // wrapper already uses: the retained row re-attaches, its event tail
  // survives, and no second session appears.
  retained.register({ sessionId: "done-1", agent: "claude" });
  const revived = retained.list().find((row) => row.session_id === "done-1");
  assert.equal(revived.status, "running");
  assert.equal(revived.attached, true);
  assert.equal(
    retained.list().filter((row) => row.session_id === "done-1").length,
    1,
  );
  assert.equal(
    retained.eventsAfter(0).events.some((event) => event.text === "bye"),
    true,
  );
}

{
  // A daemon restart used to blank the registry: every finished session the
  // App asked about answered `session_not_registered` forever, and every run
  // the catalog still believed live stayed `running` in the catalog with no
  // process behind it. The durable half of the registry is rebuilt from the
  // catalog instead.
  const home = mkdtempSync(join(tmpdir(), "originrouter-registry-rehydrate-"));
  try {
    let clock = Date.parse("2026-11-16T10:00:00Z");
    const catalog = new AgentCatalog({ stateDir: home });
    catalog.upsertSession({
      sessionId: "maybe-live-1",
      conversationId: "maybe-live-1",
      runId: "run-live-1",
      agent: "claude",
      title: "Still working",
      deviceId: "device-1",
      cwd: "/srv/live",
      status: "running",
      nativeSessionId: "native-live-1",
      transcriptPath: "/tmp/native-live-1.jsonl",
      startedAt: "2026-11-16T09:00:00Z",
    });
    catalog.upsertSession({
      sessionId: "zombie-run-1",
      conversationId: "zombie-run-1",
      runId: "run-zombie-1",
      agent: "claude",
      title: "Died with the old daemon",
      deviceId: "device-1",
      status: "running",
      startedAt: "2026-11-16T08:00:00Z",
    });
    catalog.upsertSession({
      sessionId: "finished-run-1",
      conversationId: "finished-conv-1",
      runId: "run-finished-1",
      agent: "claude",
      title: "Done and dusted",
      deviceId: "device-1",
      status: "stopped",
      nativeSessionId: "native-finished-1",
      transcriptPath: "/tmp/native-finished-1.jsonl",
      startedAt: "2026-11-16T07:00:00Z",
      exitedAt: "2026-11-16T07:30:00Z",
    });

    const restored = new ExternalAgentRegistry({ catalog, now: () => clock });
    const rows = Object.fromEntries(
      restored.list().map((row) => [row.session_id, row]),
    );

    // A run that ended cleanly comes back as it ended: detached, stopped,
    // still naming its transcript and its conversation.
    assert.equal(rows["finished-run-1"].status, "stopped");
    assert.equal(rows["finished-run-1"].attached, false);
    assert.equal(rows["finished-run-1"].conversation_id, "finished-conv-1");
    assert.equal(
      restored.sessionFacts("finished-run-1").attached,
      false,
    );
    assert.equal(
      restored.history("finished-run-1").messages.length,
      0,
      "a transcript gone from disk reads as an empty page",
    );

    // A run the catalog last saw live gets the stale window: running but not
    // yet attached. The first wrapper call is the proof of life that
    // re-attaches it, and commands queued during the gap are drained.
    assert.equal(rows["maybe-live-1"].status, "running");
    assert.equal(rows["maybe-live-1"].attached, false);
    restored.enqueueCommand("maybe-live-1", {
      type: "agent.message",
      message: "sent while the daemon was down",
    });
    const drained = restored.commandsAfter("maybe-live-1", 0);
    assert.equal(drained.commands.length, 1);
    assert.equal(
      restored.list().find((row) => row.session_id === "maybe-live-1")
        .attached,
      true,
      "the polling wrapper re-attaches its own row",
    );

    // A run whose process died with the old daemon gets its grace window,
    // then `expireStale` finishes it — including the catalog row it left
    // marked `running`.
    clock += 91_000;
    assert.equal(
      restored.list().find((row) => row.session_id === "zombie-run-1")
        .status,
      "stopped",
    );
    const zombieRun = catalog.getConversation("zombie-run-1").runs
      .find((run) => run.originrouter_session_id === "zombie-run-1");
    assert.equal(zombieRun.status, "stopped");
    assert.ok(zombieRun.exited_at);

    catalog.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

console.log("external agent registry tests ok");
