import assert from "node:assert/strict";
import { resolveClaudeSdkModelSelection } from "../src/runtime/claudeSdkSession.js";

const routed = resolveClaudeSdkModelSelection({}, {
  env: {
    ANTHROPIC_MODEL: "grok-4.5",
    ANTHROPIC_SMALL_FAST_MODEL: "grok-4.5-mini",
  },
  routes: {
    main: { model: "route-main" },
    small: { model: "route-small" },
  },
  provider: {
    model: "stale-provider-default",
    smallFastModel: "stale-provider-small",
  },
});
assert.deepEqual(routed, {
  model: "grok-4.5",
  fallbackModel: undefined,
});

const identicalRoutes = resolveClaudeSdkModelSelection({}, {
  env: {
    ANTHROPIC_MODEL: "grok-4.5",
    ANTHROPIC_SMALL_FAST_MODEL: "grok-4.5",
  },
});
assert.deepEqual(identicalRoutes, {
  model: "grok-4.5",
  fallbackModel: undefined,
});

const explicit = resolveClaudeSdkModelSelection(
  { model: "explicit-main", fallbackModel: "explicit-small" },
  {
    env: {
      ANTHROPIC_MODEL: "environment-main",
      ANTHROPIC_SMALL_FAST_MODEL: "environment-small",
    },
  },
);
assert.deepEqual(explicit, {
  model: "explicit-main",
  fallbackModel: "explicit-small",
});

const routeFallback = resolveClaudeSdkModelSelection({}, {
  routes: {
    main: { model: "route-main" },
    small: { model: "route-small" },
  },
  provider: {
    model: "provider-main",
    smallFastModel: "provider-small",
  },
});
assert.deepEqual(routeFallback, {
  model: "route-main",
  fallbackModel: undefined,
});

assert.deepEqual(resolveClaudeSdkModelSelection({}, {}), {
  model: undefined,
  fallbackModel: undefined,
});

console.log("claude SDK model selection tests passed");
