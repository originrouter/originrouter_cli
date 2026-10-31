// The reasoning effort of a run.
//
// The runtime owns the vocabulary: it publishes `agent.effort.status` with
// the levels it can actually apply to a running turn, the registry folds
// that into the session record, and the control snapshot and the session
// projection carry it out.
//
// Two rules are pinned here:
//
//   1. The App is given the device's list, not a list of its own. A level
//      the runtime cannot take is a row that fails when tapped.
//   2. The command path reaches the runtime the same way the model's does:
//      E2EE-only on the relay, a session command in the daemon, and a
//      `/effort` twin of the `/model` endpoint on the local API.

import assert from "node:assert/strict";

import {
  AGENT_EFFORT_LEVELS,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  claudeEffortSettings,
  effortLevelsForRuntime,
  normalizeAgentEffort,
} from "../src/runtime/agentEffort.js";
import { buildCodexCollaborationMode } from "../src/runtime/codexAppServerPrimitives.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";
import { ExternalAgentRelayRouter } from "../src/daemon/externalAgentRelayRouter.js";
import { PROTECTED_DEVICE_MESSAGE_TYPES } from "../src/security/deviceE2eeRelayTransport.js";

// The vocabulary.
//
// The whole vocabulary is the union of what the runtimes can take, not what
// any one of them can take: `minimal` sits below `low` and `ultra` above
// `max`, and only the app-server speaks for both. Which of them a session
// may use is a question the device answers, per model.
assert.deepEqual(AGENT_EFFORT_LEVELS, [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
assert.equal(normalizeAgentEffort("HIGH"), "high");
assert.equal(normalizeAgentEffort("  medium "), "medium");
assert.equal(normalizeAgentEffort("minimal"), "minimal");
assert.equal(normalizeAgentEffort("ultra"), "ultra");
assert.equal(normalizeAgentEffort("persistent"), null);
assert.equal(normalizeAgentEffort(""), null);
assert.equal(normalizeAgentEffort(null), null);

// Claude's settings layer holds four levels plus the one that turns thinking
// off. `max` is a launch flag, so a running session has no way to take it.
assert.deepEqual(CLAUDE_EFFORT_LEVELS, ["none", "low", "medium", "high", "xhigh"]);
assert.deepEqual(CODEX_EFFORT_LEVELS, AGENT_EFFORT_LEVELS);

assert.deepEqual(effortLevelsForRuntime("claude-sdk"), CLAUDE_EFFORT_LEVELS);
assert.deepEqual(effortLevelsForRuntime("codex-app-server"), CODEX_EFFORT_LEVELS);
// A runtime that cannot take an effort publishes nothing, and the App draws
// nothing rather than rows that fail.
assert.deepEqual(effortLevelsForRuntime("claude-pty"), []);

// `none` is the absence of thinking, not a level of it.
assert.deepEqual(claudeEffortSettings("none"), { alwaysThinkingEnabled: false });
assert.deepEqual(claudeEffortSettings("xhigh"), {
  effortLevel: "xhigh",
  alwaysThinkingEnabled: true,
});

// Codex reads the level from inside the collaboration mode.
//
// The app-server gives a collaboration mode precedence over the request's own
// `effort`, and it replaces the mode's settings wholesale rather than
// merging them. A level sent beside the mode is dropped, and a mode that
// leaves the level out clears the one the reader chose — so the level rides
// inside the mode, and every level the App offers is a level the protocol
// spells.
assert.deepEqual(buildCodexCollaborationMode("default", "gpt-5.4", "xhigh"), {
  mode: "default",
  settings: {
    model: "gpt-5.4",
    reasoning_effort: "xhigh",
    developer_instructions: null,
  },
});
// A session nobody has put on a level says nothing rather than clearing one.
assert.deepEqual(buildCodexCollaborationMode("default", "gpt-5.4"), {
  mode: "default",
  settings: {
    model: "gpt-5.4",
    reasoning_effort: null,
    developer_instructions: null,
  },
});
for (const level of CODEX_EFFORT_LEVELS) {
  const mode = buildCodexCollaborationMode("default", "gpt-5.4", level);
  assert.equal(mode.settings.reasoning_effort, level);
}

// The command must not fall back to the plaintext relay.
assert.equal(PROTECTED_DEVICE_MESSAGE_TYPES.has("agent.effort.set"), true);

// The daemon must recognise it as a session command.
const commands = [];
const router = new ExternalAgentRelayRouter({
  registry: {
    has: () => true,
    enqueueCommand: (sessionId, payload) => {
      commands.push({ sessionId, payload });
      return { commandId: "c1", commandSequence: 1 };
    },
  },
  relayClient: { send: async () => {} },
});
assert.equal(
  await router.handle({
    type: "agent.effort.set",
    sessionId: "s1",
    effort: "high",
  }),
  true,
);
assert.equal(commands.length, 1);
assert.equal(commands[0].payload.type, "agent.effort.set");
assert.equal(commands[0].payload.effort, "high");

// The registry folds the status event into the session.
let now = 1_000_000;
const registry = new ExternalAgentRegistry({ now: () => now });
registry.register({
  sessionId: "claude-local-1",
  agent: "claude",
  deviceId: "device-local",
  deviceName: "MacBook",
});

// Before the runtime says anything, the session has no effort and the
// device publishes no levels: there is nothing to draw.
let snapshot = registry.controlSnapshot("claude-local-1");
assert.equal(snapshot.effort, null);
assert.equal(snapshot.effortControl, "unsupported");
assert.deepEqual(snapshot.availableEfforts, []);

registry.appendEvent("claude-local-1", {
  type: "agent.effort.status",
  effort: "high",
  effortControl: "supported",
  availableEfforts: CLAUDE_EFFORT_LEVELS,
});
snapshot = registry.controlSnapshot("claude-local-1");
assert.equal(snapshot.effort, "high");
assert.equal(snapshot.effortControl, "supported");
assert.deepEqual(snapshot.availableEfforts, CLAUDE_EFFORT_LEVELS);

let projected = registry.list().find((item) => item.session_id === "claude-local-1");
assert.equal(projected.effort, "high");
assert.equal(projected.effort_control, "supported");
assert.deepEqual(projected.available_efforts, CLAUDE_EFFORT_LEVELS);

// The command's own answer is reachable by its requestId, so the App can
// learn that the change it asked for did not happen.
registry.appendEvent("claude-local-1", {
  type: "agent.effort.status",
  effort: "high",
  effortControl: "supported",
  availableEfforts: CLAUDE_EFFORT_LEVELS,
  requestId: "req-1",
  accepted: false,
  reason: "effort_level_unsupported",
});
const results = registry.controlSnapshot("claude-local-1").controlResults;
assert.equal(results.length, 1);
assert.equal(results[0].requestId, "req-1");
assert.equal(results[0].accepted, false);
assert.equal(results[0].reason, "effort_level_unsupported");

console.log("agentEffort: ok");
