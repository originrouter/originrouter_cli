// Stage 4 pure-helper tests. No filesystem writes, no process spawns.

import assert from "node:assert/strict";
import { join } from "node:path";
import { ENV_REF_RE } from "../src/proxy/litellm.js";
import {
  LITELLM_PACKAGE,
  LITELLM_VERSION,
  NOOP_ANTHROPIC_API_KEY,
  isInstalled,
  litellmArgs,
  litellmBinaryPath,
  pipBinaryPath,
  pythonBinaryPath,
  renderLitellmConfigYaml,
  renderLitellmProvidersConfigYaml,
  renderLitellmRoutesConfigYaml,
  runtimeDir,
  venvDir,
} from "../src/proxy/litellm.js";

assert.equal(LITELLM_VERSION, "1.83.0", "pinned version — bump deliberately, not as a side effect");
assert.equal(LITELLM_PACKAGE, "litellm[proxy]==1.83.0");
assert.ok(NOOP_ANTHROPIC_API_KEY.startsWith("sk-"), "no-op key must be non-empty so Claude Code accepts it");

// ---------- path helpers ----------
{
  const stateDir = "/home/u/.originrouter";
  assert.equal(runtimeDir(stateDir), join(stateDir, "runtimes", "litellm", "1.83.0"));
  assert.equal(runtimeDir(stateDir, "1.84.0"), join(stateDir, "runtimes", "litellm", "1.84.0"));
  assert.equal(venvDir(stateDir), join(stateDir, "runtimes", "litellm", "1.83.0", "venv"));
  assert.equal(pythonBinaryPath(stateDir), join(stateDir, "runtimes", "litellm", "1.83.0", "venv", "bin", "python"));
  assert.equal(litellmBinaryPath(stateDir), join(stateDir, "runtimes", "litellm", "1.83.0", "venv", "bin", "litellm"));
  assert.equal(pipBinaryPath(stateDir), join(stateDir, "runtimes", "litellm", "1.83.0", "venv", "bin", "pip"));
}

// ---------- isInstalled ----------
{
  // Pass a stateDir under tmpdir that doesn't have the venv — must be false.
  const tmp = `/tmp/originrouter-litellm-noexist-${Date.now()}`;
  assert.equal(isInstalled(tmp), false);
}

// ---------- litellmArgs ----------
{
  const args = litellmArgs("/path/to/config.yaml", 40123, "127.0.0.1");
  assert.deepEqual(args, [
    "--config", "/path/to/config.yaml",
    "--host", "127.0.0.1",
    "--port", "40123",
  ]);
  // Default host is loopback (index 3 is "--host", 4 is the value).
  const defaultArgs = litellmArgs("/p", 0);
  assert.deepEqual(defaultArgs, ["--config", "/p", "--host", "127.0.0.1", "--port", "0"]);
}

