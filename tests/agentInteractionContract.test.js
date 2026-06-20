// Stage 8.8: offline coverage for src/runtime/agentInteractionContract.js.
//
// What this file proves:
//   1. Claude permission event maps to agent.interaction.requested.
//   2. Codex permission event maps to agent.interaction.requested.
//   3. callId is preserved as interactionId.
//   4. tool and input are preserved.
//   5. permissionSuggestions are preserved.
//   6. resolution.decisions are preserved AND resolution.eventType
//      becomes "agent.interaction.resolve" (the new envelope always
//      carries the new eventType, even when the input was a legacy
//      agent.permission.* event).
//   7. Default kind is "permission" and INTERACTION_KINDS /
//      INTERACTION_SOURCES are frozen (the frozen check is bundled
//      into case 7 per the Stage 8.8 plan).
//   8. Source defaults to "hook"; caller override wins; unknown
//      source throws TypeError.
//   9. Reverse map (interaction → permission) round-trips faithfully
//      and emits eventType "agent.permission.resolve"; type guards
//      discriminate correctly; non-permission kinds throw.
//  10. buildInteractionResolved produces agent.interaction.resolve
//      with stable required fields, omits value/data when caller
//      does not pass them, and rejects missing required fields.

import assert from "node:assert/strict";
import {
  INTERACTION_KINDS,
  INTERACTION_SOURCES,
  buildInteractionResolved,
  interactionToPermissionEvent,
  isInteractionRequest,
  isInteractionResolve,
  permissionEventToInteraction,
} from "../src/runtime/agentInteractionContract.js";

const CLAUDE_CALL_ID = "claude-perm-1781663400000-a1b2c3d4e";
const CODEX_CALL_ID = "codex-approval-1781663500000-zyxwvu";

const CLAUDE_PERMISSION_SUGGESTIONS = [
  {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test" }],
  },
];

const DEFAULT_DECISIONS = [
  "approved",
  "approved_for_session",
  "denied",
  "abort",
];

// ---- 1. Claude permission → agent.interaction.requested ----

{
  const claudeEvent = {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "npm test" },
    permissionSuggestions: CLAUDE_PERMISSION_SUGGESTIONS,
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: DEFAULT_DECISIONS,
    },
  };
  const out = permissionEventToInteraction(claudeEvent);
  assert.equal(out.type, "agent.interaction.requested");
  assert.equal(out.kind, "permission");
  assert.equal(out.source, "hook",
    "default source must be hook when caller omits extras.source");
  assert.equal(out.provider, "claude");
  assert.equal(out.tool, "Bash");
  assert.equal(out.interactionId, CLAUDE_CALL_ID,
    "interactionId must equal the legacy callId");
  assert.equal(out.callId, CLAUDE_CALL_ID,
    "callId is preserved on the envelope for back-compat consumers");
  assert.deepEqual(out.input, { command: "npm test" });
  assert.deepEqual(out.permissionSuggestions, CLAUDE_PERMISSION_SUGGESTIONS);
  assert.equal(out.resolution.eventType, "agent.interaction.resolve",
    "new envelope always carries the new eventType");
  assert.deepEqual(out.resolution.decisions, DEFAULT_DECISIONS);
  assert.equal(out.terminalReply, null,
    "non raw_terminal kind must not invent a terminalReply envelope");
}

// ---- 2. Codex permission → agent.interaction.requested ----

{
  const codexEvent = {
    type: "agent.permission.request.detected",
    provider: "codex",
    callId: CODEX_CALL_ID,
    tool: "exec",
    input: { command: "pytest -q", cwd: "/tmp/proj" },
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: DEFAULT_DECISIONS,
    },
  };
  const out = permissionEventToInteraction(codexEvent, {
    source: INTERACTION_SOURCES.APP_SERVER,
  });
  assert.equal(out.type, "agent.interaction.requested");
  assert.equal(out.kind, "permission");
  assert.equal(out.source, "app-server",
    "caller-supplied source must override the default hook value");
  assert.equal(out.provider, "codex");
  assert.equal(out.tool, "exec");
  assert.equal(out.interactionId, CODEX_CALL_ID);
  assert.deepEqual(out.input, { command: "pytest -q", cwd: "/tmp/proj" });
  assert.equal(out.resolution.eventType, "agent.interaction.resolve");
  assert.deepEqual(out.resolution.decisions, DEFAULT_DECISIONS);
}

// ---- 3. callId preserved as interactionId ----

{
  const out = permissionEventToInteraction({
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "echo hi" },
  });
  assert.equal(out.interactionId, CLAUDE_CALL_ID);
  assert.equal(out.callId, CLAUDE_CALL_ID);
  assert.equal(out.interactionId, out.callId,
    "interactionId and callId must be the same string on the envelope");
}

