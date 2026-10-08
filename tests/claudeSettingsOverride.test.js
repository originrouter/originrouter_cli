import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSettingsOverride,
  describeClaudeSettingsConflicts,
  CLAUDE_TRANSPORT_ENV_KEYS,
  CLAUDE_PROVIDER_REDIRECT_ENV_KEYS,
} from "../src/config/claudeConfig.js";
import { formatClaudeSettingsConflicts } from "../src/adapters/claude/settingsConflicts.js";

// ---------- buildClaudeSettingsOverride ----------

// The originrouter-coding shape, as protectOriginrouterCodingEnv leaves it.
const codingResult = {
  source: "originrouter-coding",
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:43210/coding",
    ANTHROPIC_AUTH_TOKEN: "or_local_secret",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: "claude-opus-5",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-opus-5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-opus-5",
    UNRELATED_SECRET: "must-not-be-copied",
  },
};

const override = buildClaudeSettingsOverride(codingResult);
assert.ok(override);

// Every model-family default is pinned. These are the keys a stale
// ~/.claude/settings.json is most likely to hold, and the SDK path used to
// miss all of them.
assert.equal(override.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4-5");
assert.equal(override.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5");
assert.equal(override.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "claude-opus-5");
assert.equal(override.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "claude-opus-5");
// The removed variables are not pinned any more: they are no longer part of
// the transport key set, so a settings-layer value would pass through.
assert.equal("ANTHROPIC_SMALL_FAST_MODEL" in override.env, false);
assert.equal("CLAUDE_CODE_SUBAGENT_MODEL" in override.env, false);

// Only transport keys cross over.
assert.equal("UNRELATED_SECRET" in override.env, false);

// Provider redirects are blanked even though the route never set them.
for (const key of CLAUDE_PROVIDER_REDIRECT_ENV_KEYS) {
  assert.equal(override.env[key], "", `${key} should be blanked`);
}

// Credential-injecting settings fields are neutralized.
assert.equal(override.apiKeyHelper, "");
assert.equal(override.awsAuthRefresh, "");
assert.equal(override.gcpAuthRefresh, "");
assert.equal(override.forceLoginMethod, "");

// Both credential variables are always pinned, whichever one the route uses.
// An absent one is supplied by a lower settings layer instead, and Claude Code
// sends it: measured, a stale ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json
// rides out as `Bearer` next to our own ANTHROPIC_API_KEY, and the bearer token
// is the one Claude Code prefers — so the proxy gets the user's stale
// credential and the user's key leaves the machine.
const tokenOnly = buildClaudeSettingsOverride({
  source: "originrouter-coding",
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1/coding",
    ANTHROPIC_AUTH_TOKEN: "or_local_secret",
    ANTHROPIC_MODEL: "claude-opus-5",
  },
});
assert.equal(tokenOnly.env.ANTHROPIC_API_KEY, "");
assert.equal(tokenOnly.env.ANTHROPIC_AUTH_TOKEN, "or_local_secret");

// The mirror case: the proxy transports authenticate with ANTHROPIC_API_KEY and
// never set a token, so the token is what must be shadowed.
for (const source of ["routes", "remote-coding"]) {
  const keyOnly = buildClaudeSettingsOverride({
    source,
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:2",
      ANTHROPIC_API_KEY: "sk-noop-litellm-passthrough",
      ANTHROPIC_MODEL: "claude-opus-5",
    },
  });
  assert.equal(keyOnly.env.ANTHROPIC_AUTH_TOKEN, "", `${source} must shadow the auth token`);
  // The route's own credential is never clobbered by that rule.
  assert.equal(keyOnly.env.ANTHROPIC_API_KEY, "sk-noop-litellm-passthrough");
}

// No OriginRouter route means no override at all: native behavior byte for byte.
assert.equal(buildClaudeSettingsOverride({
  source: "inherited",
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:5580" },
}), null);
assert.equal(buildClaudeSettingsOverride({ source: "native-config", env: {} }), null);
assert.equal(buildClaudeSettingsOverride({}), null);
assert.equal(buildClaudeSettingsOverride({ source: "routes", env: {} }), null);

// Values are stringified so a numeric port or a null never reaches the JSON
// as a non-string.
const coerced = buildClaudeSettingsOverride({
  source: "routes",
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:2/", ANTHROPIC_MODEL: null },
});
assert.equal(coerced.env.ANTHROPIC_MODEL, "");

// ---------- conflict reporting ----------

// The exact shape of the machine that prompted this fix.
const staleUserSettings = {
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:5580",
    ANTHROPIC_AUTH_TOKEN: "sk-stale",
    ANTHROPIC_API_KEY: "sk-stale",
    ANTHROPIC_MODEL: "CLAUDE_HAIKU_4_5_20251001_V1_0",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "CLAUDE_HAIKU_4_5_20251001_V1_0",
  },
  theme: "auto",
};

const conflicts = describeClaudeSettingsConflicts(override, staleUserSettings);
assert.ok(conflicts.includes("ANTHROPIC_BASE_URL"));
assert.ok(conflicts.includes("ANTHROPIC_MODEL"));
assert.ok(conflicts.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL"));
// theme is the user's own; we never touch it, so it is never a conflict.
assert.equal(conflicts.includes("theme"), false);

// A key set to the same value we would set is not a conflict.
assert.deepEqual(
  describeClaudeSettingsConflicts(override, {
    env: { ANTHROPIC_MODEL: "claude-opus-5" },
  }),
  [],
);

// A provider switch the user never set is not reported just because we blanked it.
assert.deepEqual(describeClaudeSettingsConflicts(override, { env: {} }), []);

// An apiKeyHelper is reported: it silently adds a second credential.
assert.deepEqual(
  describeClaudeSettingsConflicts(override, { apiKeyHelper: "/usr/local/bin/get-key" }),
  ["apiKeyHelper"],
);

assert.deepEqual(describeClaudeSettingsConflicts(null, staleUserSettings), []);
assert.deepEqual(describeClaudeSettingsConflicts(override, null), []);

// Managed settings outrank us; the message has to say so rather than claim a
// successful override.
const managedLines = formatClaudeSettingsConflicts(
  override,
  [{
    source: "/Library/Application Support/ClaudeCode/managed-settings.json",
    settings: staleUserSettings,
    outranksUs: true,
  }],
  describeClaudeSettingsConflicts,
);
assert.equal(managedLines.length, 1);
assert.match(managedLines[0], /enterprise-managed and outranks OriginRouter/);

const userLines = formatClaudeSettingsConflicts(
  override,
  [{ source: "~/.claude/settings.json", settings: staleUserSettings, outranksUs: false }],
  describeClaudeSettingsConflicts,
);
assert.equal(userLines.length, 1);
assert.match(userLines[0], /using OriginRouter routing instead of ~\/\.claude\/settings\.json/);
// Key names only — these files hold live credentials.
assert.equal(userLines[0].includes("sk-stale"), false);

// A layer we did not collide with produces no line.
assert.deepEqual(
  formatClaudeSettingsConflicts(
    override,
    [{ source: "~/.claude/settings.json", settings: { theme: "dark" }, outranksUs: false }],
    describeClaudeSettingsConflicts,
  ),
  [],
);

console.log("claude settings override tests passed");