// ---------- renderLitellmConfigYaml ----------
{
  const yaml = renderLitellmProvidersConfigYaml([
    {
      name: "deepseek",
      type: "proxy",
      engine: "litellm",
      litellmProvider: "deepseek",
      apiKey: "sk-deepseek",
      model: "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner"],
    },
    {
      name: "glm",
      type: "proxy",
      engine: "litellm",
      litellmProvider: "custom_openai",
      baseUrl: "https://glm.example/v1",
      apiKey: "sk-glm",
      model: "glm-5",
    },
  ]);
  assert.match(yaml, /model_name: deepseek\/deepseek-chat/);
  assert.match(yaml, /model_name: deepseek\/deepseek-reasoner/);
  assert.match(yaml, /model_name: glm\/glm-5/);
  assert.match(yaml, /model: deepseek\/deepseek-chat/);
  assert.match(yaml, /model: deepseek\/deepseek-reasoner/);
  assert.match(yaml, /model: openai\/glm-5/);
}
{
  // DeepSeek via the legacy openai-compatible path renders to the v1 YAML
  // byte-for-byte (backward compat). The `deepseek/` prefix is selected by
  // the catalog entry for litellmProvider=deepseek, but the legacy type
  // resolves to custom_openai (openai/ prefix) — so this case uses the
  // provider.name as a hint: legacy openai-compatible stays openai/.
  const yaml = renderLitellmConfigYaml({
    name: "deepseek",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-ds-1234567890",
    model: "deepseek-chat",
  });
  // Expected keys present.
  assert.match(yaml, /^model_list:/m);
  assert.match(yaml, /model_name: deepseek/);
  assert.match(yaml, /model: openai\/deepseek-chat/);
  assert.match(yaml, /api_key: "sk-ds-1234567890"/);
  assert.match(yaml, /api_base: "https:\/\/api\.deepseek\.com\/v1"/);
  assert.match(yaml, /drop_params: true/);
}
{
  // Unknown openai-compatible provider falls back to `openai/` prefix.
  const yaml = renderLitellmConfigYaml({
    name: "my-custom-llm",
    type: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-x-1234567890",
    model: "my-model",
  });
  assert.match(yaml, /model_name: my-custom-llm/);
  assert.match(yaml, /model: openai\/my-model/);
}
{
  // Refuses type=anthropic (the direct path; not a LiteLLM provider).
  assert.throws(
    () => renderLitellmConfigYaml({ name: "x", type: "anthropic", apiKey: "k", baseUrl: "u", model: "m" }),
    /unsupported provider type 'anthropic'/,
  );
  // Null and unknown types throw.
  assert.throws(() => renderLitellmConfigYaml(null), /provider required/);
  assert.throws(
    () => renderLitellmConfigYaml({ name: "x", type: "litellm", litellmProvider: "ghost" }),
    /unknown litellm provider/,
  );
  // Refuses missing required fields (catalog fields iterate in catalog order).
  // Stage 7.7: custom_openai has only baseUrl as `required: true` (no env
  // fallback). apiKey is runtimeRequired, so save/render succeeds without it.
  assert.throws(() => renderLitellmConfigYaml({ name: "x", type: "openai-compatible" }), /model/);
  assert.throws(() => renderLitellmConfigYaml({ name: "x", type: "openai-compatible", model: "m" }), /missing required field 'baseUrl'/);
  // Save succeeds with baseUrl but no apiKey (runtimeRequired only).
  const yamlNoKey = renderLitellmConfigYaml({
    name: "x", type: "openai-compatible", baseUrl: "https://x", model: "m",
  });
  assert.match(yamlNoKey, /api_base: "https:\/\/x"/);
  assert.doesNotMatch(yamlNoKey, /api_key:/);
}