// ---- 4. tool and input preserved ----

{
  const out = permissionEventToInteraction({
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "npm test" },
  });
  assert.equal(out.tool, "Bash");
  assert.deepEqual(out.input, { command: "npm test" });
  // Missing input on the input event → null on output (do not invent {}).
  const noInput = permissionEventToInteraction({
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Read",
  });
  assert.equal(noInput.input, null,
    "missing input must surface as null, not a synthesized object");
}

// ---- 5. permissionSuggestions preserved ----

{
  const out = permissionEventToInteraction({
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "npm test" },
    permissionSuggestions: CLAUDE_PERMISSION_SUGGESTIONS,
  });
  assert.deepEqual(out.permissionSuggestions, CLAUDE_PERMISSION_SUGGESTIONS);
  // Missing permissionSuggestions on a permission event → omitted
  // from the output (do not synthesize []).
  const noSuggestions = permissionEventToInteraction({
    type: "agent.permission.request.detected",
    provider: "codex",
    callId: CODEX_CALL_ID,
    tool: "exec",
    input: { command: "ls" },
  });
  assert.equal("permissionSuggestions" in noSuggestions, false,
    "missing permissionSuggestions must be omitted from the envelope");
}

// ---- 6. resolution.decisions preserved (with new envelope eventType) ----

{
  const out = permissionEventToInteraction({
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "npm test" },
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: DEFAULT_DECISIONS,
    },
  });
  assert.deepEqual(out.resolution.decisions, DEFAULT_DECISIONS);
  assert.equal(out.resolution.eventType, "agent.interaction.resolve",
    "new envelope must always carry eventType \"agent.interaction.resolve\"; "
    + "carrying the legacy eventType would mislead a 9.0 consumer");
  // A copy of the decisions array — mutating the input must not
  // leak into the output (non-mutation invariant).
  assert.notEqual(out.resolution.decisions, DEFAULT_DECISIONS,
    "decisions must be a fresh array, not the same reference as the input");
}

// ---- 7. Default kind is "permission" + frozen check ----

{
  const out = permissionEventToInteraction({
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "ls" },
  });
  assert.equal(out.kind, "permission",
    "default kind must be permission when caller omits extras.kind");
  assert.equal(INTERACTION_KINDS.PERMISSION, "permission",
    "INTERACTION_KINDS.PERMISSION must stay \"permission\"");
  assert.equal(Object.isFrozen(INTERACTION_KINDS), true,
    "INTERACTION_KINDS must be frozen so a future typo breaks the test");
  assert.equal(Object.isFrozen(INTERACTION_SOURCES), true,
    "INTERACTION_SOURCES must be frozen so a future typo breaks the test");
  assert.equal(INTERACTION_SOURCES.HOOK, "hook");
  assert.equal(INTERACTION_SOURCES.APP_SERVER, "app-server");
  assert.equal(INTERACTION_SOURCES.JSONL, "jsonl");
  assert.equal(INTERACTION_SOURCES.PTY, "pty");
}

// ---- 8. Source default, override, and unknown rejection ----

{
  const baseEvent = {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "ls" },
  };
  const defaultOut = permissionEventToInteraction(baseEvent);
  assert.equal(defaultOut.source, "hook");

  const overridden = permissionEventToInteraction(baseEvent, {
    source: "app-server",
  });
  assert.equal(overridden.source, "app-server");

  assert.throws(
    () => permissionEventToInteraction(baseEvent, { source: "bogus" }),
    TypeError,
    "unknown source must throw TypeError",
  );

  assert.throws(
    () => permissionEventToInteraction(baseEvent, { kind: "bogus" }),
    TypeError,
    "unknown kind must throw TypeError",
  );

  // Missing callId on the input event → TypeError.
  assert.throws(
    () => permissionEventToInteraction({
      type: "agent.permission.request.detected",
      provider: "claude",
      tool: "Bash",
      input: { command: "ls" },
    }),
    TypeError,
    "missing callId must throw TypeError (interactionId anchor)",
  );
}

// ---- 9. Round-trip + type guards ----

