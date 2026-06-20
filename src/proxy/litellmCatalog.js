// Stage 7.7: LiteLLM provider catalog.
//
// Source of truth for which providers OriginRouter knows how to render as
// LiteLLM `model_list` entries. Each entry declares:
//   - id                stable id used in `provider.litellmProvider` and CLI flags
//   - label             display name (browser UI, CLI help)
//   - prefix            litellm_params `model:` prefix (e.g. `bedrock`, `zai`)
//   - modelPlaceholder  placeholder shown in the model input
//   - litellmParams     ordered list of `litellm_params:` keys this provider emits
//   - fields[]          UI input definitions, each carrying `litellmParam` for
//                       mapping to the snake_case litellm key. Field metadata:
//                         key             — provider record's camelCase key
//                         litellmParam    — snake_case YAML key
//                         label           — display label
//                         type            — "text" | "password"
//                         required        — true => throw on save when blank
//                                            (Stage 7.7: ZERO fields use this;
//                                            use runtimeRequired instead)
//                         runtimeRequired — true => doctor warns + proxy-start
//                                            surfaces provider+field hint when
//                                            LiteLLM needs this at runtime
//                                            (env / chain fallback may satisfy)
//                         secret          — true => masked in summarize / list
//                                            / API responses; input defaults
//                                            to "password"
//                         envVar          — UI hint chip text; multi-env
//                                            strings (e.g. "AWS_REGION /
//                                            AWS_REGION_NAME") are UI hints
//                                            only — env-refs in values accept
//                                            exactly one var
//                         omitIfBlank     — true => field omitted from YAML
//                                            when blank (default for optional)
//                         advanced        — true => rendered under Advanced
//                                            section in UI
//                         showOnlyIf      — "inlineCreds" => only rendered
//                                            when draft.inlineCreds === true
//                                            (Bedrock / SageMaker inline creds)
//                         placeholder     — input placeholder
//                         help            — long-form hint under the input
//   - paramsSource?     when set, `paramsFor`/`prefixFor` resolve through this
//                       id (used for label-only aliases like
//                       `qwen-via-dashscope`)
//   - flags?            UI hints — `"advanced"` adds an "experimental" badge;
//                       `"schema-only"` adds a red "schema-only" badge
//   - help?             long-form warning rendered under the form
//
// The catalog is a frozen array. Add a new provider by adding an entry here
// (plus tests); no renderer changes required.
//
// Stage 7.7 invariant: `required: true` is reserved for the rare case of a
// field with NO env fallback at all (e.g. `custom_openai.baseUrl`,
// `azure.baseUrl`, `azure_ai.baseUrl`, `litellm_proxy.baseUrl`). Every
// field that LiteLLM might need at runtime has `runtimeRequired: true`
// and an env-var hint. The validator accepts blank; doctor + proxy-start
// catch the failure mode later. This avoids forcing the user to paste a key
// when one is already in their environment.

