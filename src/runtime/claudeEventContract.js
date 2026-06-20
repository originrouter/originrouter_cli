// src/runtime/claudeEventContract.js
//
// Stage 8.7 Claude SDK / PTY event normalization contract helper.
// Pure functions only. No I/O, no spawn, no process access.
// NOT wired into production. The test file
// (tests/claudeEventContract.test.js) is the only consumer in
// Stage 8.7. A future wiring stage may replace this module with
// the production mapper or promote it; either way, no production
// code imports it in Stage 8.7.
//
// Stage 8.7 contracts the current event names (`agent.text`,
// `agent.task.completed`) and locks the future target shapes
// (`agent.message`, `agent.task.complete` are deferred to a
// future wiring stage). The helper does not rename events.

export const CLAUDE_RUNTIMES = Object.freeze({
  PTY: "claude-pty",
  SDK: "claude-sdk",
});

// All normalized Claude events carry `provider: "claude"`.
export const CLAUDE_PROVIDER = "claude";

// Sets runtime + provider on a session.started event. Preserves
// existing metadata fields and ensures metadata.runtime mirrors
// the top-level runtime. `metadata.adapter` preserves the
// runtime-specific adapter value (e.g. "claude-sdk") so the
// relay can still distinguish source; only the agent-level
// `agent` field is normalized to "claude".
export function normalizeClaudeSessionStarted(event, runtime) {
  if (!event || typeof event !== "object") return event;
  return {
    ...event,
    agent: "claude",
    runtime,
    metadata: {
      ...(event.metadata || {}),
      runtime,
      adapter: event.metadata?.adapter || "claude",
    },
  };
}

// For any agent.* event, ensure provider + runtime are present.
// Provider is FORCED to "claude" (every normalized Claude event
// carries `provider: "claude"` — no override allowed).
// Caller-supplied runtime wins (explicit beats implicit).
export function withClaudeRuntime(event, runtime) {
  if (!event || typeof event !== "object") return event;
  if (typeof event.type !== "string" || !event.type.startsWith("agent.")) {
    return event;
  }
  return {
    ...event,
    provider: CLAUDE_PROVIDER,
    runtime: event.runtime || runtime,
  };
}

// Single entry point: dispatch on event.type.
export function normalizeClaudeEvent(event, runtime) {
  if (!event || typeof event !== "object") return event;
  if (event.type === "session.started") {
    return normalizeClaudeSessionStarted(event, runtime);
  }
  return withClaudeRuntime(event, runtime);
}
