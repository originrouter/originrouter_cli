// Stage 9.1B: exhaustive coverage of the originrouter direct branch in
// `buildAgentProviderEnv` (src/config/claudeConfig.js).
//
// The smoke cases 13-14 in tests/claudeConfigRoutes.test.js lock in the
// happy-path contract alongside the proxy regression. This file covers
// the rest: baseUrl override, small model fallback, mixed-provider
// rejection, missing / expired / malformed coding-key.json, and three
// proxy regression cases so the suite is self-contained.
//
// Valid keys are seeded via writeCodingAuth. Malformed keys bypass
// writeCodingAuth (which would refuse) and write raw JSON deliberately —
// the storage IO layer has already been tested and is correct; here we
// are feeding the runtime guard bad input to verify it rejects.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentProviderEnv } from "../src/config/claudeConfig.js";
import {
  MAIN_ALIAS, SMALL_ALIAS, CODEX_MAIN_ALIAS,
  getAllRoutes, hashRoutes, setRoute,
} from "../src/config/routes.js";
import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import { KEY_KIND, KEY_SCOPE, KEY_SOURCE } from "../src/runtime/authContract.js";
import { DEFAULT_ORIGINROUTER_BASE_URL } from "../src/config/providerRoutes.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-runtime-route-"));
process.env.ORIGINROUTER_HOME = home;

// ---- helpers ----

function seedManagedKey(home, overrides = {}) {
  const key = {
    kind: KEY_KIND.MANAGED,
    keyId: "ok_test_key",
    key: "sk-or-v1-ok-test-key",
    deviceGrantId: "og_test_grant_id",
    deviceGrant: "og_test_grant_token_for_unit_tests_only",
    deviceId: "device-test-001",
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    source: KEY_SOURCE.ORIGINROUTER_CLI,
    scopes: [KEY_SCOPE.CODING],
    ...overrides,
  };
  writeCodingAuth(home, key);
}

// Bypass writeCodingAuth to feed the runtime guard bad input on purpose.
function writeRawJsonKey(home, key) {
  writeFileSync(join(home, "coding-key.json"), JSON.stringify(key, null, 2));
}

function clearCodingKeyFile(home) {
  try { rmSync(join(home, "coding-key.json"), { force: true }); } catch {}
}

const officialClaude = {
  name: "official", type: "originrouter",
  auth: { type: "managed_originrouter_key", keyRef: "current" },
  model: "claude-sonnet-4-6",
};
const officialClaudeWithBaseUrl = {
  ...officialClaude,
  baseUrl: "https://alt.originrouter.example",
};
const fastOrig = {
  name: "fast-orig", type: "originrouter",
  auth: { type: "managed_originrouter_key", keyRef: "current" },
  model: "claude-haiku-4-5",
};
const moonshotProxy = {
  name: "moonshot-proxy", type: "proxy", engine: "litellm",
  litellmProvider: "moonshot", apiKey: "sk-ms", model: "moonshot-v1-8k",
};
const officialCodex = {
  name: "official-codex", type: "originrouter",
  auth: { type: "managed_originrouter_key", keyRef: "current" },
  model: "gpt-5-codex",
  baseUrl: "https://alt.originrouter.example",
};

function baseConfig() {
  return { providers: { official: officialClaude } };
}

const cases = [];

// --- claude originrouter direct ---

cases.push({
  name: "claude originrouter direct: returns source + four env vars",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    const out = buildAgentProviderEnv("claude", cfg, {
      proxyStatus: () => ({ state: "stopped" }), // proxy must NOT block direct
    });
    assert.equal(out.source, "originrouter-coding");
    assert.equal(out.env.ANTHROPIC_BASE_URL,
      `${DEFAULT_ORIGINROUTER_BASE_URL}/coding`);
    assert.equal(out.env.ANTHROPIC_API_KEY, "sk-or-v1-ok-test-key");
    assert.equal(out.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
    // small falls back to main when small slot not configured
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, "claude-sonnet-4-6");
  },
});

cases.push({
  name: "claude originrouter direct: provider.baseUrl override",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = { providers: { "official-baseurl": officialClaudeWithBaseUrl } };
    const routed = setRoute(cfg, "claude", "main",
      { provider: "official-baseurl", model: "claude-sonnet-4-6" });
    const out = buildAgentProviderEnv("claude", routed, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.env.ANTHROPIC_BASE_URL, "https://alt.originrouter.example/coding");
  },
});

cases.push({
  name: "claude originrouter direct: explicit small route model wins over main",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = { providers: { official: officialClaude, "fast-orig": fastOrig } };
    const routed = setRoute(cfg, "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    const routed2 = setRoute(routed, "claude", "small",
      { provider: "fast-orig", model: "claude-haiku-4-5" });
    const out = buildAgentProviderEnv("claude", routed2, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.env.ANTHROPIC_MODEL, "claude-sonnet-4-6");
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, "claude-haiku-4-5");
  },
});

