import { fileURLToPath } from "node:url";

const ORIGINROUTER_BIN = fileURLToPath(new URL("../../bin/originrouter.js", import.meta.url));

export function agentGatewayMcpConfig(sessionId, {deviceTools = false, stateDir = null} = {}) {
  const value = String(sessionId || "").trim().slice(0, 64);
  if (!value) return null;
  return {
    command: process.execPath,
    ...(deviceTools ? {timeout:720_000, alwaysLoad:true} : {}),
    ...(stateDir ? {env:{ORIGINROUTER_HOME:String(stateDir)}} : {}),
    args: [
      ORIGINROUTER_BIN,
      "agent-mcp-server",
      "--originrouter-session",
      value,
      ...(deviceTools ? ["--device-tools"] : []),
    ],
  };
}

export function codexAgentGatewayConfigArgs(sessionId, {deviceTools = false, stateDir = null} = {}) {
  const config = agentGatewayMcpConfig(sessionId, {deviceTools,stateDir});
  if (!config) return [];
  const name = deviceTools ? "originrouter_device" : "originrouter";
  return [
    [`mcp_servers.${name}.command`, JSON.stringify(config.command)],
    [`mcp_servers.${name}.args`, JSON.stringify(config.args)],
    [`mcp_servers.${name}.enabled`, "true"],
    ...(stateDir ? [[`mcp_servers.${name}.env.ORIGINROUTER_HOME`, JSON.stringify(String(stateDir))]] : []),
    ...(deviceTools ? [[`mcp_servers.${name}.tool_timeout_sec`, "720"]] : []),
    // Device tools perform their own session-bound policy/approval check in
    // the daemon. Let Codex invoke this server so its separate MCP gate does
    // not deny in `never` mode or ask a second, less informative question.
    ...(deviceTools ? [[`mcp_servers.${name}.default_tools_approval_mode`, '"approve"']] : []),
  ];
}
