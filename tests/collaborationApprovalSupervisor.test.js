import assert from "node:assert/strict";

import { CollaborationApprovalSupervisor } from "../src/collaboration/collaborationApprovalSupervisor.js";

const supervisor = new CollaborationApprovalSupervisor();
const request = (command) => ({
  interactionId: `permission-${command}`,
  kind: "permission",
  title: "Bash needs permission",
  payload: { tool: "Bash", command, cwd: process.cwd() },
});
const decide = (agentProfile, sessionProfile, command = "uptime") => supervisor.evaluate({
  request: request(command),
  agent: { runtime: "codex", permission_profile: agentProfile },
  run: { supervisor_permission_profile: sessionProfile },
  workspaceRoot: process.cwd(),
});

let result = await decide("unrestricted", "guarded");
assert.equal(result.effect, "allow");
assert.deepEqual(result.layers.map((layer) => layer.effect), ["allow", "allow"]);

result = await decide("guarded", "unrestricted", "rm -rf ./build");
assert.notEqual(result.effect, "allow", "Session Full must not widen an Agent Guarded limit");

result = await decide("unrestricted", "guarded", "rm -rf ./build");
assert.equal(result.effect, "ask", "Agent Full must not widen Session Guarded");

result = await decide("manual", "unrestricted");
assert.equal(result.effect, "ask", "either manual layer requires user confirmation");

result = await decide("unrestricted", "unrestricted", "rm -rf ./build");
assert.equal(result.effect, "allow", "both layers must allow before automatic approval");
assert.equal(result.response.remember_for_session, false);

console.log("collaboration approval supervisor tests passed");
