// Stage 9.0: provider config normalization tests.
//
// Covers:
//   - read-projection (legacy strings -> proxy(engine=litellm, ...))
//   - write-normalization (caller-supplied "litellm" / "anthropic"
//     are accepted as aliases; "openai-compatible" is rejected)
//   - canonical wire types (originrouter / proxy / remote)
//   - originrouter accepts missing baseUrl
//   - engine sub-type (only "litellm" allowed in 9.0)
//   - PROVIDER_TYPES is the 9.0 set
//
// Pure ESM, no I/O, no spawn. Mirrors the existing test idiom
// (assert from "node:assert/strict", inline {} blocks,
// console.log at end).

import assert from "node:assert/strict";
import {
  PROVIDER_TYPES,
  addProvider,
  normalizeProviderForRead,
  normalizeProviderForWrite,
} from "../src/config/providers.js";

function tryAdd(payload) {
  let captured;
  try {
    const cfg = addProvider({}, payload);
    return { ok: true, provider: cfg.providers[payload.name] };
  } catch (e) {
    return { ok: false, error: e };
  }
}

const cases = [];

// 1. Read legacy type="litellm" -> proxy(engine=litellm).
cases.push({
  name: "read legacy litellm -> proxy(engine=litellm)",
  run: () => {
    const projected = normalizeProviderForRead({
      name: "old", type: "litellm", litellmProvider: "deepseek", apiKey: "k", model: "m",
    });
    assert.equal(projected.type, "proxy");
    assert.equal(projected.engine, "litellm");
    assert.equal(projected.litellmProvider, "deepseek");
    assert.equal(projected._legacyType, "litellm");
  },
});

// 2. Read legacy type="anthropic" -> proxy(engine=litellm, litellmProvider=anthropic).
cases.push({
  name: "read legacy anthropic -> proxy(engine=litellm, litellmProvider=anthropic)",
  run: () => {
    const projected = normalizeProviderForRead({
      name: "old-mm", type: "anthropic", baseUrl: "https://x", apiKey: "k", model: "m",
    });
    assert.equal(projected.type, "proxy");
    assert.equal(projected.engine, "litellm");
    assert.equal(projected.litellmProvider, "anthropic");
    assert.equal(projected._legacyType, "anthropic");
  },
});

// 3. Read legacy type="openai-compatible" -> proxy(engine=litellm, litellmProvider=custom_openai).
cases.push({
  name: "read legacy openai-compatible -> proxy(engine=litellm, litellmProvider=custom_openai)",
  run: () => {
    const projected = normalizeProviderForRead({
      name: "old", type: "openai-compatible", baseUrl: "https://x", apiKey: "k", model: "m",
    });
    assert.equal(projected.type, "proxy");
    assert.equal(projected.engine, "litellm");
    assert.equal(projected.litellmProvider, "custom_openai");
    assert.equal(projected._legacyType, "openai-compatible");
  },
});