// ---------- per-provider catalog rendering ----------
{
  // type=litellm + litellmProvider=deepseek produces the deepseek/ prefix.
  const yaml = renderLitellmConfigYaml({
    name: "deepseek-via-litellm",
    type: "litellm",
    litellmProvider: "deepseek",
    apiKey: "sk-ds-xxx",
    model: "deepseek-chat",
  });
  assert.match(yaml, /model_name: deepseek-via-litellm/);
  assert.match(yaml, /model: deepseek\/deepseek-chat/);
  assert.match(yaml, /api_key: "sk-ds-xxx"/);
  // No api_base — deepseek doesn't require it.
  assert.doesNotMatch(yaml, /api_base:/);
}
{
  // type=litellm + litellmProvider=anthropic routes Anthropic through the
  // proxy (used when the user wants LiteLLM in front of Anthropic).
  const yaml = renderLitellmConfigYaml({
    name: "anthropic-via-litellm",
    type: "litellm",
    litellmProvider: "anthropic",
    apiKey: "sk-ant-xxx",
    model: "claude-3-5-sonnet-latest",
  });
  assert.match(yaml, /model: anthropic\/claude-3-5-sonnet-latest/);
  assert.match(yaml, /api_key: "sk-ant-xxx"/);
}
{
  // Azure: api_version is required.
  const yaml = renderLitellmConfigYaml({
    name: "my-azure",
    type: "litellm",
    litellmProvider: "azure",
    apiKey: "azure-key",
    baseUrl: "https://x.openai.azure.com/",
    apiVersion: "2024-07-01-preview",
    model: "gpt-4",
  });
  assert.match(yaml, /model: azure\/gpt-4/);
  assert.match(yaml, /api_key: "azure-key"/);
  assert.match(yaml, /api_base: "https:\/\/x\.openai\.azure\.com\/"/);
  assert.match(yaml, /api_version: "2024-07-01-preview"/);
  // Stage 7.7: apiVersion is runtimeRequired (not required). Render succeeds
// without it; the YAML omits api_version entirely.
  const yamlNoVersion = renderLitellmConfigYaml({
    name: "x", type: "litellm", litellmProvider: "azure",
    apiKey: "k", baseUrl: "u", model: "m",
  });
  assert.doesNotMatch(yamlNoVersion, /api_version:/);
}
{
  // Bedrock: aws_region_name required; optional inline creds only rendered when present.
  const yamlBase = renderLitellmConfigYaml({
    name: "br",
    type: "litellm",
    litellmProvider: "bedrock",
    awsRegion: "us-east-1",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  });
  assert.match(yamlBase, /model: bedrock\/anthropic\.claude-3-5-sonnet-20241022-v2:0/);
  assert.match(yamlBase, /aws_region_name: "us-east-1"/);
  assert.doesNotMatch(yamlBase, /aws_access_key_id/);
  assert.doesNotMatch(yamlBase, /aws_secret_access_key/);

  const yamlFull = renderLitellmConfigYaml({
    name: "br",
    type: "litellm",
    litellmProvider: "bedrock",
    awsRegion: "us-east-1",
    awsAccessKeyId: "AKIA...",
    awsSecretAccessKey: "secret",
    awsSessionToken: "session",
    awsProfileName: "default",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  });
  assert.match(yamlFull, /aws_region_name: "us-east-1"/);
  assert.match(yamlFull, /aws_access_key_id: "AKIA\.\.\."/);
  assert.match(yamlFull, /aws_secret_access_key: "secret"/);
  assert.match(yamlFull, /aws_session_token: "session"/);
  assert.match(yamlFull, /aws_profile_name: "default"/);
}
{
  // Vertex AI: vertex_project + vertex_location required.
  const yaml = renderLitellmConfigYaml({
    name: "vx",
    type: "litellm",
    litellmProvider: "vertex_ai",
    vertexProject: "my-proj",
    vertexLocation: "us-central1",
    model: "gemini-1.5-pro",
  });
  assert.match(yaml, /model: vertex_ai\/gemini-1\.5-pro/);
  assert.match(yaml, /vertex_project: "my-proj"/);
  assert.match(yaml, /vertex_location: "us-central1"/);
  assert.doesNotMatch(yaml, /google_application_credentials/);
  // Optional creds path.
  const yaml2 = renderLitellmConfigYaml({
    name: "vx",
    type: "litellm",
    litellmProvider: "vertex_ai",
    vertexProject: "p",
    vertexLocation: "l",
    googleApplicationCredentials: "/tmp/sa.json",
    model: "gemini-1.5-pro",
  });
  assert.match(yaml2, /google_application_credentials: "\/tmp\/sa\.json"/);
}
{
  // Gemini: api_key only.
  const yaml = renderLitellmConfigYaml({
    name: "gem",
    type: "litellm",
    litellmProvider: "gemini",
    apiKey: "AIza-xxx",
    model: "gemini-1.5-pro",
  });
  assert.match(yaml, /model: gemini\/gemini-1\.5-pro/);
  assert.match(yaml, /api_key: "AIza-xxx"/);
  assert.doesNotMatch(yaml, /api_base/);
}
{
  // Ollama: api_base only (no api_key).
  const yaml = renderLitellmConfigYaml({
    name: "ol",
    type: "litellm",
    litellmProvider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "llama2",
  });
  assert.match(yaml, /model: ollama\/llama2/);
  assert.match(yaml, /api_base: "http:\/\/localhost:11434"/);
  assert.doesNotMatch(yaml, /api_key/);
}
{
  // HuggingFace: hf_token (NOT api_key).
  const yaml = renderLitellmConfigYaml({
    name: "hf",
    type: "litellm",
    litellmProvider: "huggingface",
    apiKey: "hf_xxx",
    model: "meta-llama/Meta-Llama-3-8B-Instruct",
  });
  assert.match(yaml, /model: huggingface\/meta-llama\/Meta-Llama-3-8B-Instruct/);
  assert.match(yaml, /api_key: "hf_xxx"/);
  assert.doesNotMatch(yaml, /hf_token/);
}
{
  // qwen-via-dashscope: alias resolves to dashscope/ prefix, NOT qwen-via-dashscope/.
  const yaml = renderLitellmConfigYaml({
    name: "qw",
    type: "litellm",
    litellmProvider: "qwen-via-dashscope",
    apiKey: "sk-dsq-xxx",
    model: "qwen-turbo",
  });
  assert.match(yaml, /model: dashscope\/qwen-turbo/);
  assert.doesNotMatch(yaml, /model: qwen-via-dashscope\//);
  assert.match(yaml, /api_key: "sk-dsq-xxx"/);
}
{
  // Z.AI / GLM.
  const yaml = renderLitellmConfigYaml({
    name: "zai",
    type: "litellm",
    litellmProvider: "zai",
    apiKey: "zai-xxx",
    model: "glm-4.5",
  });
  assert.match(yaml, /model: zai\/glm-4\.5/);
  assert.match(yaml, /api_key: "zai-xxx"/);
}

// ---------- adversarial ----------
{
  // YAML escape: backslashes and quotes round-trip safely (no newline in this one).
  const yaml = renderLitellmConfigYaml({
    name: "adv",
    type: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    apiKey: 'sk-"weird"\\key\\value',
    model: 'weird:model#"1"',
  });
  // The escaped form is in the YAML.
  assert.match(yaml, /api_key: "sk-\\"weird\\"\\\\key\\\\value"/);
  assert.match(yaml, /model: openai\/weird:model#\\"1\\"/);
}
{
  // Newline in field values throws.
  assert.throws(
    () => renderLitellmConfigYaml({
      name: "x", type: "openai-compatible", baseUrl: "u", apiKey: "k\n", model: "m",
    }),
    /forbidden character/,
  );
}
{
  // Null byte in field values throws.
  assert.throws(
    () => renderLitellmConfigYaml({
      name: "x", type: "openai-compatible", baseUrl: "u\0", apiKey: "k", model: "m",
    }),
    /forbidden character/,
  );
}

// ---------- Stage 7.5: renderLitellmRoutesConfigYaml ----------

const ROUTE_PROVIDERS = {
  deepseek: { name: "deepseek", type: "litellm", litellmProvider: "deepseek", apiKey: "sk-ds", model: "deepseek-chat" },
  moonshot: { name: "moonshot", type: "litellm", litellmProvider: "moonshot", apiKey: "sk-ms", model: "moonshot-v1-8k" },
  // type=anthropic, included to test the renderer's rejection of non-litellm backings.
  minimax:  { name: "minimax",  type: "anthropic", baseUrl: "https://api.minimax.example/v1", apiKey: "sk-mm", model: "MiniMax-M3" },
};

{
  // Main only — minimal valid route set; small is the fast fallback to main.
  const yaml = renderLitellmRoutesConfigYaml(
    { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } },
    ROUTE_PROVIDERS,
  );
  assert.match(yaml, /model_name: originrouter-claude-model/);
  assert.match(yaml, /model: deepseek\/deepseek-chat/);
  assert.match(yaml, /api_key: "sk-ds"/);
  assert.match(yaml, /drop_params: true/);
  // Both aliases present (small falls back to main).
  assert.match(yaml, /model_name: originrouter-claude-fast-model/);
  // The fast alias has the same params as the main alias.
  const fastStart = yaml.indexOf("originrouter-claude-fast-model");
  const fastBlock = yaml.slice(fastStart);
  assert.match(fastBlock, /model: deepseek\/deepseek-chat/);
  assert.match(fastBlock, /api_key: "sk-ds"/);
}

{
  // Main + small use one Provider, while each alias can select a different
  // model exposed by that Provider.
  const yaml = renderLitellmRoutesConfigYaml(
    {
      claude: {
        main:  { provider: "deepseek", model: "deepseek-chat" },
        small: { provider: "deepseek", model: "deepseek-chat-fast" },
      },
    },
    ROUTE_PROVIDERS,
  );
  assert.match(yaml, /model_name: originrouter-claude-model/);
  assert.match(yaml, /model: deepseek\/deepseek-chat/);
  assert.match(yaml, /model_name: originrouter-claude-fast-model/);
  assert.match(yaml, /model: deepseek\/deepseek-chat-fast/);
  // Both keys present, in the order main → fast.
  const mainIdx = yaml.indexOf("originrouter-claude-model\n");
  const smallIdx = yaml.indexOf("originrouter-claude-fast-model");
  assert.ok(mainIdx >= 0 && smallIdx > mainIdx, "main must appear before fast");
}

{
  assert.throws(
    () => renderLitellmRoutesConfigYaml(
      {
        claude: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          small: { provider: "moonshot", model: "moonshot-v1-8k" },
        },
      },
      ROUTE_PROVIDERS,
    ),
    /Claude main and small routes must use the same provider/,
  );
}

