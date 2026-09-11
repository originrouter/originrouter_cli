import assert from "node:assert/strict";
import test from "node:test";

import { resolveRelayEndpoint } from "../src/relay/relayEndpointSelector.js";

test("explicit Relay configuration is never latency-probed or replaced", async () => {
  let calls = 0;
  const result = await resolveRelayEndpoint({
    configuredRelayUrl: "https://relay.example/",
    fetchFn: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  assert.deepEqual(result, {
    relayUrl: "https://relay.example",
    source: "configured",
  });
  assert.equal(calls, 0);
});

test("automatic Relay selection chooses the lowest-latency healthy official endpoint", async () => {
  let clock = 0;
  const result = await resolveRelayEndpoint({
    candidates: ["https://slow.example", "https://fast.example"],
    now: () => clock,
    fetchFn: async (url) => {
      clock += url.includes("slow") ? 70 : 15;
      return { status: 200 };
    },
  });
  assert.deepEqual(result, {
    relayUrl: "https://fast.example",
    source: "latency",
  });
});

test("automatic Relay selection falls back to the established default when all probes fail", async () => {
  const result = await resolveRelayEndpoint({
    candidates: ["https://down-a.example", "https://down-b.example"],
    fetchFn: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(result, {
    relayUrl: "https://app.easytransnote.com",
    source: "default",
  });
});
