// How long the CLI waits for a person to answer a blocking request before it
// answers one on their behalf.
//
// This used to be a hard-coded five minutes on two code paths, and the
// consequence was that a phone in a pocket produced a permission decision
// nobody made: the request expired while the screen was off, the registry
// recorded `expired` / `auto_resolution_timeout`, and the agent was told the
// user had declined. Whether a request should ever expire is the user's call,
// not ours, so it is a config value.
//
// `0` — the default — means "wait for the user, for as long as it takes".
// A positive value is the decision window in milliseconds.
//
// Stored as `agent.interactionTimeoutMs` in config.json.

export const DEFAULT_AGENT_INTERACTION_TIMEOUT_MS = 0;

// Grace between the decision window and each layer that exists to bound it.
// Every layer outward gets the same margin the fixed constants used to have,
// so the request's own deadline always fires first and the layer above it is
// only the backstop for an answer that never arrives at all.
//
// When the window is 0 there is nothing to bound: every layer below is 0 too,
// meaning "no deadline of our own". Claude Code's own hook deadline is the one
// exception — it insists on a finite number, so we hand it a large one and
// document that it, not this CLI, is what finally gives up.
export const AGENT_INTERACTION_GRACE_MS = 15_000;

// Claude Code requires a finite `timeout` on every hook and has no "wait
// forever". This is the ceiling we hand it when the user asked for no
// deadline, so an unanswered request is finally abandoned by Claude Code
// rather than by us. Roughly a day.
export const CLAUDE_HOOK_DEADLINE_CEILING_SECONDS = 86_400;

const MAX_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const UNIT_MULTIPLES = Object.freeze({
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

// Lenient on read, the way every other accessor here is: an absent key, a
// blank string, or something unparseable all mean "use the default". A config
// file is hand-editable and must never be able to stop the CLI from starting.
//
// `??` rather than `||` throughout, because `0` is a real value here — it is
// the default, and it is the one value that means something specific.
export function agentInteractionTimeoutMsFromConfig(config) {
  const raw = config?.agent?.interactionTimeoutMs;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_AGENT_INTERACTION_TIMEOUT_MS;
  }
  // Normalized the same way the writer normalizes, so a value that
  // `config set` accepted reads back identically from a hand-edited file.
  const parsed = parseAgentInteractionTimeout(String(raw).trim().toLowerCase());
  return parsed === null ? DEFAULT_AGENT_INTERACTION_TIMEOUT_MS : parsed;
}

// Strict on write, like `setUpdateMode`. `originrouter config set` is the one
// place a bad value gets a chance to be reported to the person who typed it,
// so it throws rather than silently storing something that will be ignored.
//
// Accepts a plain millisecond count or a suffixed one — `300000`, `5m`,
// `2h`, `0`. Returns the next config object; the caller persists it.
export function setAgentInteractionTimeoutMs(config, raw) {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) {
    throw new Error(
      "agent.interactionTimeoutMs must be a duration, for example 300000, 5m, 2h, or 0 for no deadline",
    );
  }
  const parsed = parseAgentInteractionTimeout(text);
  if (parsed === null) {
    throw new Error(
      `Invalid agent.interactionTimeoutMs: ${raw}. Use 0 for no deadline, or a duration like 300000, 5m, or 2h.`,
    );
  }
  if (parsed > MAX_TIMEOUT_MS) {
    throw new Error("agent.interactionTimeoutMs must be at most 30d");
  }
  return {
    ...(config || {}),
    agent: {
      ...(config?.agent || {}),
      interactionTimeoutMs: parsed,
    },
  };
}

export function unsetAgentInteractionTimeoutMs(config) {
  const next = { ...(config || {}), agent: { ...(config?.agent || {}) } };
  delete next.agent.interactionTimeoutMs;
  return next;
}

// The absolute deadline in epoch **seconds**, or `null` for "no deadline".
// `null` is what the wire format already uses for an absent expiry, and both
// ends already read it that way: the registry arms no timer without it, and
// the App shows no countdown without it.
export function agentInteractionExpiresAt(timeoutMs, now = Date.now()) {
  if (!(timeoutMs > 0)) return null;
  return Math.ceil((now + timeoutMs) / 1000);
}

// The timeout for a layer that must merely outlive the decision above it.
// `0` means "no deadline of our own", which is what every layer gets once the
// user has asked for no deadline.
export function agentInteractionGraceMs(timeoutMs) {
  return timeoutMs > 0 ? timeoutMs + AGENT_INTERACTION_GRACE_MS : 0;
}

function parseAgentInteractionTimeout(text) {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  const unit = match[2] || "ms";
  const multiplier = UNIT_MULTIPLES[unit];
  if (multiplier === undefined) return null;
  const total = amount * multiplier;
  return Number.isSafeInteger(total) ? total : null;
}