{
  const claudeEvent = {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId: CLAUDE_CALL_ID,
    tool: "Bash",
    input: { command: "npm test" },
    permissionSuggestions: CLAUDE_PERMISSION_SUGGESTIONS,
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: DEFAULT_DECISIONS,
    },
  };
  const interaction = permissionEventToInteraction(claudeEvent);
  const legacy = interactionToPermissionEvent(interaction);

  assert.equal(legacy.type, "agent.permission.request.detected");
  assert.equal(legacy.provider, "claude");
  assert.equal(legacy.callId, CLAUDE_CALL_ID,
    "reverse map must use interactionId as the legacy callId");
  assert.equal(legacy.tool, "Bash");
  assert.deepEqual(legacy.input, { command: "npm test" });
  assert.deepEqual(legacy.permissionSuggestions, CLAUDE_PERMISSION_SUGGESTIONS);
  assert.deepEqual(legacy.resolution.decisions, DEFAULT_DECISIONS);
  assert.equal(legacy.resolution.eventType, "agent.permission.resolve",
    "reverse map must always emit the legacy eventType on the legacy envelope");

  // Type guards.
  assert.equal(isInteractionRequest(interaction), true,
    "the new interaction envelope is an interaction request");
  assert.equal(isInteractionRequest(legacy), false,
    "the legacy envelope is not an interaction request");
  assert.equal(isInteractionResolve(legacy), false,
    "the legacy envelope is not an interaction resolve (type differs)");

  // sessionId is dropped on the reverse map (the legacy wire shape
  // did not carry it; the relay attaches it at the wrapper level).
  assert.equal("sessionId" in legacy, false,
    "reverse map must drop sessionId to preserve the legacy wire shape");

  // Non-permission kinds throw on the reverse map.
  assert.throws(
    () => interactionToPermissionEvent({
      type: "agent.interaction.requested",
      kind: "confirm",
      interactionId: "i1",
    }),
    TypeError,
    "non-permission kind must throw on the reverse map (only permission is reversible in 8.8)",
  );

  // Wrong type throws.
  assert.throws(
    () => interactionToPermissionEvent({
      type: "agent.permission.request.detected",
      callId: "i1",
    }),
    TypeError,
    "interactionToPermissionEvent must reject non-interaction inputs",
  );

  // Missing interactionId throws.
  assert.throws(
    () => interactionToPermissionEvent({
      type: "agent.interaction.requested",
      kind: "permission",
    }),
    TypeError,
    "missing interactionId must throw on the reverse map",
  );
}

// ---- 10. buildInteractionResolved ----

{
  // Required fields only — value and data are absent (not undefined).
  const minimal = buildInteractionResolved({
    sessionId: "s1",
    interactionId: "i1",
    decision: "approved",
  });
  assert.equal(minimal.type, "agent.interaction.resolve");
  assert.equal(minimal.sessionId, "s1");
  assert.equal(minimal.interactionId, "i1");
  assert.equal(minimal.decision, "approved");
  assert.equal("value" in minimal, false,
    "value must be absent when caller does not pass it (not undefined)");
  assert.equal("data" in minimal, false,
    "data must be absent when caller does not pass it (not undefined)");

  // value passthrough (for future single_select / free_text / typed).
  const withValue = buildInteractionResolved({
    sessionId: "s2",
    interactionId: "i2",
    decision: "approved",
    value: "user typed text",
  });
  assert.equal(withValue.value, "user typed text");
  assert.equal("data" in withValue, false,
    "data must still be absent when caller passes only value");

  // data passthrough (labeled raw-terminal escape hatch).
  const withData = buildInteractionResolved({
    sessionId: "s3",
    interactionId: "i3",
    decision: "approved",
    data: "\x1b[1m",
  });
  assert.equal(withData.data, "\x1b[1m");
  assert.equal("value" in withData, false);

  // Both value and data together.
  const withBoth = buildInteractionResolved({
    sessionId: "s4",
    interactionId: "i4",
    decision: "abort",
    value: null,
    data: { bytes: [0x1b, 0x5b, 0x41] },
  });
  assert.equal(withBoth.decision, "abort");
  assert.equal(withBoth.value, null);
  assert.deepEqual(withBoth.data, { bytes: [0x1b, 0x5b, 0x41] });

  // Missing required fields throw.
  assert.throws(
    () => buildInteractionResolved({ interactionId: "i1", decision: "approved" }),
    TypeError,
    "missing sessionId must throw",
  );
  assert.throws(
    () => buildInteractionResolved({ sessionId: "s1", decision: "approved" }),
    TypeError,
    "missing interactionId must throw",
  );
  assert.throws(
    () => buildInteractionResolved({ sessionId: "s1", interactionId: "i1" }),
    TypeError,
    "missing decision must throw",
  );
  assert.throws(
    () => buildInteractionResolved({ sessionId: "", interactionId: "i1", decision: "approved" }),
    TypeError,
    "empty-string sessionId must throw (non-empty required)",
  );

  // Type guards.
  assert.equal(isInteractionResolve(minimal), true);
  assert.equal(isInteractionRequest(minimal), false);
  // A legacy permission.resolve event must NOT match the new
  // interaction-resolve guard (different type string).
  assert.equal(
    isInteractionResolve({ type: "agent.permission.resolve", interactionId: "i1" }),
    false,
    "legacy agent.permission.resolve must not match the new guard",
  );
}

console.log("agent interaction contract tests ok");
