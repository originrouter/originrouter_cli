import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { CompatibilityEngine } from "../src/compatibility/engine.js";
import {
  COMPATIBILITY_PACK_SCHEMA,
  COMPATIBILITY_SIGNATURE_DOMAIN,
  COMPATIBILITY_SIGNED_ENVELOPE,
  canonicalCompatibilityJson,
  mergeCompatibilityPacks,
  verifySignedCompatibilityPack,
} from "../src/compatibility/patchPack.js";

const nonOpenAi = {
  method: "POST",
  path: "/v1/responses",
  protocol: "openai.responses",
  providerFamily: "anthropic",
  provider: "work-claude",
  model: "claude-sonnet",
  runtime: "codex",
  stream: false,
};

{
  const engine = new CompatibilityEngine();
  const original = {
    model: "work-claude/claude-sonnet",
    tools: [
      { type: "function", name: "outside", parameters: {} },
      {
        type: "namespace",
        name: "workspace",
        tools: [
          { type: "function", name: "read_file", parameters: {} },
          { type: "function", name: "outside", parameters: { duplicate: true } },
        ],
      },
    ],
    input: [
      { type: "message", role: "user", content: "run it" },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{}" },
      { type: "message", role: "assistant", content: "intermediate" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ],
  };
  const result = await engine.apply("request", nonOpenAi, original);
  assert.deepEqual(result.document.tools.map((tool) => tool.name), ["outside", "read_file"]);
  assert.deepEqual(result.document.input.map((item) => item.type), [
    "message", "function_call", "function_call_output",
  ]);
  assert.equal(result.applied.length, 1);
  assert.notEqual(result.document, original);
  assert.equal(original.tools[1].type, "namespace");
}

{
  const engine = new CompatibilityEngine();
  const original = {
    model: "provider/gemini",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect", signature: "opaque" },
          { type: "text", text: "checking" },
          { type: "server_tool_use", id: "srv-1", name: "web_search", input: { query: "test" } },
          { type: "tool_result", tool_use_id: "srv-1", content: "result" },
          { type: "text", text: "done" },
        ],
      },
      {
        role: "user",
        content: [{ type: "thinking", thinking: "user", signature: "remove" }],
      },
    ],
  };
  const result = await engine.apply("request", {
    method: "POST",
    path: "/v1/messages",
    protocol: "anthropic.messages",
    providerFamily: "gemini",
    provider: "provider",
    model: "provider/gemini",
    runtime: "claude",
    stream: false,
  }, original);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.document.messages.map((message) => message.role), [
    "assistant", "user", "assistant", "user",
  ]);
  assert.equal(result.document.messages[0].content[0].signature, undefined);
  assert.deepEqual(result.document.messages[0].content.at(-1), {
    type: "tool_use",
    id: "srv-1",
    name: "web_search",
    input: { query: "test" },
  });
  assert.equal(result.document.messages[1].content[0].type, "tool_result");
  assert.equal(result.document.messages[3].content[0].signature, undefined);
  assert.equal(original.messages[0].content[0].signature, "opaque");
}

{
  const engine = new CompatibilityEngine();
  const document = {
    model: "gpt-5.4",
    tools: [{ type: "namespace", tools: [{ type: "function", name: "search" }] }],
    input: [],
  };
  const result = await engine.apply("request", { ...nonOpenAi, providerFamily: "openai" }, document);
  assert.equal(result.document, document);
  assert.equal(result.applied.length, 0);
}

{
  const base = {
    schema: COMPATIBILITY_PACK_SCHEMA,
    pack_id: "base",
    revision: 1,
    min_engine_version: "1.0.0",
    patches: [{
      id: "one", version: "1", phase: "request", operations: [
        { operator: "flatten_namespace_tools", options: {} },
      ],
    }],
  };
  const update = {
    schema: COMPATIBILITY_PACK_SCHEMA,
    pack_id: "update",
    revision: 2,
    min_engine_version: "1.0.0",
    patches: [{
      id: "one", version: "2", phase: "request", operations: [
        { operator: "flatten_namespace_tools", options: { collision_strategy: "reject" } },
      ],
    }],
  };
  const merged = mergeCompatibilityPacks(base, update);
  assert.equal(merged.patches.length, 1);
  assert.equal(merged.patches[0].version, "2");
}

{
  const pair = generateKeyPairSync("ed25519");
  const payload = {
    schema: COMPATIBILITY_PACK_SCHEMA,
    pack_id: "signed-test",
    revision: 1,
    min_engine_version: "1.0.0",
    patches: [],
  };
  const signature = sign(
    null,
    Buffer.from(`${COMPATIBILITY_SIGNATURE_DOMAIN}${canonicalCompatibilityJson(payload)}`),
    pair.privateKey,
  ).toString("base64url");
  const envelope = {
    schema: COMPATIBILITY_SIGNED_ENVELOPE,
    key_id: "test-key",
    algorithm: "Ed25519",
    payload,
    signature,
  };
  const verified = verifySignedCompatibilityPack(envelope, {
    "test-key": pair.publicKey.export({ type: "spki", format: "pem" }),
  });
  assert.equal(verified.pack_id, "signed-test");
  assert.throws(() => verifySignedCompatibilityPack(
    { ...envelope, signature: `${signature.slice(0, -2)}aa` },
    { "test-key": pair.publicKey.export({ type: "spki", format: "pem" }) },
  ));
}

console.log("compatibilityEngine tests passed");
