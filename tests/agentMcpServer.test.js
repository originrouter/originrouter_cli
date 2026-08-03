import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = fileURLToPath(new URL("../bin/originrouter.js", import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin, "agent-mcp-server", "--originrouter-session", "test-session"],
  stderr: "pipe",
});
const client = new Client({ name: "originrouter-agent-mcp-test", version: "0.1.0" });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    "ask_agent",
    "delegate_task",
    "get_task_result",
    "list_participants",
  ]);
} finally {
  await client.close();
}

console.log("Agent MCP stdio server tests passed");
