import assert from "node:assert/strict";
import {
  buildLitellmProbeRequest,
  probeProviderModel,
} from "../src/proxy/modelProbe.js";

{
  let call;
  const result = await probeProviderModel(
    {
      litellmProvider: "custom_openai",
      baseUrl: "https://models.example/v1",
      apiKey: "sk-test",
    },
    "model-a",
    {
      completionRunner: async (request, options) => {
        call = { request, options };
        return { responseModel: "model-a", finishReason: "stop" };
      },
    },
  );
  assert.equal(call.request.model, "openai/model-a");
  assert.equal(call.request.params.api_base, "https://models.example/v1");
  assert.equal(call.request.params.api_key, "sk-test");
  assert.equal(call.options.timeoutMs, 20_000);
  assert.equal(result.ok, true);
  assert.equal(result.model, "model-a");
  assert.equal(result.litellmModel, "openai/model-a");
  assert.equal(result.finishReason, "stop");
}

{
  const request = buildLitellmProbeRequest(
    {
      litellmProvider: "anthropic",
      apiKey: "os.environ/ANTHROPIC_API_KEY",
    },
    "claude-test",
    { env: { ANTHROPIC_API_KEY: "sk-ant-test" } },
  );
  assert.equal(request.model, "anthropic/claude-test");
  assert.equal(request.params.api_key, "sk-ant-test");
}

{
  const request = buildLitellmProbeRequest(
    {
      litellmProvider: "bedrock",
      awsRegion: "us-east-1",
      awsProfileName: "originrouter-test",
    },
    "anthropic.claude-test-v1:0",
  );
  assert.equal(request.model, "bedrock/anthropic.claude-test-v1:0");
  assert.equal(request.params.aws_region_name, "us-east-1");
  assert.equal(request.params.aws_profile_name, "originrouter-test");
}

await assert.rejects(
  () => probeProviderModel(
    { litellmProvider: "deepseek", apiKey: "sk-test" },
    "deepseek-chat",
    {
      completionRunner: async () => {
        throw new Error("upstream rejected the request");
      },
    },
  ),
  /failed through LiteLLM: upstream rejected the request/,
);

console.log("model probe tests ok");
