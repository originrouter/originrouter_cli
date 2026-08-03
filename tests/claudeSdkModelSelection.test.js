import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClaudeRuntimeSettingsOverride,
  resolveClaudeSdkModelSelection,
} from "../src/runtime/claudeSdkSession.js";

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

const temporaryRoot = mkdtempSync(join(tmpdir(), "originrouter-claude-override-test-"));
const settingsOverride = createClaudeRuntimeSettingsOverride({
  source: "originrouter-coding",
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:43210/coding",
    ANTHROPIC_AUTH_TOKEN: "or_local_secret",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: "grok-4.5",
    UNRELATED_SECRET: "must-not-be-copied",
  },
}, { temporaryRoot });
assert.ok(settingsOverride);
assert.equal(statSync(settingsOverride.path).mode & 0o777, 0o600);
assert.deepEqual(JSON.parse(readFileSync(settingsOverride.path, "utf8")), {
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:43210/coding",
    ANTHROPIC_AUTH_TOKEN: "or_local_secret",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: "grok-4.5",
  },
});
settingsOverride.cleanup();
assert.throws(() => statSync(settingsOverride.path), /ENOENT/);
settingsOverride.cleanup();

assert.equal(createClaudeRuntimeSettingsOverride({
  source: "inherited",
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:5580" },
}), null);

console.log("claude SDK model selection tests passed");