// 4. addProvider rejects type="openai-compatible".
cases.push({
  name: "addProvider rejects openai-compatible",
  run: () => {
    const r = tryAdd({
      name: "old", type: "openai-compatible",
      baseUrl: "https://x", apiKey: "k", model: "m",
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /openai-compatible.*no longer supported/);
  },
});

// 5. addProvider normalizes type="litellm" to proxy(engine=litellm) on write.
cases.push({
  name: "addProvider normalizes type=litellm to proxy(engine=litellm)",
  run: () => {
    const r = tryAdd({
      name: "ds", type: "litellm", litellmProvider: "deepseek",
      apiKey: "sk", model: "deepseek-chat",
    });
    assert.equal(r.ok, true, `unexpected throw: ${r.error && r.error.message}`);
    assert.equal(r.provider.type, "proxy");
    assert.equal(r.provider.engine, "litellm");
    assert.equal(r.provider.litellmProvider, "deepseek");
  },
});

// 6. addProvider accepts originrouter with all required fields.
cases.push({
  name: "addProvider originrouter with all fields succeeds",
  run: () => {
    const r = tryAdd({
      name: "official",
      type: "originrouter",
      baseUrl: "https://server.originrouter.com",
      auth: { type: "managed_originrouter_key", keyRef: "managed-key-1" },
      model: "claude-sonnet-4-6",
    });
    assert.equal(r.ok, true, `unexpected throw: ${r.error && r.error.message}`);
    assert.equal(r.provider.type, "originrouter");
    assert.equal(r.provider.model, "claude-sonnet-4-6");
    assert.equal(r.provider.auth.type, "managed_originrouter_key");
    assert.equal(r.provider.auth.keyRef, "managed-key-1");
  },
});

// 7. addProvider accepts originrouter without baseUrl (optional, default applied later).
cases.push({
  name: "addProvider originrouter without baseUrl succeeds",
  run: () => {
    const r = tryAdd({
      name: "official-default-base",
      type: "originrouter",
      auth: { type: "managed_originrouter_key", keyRef: "managed-key-1" },
      model: "claude-sonnet-4-6",
    });
    assert.equal(r.ok, true, `unexpected throw: ${r.error && r.error.message}`);
    assert.equal(r.provider.type, "originrouter");
    assert.equal(r.provider.baseUrl, undefined, "baseUrl is optional and not auto-set at write time");
  },
});

// 8. addProvider rejects originrouter without auth.keyRef.
cases.push({
  name: "addProvider originrouter without auth.keyRef throws",
  run: () => {
    // The validator checks auth.type before keyRef. We pass a malformed
    // auth object to reach the keyRef check; without auth at all, the
    // type check fires first (also correct). Both throw — we only need
    // one of them to assert the gate exists.
    const r = tryAdd({
      name: "official",
      type: "originrouter",
      auth: { type: "managed_originrouter_key" },
      model: "claude-sonnet-4-6",
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /auth\.keyRef is required/);
  },
});

// 9. addProvider accepts remote with deviceId + auth.grantRef.
cases.push({
  name: "addProvider remote with deviceId+grantRef succeeds",
  run: () => {
    const r = tryAdd({
      name: "laptop",
      type: "remote",
      deviceId: "device-x",
      auth: { type: "device_grant", grantRef: "grant-1" },
      target: "proxy",
    });
    assert.equal(r.ok, true, `unexpected throw: ${r.error && r.error.message}`);
    assert.equal(r.provider.type, "remote");
    assert.equal(r.provider.deviceId, "device-x");
    assert.equal(r.provider.auth.type, "device_grant");
    assert.equal(r.provider.auth.grantRef, "grant-1");
    assert.equal(r.provider.target, "proxy");
  },
});

// 10. addProvider rejects remote without deviceId.
cases.push({
  name: "addProvider remote without deviceId throws",
  run: () => {
    const r = tryAdd({
      name: "laptop",
      type: "remote",
      auth: { type: "device_grant", grantRef: "grant-1" },
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /deviceId is required/);
  },
});

// 11. addProvider rejects proxy with non-litellm engine.
cases.push({
  name: "addProvider proxy with engine=direct_anthropic throws",
  run: () => {
    const r = tryAdd({
      name: "p",
      type: "proxy",
      engine: "direct_anthropic",
      litellmProvider: "anthropic",
      baseUrl: "https://x", apiKey: "k", model: "m",
    });
    assert.equal(r.ok, false);
    assert.match(r.error.message, /engine must be 'litellm'/);
  },
});

// 12. PROVIDER_TYPES is exactly the 9.0 canonical set.
cases.push({
  name: "PROVIDER_TYPES is [originrouter, proxy, remote]",
  run: () => {
    assert.deepEqual(PROVIDER_TYPES, ["originrouter", "proxy", "remote"]);
  },
});

// 13. normalizeProviderForWrite leaves a non-legacy record unchanged.
cases.push({
  name: "normalizeProviderForWrite leaves canonical records unchanged",
  run: () => {
    const rec = { name: "x", type: "originrouter", model: "m" };
    const out = normalizeProviderForWrite(rec);
    assert.equal(out, rec, "non-legacy records must pass through unchanged");
  },
});

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

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

console.log("provider config normalization tests ok");
