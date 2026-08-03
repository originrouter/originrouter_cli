import { fileURLToPath } from "node:url";

const ORIGINROUTER_BIN = fileURLToPath(new URL("../../bin/originrouter.js", import.meta.url));

export function agentGatewayMcpConfig(sessionId) {
  const value = String(sessionId || "").trim().slice(0, 64);
  if (!value) return null;
  return {
    command: process.execPath,
    args: [
      ORIGINROUTER_BIN,
      "agent-mcp-server",
      "--originrouter-session",
      value,
    ],
  };
}

export function codexAgentGatewayConfigArgs(sessionId) {
  const config = agentGatewayMcpConfig(sessionId);
  if (!config) return [];
  return [
    ["mcp_servers.originrouter.command", JSON.stringify(config.command)],
    ["mcp_servers.originrouter.args", JSON.stringify(config.args)],
    ["mcp_servers.originrouter.enabled", "true"],
  ];
}
