import assert from "node:assert/strict";

import {
  normalizeProviderModels,
  providerModelIds,
  remoteShareModelEntries,
} from "../src/config/providerModels.js";
import { addProvider, applyProviderUpdate, listProviders } from "../src/config/providers.js";
import {
  applyConfiguredPricing,
  calculateConfiguredUsageCost,
} from "../src/collaboration/configuredPricing.js";

{
  const provider = normalizeProviderModels({
    name: "priced",
    type: "proxy",
    models: [{
      id: "model-a",
      remoteEnabled: true,
      pricing: {
        currency: "USD",
        input: "2",
        output: "10",
        reasoning: "12",
        cacheReadInput: "0.2",
        cacheWriteInput: "2.5",
      },
    }],
  });
  assert.equal(provider.models[0].pricing.currency, "USD");
  assert.equal(remoteShareModelEntries(provider)[0].pricing.input, "2");
  assert.deepEqual(calculateConfiguredUsageCost(provider.models[0].pricing, {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    reasoningTokens: 20_000,
    cacheReadInputTokens: 500_000,
    cacheWriteInputTokens: 100_000,
  }), {
    amountMicros: 2_190_000,
    currency: "USD",
    source: "configured",
  });
  assert.deepEqual(applyConfiguredPricing({
    type: "agent.usage",
    tokenUsage: { inputTokens: 1_000_000, outputTokens: 100_000 },
  }, {
    provider,
    model: "model-a",
    source: "routes",
  }), {
    type: "agent.usage",
    tokenUsage: { inputTokens: 1_000_000, outputTokens: 100_000 },
    amountMicros: 3_000_000,
    currency: "USD",
    source: "configured",
    costSource: "configured",
  });
  assert.equal(applyConfiguredPricing({
    type: "agent.usage",
    tokenUsage: { inputTokens: 1_000_000 },
  }, {
    provider,
    model: "model-a",
    source: "originrouter-coding",
  }).costSource, "unsupported");
}

{
  const provider = normalizeProviderModels({
    name: "work",
    model: "gpt-5.4",
    models: ["gpt-5-mini", "gpt-5.4", "gpt-5-mini"],
  });
  assert.equal(provider.model, undefined);
  assert.deepEqual(provider.models, [
    { id: "gpt-5.4", enabled: true, remoteEnabled: false },
    { id: "gpt-5-mini", enabled: true, remoteEnabled: false },
  ]);
  assert.deepEqual(providerModelIds(provider), ["gpt-5.4", "gpt-5-mini"]);
}

{
  const provider = normalizeProviderModels({
    name: "work",
    models: [
      { id: "gpt-5-mini", enabled: true, remoteEnabled: true },
      { id: "gpt-5.4", enabled: true, remoteEnabled: true },
    ],
  });
  assert.equal(provider.model, undefined);
  assert.deepEqual(remoteShareModelEntries(provider), [
    {
      provider: "work/gpt-5-mini",
      sourceProvider: "work",
      model: "gpt-5-mini",
    },
    {
      provider: "work/gpt-5.4",
      sourceProvider: "work",
      model: "gpt-5.4",
    },
  ]);
}

assert.throws(
  () => normalizeProviderModels({ model: "gpt", models: "gpt" }),
  /must be an array/,
);
assert.throws(
  () => normalizeProviderModels({ models: [42] }),
  /model ids or model objects/,
);

{
  const added = addProvider({}, {
    name: "deepseek-work",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "deepseek",
    apiKey: "sk-test",
    model: "deepseek-chat",
    models: ["deepseek-reasoner", "deepseek-chat"],
  });
  assert.deepEqual(added.providers["deepseek-work"].models, [
    { id: "deepseek-chat", enabled: true, remoteEnabled: false },
    { id: "deepseek-reasoner", enabled: true, remoteEnabled: false },
  ]);
  assert.deepEqual(listProviders(added)[0].models, [
    { id: "deepseek-chat", enabled: true, remoteEnabled: false },
    { id: "deepseek-reasoner", enabled: true, remoteEnabled: false },
  ]);

  const updated = applyProviderUpdate(added, "deepseek-work", {
    models: [
      { id: "deepseek-chat", enabled: true, remoteEnabled: false },
      { id: "deepseek-reasoner", enabled: false, remoteEnabled: false },
      { id: "deepseek-coder", enabled: true, remoteEnabled: true },
    ],
  });
  assert.equal(updated.providers["deepseek-work"].model, undefined);
  assert.deepEqual(updated.providers["deepseek-work"].models, [
    { id: "deepseek-chat", enabled: true, remoteEnabled: false },
    { id: "deepseek-reasoner", enabled: false, remoteEnabled: false },
    { id: "deepseek-coder", enabled: true, remoteEnabled: true },
  ]);
}

// The reasoning levels are the reader's own words about a model the device
// does not know. They survive a save, they travel with a shared model, and
// clearing them is a statement — "this one does not reason" — not an
// omission.
{
  const provider = normalizeProviderModels({
    name: "work",
    type: "proxy",
    models: [
      { id: "gpt-5.4", enabled: true, remoteEnabled: true, effortLevels: ["low", "medium", "high"] },
      { id: "plain", enabled: true, remoteEnabled: true, effortLevels: [] },
      { id: "custom", enabled: true, remoteEnabled: true, effortLevels: [" ultra ", "ultra"] },
    ],
  });
  assert.deepEqual(provider.models[0].effortLevels, ["low", "medium", "high"]);
  assert.equal(provider.models[1].effortLevels, undefined);
  assert.deepEqual(provider.models[2].effortLevels, ["ultra"]);
  assert.deepEqual(remoteShareModelEntries(provider), [
    {
      provider: "work/gpt-5.4",
      sourceProvider: "work",
      model: "gpt-5.4",
      effortLevels: ["low", "medium", "high"],
    },
    {
      provider: "work/plain",
      sourceProvider: "work",
      model: "plain",
    },
    {
      provider: "work/custom",
      sourceProvider: "work",
      model: "custom",
      effortLevels: ["ultra"],
    },
  ]);

  assert.throws(
    () => normalizeProviderModels({
      name: "work",
      type: "proxy",
      models: [{ id: "gpt-5.4", effortLevels: "low" }],
    }),
    /effort levels must be an array/,
  );

  // A save that clears the levels clears them: the list is replaced whole.
  const added = addProvider({}, {
    name: "work",
    type: "proxy",
    engine: "litellm",
    litellmProvider: "openai",
    apiKey: "sk-test",
    models: [{ id: "gpt-5.4", effortLevels: ["low", "high"] }],
  });
  assert.deepEqual(added.providers["work"].models[0].effortLevels, ["low", "high"]);
  const updated = applyProviderUpdate(added, "work", {
    models: [{ id: "gpt-5.4", enabled: true, remoteEnabled: false, effortLevels: [] }],
  });
  assert.equal(updated.providers["work"].models[0].effortLevels, undefined);
}

console.log("provider model tests ok");
