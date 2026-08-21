import assert from "node:assert/strict";
import test from "node:test";

import { projectCollaborationActivity } from "../src/collaboration/activityPresentation.js";

function event(sequence, type, overrides = {}) {
  return {
    event_id: `event-${sequence}`,
    sequence,
    type,
    participant_id: "remote_operator",
    category: type.split(".")[0],
    severity: "info",
    visibility: "detail",
    summary: type,
    detail: "",
    metadata: {},
    ...overrides,
  };
}

test("collapsed activity groups operational events without exposing protocol payloads", () => {
  const events = [
    event(1, "user.text", {
      detail: "<originrouter_collaboration>{\"secret\":\"protocol\"}</originrouter_collaboration>",
    }),
    ...Array.from({ length: 10 }, (_, index) => event(2 + index, "agent.tool_call.start", {
      metadata: { activity: index < 6 ? "search" : "command", tool: index < 6 ? "rg" : "exec" },
    })),
    ...Array.from({ length: 10 }, (_, index) => event(12 + index, "agent.tool_call.end", {
      metadata: { activity: index < 6 ? "search" : "command", tool: index < 6 ? "rg" : "exec" },
    })),
    ...Array.from({ length: 8 }, (_, index) => event(22 + index, "agent.interaction.requested")),
    ...Array.from({ length: 8 }, (_, index) => event(30 + index, "approval.resolved", {
      category: "approval",
    })),
  ];
  const groups = projectCollaborationActivity(events, {
    participantLabels: { remote_operator: "Remote Operator" },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Remote Operator worked");
  assert.match(groups[0].summary, /6 explorations/);
  assert.match(groups[0].summary, /4 commands/);
  assert.match(groups[0].summary, /8 permissions handled/);
  assert.doesNotMatch(JSON.stringify(groups), /originrouter_collaboration|secret|protocol/);
});

test("expanded activity humanizes structured details and deduplicates replayed events", () => {
  const structured = event(1, "agent.text", {
    detail: JSON.stringify({ status: "ok", path: "/Users/example/project", ignored: "raw" }),
  });
  const groups = projectCollaborationActivity([structured, structured], {
    expanded: true,
    participantLabels: { remote_operator: "Remote Operator" },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 1);
  assert.match(groups[0].details.join("\n"), /status: ok/);
  assert.match(groups[0].details.join("\n"), /path: \/Users\/example\/project/);
  assert.doesNotMatch(groups[0].details.join("\n"), /ignored|\{\"status\"/);
});

test("warnings and failures remain visible even when they are not Agent activity", () => {
  const groups = projectCollaborationActivity([
    event(1, "device.waiting", {
      participant_id: null,
      category: "device",
      severity: "warning",
      visibility: "summary",
      summary: "Remote device is unavailable",
    }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].marker, "warning");
  assert.equal(groups[0].title, "Remote device is unavailable");
});
