function clone(value) {
  return structuredClone(value);
}

function toolName(tool) {
  return tool && typeof tool === "object" && typeof tool.name === "string"
    ? tool.name
    : null;
}

export function flattenNamespaceTools(document, options = {}) {
  const tools = document?.tools;
  if (!Array.isArray(tools) || !tools.some((tool) => tool?.type === "namespace")) {
    return { document, changed: false, metadata: null };
  }
  const collisionStrategy = options.collision_strategy || "preserve_existing";
  if (collisionStrategy !== "preserve_existing" && collisionStrategy !== "reject") {
    throw new Error(`unsupported namespace collision strategy '${collisionStrategy}'`);
  }
  const existing = new Set();
  for (const tool of tools) {
    if (tool && typeof tool === "object" && tool.type !== "namespace") {
      const name = toolName(tool);
      if (name) existing.add(name);
    }
  }
  const flattened = [];
  let namespaceCount = 0;
  let emittedCount = 0;
  let collisionCount = 0;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type !== "namespace") {
      flattened.push(clone(tool));
      continue;
    }
    namespaceCount += 1;
    if (!Array.isArray(tool.tools)) continue;
    for (const child of tool.tools) {
      if (!child || typeof child !== "object") continue;
      const name = toolName(child);
      if (name && existing.has(name)) {
        collisionCount += 1;
        if (collisionStrategy === "reject") {
          throw new Error(`namespace tool '${name}' conflicts with another tool`);
        }
        continue;
      }
      flattened.push(clone(child));
      emittedCount += 1;
      if (name) existing.add(name);
    }
  }
  return {
    document: { ...document, tools: flattened },
    changed: true,
    metadata: { namespace_count: namespaceCount, emitted_tools: emittedCount, collisions: collisionCount },
  };
}

function pairFunctionCalls(input) {
  const outputs = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item?.type !== "function_call_output" || typeof item.call_id !== "string") continue;
    const list = outputs.get(item.call_id) || [];
    list.push(index);
    outputs.set(item.call_id, list);
  }
  const usedOutputs = new Set();
  const pairs = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item?.type !== "function_call" || typeof item.call_id !== "string") continue;
    const candidate = (outputs.get(item.call_id) || []).find((outputIndex) => (
      outputIndex > index && !usedOutputs.has(outputIndex)
    ));
    if (candidate == null) continue;
    usedOutputs.add(candidate);
    pairs.set(index, candidate);
  }
  return { pairs, usedOutputs };
}

function reorderPairs(input, pairs, usedOutputs) {
  const output = [];
  for (let index = 0; index < input.length; index += 1) {
    if (usedOutputs.has(index)) continue;
    const item = input[index];
    if (item?.type === "function_call_output") continue;
    if (item?.type === "function_call") {
      const outputIndex = pairs.get(index);
      if (outputIndex == null) continue;
      output.push(clone(item), clone(input[outputIndex]));
      continue;
    }
    output.push(clone(item));
  }
  return output;
}

function dropBetweenPairs(input, pairs) {
  const output = [];
  let index = 0;
  while (index < input.length) {
    const item = input[index];
    if (item?.type === "function_call_output") {
      index += 1;
      continue;
    }
    if (item?.type !== "function_call") {
      output.push(clone(item));
      index += 1;
      continue;
    }
    const outputIndex = pairs.get(index);
    if (outputIndex == null) {
      index += 1;
      continue;
    }
    output.push(clone(item), clone(input[outputIndex]));
    index = outputIndex + 1;
  }
  return output;
}