export const LITELLM_PROVIDERS = Object.freeze([
  {
    id: "anthropic",
    label: "Anthropic (via LiteLLM)",
    prefix: "anthropic",
    modelPlaceholder: "claude-3-5-sonnet-latest",
    litellmParams: ["api_key", "api_base", "auth_token"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "API key (X-Api-Key)",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "ANTHROPIC_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "ANTHROPIC_API_BASE / ANTHROPIC_BASE_URL",
        placeholder: "(leave blank for api.anthropic.com)",
        help: "Set Base URL for Anthropic-compatible endpoints (e.g. MiniMax, third-party gateways)." },
      { key: "authToken", litellmParam: "auth_token", label: "Auth token (Bearer)",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: false, envVar: "ANTHROPIC_AUTH_TOKEN",
        help: "Used as Authorization: Bearer instead of X-Api-Key. Pick one of apiKey / authToken; authToken takes precedence." },
    ],
    help: "Routes Anthropic-format requests through LiteLLM. Without a Base URL, LiteLLM defaults to api.anthropic.com. api_key uses X-Api-Key; auth_token uses Authorization: Bearer.",
  },
  {
    id: "openai",
    label: "OpenAI",
    prefix: "openai",
    modelPlaceholder: "gpt-4o-mini",
    litellmParams: ["api_key", "api_base", "organization"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "OpenAI API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "OPENAI_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "OPENAI_API_BASE",
        placeholder: "(leave blank for api.openai.com)" },
      { key: "organization", litellmParam: "organization", label: "Organization",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "OPENAI_ORGANIZATION" },
    ],
  },
  {
    id: "custom_openai",
    label: "OpenAI-compatible (custom endpoint)",
    prefix: "openai",
    modelPlaceholder: "gpt-4o-mini",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true,
        help: "Required at runtime unless the upstream endpoint allows anonymous requests." },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", required: true, // Stage 7.7 exception: generic custom_openai has no env fallback for the endpoint.
        placeholder: "https://...",
        help: "Generic OpenAI-compatible endpoint. Use this when the provider does not have its own LiteLLM adapter." },
    ],
    help: "Generic OpenAI-compatible endpoint. Use this when the provider does not have its own LiteLLM adapter (or when you want to point at a custom proxy).",
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    prefix: "azure",
    modelPlaceholder: "<your-deployment-name>",
    litellmParams: ["api_key", "api_base", "api_version", "azure_ad_token"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "AZURE_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", required: true,
        placeholder: "https://<resource>.openai.azure.com/",
        envVar: "AZURE_API_BASE" },
      { key: "apiVersion", litellmParam: "api_version", label: "API version",
        type: "text", omitIfBlank: true, runtimeRequired: true,
        envVar: "AZURE_API_VERSION",
        placeholder: "2024-07-01-preview" },
      { key: "azureAdToken", litellmParam: "azure_ad_token", label: "Azure AD token",
        type: "password", secret: true, omitIfBlank: true, advanced: true,
        runtimeRequired: false, envVar: "AZURE_AD_TOKEN",
        help: "Used in place of api_key for service-principal / managed-identity flows. (For dynamic-token providers, edit the rendered YAML — Stage 7.7 does not expose that flow as a form field.)" },
    ],
    help: "Model name must be the Azure deployment name (not the underlying OpenAI model name).",
  },
  {
    id: "azure_ai",
    label: "Azure AI (serverless)",
    prefix: "azure_ai",
    modelPlaceholder: "<your-deployment-name>",
    litellmParams: ["api_key", "api_base", "api_version"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "AZURE_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", required: true,
        envVar: "AZURE_API_BASE" },
      { key: "apiVersion", litellmParam: "api_version", label: "API version",
        type: "text", omitIfBlank: true, runtimeRequired: true,
        envVar: "AZURE_API_VERSION",
        placeholder: "(LiteLLM default: preview)" },
    ],
  },
  {
    id: "bedrock",
    label: "AWS Bedrock",
    prefix: "bedrock",
    modelPlaceholder: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    litellmParams: [
      "aws_region_name",
      "aws_access_key_id", "aws_secret_access_key", "aws_session_token",
      "aws_profile_name",
      "aws_role_name", "aws_session_name",
      "aws_bedrock_runtime_endpoint", "aws_web_identity_token", "aws_sts_endpoint",
    ],
    fields: [
      { key: "awsRegion", litellmParam: "aws_region_name", label: "AWS region",
        type: "text",
        // Save-time: not required (env / AWS config chain satisfies it).
        // Runtime:  LiteLLM refuses to start without it. Doctor warns.
        runtimeRequired: true,
        envVar: "AWS_REGION_NAME / AWS_REGION / AWS_DEFAULT_REGION",
        placeholder: "us-east-1",
        help: "Required at runtime unless AWS_REGION_NAME, AWS_REGION, or AWS_DEFAULT_REGION is set, or ~/.aws/config supplies it." },
      { key: "awsAccessKeyId", litellmParam: "aws_access_key_id", label: "AWS access key id",
        type: "text", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_ACCESS_KEY_ID",
        showOnlyIf: "inlineCreds" },
      { key: "awsSecretAccessKey", litellmParam: "aws_secret_access_key", label: "AWS secret access key",
        type: "password", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_SECRET_ACCESS_KEY",
        showOnlyIf: "inlineCreds" },
      { key: "awsSessionToken", litellmParam: "aws_session_token", label: "AWS session token",
        type: "password", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_SESSION_TOKEN",
        showOnlyIf: "inlineCreds" },
      { key: "awsProfileName", litellmParam: "aws_profile_name", label: "AWS profile name",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_PROFILE",
        help: "Optional. Takes precedence over inline keys when set." },
      // Advanced / IRSA-style:
      { key: "awsRoleName", litellmParam: "aws_role_name", label: "AWS role name (IRSA)",
        type: "text", advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_ROLE_NAME" },
      { key: "awsSessionName", litellmParam: "aws_session_name", label: "AWS session name",
        type: "text", advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_SESSION_NAME" },
      { key: "awsBedrockRuntimeEndpoint", litellmParam: "aws_bedrock_runtime_endpoint",
        label: "Bedrock runtime endpoint", type: "text", advanced: true,
        omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_BEDROCK_RUNTIME_ENDPOINT",
        help: "Override Bedrock runtime URL (private VPC endpoint, FIPS, etc.)." },
      { key: "awsWebIdentityToken", litellmParam: "aws_web_identity_token",
        label: "Web identity token", type: "password", secret: true,
        advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_WEB_IDENTITY_TOKEN_FILE",
        help: "Paste a literal token, or 'os.environ/AWS_WEB_IDENTITY_TOKEN_FILE' to read the file path from env." },
      { key: "awsStsEndpoint", litellmParam: "aws_sts_endpoint", label: "STS endpoint",
        type: "text", advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_STS_ENDPOINT" },
    ],
    help: "If credentials are left blank, LiteLLM/boto3 falls back to env vars, ~/.aws/credentials profiles, SSO, or instance/container role. Inline credentials are stored on disk at ~/.originrouter/config.json (mode 0600) and are masked in CLI / UI output.",
  },
  {
    id: "sagemaker",
    label: "AWS SageMaker endpoint",
    prefix: "sagemaker",
    modelPlaceholder: "<your-endpoint-name>",
    litellmParams: [
      "aws_region_name",
      "aws_access_key_id", "aws_secret_access_key", "aws_session_token",
      "aws_profile_name",
      "aws_role_name", "aws_session_name",
      "aws_web_identity_token", "aws_sts_endpoint",
      "sagemaker_base_url",
    ],
    fields: [
      { key: "awsRegion", litellmParam: "aws_region_name", label: "AWS region",
        type: "text", runtimeRequired: true, envVar: "AWS_REGION_NAME / AWS_REGION",
        placeholder: "us-east-1" },
      { key: "awsAccessKeyId", litellmParam: "aws_access_key_id", label: "AWS access key id",
        type: "text", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_ACCESS_KEY_ID",
        showOnlyIf: "inlineCreds" },
      { key: "awsSecretAccessKey", litellmParam: "aws_secret_access_key", label: "AWS secret access key",
        type: "password", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_SECRET_ACCESS_KEY",
        showOnlyIf: "inlineCreds" },
      { key: "awsSessionToken", litellmParam: "aws_session_token", label: "AWS session token",
        type: "password", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_SESSION_TOKEN",
        showOnlyIf: "inlineCreds" },
      { key: "awsProfileName", litellmParam: "aws_profile_name", label: "AWS profile name",
        type: "text", omitIfBlank: true, runtimeRequired: false, envVar: "AWS_PROFILE" },
      { key: "awsRoleName", litellmParam: "aws_role_name", label: "AWS role name (IRSA)",
        type: "text", advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_ROLE_NAME" },
      { key: "awsSessionName", litellmParam: "aws_session_name", label: "AWS session name",
        type: "text", advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_SESSION_NAME" },
      { key: "awsWebIdentityToken", litellmParam: "aws_web_identity_token",
        label: "Web identity token", type: "text", advanced: true,
        omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_WEB_IDENTITY_TOKEN_FILE" },
      { key: "awsStsEndpoint", litellmParam: "aws_sts_endpoint", label: "STS endpoint",
        type: "text", advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_STS_ENDPOINT" },
      { key: "sagemakerBaseUrl", litellmParam: "sagemaker_base_url", label: "SageMaker base URL",
        type: "text", advanced: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "AWS_BEDROCK_RUNTIME_ENDPOINT",
        help: "Override the auto-built runtime.sagemaker.<region>.amazonaws.com URL." },
    ],
    help: "Model name is your SageMaker endpoint name. AWS credential family mirrors Bedrock.",
  },
  {
    id: "vertex_ai",
    label: "Google Vertex AI",
    prefix: "vertex_ai",
    modelPlaceholder: "gemini-1.5-pro",
    litellmParams: ["vertex_project", "vertex_location", "vertex_credentials", "google_application_credentials"],
    fields: [
      { key: "vertexProject", litellmParam: "vertex_project", label: "GCP project id",
        type: "text", runtimeRequired: true, envVar: "GOOGLE_CLOUD_PROJECT",
        placeholder: "my-gcp-project",
        help: "Required at runtime unless GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT is set." },
      { key: "vertexLocation", litellmParam: "vertex_location", label: "GCP region",
        type: "text", runtimeRequired: true, envVar: "GOOGLE_CLOUD_LOCATION",
        placeholder: "us-central1" },
      { key: "vertexCredentials", litellmParam: "vertex_credentials",
        label: "Service account JSON (inline)", type: "password",
        secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "(no env fallback; paste literal JSON)",
        help: "Paste a literal service-account JSON string. Alternatively point google_application_credentials at a file path." },
      { key: "googleApplicationCredentials", litellmParam: "google_application_credentials",
        label: "Service account JSON path", type: "text",
        secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "GOOGLE_APPLICATION_CREDENTIALS",
        placeholder: "(leave blank for ADC)",
        help: "Path to a service-account JSON file. Falls back to ADC if blank." },
    ],
    help: "If credentials are left blank, LiteLLM falls back to GOOGLE_APPLICATION_CREDENTIALS, gcloud application-default login, or instance/container metadata.",
  },
  {
    id: "gemini",
    label: "Google Gemini (AI Studio)",
    prefix: "gemini",
    modelPlaceholder: "gemini-1.5-pro",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Google API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "GOOGLE_API_KEY / GEMINI_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "GEMINI_API_BASE",
        placeholder: "(leave blank for generativelanguage.googleapis.com)",
        help: "Set to a Vertex Express / private endpoint URL." },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    prefix: "deepseek",
    modelPlaceholder: "deepseek-chat",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "DeepSeek API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "DEEPSEEK_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "DEEPSEEK_API_BASE",
        placeholder: "(leave blank for api.deepseek.com)" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    prefix: "openrouter",
    modelPlaceholder: "anthropic/claude-3.5-sonnet",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "OpenRouter API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "OPENROUTER_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "OPENROUTER_API_BASE",
        placeholder: "(leave blank for openrouter.ai)" },
    ],
  },
  {
    id: "groq",
    label: "Groq",
    prefix: "groq",
    modelPlaceholder: "llama-3.3-70b-versatile",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Groq API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "GROQ_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        placeholder: "(leave blank for api.groq.com)" },
    ],
  },
  {
    id: "together_ai",
    label: "Together AI",
    prefix: "together_ai",
    modelPlaceholder: "meta-llama/Llama-3-70b-chat-hf",
    litellmParams: ["api_key"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Together API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "TOGETHERAI_API_KEY" },
    ],
  },
  {
    id: "fireworks_ai",
    label: "Fireworks AI",
    prefix: "fireworks_ai",
    modelPlaceholder: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Fireworks API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "FIREWORKS_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        placeholder: "(leave blank for api.fireworks.ai)" },
    ],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    prefix: "xai",
    modelPlaceholder: "grok-2-latest",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "xAI API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "XAI_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "XAI_API_BASE",
        placeholder: "(leave blank for api.x.ai)" },
    ],
  },
  {
    id: "mistral",
    label: "Mistral AI",
    prefix: "mistral",
    modelPlaceholder: "mistral-large-latest",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Mistral API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "MISTRAL_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        placeholder: "(leave blank for api.mistral.ai)" },
    ],
  },
  {
    id: "cohere",
    label: "Cohere",
    prefix: "cohere",
    modelPlaceholder: "command-r-plus",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Cohere API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "COHERE_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        placeholder: "(leave blank for api.cohere.ai)" },
    ],
  },
  {
    id: "perplexity",
    label: "Perplexity",
    prefix: "perplexity",
    modelPlaceholder: "llama-3.1-sonar-large-128k-online",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Perplexity API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "PERPLEXITY_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "PERPLEXITY_API_BASE",
        placeholder: "(leave blank for api.perplexity.ai)" },
    ],
  },
  {
    id: "huggingface",
    label: "HuggingFace Inference",
    prefix: "huggingface",
    modelPlaceholder: "meta-llama/Meta-Llama-3-8B-Instruct",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "HF token",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "HF_TOKEN / HUGGINGFACE_API_KEY",
        help: "HF accepts api_key as either HF_TOKEN or HUGGINGFACE_API_KEY. If you used the legacy hf_token form, the API mirrors it to api_key on save." },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        placeholder: "(leave blank for huggingface.co)" },
    ],
    help: "HuggingFace reads api_key (and the legacy hf_token alias). The form mirrors hfToken to apiKey on save.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    prefix: "ollama",
    modelPlaceholder: "llama2",
    litellmParams: ["api_base"],
    fields: [
      { key: "baseUrl", litellmParam: "api_base", label: "Ollama base URL",
        type: "text", omitIfBlank: true, runtimeRequired: true,
        envVar: "OLLAMA_API_BASE",
        placeholder: "http://localhost:11434" },
    ],
  },
  {
    id: "ollama_chat",
    label: "Ollama Chat (local, chat API)",
    prefix: "ollama_chat",
    modelPlaceholder: "llama2",
    litellmParams: ["api_base"],
    fields: [
      { key: "baseUrl", litellmParam: "api_base", label: "Ollama base URL",
        type: "text", omitIfBlank: true, runtimeRequired: true,
        envVar: "OLLAMA_API_BASE",
        placeholder: "http://localhost:11434" },
    ],
    help: "Uses Ollama's /api/chat endpoint instead of /api/generate. Prefer this for chat-style providers.",
  },
  {
    id: "lm_studio",
    label: "LM Studio (local)",
    prefix: "lm_studio",
    modelPlaceholder: "<local-model-id>",
    litellmParams: ["api_base"],
    fields: [
      { key: "baseUrl", litellmParam: "api_base", label: "LM Studio base URL",
        type: "text", omitIfBlank: true, runtimeRequired: true,
        envVar: "LM_STUDIO_API_BASE",
        placeholder: "http://localhost:1234/v1" },
    ],
  },
  {
    id: "vllm",
    label: "vLLM (local)",
    prefix: "vllm",
    modelPlaceholder: "<model>",
    litellmParams: ["api_base", "api_key"],
    fields: [
      { key: "baseUrl", litellmParam: "api_base", label: "vLLM base URL",
        type: "text", omitIfBlank: true, runtimeRequired: true,
        envVar: "VLLM_API_BASE",
        placeholder: "http://localhost:8000/v1" },
      { key: "apiKey", litellmParam: "api_key", label: "vLLM API key",
        type: "password", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "VLLM_API_KEY",
        help: "Optional. vLLM sends this as x-api-key when set; many local instances don't require it." },
    ],
  },
  {
    id: "hosted_vllm",
    label: "Hosted vLLM (remote)",
    prefix: "hosted_vllm",
    modelPlaceholder: "<model>",
    litellmParams: ["api_base", "api_key"],
    fields: [
      { key: "baseUrl", litellmParam: "api_base", label: "vLLM base URL",
        type: "text", omitIfBlank: true, runtimeRequired: true,
        envVar: "HOSTED_VLLM_API_BASE",
        placeholder: "https://..." },
      { key: "apiKey", litellmParam: "api_key", label: "vLLM API key",
        type: "password", secret: true, omitIfBlank: true, runtimeRequired: false,
        envVar: "HOSTED_VLLM_API_KEY" },
    ],
  },
  {
    id: "litellm_proxy",
    label: "LiteLLM Proxy (chain to upstream)",
    prefix: "litellm_proxy",
    modelPlaceholder: "<upstream-model>",
    litellmParams: ["api_base", "api_key"],
    fields: [
      { key: "baseUrl", litellmParam: "api_base", label: "Upstream LiteLLM base URL",
        type: "text", required: true,
        envVar: "LITELLM_PROXY_API_BASE",
        placeholder: "http://..." },
      { key: "apiKey", litellmParam: "api_key", label: "Upstream key",
        type: "password", secret: true, omitIfBlank: true, runtimeRequired: true,
        envVar: "LITELLM_PROXY_API_KEY",
        placeholder: "sk-...",
        help: "Required at runtime unless the upstream proxy allows anonymous requests." },
    ],
    help: "Use this to chain OriginRouter's proxy in front of an existing LiteLLM Proxy instance.",
  },
  {
    id: "minimax",
    label: "MiniMax (via LiteLLM)",
    prefix: "minimax",
    modelPlaceholder: "abab6.5-chat",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "MiniMax API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "MINIMAX_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "MINIMAX_API_BASE",
        placeholder: "https://api.minimax.io/v1" },
    ],
    help: "Most MiniMax users should use type=anthropic (direct path) — this entry is for routing MiniMax through LiteLLM specifically.",
  },
  {
    id: "dashscope",
    label: "DashScope (Aliyun)",
    prefix: "dashscope",
    modelPlaceholder: "qwen-turbo",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "DashScope API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "DASHSCOPE_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "DASHSCOPE_API_BASE",
        placeholder: "(leave blank for dashscope.aliyuncs.com)" },
    ],
  },
  {
    id: "qwen-via-dashscope",
    label: "Qwen via DashScope",
    prefix: "dashscope",
    modelPlaceholder: "qwen-turbo",
    paramsSource: "dashscope",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "DashScope API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "DASHSCOPE_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "DASHSCOPE_API_BASE" },
    ],
    help: "Label-only alias of DashScope — selecting this entry produces the same litellm_params as DashScope. Model is rendered as dashscope/<model>.",
  },
  {
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    prefix: "moonshot",
    modelPlaceholder: "moonshot-v1-8k",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Moonshot API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "MOONSHOT_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "MOONSHOT_API_BASE",
        placeholder: "(leave blank for api.moonshot.ai/v1)" },
    ],
  },
  {
    id: "volcengine",
    label: "Volcengine (ByteDance)",
    prefix: "volcengine",
    modelPlaceholder: "skylark-lite",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Volcengine API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "VOLCENGINE_API_KEY / ARK_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "VOLCENGINE_API_BASE",
        placeholder: "(leave blank for ark.cn-beijing.volces.com/api/v3)" },
    ],
  },
  {
    id: "modelscope",
    label: "ModelScope (Aliyun)",
    prefix: "modelscope",
    modelPlaceholder: "qwen-7b-chat",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "ModelScope token",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "MODELSCOPE_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "MODELSCOPE_API_BASE",
        placeholder: "(leave blank for api-inference.modelscope.cn)" },
    ],
  },
  {
    id: "zai",
    label: "Z.AI / GLM",
    prefix: "zai",
    modelPlaceholder: "glm-4.5",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "Z.AI API key",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "ZAI_API_KEY" },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "ZAI_API_BASE",
        placeholder: "(leave blank for api.z.ai/api/paas/v4)" },
    ],
  },
  {
    id: "github",
    label: "GitHub Models",
    prefix: "github",
    modelPlaceholder: "gpt-4o",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "GitHub token",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true, envVar: "GITHUB_API_KEY",
        help: "GitHub Models marketplace (limited public beta). Token must have the models scope." },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        placeholder: "(leave blank for models.github.com/inference)" },
    ],
  },
  {
    id: "github_copilot",
    label: "GitHub Copilot",
    prefix: "github_copilot",
    modelPlaceholder: "gpt-4o",
    litellmParams: ["api_key", "api_base"],
    fields: [
      { key: "apiKey", litellmParam: "api_key", label: "GitHub token",
        type: "password", secret: true, omitIfBlank: true,
        runtimeRequired: true,
        envVar: "(authenticator-managed token file under ~/.config/litellm/github_copilot)",
        help: "Required. The OAuth / device-flow handshake that produces the short-lived token is not implemented in this build; see schema-only flag." },
      { key: "baseUrl", litellmParam: "api_base", label: "Base URL",
        type: "text", omitIfBlank: true, runtimeRequired: false,
        envVar: "GITHUB_COPILOT_API_BASE",
        placeholder: "(leave blank for api.githubcopilot.com)" },
    ],
    flags: ["advanced", "schema-only"],
    help: "Stage 7 ships the schema only. The real GitHub Copilot OAuth / device-flow handshake is not implemented; rendering works but the proxy may fail at runtime. Do not rely on this for production.",
  },
]);

