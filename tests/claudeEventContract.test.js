// Stage 8.7: offline coverage for src/runtime/claudeEventContract.js.
//
// What this file proves:
//   1. session.started PTY gets top-level runtime: "claude-pty".
//   2. session.started SDK gets top-level runtime: "claude-sdk".
//   3. metadata.runtime mirrors the top-level runtime.
//   4. Existing metadata fields are preserved on session.started.
//   5. agent.ready gets provider:"claude" and runtime.
//   6. agent.permission.request.detected keeps callId, tool,
//      resolution, and gets runtime added.
//   7. Non-agent event (terminal.output, session.exited) is
//      not modified by withClaudeRuntime.
//   8. Existing explicit runtime is not overwritten on agent.* events;
//      session.started uses the helper runtime argument as the contract anchor.
//   9. Unknown agent.* extension event still gets provider/runtime.
//  10. CLAUDE_RUNTIMES constants are stable.
//  11. provider is forced to "claude" even if the caller passes
//      a different value (asymmetry between provider-forced and
//      runtime-caller-overridable).

import assert from "node:assert/strict";
import {
  CLAUDE_PROVIDER,
  CLAUDE_RUNTIMES,
  normalizeClaudeEvent,
  normalizeClaudeSessionStarted,
  withClaudeRuntime,
} from "../src/runtime/claudeEventContract.js";

// ---- 1. session.started PTY gets top-level runtime ----

{
  const out = normalizeClaudeSessionStarted(
    { type: "session.started", sessionId: "s1" },
    CLAUDE_RUNTIMES.PTY,
  );
  assert.equal(out.runtime, "claude-pty");
  assert.equal(out.type, "session.started");
  assert.equal(out.sessionId, "s1");
}

// ---- 2. session.started SDK gets top-level runtime ----

{
  const out = normalizeClaudeSessionStarted(
    { type: "session.started", sessionId: "s2" },
    CLAUDE_RUNTIMES.SDK,
  );
  assert.equal(out.runtime, "claude-sdk");
}

// ---- 3. metadata.runtime mirrors top-level runtime ----

{
  const out = normalizeClaudeSessionStarted(
    { type: "session.started", sessionId: "s3" },
    CLAUDE_RUNTIMES.SDK,
  );
  assert.equal(out.metadata.runtime, "claude-sdk",
    "metadata.runtime must mirror the top-level runtime");
}

// ---- 4. Existing metadata fields are preserved on session.started ----

{
  const out = normalizeClaudeSessionStarted(
    {
      type: "session.started",
      sessionId: "s4",
      metadata: {
        adapter: "claude-sdk",
        structuredSources: ["claude-agent-sdk"],
        projectPath: "/tmp/proj",
      },
    },
    CLAUDE_RUNTIMES.SDK,
  );
  assert.equal(out.metadata.adapter, "claude-sdk",
    "runtime-specific metadata.adapter must be preserved");
  assert.deepEqual(out.metadata.structuredSources, ["claude-agent-sdk"]);
  assert.equal(out.metadata.projectPath, "/tmp/proj");
  assert.equal(out.metadata.runtime, "claude-sdk");
}

// metadata.adapter defaults to "claude" when caller did not set it.
{
  const out = normalizeClaudeSessionStarted(
    { type: "session.started", sessionId: "s4b" },
    CLAUDE_RUNTIMES.PTY,
  );
  assert.equal(out.metadata.adapter, "claude",
    "metadata.adapter defaults to claude when not provided");
}

// ---- 5. agent.ready gets provider:"claude" and runtime ----

{
  const out = withClaudeRuntime(
    { type: "agent.ready", message: "ready" },
    CLAUDE_RUNTIMES.SDK,
  );
  assert.equal(out.provider, "claude");
  assert.equal(out.runtime, "claude-sdk");
  assert.equal(out.message, "ready");
}

// ---- 6. agent.permission.request.detected keeps callId/tool/resolution ----