export function reconcileFunctionPairs(document, options = {}) {
  const input = document?.input;
  if (!Array.isArray(input)) return { document, changed: false, metadata: null };
  const hasFunctionItems = input.some((item) => (
    item?.type === "function_call" || item?.type === "function_call_output"
  ));
  if (!hasFunctionItems) return { document, changed: false, metadata: null };
  const mode = options.mode || "reorder";
  if (mode !== "reorder" && mode !== "drop_between") {
    throw new Error(`unsupported function pair reconciliation mode '${mode}'`);
  }
  const { pairs, usedOutputs } = pairFunctionCalls(input);
  const next = mode === "drop_between"
    ? dropBetweenPairs(input, pairs)
    : reorderPairs(input, pairs, usedOutputs);
  const orphanCalls = input.filter((item) => item?.type === "function_call").length - pairs.size;
  const orphanOutputs = input.filter((item) => item?.type === "function_call_output").length - usedOutputs.size;
  return {
    document: { ...document, input: next },
    changed: JSON.stringify(next) !== JSON.stringify(input),
    metadata: { pairs: pairs.size, orphan_calls: orphanCalls, orphan_outputs: orphanOutputs, mode },
  };
}

function stripThinkingSignature(block) {
  if (!block || typeof block !== "object" || block.type !== "thinking"
      || !("signature" in block)) return clone(block);
  const result = { ...block };
  delete result.signature;
  return result;
}

function strippedBlocks(blocks) {
  return blocks.map(stripThinkingSignature);
}

function splitServerToolAssistantContent(content) {
  const messages = [];
  let assistantBlocks = [];
  let index = 0;
  while (index < content.length) {
    const block = content[index];
    if (!block || typeof block !== "object") {
      assistantBlocks.push(clone(block));
      index += 1;
      continue;
    }
    if (block.type === "server_tool_use") {
      assistantBlocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input && typeof block.input === "object" ? clone(block.input) : {},
      });
      if (assistantBlocks.length > 0) {
        messages.push({ role: "assistant", content: strippedBlocks(assistantBlocks) });
        assistantBlocks = [];
      }
      index += 1;
      if (content[index]?.type === "tool_result") {
        messages.push({ role: "user", content: [clone(content[index])] });
        index += 1;
      }
      continue;
    }
    if (block.type === "tool_result") {
      if (assistantBlocks.length > 0) {
        messages.push({ role: "assistant", content: strippedBlocks(assistantBlocks) });
        assistantBlocks = [];
      }
      messages.push({ role: "user", content: [clone(block)] });
      index += 1;
      continue;
    }
    assistantBlocks.push(stripThinkingSignature(block));
    index += 1;
  }
  if (assistantBlocks.length > 0) {
    messages.push({ role: "assistant", content: strippedBlocks(assistantBlocks) });
  }
  return messages;
}

export function transformAnthropicServerToolMessages(document) {
  const messages = document?.messages;
  if (!Array.isArray(messages)) return { document, changed: false, metadata: null };
  let serverToolCount = 0;
  let strippedSignatureCount = 0;
  const result = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
      result.push(clone(message));
      continue;
    }
    serverToolCount += message.content.filter((block) => block?.type === "server_tool_use").length;
    strippedSignatureCount += message.content.filter((block) => (
      block?.type === "thinking" && "signature" in block
    )).length;
    if (message.role === "assistant"
        && message.content.some((block) => block?.type === "server_tool_use")) {
      result.push(...splitServerToolAssistantContent(message.content));
      continue;
    }
    result.push({
      ...clone(message),
      content: strippedBlocks(message.content),
    });
  }
  const filtered = result.filter((message) => (
    (Array.isArray(message?.content) && message.content.length > 0)
    || (typeof message?.content === "string" && message.content.length > 0)
  ));
  const changed = serverToolCount > 0 || strippedSignatureCount > 0
    || filtered.length !== messages.length;
  return {
    document: changed ? { ...document, messages: filtered } : document,
    changed,
    metadata: changed ? {
      server_tool_uses: serverToolCount,
      stripped_thinking_signatures: strippedSignatureCount,
      output_messages: filtered.length,
    } : null,
  };
}

export const COMPATIBILITY_OPERATORS = Object.freeze({
  flatten_namespace_tools: flattenNamespaceTools,
  reconcile_function_pairs: reconcileFunctionPairs,
  transform_anthropic_server_tool_messages: transformAnthropicServerToolMessages,
});
