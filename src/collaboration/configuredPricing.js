import { providerModelEntries } from "../config/providerModels.js";

function count(value) {
  const number = Math.floor(Number(value) || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function price(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function configuredPricingFor(provider, modelId) {
  if (!provider || !modelId) return null;
  const requested = String(modelId);
  const direct = providerModelEntries(provider).find((entry) => entry.id === requested);
  if (direct?.pricing) return direct.pricing;
  const suffix = requested.includes("/") ? requested.slice(requested.indexOf("/") + 1) : requested;
  return providerModelEntries(provider).find((entry) => entry.id === suffix)?.pricing || null;
}

export function calculateConfiguredUsageCost(pricing, usage = {}) {
  if (!pricing?.enabled) return null;
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  const reasoning = Math.min(output, count(usage.reasoningTokens));
  const cacheRead = Math.min(input, count(usage.cacheReadInputTokens));
  const cacheWrite5m = count(usage.cacheWrite5mInputTokens);
  const cacheWrite1h = count(usage.cacheWrite1hInputTokens);
  const explicitCacheWrite = count(usage.cacheWriteInputTokens);
  const cacheWrite = Math.min(
    Math.max(0, input - cacheRead),
    Math.max(explicitCacheWrite, cacheWrite5m + cacheWrite1h),
  );
  const ordinaryInput = Math.max(0, input - cacheRead - cacheWrite);
  const ordinaryOutput = Math.max(0, output - reasoning);
  const genericCacheWrite = Math.max(0, cacheWrite - cacheWrite5m - cacheWrite1h);
  const inputPrice = price(pricing.input);
  const outputPrice = price(pricing.output);
  const reasoningPrice = price(pricing.reasoning, outputPrice);
  const cacheReadPrice = price(pricing.cacheReadInput, inputPrice);
  const cacheWritePrice = price(pricing.cacheWriteInput, inputPrice);
  const cacheWrite5mPrice = price(pricing.cacheWrite5mInput, cacheWritePrice);
  const cacheWrite1hPrice = price(pricing.cacheWrite1hInput, cacheWritePrice);
  const perMillion = ordinaryInput * inputPrice
    + cacheRead * cacheReadPrice
    + genericCacheWrite * cacheWritePrice
    + cacheWrite5m * cacheWrite5mPrice
    + cacheWrite1h * cacheWrite1hPrice
    + ordinaryOutput * outputPrice
    + reasoning * reasoningPrice;
  return {
    amountMicros: Math.max(0, Math.round(perMillion)),
    currency: pricing.currency || "USD",
    source: "configured",
  };
}

export function applyConfiguredPricing(event, { provider, model, source } = {}) {
  if (event?.type !== "agent.usage") return event;
  if (source !== "routes" && source !== "remote-coding") {
    return { ...event, amountMicros: null, currency: null, costSource: "unsupported" };
  }
  const pricing = configuredPricingFor(provider, model);
  const cost = calculateConfiguredUsageCost(pricing, event.tokenUsage);
  return cost
    ? { ...event, ...cost, costSource: cost.source }
    : { ...event, amountMicros: null, currency: null, costSource: "unconfigured" };
}