{
  const out = withClaudeRuntime(
    {
      type: "agent.permission.request.detected",
      callId: "c-1",
      tool: "Bash",
      input: { command: "npm test" },
      resolution: {
        eventType: "agent.permission.resolve",
        decisions: ["approved", "approved_for_session", "denied", "abort"],
      },
    },
    CLAUDE_RUNTIMES.PTY,
  );
  assert.equal(out.provider, "claude");
  assert.equal(out.runtime, "claude-pty");
  assert.equal(out.callId, "c-1");
  assert.equal(out.tool, "Bash");
  assert.deepEqual(out.input, { command: "npm test" });
  assert.equal(out.resolution.eventType, "agent.permission.resolve");
  assert.deepEqual(out.resolution.decisions,
    ["approved", "approved_for_session", "denied", "abort"]);
}

// ---- 7. Non-agent event is not modified ----

{
  const terminalEvent = { type: "terminal.output", data: "raw bytes" };
  const out = withClaudeRuntime(terminalEvent, CLAUDE_RUNTIMES.PTY);
  assert.deepEqual(out, terminalEvent,
    "withClaudeRuntime must not modify non-agent events");
}

{
  const exitedEvent = { type: "session.exited", code: 0 };
  const out = withClaudeRuntime(exitedEvent, CLAUDE_RUNTIMES.SDK);
  assert.deepEqual(out, exitedEvent);
}

// ---- 8. Existing explicit runtime rules ----

{
  const out = withClaudeRuntime(
    { type: "agent.ready", runtime: "custom-runtime" },
    CLAUDE_RUNTIMES.SDK,
  );
  assert.equal(out.runtime, "custom-runtime",
    "caller-supplied runtime must win over the helper default");
}

// Same asymmetry check for session.started: explicit runtime wins.
{
  const out = normalizeClaudeSessionStarted(
    { type: "session.started", sessionId: "s8", runtime: "explicit" },
    CLAUDE_RUNTIMES.SDK,
  );
  // normalizeClaudeSessionStarted always sets runtime from its argument
  // (this is the only category where the helper is opinionated — the
  // session.started top-level runtime is the contract anchor). The
  // caller argument wins over the input event's runtime.
  assert.equal(out.runtime, "claude-sdk");
}

// ---- 9. Unknown agent.* extension event still gets provider/runtime ----

{
  const out = withClaudeRuntime(
    { type: "agent.exotic_extension", payload: { x: 1 } },
    CLAUDE_RUNTIMES.PTY,
  );
  assert.equal(out.provider, "claude");
  assert.equal(out.runtime, "claude-pty");
  assert.equal(out.type, "agent.exotic_extension");
  assert.deepEqual(out.payload, { x: 1 });
}

// ---- 10. CLAUDE_RUNTIMES constants are stable ----

assert.equal(CLAUDE_RUNTIMES.PTY, "claude-pty");
assert.equal(CLAUDE_RUNTIMES.SDK, "claude-sdk");
assert.equal(typeof CLAUDE_RUNTIMES, "object");
assert.equal(Object.isFrozen(CLAUDE_RUNTIMES), true,
  "CLAUDE_RUNTIMES must be frozen so a future rename breaks the test");

// ---- 11. provider is forced to "claude" even if caller passes a different value ----

{
  const out = withClaudeRuntime(
    { type: "agent.ready", provider: "wrong" },
    CLAUDE_RUNTIMES.SDK,
  );
  assert.equal(out.provider, "claude",
    "provider must be forced to claude regardless of caller input");
  assert.equal(out.runtime, "claude-sdk",
    "runtime defaults to the helper argument when caller omitted it");
}

// Same asymmetry check at the entry-point dispatcher level.
{
  const out = normalizeClaudeEvent(
    { type: "agent.permission.request.detected", provider: "wrong", callId: "x" },
    CLAUDE_RUNTIMES.PTY,
  );
  assert.equal(out.provider, "claude");
  assert.equal(out.runtime, "claude-pty");
  assert.equal(out.callId, "x");
}

// CLAUDE_PROVIDER constant sanity (read by the helper, exported for tests).
assert.equal(CLAUDE_PROVIDER, "claude");

console.log("claude event contract tests ok");
