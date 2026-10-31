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
const writtenOverride = JSON.parse(readFileSync(settingsOverride.path, "utf8"));
// Transport keys are copied through; unrelated environment entries are not.
assert.deepEqual(writtenOverride.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:43210/coding");
assert.deepEqual(writtenOverride.env.ANTHROPIC_AUTH_TOKEN, "or_local_secret");
assert.deepEqual(writtenOverride.env.ANTHROPIC_API_KEY, "");
assert.deepEqual(writtenOverride.env.ANTHROPIC_MODEL, "grok-4.5");
assert.equal("UNRELATED_SECRET" in writtenOverride.env, false);
// Provider redirect switches are blanked: a CLAUDE_CODE_USE_BEDROCK left set
// by a filesystem settings layer diverts the request away from our proxy even
// when base URL, token and model are all pinned.
assert.equal(writtenOverride.env.CLAUDE_CODE_USE_BEDROCK, "");
assert.equal(writtenOverride.env.CLAUDE_CODE_USE_VERTEX, "");
// apiKeyHelper is neutralized: otherwise its key still rides along as
// `x-api-key` on the request our auth token authorizes.
assert.equal(writtenOverride.apiKeyHelper, "");
assert.equal(writtenOverride.forceLoginMethod, "");
settingsOverride.cleanup();
assert.throws(() => statSync(settingsOverride.path), /ENOENT/);
settingsOverride.cleanup();

// An inherited route has no transport to pin, but it still gets a settings file:
// the permission safety keys are not transport and must be written for every
// session. A null here used to mean "no --settings file", which left auto mode
// reachable through the user's own settings.json.
const inheritedOverride = createClaudeRuntimeSettingsOverride({
  source: "inherited",
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:5580" },
}, { temporaryRoot });
assert.ok(inheritedOverride);
const inheritedSettings = JSON.parse(readFileSync(inheritedOverride.path, "utf8"));
assert.equal(inheritedSettings.disableAutoMode, "disable");
assert.deepEqual(inheritedSettings.permissions, { defaultMode: "default" });
// No transport override means no `env` block at all: the route stays whatever
// the environment says, and only the permission keys are added.
assert.equal("env" in inheritedSettings, false);
inheritedOverride.cleanup();
assert.throws(() => statSync(inheritedOverride.path), /ENOENT/);

console.log("claude SDK model selection tests passed");