export const LITELLM_PROVIDER_IDS = Object.freeze(LITELLM_PROVIDERS.map((p) => p.id));

export function getLitellmProfile(id) {
  const entry = LITELLM_PROVIDERS.find((p) => p.id === id);
  if (!entry) throw new Error(`unknown litellm provider '${id}'`);
  return entry;
}

// Resolve the profile that owns the rendered params / prefix. Aliases
// (`qwen-via-dashscope`) point at their source (`dashscope`) so rendering
// always uses the source's prefix and field set.
function resolveSourceProfile(id) {
  const entry = getLitellmProfile(id);
  return entry.paramsSource ? getLitellmProfile(entry.paramsSource) : entry;
}

export function paramsFor(id) { return resolveSourceProfile(id).litellmParams; }
export function prefixFor(id) { return resolveSourceProfile(id).prefix; }
export function isAlias(id) { return !!getLitellmProfile(id).paramsSource; }

export function hasFlag(id, flag) {
  const entry = getLitellmProfile(id);
  return Array.isArray(entry.flags) && entry.flags.includes(flag);
}

// Stage 7.7: derive the set of field keys that should be masked in CLI /
// API summaries. Replaces the hardcoded SECRET_FIELDS list in providers.js.
//
// Returns an empty set when the provider record is missing, non-litellm, or
// references an unknown litellmProvider (e.g. mid-migration legacy record).
export function secretFieldKeysFor(provider) {
  if (!provider || provider.type !== "litellm" || !provider.litellmProvider) return new Set();
  let profile;
  try { profile = getLitellmProfile(provider.litellmProvider); }
  catch { return new Set(); }
  return new Set(profile.fields.filter((f) => f.secret).map((f) => f.key));
}

// Stage 7.7: derive the set of field keys declared by the catalog profile.
// Empty set when unknown (so legacy / mid-migration records don't accidentally
// trip the strict unknown-field check).
export function catalogFieldKeysFor(litellmProvider) {
  if (!litellmProvider) return new Set();
  try {
    const profile = getLitellmProfile(litellmProvider);
    return new Set(profile.fields.map((f) => f.key));
  } catch {
    return new Set();
  }
}