{
  // Empty Agent routes still expose enabled Provider models for App chat.
  const providerOnlyYaml = renderLitellmRoutesConfigYaml({}, ROUTE_PROVIDERS);
  assert.match(providerOnlyYaml, /model_name: deepseek\/deepseek-chat/);
  assert.throws(
    () => renderLitellmRoutesConfigYaml({}, {}),
    /no enabled local LiteLLM models or Agent routes configured/,
  );
}

{
  // Dangling route (provider deleted) throws at render time.
  assert.throws(
    () => renderLitellmRoutesConfigYaml(
      { claude: { main: { provider: "ghost", model: "x" } } },
      ROUTE_PROVIDERS,
    ),
    /routes\.claude\.main references a provider that no longer exists/,
  );
}

{
  // Stage 8.0: type=anthropic is read-projected to type=litellm by the
  // renderer (matching the projection validateRouteEntry() applies at
  // write time), so the alias IS emitted rather than rejected. This
  // closes the "route set succeeded but proxy render failed" gap.
  const yaml = renderLitellmRoutesConfigYaml(
    { claude: { main: { provider: "minimax", model: "MiniMax-M3" } } },
    ROUTE_PROVIDERS,
  );
  assert.match(yaml, /model_name: originrouter-claude-model/);
  assert.match(yaml, /model: anthropic\/MiniMax-M3/);
}

