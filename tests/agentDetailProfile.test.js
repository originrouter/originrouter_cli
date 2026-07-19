import assert from "node:assert/strict";

import {
  agentDetailDefaultFromConfig,
  resolveAgentDetailProfile,
  setAgentDetailDefault,
} from "../src/runtime/agentDetailProfile.js";

assert.equal(agentDetailDefaultFromConfig({}), "concise");
assert.equal(
  agentDetailDefaultFromConfig({ agent: { detailProfile: "standard" } }),
  "standard",
);

const updated = setAgentDetailDefault({ providers: { local: {} } }, "detailed");
assert.equal(updated.agent.detailProfile, "detailed");
assert.deepEqual(updated.providers, { local: {} });

assert.deepEqual(resolveAgentDetailProfile({ config: {} }), {
  profile: "concise",
  source: "builtin_default",
});
assert.deepEqual(
  resolveAgentDetailProfile({
    config: { agent: { detailProfile: "standard" } },
  }),
  { profile: "standard", source: "global_default" },
);
assert.deepEqual(
  resolveAgentDetailProfile({
    config: { agent: { detailProfile: "standard" } },
    launchOverride: "detailed",
  }),
  { profile: "detailed", source: "launch_argument" },
);
assert.throws(
  () => resolveAgentDetailProfile({ config: {}, launchOverride: "everything" }),
  /concise, standard, or detailed/,
);

console.log("agent detail profile tests ok");
