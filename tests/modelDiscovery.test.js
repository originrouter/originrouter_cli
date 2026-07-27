import assert from "node:assert/strict";

import { discoverProviderModels } from "../src/proxy/modelDiscovery.js";

{
  const calls = [];
  const result = await discoverProviderModels({
    litellmProvider: "custom_openai",
    baseUrl: "https://models.example/v1",
    apiKey: "sk-secret",
  }, {
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "model-b", owned_by: "team" },
            { id: "model-a" },
            { id: "model-b" },
          ],
        }),
      };
    },
  });
  assert.equal(calls[0].url, "https://models.example/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer sk-secret");
  assert.deepEqual(result.models.map((model) => model.id), ["model-b", "model-a"]);
  assert.equal(result.models[0].ownedBy, "team");
}

{
  const calls = [];
  const result = await discoverProviderModels({
    litellmProvider: "anthropic",
    apiKey: "os.environ/ANTHROPIC_API_KEY",
  }, {
    env: { ANTHROPIC_API_KEY: "sk-ant-env" },
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "claude-sonnet-4-6" }] }),
      };
    },
  });
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  assert.equal(calls[0].options.headers["x-api-key"], "sk-ant-env");
  assert.equal(result.models[0].id, "claude-sonnet-4-6");
}

await assert.rejects(
  () => discoverProviderModels({ litellmProvider: "bedrock" }),
  /add models manually/,
);

console.log("model discovery tests ok");