{
  // Required fields are emitted; optional missing fields are omitted.
  // deepseek only has api_key; render must not invent keys.
  const yaml = renderLitellmRoutesConfigYaml(
    { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } },
    ROUTE_PROVIDERS,
  );
  assert.ok(!/aws_/.test(yaml),  "no AWS keys in deepseek route");
  assert.ok(!/vertex_/.test(yaml), "no Vertex keys in deepseek route");
}

{
  // Model override on a route wins over provider.model.
  const yaml = renderLitellmRoutesConfigYaml(
    { claude: { main: { provider: "deepseek", model: "deepseek-reasoner" } } },
    ROUTE_PROVIDERS,
  );
  assert.match(yaml, /model: deepseek\/deepseek-reasoner/);
}

{
  // Adversarial: provider field contains \n.
  const providersWithBad = {
    deepseek: { ...ROUTE_PROVIDERS.deepseek, apiKey: "sk-ds\nINJECT" },
  };
  assert.throws(
    () => renderLitellmRoutesConfigYaml(
      { claude: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      providersWithBad,
    ),
    /forbidden character/,
  );
}

// ---------- Stage 7.7: catalog fidelity ----------

{
  // Env-ref regex is exported and matches the documented shape.
  assert.equal(ENV_REF_RE.test("os.environ/DEEPSEEK_API_KEY"), true);
  assert.equal(ENV_REF_RE.test("os.environ/A"), true);
  assert.equal(ENV_REF_RE.test("os.environ/_UNDERSCORE_OK"), true);
  assert.equal(ENV_REF_RE.test("os.environ/"), false);          // empty var
  assert.equal(ENV_REF_RE.test("os.environ/1foo"), false);       // leading digit
  assert.equal(ENV_REF_RE.test("os.environ/A B"), false);        // space
  assert.equal(ENV_REF_RE.test("os.environ/A/B"), false);        // slash
  assert.equal(ENV_REF_RE.test("os.environ/A-B"), false);        // dash
  assert.equal(ENV_REF_RE.test("DEEPSEEK_API_KEY"), false);      // missing prefix
}

{
  // Env-ref round-trips verbatim through renderer.
  const yaml = renderLitellmConfigYaml({
    name: "deepseek-env", type: "litellm", litellmProvider: "deepseek",
    apiKey: "os.environ/DEEPSEEK_API_KEY",
    baseUrl: "os.environ/DEEPSEEK_API_BASE",
    model: "deepseek-chat",
  });
  assert.match(yaml, /api_key: "os\.environ\/DEEPSEEK_API_KEY"/);
  assert.match(yaml, /api_base: "os\.environ\/DEEPSEEK_API_BASE"/);
}

{
  // Malformed env-refs throw at render time.
  assert.throws(
    () => renderLitellmConfigYaml({
      name: "x", type: "litellm", litellmProvider: "deepseek",
      apiKey: "os.environ/", model: "m",
    }),
    /malformed env reference/,
  );
  assert.throws(
    () => renderLitellmConfigYaml({
      name: "x", type: "litellm", litellmProvider: "deepseek",
      apiKey: "os.environ/A B", model: "m",
    }),
    /malformed env reference/,
  );
  assert.throws(
    () => renderLitellmConfigYaml({
      name: "x", type: "litellm", litellmProvider: "deepseek",
      apiKey: "os.environ/1foo", model: "m",
    }),
    /malformed env reference/,
  );
}

{
  // No fake-api-key is ever emitted for litellm_proxy even when apiKey blank.
  const yaml = renderLitellmConfigYaml({
    name: "lp", type: "litellm", litellmProvider: "litellm_proxy",
    baseUrl: "http://upstream:4000", model: "m",
  });
  assert.doesNotMatch(yaml, /api_key:/);
  assert.doesNotMatch(yaml, /fake-api-key/);
}

{
  // UI-only metadata must never appear in the rendered YAML.
  const yaml = renderLitellmConfigYaml({
    name: "ds", type: "litellm", litellmProvider: "deepseek",
    apiKey: "k", model: "m",
  });
  for (const uiKey of ["inlineCreds", "envVar", "advanced", "help", "secret", "omitIfBlank", "runtimeRequired", "showOnlyIf"]) {
    assert.ok(!yaml.includes(uiKey + ":"), `UI-only key '${uiKey}:' must not appear in rendered YAML`);
    assert.ok(!yaml.includes("'" + uiKey + "'"), `UI-only key '${uiKey}' must not appear in rendered YAML`);
  }
}

{
  // Bedrock advanced AWS params render when set, omit when blank.
  const yamlAll = renderLitellmConfigYaml({
    name: "br", type: "litellm", litellmProvider: "bedrock",
    awsRegion: "us-east-1",
    awsRoleName: "arn:aws:iam::1:role/x",
    awsSessionName: "session-1",
    awsBedrockRuntimeEndpoint: "https://vpce-xxx.bedrock-runtime.us-east-1.vpce.amazonaws.com",
    awsWebIdentityToken: "os.environ/AWS_WEB_IDENTITY_TOKEN_FILE",
    awsStsEndpoint: "https://sts.us-east-1.amazonaws.com",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  });
  assert.match(yamlAll, /aws_role_name: "arn:aws:iam::1:role\/x"/);
  assert.match(yamlAll, /aws_session_name: "session-1"/);
  assert.match(yamlAll, /aws_bedrock_runtime_endpoint: "https:\/\/vpce-xxx\.bedrock-runtime\.us-east-1\.vpce\.amazonaws\.com"/);
  assert.match(yamlAll, /aws_web_identity_token: "os\.environ\/AWS_WEB_IDENTITY_TOKEN_FILE"/);
  assert.match(yamlAll, /aws_sts_endpoint: "https:\/\/sts\.us-east-1\.amazonaws\.com"/);
}

{
  // Vertex credentials inline JSON round-trips as a string (not parsed).
  const json = '{"type":"service_account","project_id":"p","private_key_id":"k","private_key":"-----BEGIN PRIVATE KEY-----\\nfoo\\n-----END PRIVATE KEY-----\\n","client_email":"sa@p.iam.gserviceaccount.com"}';
  const yaml = renderLitellmConfigYaml({
    name: "vx", type: "litellm", litellmProvider: "vertex_ai",
    vertexProject: "p", vertexLocation: "us-central1",
    vertexCredentials: json,
    model: "gemini-1.5-pro",
  });
  // Quotes and newlines get YAML-escaped but the structure is preserved.
  assert.match(yaml, /vertex_credentials: "{/);
  assert.match(yaml, /private_key/);
}

{
  // Rendered YAML header is Stage 7.7, not Stage 7.
  const yaml = renderLitellmConfigYaml({
    name: "ds", type: "litellm", litellmProvider: "deepseek",
    apiKey: "k", model: "m",
  });
  assert.match(yaml, /Stage 7\.7/);
  assert.doesNotMatch(yaml, /Stage 7\.[05]\b/);
}

// ---------- Stage 8.0: multi-agent routes ----------

const CODEX_PROVIDERS = {
  ...ROUTE_PROVIDERS,
  openai_codex: { name: "openai_codex", type: "litellm", litellmProvider: "openai", apiKey: "sk-oai", model: "gpt-5-codex" },
  originrouter_cloud: { name: "originrouter_cloud", type: "originrouter", model: "grok-4.5" },
};

{
  // Only codex route → only the Codex alias appears. No Claude aliases.
  const yaml = renderLitellmRoutesConfigYaml(
    { codex: { main: { provider: "openai_codex", model: "gpt-5-codex" } } },
    CODEX_PROVIDERS,
  );
  assert.match(yaml, /model_name: gpt-5.4/);
  assert.match(yaml, /model: openai\/gpt-5-codex/);
  assert.doesNotMatch(yaml, /originrouter-claude-model/);
  assert.doesNotMatch(yaml, /originrouter-claude-fast-model/);
}

{
  // Mixed Cloud + local proxy routes render only aliases that need LiteLLM.
  const yaml = renderLitellmRoutesConfigYaml(
    {
      claude: {
        main: { provider: "originrouter_cloud", model: "grok-4.5" },
        small: { provider: "originrouter_cloud", model: "grok-4.5" },
      },
      codex: { main: { provider: "openai_codex", model: "gpt-5-codex" } },
    },
    CODEX_PROVIDERS,
  );
  assert.match(yaml, /model_name: gpt-5.4/);
  assert.doesNotMatch(yaml, /originrouter-claude-model/);
  assert.doesNotMatch(yaml, /originrouter-claude-fast-model/);
}

{
  const yaml = renderLitellmRoutesConfigYaml(
    { claude: { main: { provider: "originrouter_cloud", model: "grok-4.5" } } },
    CODEX_PROVIDERS,
  );
  assert.match(yaml, /model_name: openai_codex\/gpt-5-codex/);
  assert.doesNotMatch(yaml, /originrouter-claude-model/);
}

{
  // Both Claude routes + Codex route → all three aliases.
  const yaml = renderLitellmRoutesConfigYaml(
    {
      claude: {
        main:  { provider: "deepseek", model: "deepseek-chat" },
        small: { provider: "deepseek", model: "deepseek-chat-fast" },
      },
      codex: { main: { provider: "openai_codex", model: "gpt-5-codex" } },
    },
    CODEX_PROVIDERS,
  );
  assert.match(yaml, /model_name: originrouter-claude-model/);
  assert.match(yaml, /model_name: originrouter-claude-fast-model/);
  assert.match(yaml, /model_name: gpt-5.4/);
  // Codex alias appears after the Claude aliases (ROUTE_AGENTS order).
  const claudeMainIdx = yaml.indexOf("originrouter-claude-model");
  const codexIdx = yaml.indexOf("gpt-5.4");
  assert.ok(claudeMainIdx >= 0 && codexIdx > claudeMainIdx, "codex must appear after claude aliases");
}

{
  // Codex dangling provider error uses routes.codex.main prefix.
  assert.throws(
    () => renderLitellmRoutesConfigYaml(
      { codex: { main: { provider: "ghost", model: "x" } } },
      CODEX_PROVIDERS,
    ),
    /routes\.codex\.main references a provider that no longer exists/,
  );
}

{
  // Codex never falls back: passing a small entry alongside main does NOT
  // emit a Codex fast alias (Codex 8.0 has no small slot).
  const yaml = renderLitellmRoutesConfigYaml(
    {
      codex: {
        main:  { provider: "openai_codex", model: "gpt-5-codex" },
        small: { provider: "openai_codex", model: "gpt-5-codex" },
      },
    },
    CODEX_PROVIDERS,
  );
  // Exactly one Codex alias; no Codex fast alias.
  const codexAliasMatches = yaml.match(/model_name: gpt-5.4/g) || [];
  assert.equal(codexAliasMatches.length, 1, "Codex 8.0 emits exactly one alias; small is ignored");
}

console.log("litellm tests ok");
