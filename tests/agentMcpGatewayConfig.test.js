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
const device = agentGatewayMcpConfig("ordinary-session", {deviceTools:true});
assert.deepEqual(device.args.slice(-3), ["--originrouter-session", "ordinary-session", "--device-tools"]);
const deviceCodex = Object.fromEntries(codexAgentGatewayConfigArgs("ordinary-session", {deviceTools:true}));
assert.deepEqual(JSON.parse(deviceCodex["mcp_servers.originrouter_device.args"]), device.args);
assert.equal(deviceCodex["mcp_servers.originrouter_device.enabled"], "true");
assert.equal(deviceCodex["mcp_servers.originrouter_device.tool_timeout_sec"], "720");
assert.equal(JSON.parse(deviceCodex["mcp_servers.originrouter_device.default_tools_approval_mode"]), "approve");
assert.equal(device.timeout, 720_000);
assert.equal(device.alwaysLoad, true);
const scoped = agentGatewayMcpConfig("ordinary-session", {deviceTools:true,stateDir:"/tmp/device-state"});
assert.deepEqual(scoped.env, {ORIGINROUTER_HOME:"/tmp/device-state"});
const scopedCodex = Object.fromEntries(codexAgentGatewayConfigArgs("ordinary-session", {deviceTools:true,stateDir:"/tmp/device-state"}));
assert.equal(JSON.parse(scopedCodex["mcp_servers.originrouter_device.env.ORIGINROUTER_HOME"]), "/tmp/device-state");

console.log("Agent MCP gateway config tests passed");