cases.push({
  name: "claude originrouter direct: small route model missing → fallback to main",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    // explicitly no small slot
    const out = buildAgentProviderEnv("claude", cfg, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, "claude-sonnet-4-6");
  },
});

cases.push({
  name: "claude originrouter direct: mixed provider (main=originrouter small=proxy) throws",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = { providers: { official: officialClaude, "moonshot-proxy": moonshotProxy } };
    const routed = setRoute(cfg, "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    const routed2 = setRoute(routed, "claude", "small",
      { provider: "moonshot-proxy", model: "moonshot-v1-8k" });
    assert.throws(
      () => buildAgentProviderEnv("claude", routed2, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED"
        && /claude\.small.*originrouter/.test(err.message),
    );
  },
});

cases.push({
  name: "claude originrouter direct: no local proxy required",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    // proxyStatus returning not-installed must not block the direct branch
    const out = buildAgentProviderEnv("claude", cfg, {
      proxyStatus: () => ({ state: "not-installed" }),
    });
    assert.equal(out.source, "originrouter-coding");
  },
});

cases.push({
  name: "claude originrouter direct: missing coding-key.json throws login hint",
  run: () => {
    clearCodingKeyFile(home);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    assert.throws(
      () => buildAgentProviderEnv("claude", cfg, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED"
        && /originrouter login --manual-code/.test(err.message),
    );
  },
});

cases.push({
  name: "claude originrouter direct: expired coding key throws rotate hint",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home, { expiresAt: Date.now() - 60 * 1000 });
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    assert.throws(
      () => buildAgentProviderEnv("claude", cfg, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED"
        && /auth rotate/.test(err.message),
    );
  },
});

// --- malformed-shape guard (Stage 9.1B §A.1.1) ---

