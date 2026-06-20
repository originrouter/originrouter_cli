// Stage 7: catalog schema integrity tests. No rendering, no fs.

import assert from "node:assert/strict";
import {
  LITELLM_PROVIDERS,
  LITELLM_PROVIDER_IDS,
  getLitellmProfile,
  hasFlag,
  isAlias,
  paramsFor,
  prefixFor,
} from "../src/proxy/litellmCatalog.js";

// Frozen: cannot mutate.
assert.equal(Object.isFrozen(LITELLM_PROVIDERS), true, "LITELLM_PROVIDERS must be frozen");
assert.equal(Object.isFrozen(LITELLM_PROVIDER_IDS), true, "LITELLM_PROVIDER_IDS must be frozen");

// Each id appears exactly once.
{
  const seen = new Set();
  for (const p of LITELLM_PROVIDERS) {
    assert.ok(!seen.has(p.id), `duplicate catalog id: ${p.id}`);
    seen.add(p.id);
  }
}

// amazon_nova was dropped (per Stage 7 decision).
assert.equal(LITELLM_PROVIDER_IDS.includes("amazon_nova"), false, "amazon_nova must be dropped");

// qwen-via-dashscope is a label-only alias of dashscope.
assert.equal(isAlias("qwen-via-dashscope"), true);
assert.equal(isAlias("dashscope"), false);
assert.equal(isAlias("deepseek"), false);
assert.deepEqual(paramsFor("qwen-via-dashscope"), paramsFor("dashscope"));
assert.equal(prefixFor("qwen-via-dashscope"), prefixFor("dashscope"));
assert.equal(prefixFor("qwen-via-dashscope"), "dashscope");

// Every catalog entry has the basic shape: id/label/prefix/litellmParams/fields.
for (const p of LITELLM_PROVIDERS) {
  assert.ok(p.id && typeof p.id === "string", `${p.id}: id required`);
  assert.ok(p.label && typeof p.label === "string", `${p.id}: label required`);
  assert.ok(p.prefix && typeof p.prefix === "string", `${p.id}: prefix required`);
  assert.ok(Array.isArray(p.litellmParams) && p.litellmParams.length > 0, `${p.id}: litellmParams non-empty`);
  assert.ok(Array.isArray(p.fields) && p.fields.length > 0, `${p.id}: fields non-empty`);
  // For aliases, litellmParams is informational (real list comes from source); for non-aliases it must match fields.
  if (!p.paramsSource) {
    const fieldKeys = new Set(p.fields.map((f) => f.litellmParam));
    for (const k of p.litellmParams) {
      assert.ok(fieldKeys.has(k), `${p.id}: litellmParams key '${k}' not in fields[].litellmParam`);
    }
  }
}

// Each field has key + litellmParam.
for (const p of LITELLM_PROVIDERS) {
  for (const f of p.fields) {
    assert.ok(f.key && typeof f.key === "string", `${p.id}: field.key required`);
    assert.ok(f.litellmParam && typeof f.litellmParam === "string", `${p.id}: field.litellmParam required`);
    assert.ok(["text", "password"].includes(f.type), `${p.id}.${f.key}: type must be text|password`);
  }
}

// github_copilot has both `advanced` and `schema-only` flags.
assert.ok(hasFlag("github_copilot", "advanced"), "github_copilot should have advanced flag");
assert.ok(hasFlag("github_copilot", "schema-only"), "github_copilot should have schema-only flag");
assert.equal(hasFlag("deepseek", "advanced"), false);

// getLitellmProfile throws on unknown.
assert.throws(() => getLitellmProfile("ghost"), /unknown litellm provider/);
assert.throws(() => paramsFor("ghost"), /unknown litellm provider/);
assert.throws(() => prefixFor("ghost"), /unknown litellm provider/);
assert.throws(() => isAlias("ghost"), /unknown litellm provider/);

// Catalog size sanity check (plan: 34 entries — 35 minus amazon_nova).
assert.equal(LITELLM_PROVIDERS.length, 34, `expected 34 entries, got ${LITELLM_PROVIDERS.length}`);

// Confirm the "first batch" providers from the user brief are all present.
const requiredIds = [
  "anthropic", "openai", "custom_openai",
  "azure", "azure_ai",
  "bedrock", "sagemaker",
  "vertex_ai", "gemini",
  "deepseek", "openrouter", "groq", "together_ai", "fireworks_ai", "xai",
  "mistral", "cohere", "perplexity", "huggingface",
  "ollama", "ollama_chat", "lm_studio", "vllm", "hosted_vllm", "litellm_proxy",
  "minimax", "dashscope", "moonshot", "volcengine", "modelscope", "zai",
  "github", "github_copilot", "qwen-via-dashscope",
];
for (const id of requiredIds) {
  assert.ok(LITELLM_PROVIDER_IDS.includes(id), `catalog must include '${id}'`);
}

console.log("litellm catalog ok");