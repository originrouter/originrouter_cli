import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {
  decisionToElicitationHookJson,
  decisionToHookJson,
  startClaudeHookServer,
} from "../src/adapters/claude/hookServer.js";
import { permissionEventToInteraction } from "../src/runtime/agentInteractionContract.js";

// v1 conservative mapping. `approved_for_session` is intentionally identical
// to `approved` until the exact `updatedPermissions` wire format is verified
// against a live Claude Code session.

const permissionOutput = (decision) => ({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision,
  },
});

assert.deepEqual(
  decisionToHookJson("approved"),
  permissionOutput({ behavior: "allow" })
);

assert.deepEqual(
  decisionToHookJson("approved_for_session"),
  permissionOutput({ behavior: "allow" }),
  "approved_for_session must be plain allow in v1 (no updatedPermissions)"
);

assert.deepEqual(
  decisionToHookJson("denied"),
  permissionOutput({
    behavior: "deny",
    message: "Denied by OriginRouter remote approval.",
  })
);

assert.deepEqual(
  decisionToHookJson("abort"),
  permissionOutput({
    behavior: "deny",
    interrupt: true,
    message: "Aborted by OriginRouter remote approval.",
  })
);

assert.deepEqual(
  decisionToHookJson("timeout"),
  permissionOutput({
    behavior: "deny",
    message: "OriginRouter remote approval timed out. Please retry or approve locally.",
  })
);

// Unknown decisions fall back to deny with a clear message rather than
// silently doing nothing.
const fallback = decisionToHookJson("wat");
assert.equal(fallback.hookSpecificOutput.decision.behavior, "deny");
assert.match(fallback.hookSpecificOutput.decision.message, /Unknown decision/);

// Stage 8.0A: `approved_for_session` echoes `permission_suggestions` back
// as `updatedPermissions` so Claude Code persists a session-scoped rule.
// The shape follows Claude Code's documented hook response:
//   { hookSpecificOutput: { hookEventName: "PermissionRequest",
//                           decision: { behavior: "allow",
//                                       updatedPermissions: [...] } } }
const ruleSuggestions = [
  {
    type: "addRules",
    rules: [
      { toolName: "Bash", ruleContent: "Allow `npm test` and `npm run build`" },
    ],
    behavior: "allow",
  },
];
const echoed = decisionToHookJson("approved_for_session", { permissionSuggestions: ruleSuggestions });
assert.deepEqual(
  echoed,
  permissionOutput({ behavior: "allow", updatedPermissions: ruleSuggestions }),
  "approved_for_session + suggestions must echo updatedPermissions",
);

// Empty suggestions array must fall back to the v1 plain allow.
const empty = decisionToHookJson("approved_for_session", { permissionSuggestions: [] });
assert.deepEqual(
  empty,
  permissionOutput({ behavior: "allow" }),
  "approved_for_session + empty suggestions must fall back to v1 plain allow",
);
// `approved` (one-shot) never carries updatedPermissions even if
// suggestions are passed.
const approvedWithSuggestions = decisionToHookJson("approved", { permissionSuggestions: ruleSuggestions });
assert.deepEqual(
  approvedWithSuggestions,
  permissionOutput({ behavior: "allow" }),
  "approved (one-shot) must never echo updatedPermissions",
);

assert.deepEqual(
  decisionToElicitationHookJson("accept", { content: { account: "primary" } }),
  {
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      action: "accept",
      content: { account: "primary" },
    },
  },
);
assert.equal(
  decisionToElicitationHookJson("cancel").hookSpecificOutput.action,
  "cancel",
);
assert.equal(
  decisionToElicitationHookJson("unknown").hookSpecificOutput.action,
  "decline",
);

const postJson = (port, path, payload) => new Promise((resolve, reject) => {
  const body = JSON.stringify(payload);
  const req = httpRequest({
    host: "127.0.0.1",
    port,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  });
  req.on("error", reject);
  req.end(body);
});

{
  let hookServer;
  hookServer = await startClaudeHookServer({
    onElicitationRequest(interactionId) {
      setImmediate(() => hookServer.resolveElicitation({
        interactionId,
        action: "accept",
        content: { account: "primary" },
      }));
    },
  });
  try {
    const response = await postJson(hookServer.port, "/hook/elicitation", {
      hook_event_name: "Elicitation",
      elicitation_id: "elicit-http-1",
      mode: "form",
      mcp_server_name: "github",
      message: "Choose an account",
      requested_schema: { type: "object" },
    });
    assert.deepEqual(response, decisionToElicitationHookJson("accept", {
      content: { account: "primary" },
    }));
  } finally {
    hookServer.stop();
  }
}

// ---- Stage 8.9: structural round-trip via permissionEventToInteraction ----

{
  const legacy = {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: "claude-perm-1",
    tool: "Bash",
    input: { command: "npm test" },
    permissionSuggestions: [],
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: ["approved", "approved_for_session", "denied", "abort"],
    },
  };
  const interaction = permissionEventToInteraction(legacy, {
    source: "hook",
    sessionId: "s-test",
  });
  assert.equal(interaction.interactionId, legacy.callId,
    "new envelope's interactionId equals the legacy callId");
  assert.equal(interaction.resolution.eventType, "agent.interaction.resolve",
    "new envelope always carries the new eventType");
}

console.log("permission decision tests ok");