cases.push({
  name: "claude originrouter direct: malformed key missing deviceGrant throws login hint",
  run: () => {
    clearCodingKeyFile(home);
    const goodKey = {
      kind: KEY_KIND.MANAGED,
      keyId: "ok_test_key",
      key: "sk-or-v1-ok-test-key",
      deviceGrantId: "og_test_grant_id",
      deviceGrant: "og_test_grant_token_for_unit_tests_only",
      deviceId: "device-test-001",
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      source: KEY_SOURCE.ORIGINROUTER_CLI,
      scopes: [KEY_SCOPE.CODING],
    };
    const { deviceGrant: _omit, ...bad } = goodKey;
    void _omit;
    writeRawJsonKey(home, bad);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    assert.throws(
      () => buildAgentProviderEnv("claude", cfg, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED"
        && /originrouter login --manual-code/.test(err.message),
    );
  },
});

cases.push({
  name: "claude originrouter direct: malformed key missing scopes throws login hint",
  run: () => {
    clearCodingKeyFile(home);
    const goodKey = {
      kind: KEY_KIND.MANAGED,
      keyId: "ok_test_key",
      key: "sk-or-v1-ok-test-key",
      deviceGrantId: "og_test_grant_id",
      deviceGrant: "og_test_grant_token_for_unit_tests_only",
      deviceId: "device-test-001",
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      source: KEY_SOURCE.ORIGINROUTER_CLI,
      scopes: [KEY_SCOPE.CODING],
    };
    const { scopes: _omit, ...bad } = goodKey;
    void _omit;
    writeRawJsonKey(home, bad);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    assert.throws(
      () => buildAgentProviderEnv("claude", cfg, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED"
        && /originrouter login --manual-code/.test(err.message),
    );
  },
});

cases.push({
  name: "claude originrouter direct: scopes not including 'coding' throws login hint",
  run: () => {
    clearCodingKeyFile(home);
    const goodKey = {
      kind: KEY_KIND.MANAGED,
      keyId: "ok_test_key",
      key: "sk-or-v1-ok-test-key",
      deviceGrantId: "og_test_grant_id",
      deviceGrant: "og_test_grant_token_for_unit_tests_only",
      deviceId: "device-test-001",
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      source: KEY_SOURCE.ORIGINROUTER_CLI,
      scopes: ["other"],
    };
    writeRawJsonKey(home, goodKey);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    assert.throws(
      () => buildAgentProviderEnv("claude", cfg, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED"
        && /originrouter login --manual-code/.test(err.message),
    );
  },
});

cases.push({
  name: "claude originrouter direct: wrong source throws login hint",
  run: () => {
    clearCodingKeyFile(home);
    // isManagedKeyShape accepts originrouter_cli AND originrouter_app; a
    // source outside that set is rejected by the shape guard.
    const goodKey = {
      kind: KEY_KIND.MANAGED,
      keyId: "ok_test_key",
      key: "sk-or-v1-ok-test-key",
      deviceGrantId: "og_test_grant_id",
      deviceGrant: "og_test_grant_token_for_unit_tests_only",
      deviceId: "device-test-001",
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      source: "rogue-source",
      scopes: [KEY_SCOPE.CODING],
    };
    writeRawJsonKey(home, goodKey);
    const cfg = setRoute(baseConfig(), "claude", "main",
      { provider: "official", model: "claude-sonnet-4-6" });
    assert.throws(
      () => buildAgentProviderEnv("claude", cfg, {
        proxyStatus: () => ({ state: "stopped" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED"
        && /originrouter login --manual-code/.test(err.message),
    );
  },
});

// --- codex originrouter direct ---

cases.push({
  name: "codex originrouter direct: returns source + three env vars",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = { providers: { "official-codex": officialCodex } };
    const routed = setRoute(cfg, "codex", "main",
      { provider: "official-codex", model: "gpt-5-codex" });
    const out = buildAgentProviderEnv("codex", routed, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.source, "originrouter-coding");
    assert.equal(out.env.OPENAI_BASE_URL, "https://alt.originrouter.example/coding/v1");
    assert.equal(out.env.OPENAI_API_KEY, "sk-or-v1-ok-test-key");
    assert.equal(out.env.OPENAI_MODEL, "gpt-5-codex");
  },
});

cases.push({
  name: "codex originrouter direct: provider.baseUrl falls back when null",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = { providers: { "official": { ...officialClaude, model: "gpt-5-codex" } } };
    const routed = setRoute(cfg, "codex", "main",
      { provider: "official", model: "gpt-5-codex" });
    const out = buildAgentProviderEnv("codex", routed, {
      proxyStatus: () => ({ state: "stopped" }),
    });
    assert.equal(out.env.OPENAI_BASE_URL,
      `${DEFAULT_ORIGINROUTER_BASE_URL}/coding/v1`);
  },
});

cases.push({
  name: "codex originrouter direct: no local proxy required",
  run: () => {
    clearCodingKeyFile(home);
    seedManagedKey(home);
    const cfg = { providers: { "official-codex": officialCodex } };
    const routed = setRoute(cfg, "codex", "main",
      { provider: "official-codex", model: "gpt-5-codex" });
    const out = buildAgentProviderEnv("codex", routed, {
      proxyStatus: () => ({ state: "not-installed" }),
    });
    assert.equal(out.source, "originrouter-coding");
  },
});

// --- proxy regression ---

cases.push({
  name: "proxy route + matching hash returns source=routes and proxy env (regression)",
  run: () => {
    clearCodingKeyFile(home);
    const cfg = { providers: { "moonshot-proxy": moonshotProxy } };
    const routed = setRoute(cfg, "claude", "main",
      { provider: "moonshot-proxy", model: "moonshot-v1-8k" });
    const out = buildAgentProviderEnv("claude", routed, {
      proxyStatus: () => ({
        state: "running",
        port: 40123,
        host: "127.0.0.1",
        mode: "route",
        routesHash: hashRoutes(getAllRoutes(routed)),
        aliases: [MAIN_ALIAS, SMALL_ALIAS],
      }),
    });
    assert.equal(out.source, "routes");
    assert.equal(out.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:40123");
    assert.equal(out.env.ANTHROPIC_API_KEY, "sk-noop-litellm-passthrough");
    assert.equal(out.env.ANTHROPIC_MODEL, MAIN_ALIAS);
    assert.equal(out.env.ANTHROPIC_SMALL_FAST_MODEL, SMALL_ALIAS);
  },
});

cases.push({
  name: "proxy route + missing proxy throws install/start hint (regression)",
  run: () => {
    clearCodingKeyFile(home);
    const cfg = { providers: { "moonshot-proxy": moonshotProxy } };
    const routed = setRoute(cfg, "claude", "main",
      { provider: "moonshot-proxy", model: "moonshot-v1-8k" });
    assert.throws(
      () => buildAgentProviderEnv("claude", routed, {
        proxyStatus: () => ({ state: "not-installed" }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED" && /install/.test(err.message),
    );
  },
});

cases.push({
  name: "proxy route + stale hash throws PROVIDER_UNSUPPORTED (regression)",
  run: () => {
    clearCodingKeyFile(home);
    const cfg = { providers: { "moonshot-proxy": moonshotProxy } };
    const routed = setRoute(cfg, "claude", "main",
      { provider: "moonshot-proxy", model: "moonshot-v1-8k" });
    assert.throws(
      () => buildAgentProviderEnv("claude", routed, {
        proxyStatus: () => ({
          state: "running",
          port: 40123,
          host: "127.0.0.1",
          mode: "route",
          routesHash: "stale-hash",
          aliases: [MAIN_ALIAS, SMALL_ALIAS],
        }),
      }),
      (err) => err.code === "PROVIDER_UNSUPPORTED",
    );
  },
});

// --- runner ---

let failures = 0;
for (const c of cases) {
  try {
    c.run();
    console.log(`  ok: ${c.name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL: ${c.name}`);
    console.log(`    ${e.message}`);
  }
}

rmSync(home, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

console.log("runtime originrouter route tests ok");