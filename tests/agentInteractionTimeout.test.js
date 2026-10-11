import assert from "node:assert/strict";

// `agent.interactionTimeoutMs` decides whether a blocking request ever expires
// on its own. The failure this setting exists to prevent: a phone in a pocket
// produced a permission decision nobody made, because a hard-coded five
// minutes expired the request while nobody was looking.
//
// The default is therefore 0 — no deadline — and 0 must survive every layer
// between the config file and the wire, including the places where a `||`
// default would silently swallow it. That is the whole point of these tests.

const {
  DEFAULT_AGENT_INTERACTION_TIMEOUT_MS,
  agentInteractionGraceMs,
  agentInteractionExpiresAt,
  agentInteractionTimeoutMsFromConfig,
  setAgentInteractionTimeoutMs,
  unsetAgentInteractionTimeoutMs,
} = await import("../src/config/agentInteractionTimeout.js");

// ---------- default ----------

assert.equal(DEFAULT_AGENT_INTERACTION_TIMEOUT_MS, 0);

// Absent config, and every "the key is not there" shape, means no deadline.
assert.equal(agentInteractionTimeoutMsFromConfig(undefined), 0);
assert.equal(agentInteractionTimeoutMsFromConfig({}), 0);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: {} }), 0);
// Neighbouring keys must not be mistaken for this one.
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { detailProfile: "detailed" } }), 0);

// A hand-edited config file must never be able to stop the CLI from starting,
// so unparseable values fall back rather than throwing.
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "" } }), 0);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "soon" } }), 0);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: {} } }), 0);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: -5 } }), 0);

// ---------- reading a configured value ----------

assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: 0 } }), 0);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "0" } }), 0);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: 300_000 } }), 300_000);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "5m" } }), 300_000);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "2h" } }), 7_200_000);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "1d" } }), 86_400_000);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: " 30 S " } }), 30_000);
assert.equal(agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "250ms" } }), 250);

// ---------- writing ----------

// The one that matters: `config set agent.interactionTimeoutMs 0` must store a
// real 0, not drop the key and leave the reader on its default by accident.
// Both happen to read as 0 today; only one of them survives a later change to
// the default.
assert.deepEqual(
  setAgentInteractionTimeoutMs({}, "0").agent.interactionTimeoutMs,
  0,
);
assert.deepEqual(
  setAgentInteractionTimeoutMs({ agent: { detailProfile: "detailed" } }, "5m"),
  { agent: { detailProfile: "detailed", interactionTimeoutMs: 300_000 } },
);
// Round-trips through the reader.
assert.equal(
  agentInteractionTimeoutMsFromConfig(setAgentInteractionTimeoutMs({}, "5m")),
  300_000,
);

assert.throws(() => setAgentInteractionTimeoutMs({}, ""), /must be a duration/);
assert.throws(() => setAgentInteractionTimeoutMs({}, "5x"), /Invalid agent\.interactionTimeoutMs/);
assert.throws(() => setAgentInteractionTimeoutMs({}, "-1"), /Invalid agent\.interactionTimeoutMs/);
assert.throws(() => setAgentInteractionTimeoutMs({}, "5 minutes"), /Invalid agent\.interactionTimeoutMs/);
assert.throws(() => setAgentInteractionTimeoutMs({}, "31d"), /at most 30d/);

// unset drops the key and leaves the rest of `agent` alone.
assert.deepEqual(
  unsetAgentInteractionTimeoutMs({ agent: { detailProfile: "detailed", interactionTimeoutMs: 5_000 } }),
  { agent: { detailProfile: "detailed" } },
);
assert.equal(
  agentInteractionTimeoutMsFromConfig(unsetAgentInteractionTimeoutMs({ agent: { interactionTimeoutMs: 5_000 } })),
  0,
);

// ---------- the deadline on the wire ----------

// `expiresAt` is epoch SECONDS, and `null` is what both ends already read as
// "no deadline": the registry arms no timer, and the App shows no countdown.
// `now` is milliseconds, as Date.now() gives.
const nowMs = 1_700_000_000_000;
const nowSeconds = nowMs / 1000;
assert.equal(agentInteractionExpiresAt(0, nowMs), null);
assert.equal(agentInteractionExpiresAt(-1, nowMs), null);
assert.equal(agentInteractionExpiresAt(0, nowMs), null);
assert.equal(agentInteractionExpiresAt(300_000, nowMs), nowSeconds + 300);
// Rounded UP, so a request never carries a deadline already in the past.
assert.equal(agentInteractionExpiresAt(1, nowMs), nowSeconds + 1);

// ---------- the layers that bound it ----------

// Each layer outward gets a fixed margin, so the window the user configured is
// always what fires first and these are only backstops.
assert.equal(agentInteractionGraceMs(300_000), 315_000);
assert.equal(agentInteractionGraceMs(1_000), 16_000);
// No deadline means no backstop either — arming one would reintroduce exactly
// the timer this setting exists to remove.
assert.equal(agentInteractionGraceMs(0), 0);
assert.equal(agentInteractionGraceMs(-1), 0);

// Invariant the hook settings and the app-server client both depend on: the
// inner deadline is strictly inside the outer one, so the request's own window
// closes first.
for (const window of [250, 1_000, 300_000, 7_200_000]) {
  assert.ok(
    agentInteractionGraceMs(window) > window,
    `grace must outlast the window it bounds (window=${window})`,
  );
}

console.log("agent interaction timeout tests passed");
