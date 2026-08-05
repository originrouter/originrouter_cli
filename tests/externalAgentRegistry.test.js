import assert from "node:assert/strict";

import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";

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
assert.equal(registry.list()[0].status, "waiting_input");
assert.equal(registry.list()[0].current_step, "Waiting for input");
assert.equal(registry.list()[0].mode, "plan");
assert.equal(registry.list()[0].autonomy_profile, "guarded");
assert.equal(registry.list()[0].autonomy_control, "supported");
assert.deepEqual(registry.list()[0].allowed_autonomy_scopes, ["workspace_edits"]);
assert.equal(registry.list()[0].available_autonomy_scopes.length, 2);
assert.deepEqual(registry.list()[0].approval_policy_capabilities.versions, [1, 2]);
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

now += 91_000;
assert.equal(registry.list()[0].status, "stopped");

console.log("external agent registry tests ok");
