import assert from "node:assert/strict";

import {
  agentGatewayMcpConfig,
  codexAgentGatewayConfigArgs,
} from "../src/mcp/agentGatewayConfig.js";

assert.equal(agentGatewayMcpConfig(""), null);
const config = agentGatewayMcpConfig("collab-session-1");
assert.equal(config.command, process.execPath);
assert.match(config.args[0], /bin\/originrouter\.js$/);
assert.deepEqual(config.args.slice(1), [
  "agent-mcp-server",
  "--originrouter-session",
  "collab-session-1",
]);
const codex = Object.fromEntries(codexAgentGatewayConfigArgs("collab-session-1"));
assert.equal(JSON.parse(codex["mcp_servers.originrouter.command"]), process.execPath);
assert.deepEqual(JSON.parse(codex["mcp_servers.originrouter.args"]), config.args);
assert.equal(codex["mcp_servers.originrouter.enabled"], "true");

console.log("Agent MCP gateway config tests passed");
