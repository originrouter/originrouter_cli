import assert from "node:assert/strict";
import { mapClaudeSdkMessage } from "../src/runtime/claudeSdkEvents.js";
import { mapCodexAppServerEvent } from "../src/adapters/codex/eventMapper.js";

const claude = mapClaudeSdkMessage({
  type: "result",
  uuid: "usage-result",
  result: "done",
  duration_ms: 1200,
  total_cost_usd: 0.12,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 },
});
assert.equal(claude[0].type, "agent.usage");
assert.equal(claude[0].sampledTokens, 175);
assert.equal(claude[0].amountMinor, 12);
assert.equal(claude[0].elapsedSeconds, 2);

const codex = mapCodexAppServerEvent({
  type: "token_count",
  total: { totalTokens: 1000 },
  last: { inputTokens: 80, outputTokens: 20 },
});
assert.equal(codex[0].type, "agent.usage");
assert.equal(codex[0].sampledTokens, 100);
console.log("Agent usage mapping tests passed");
