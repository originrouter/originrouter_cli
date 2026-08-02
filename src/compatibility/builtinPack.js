import { COMPATIBILITY_PACK_SCHEMA } from "./patchPack.js";

export const BUILTIN_COMPATIBILITY_PACK = Object.freeze({
  schema: COMPATIBILITY_PACK_SCHEMA,
  pack_id: "originrouter-builtin-compatibility",
  revision: 2,
  min_engine_version: "1.1.0",
  max_engine_version: null,
  generated_at: null,
  patches: [
    {
      id: "responses.non-openai.agent-compatibility",
      name: "Responses agent compatibility",
      description: "Adapts OpenAI Responses agent tool history for non-OpenAI providers, including namespace tools and function-call pairing.",
      version: "1.1.0",
      phase: "request",
      priority: 1000,
      required: true,
      failure_mode: "reject",
      match: {
        methods: ["POST"],
        paths: ["/v1/responses"],
        protocols: ["openai.responses"],
        exclude_provider_families: ["openai"],
      },
      operations: [
        {
          operator: "flatten_namespace_tools",
          options: { collision_strategy: "preserve_existing" },
        },
        {
          operator: "reconcile_function_pairs",
          options: { mode: "drop_between" },
        },
      ],
    },
    {
      id: "messages.non-anthropic.server-tool-history",
      name: "Messages server-tool history compatibility",
      description: "Converts Anthropic server-tool history into standard tool-use turns understood by non-Anthropic providers.",
      version: "1.0.0",
      phase: "request",
      priority: 800,
      required: true,
      failure_mode: "reject",
      match: {
        methods: ["POST"],
        paths: ["/v1/messages"],
        protocols: ["anthropic.messages"],
        exclude_provider_families: ["anthropic"],
      },
      operations: [
        {
          operator: "transform_anthropic_server_tool_messages",
          options: {},
        },
      ],
    },
  ],
});
