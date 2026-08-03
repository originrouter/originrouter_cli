import { setTimeout as delay } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readApiToken } from "../persistence/authToken.js";
import { ensureStateDir, readDaemonState } from "../persistence/state.js";

function value(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) return String(args[index + 1] || "");
  const prefix = `${name}=`;
  return String(args.find((item) => item.startsWith(prefix)) || "").slice(prefix.length);
}

function localApi() {
  const stateDir = ensureStateDir();
  const state = readDaemonState();
  const token = readApiToken(stateDir);
  if (!state?.localApiPort || !token) {
    throw new Error("OriginRouter daemon is unavailable; start it before using Agent collaboration tools.");
  }
  const bind = state.localApiBindAddress || "127.0.0.1";
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { baseUrl: `http://${urlHost}:${state.localApiPort}`, token };
}

async function gatewayRequest(sessionId, action, payload = {}) {
  const api = localApi();
  const response = await fetch(`${api.baseUrl}/agent/local/mcp-gateway`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${api.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId, action, payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    const error = new Error(
      (typeof result.error === "string" ? result.error : result.error?.message)
      || result.message
      || `Agent MCP gateway request failed (${response.status})`,
    );
    error.code = result.error?.reason || result.reason || "AGENT_MCP_GATEWAY_FAILED";
    throw error;
  }
  return result.data || result;
}

function textResult(value, { isError = false } = {}) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function toolResult(operation) {
  try {
    return textResult(await operation());
  } catch (error) {
    return textResult({
      ok: false,
      reason: String(error?.code || "AGENT_MCP_GATEWAY_FAILED"),
      message: String(error?.message || "Agent MCP gateway request failed."),
    }, { isError: true });
  }
}

export async function runAgentGatewayMcpServer(args = process.argv.slice(2)) {
  const sessionId = value(args, "--originrouter-session").trim();
  if (!sessionId) throw new Error("--originrouter-session is required");

  const server = new McpServer({
    name: "originrouter-agent-gateway",
    version: "0.1.0",
  });

  server.registerTool("list_participants", {
    description: "List the other OriginRouter collaboration participants that this Agent may contact.",
    inputSchema: {},
  }, async () => toolResult(() => gatewayRequest(sessionId, "list")));

  server.registerTool("delegate_task", {
    description: "Delegate a typed child task to another Agent in this OriginRouter collaboration. Returns immediately with a task id; use get_task_result to check it.",
    inputSchema: {
      participant_id: z.string().min(1).max(32),
      instructions: z.string().min(1).max(16_000),
      deliverable: z.string().max(2_000).optional(),
      mode: z.enum(["read_only", "workspace_write", "verify", "discussion"]).default("discussion"),
    },
  }, async (input) => toolResult(() => gatewayRequest(sessionId, "delegate", input)));

  server.registerTool("get_task_result", {
    description: "Read the current status and result of a child task previously created through delegate_task or ask_agent.",
    inputSchema: { task_id: z.string().min(1).max(195) },
  }, async (input) => toolResult(() => gatewayRequest(sessionId, "status", input)));

  server.registerTool("ask_agent", {
    description: "Ask another Agent a question and wait for its response. Use this for bounded discussion; use delegate_task for longer work.",
    inputSchema: {
      participant_id: z.string().min(1).max(32),
      message: z.string().min(1).max(16_000),
      timeout_seconds: z.number().int().min(5).max(180).default(120),
    },
  }, async ({ participant_id: participantId, message, timeout_seconds: timeoutSeconds }) => toolResult(async () => {
    const delegated = await gatewayRequest(sessionId, "delegate", {
      participant_id: participantId,
      instructions: message,
      deliverable: "A concise response to the requesting Agent.",
      mode: "discussion",
      wait_requested: true,
    });
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const status = await gatewayRequest(sessionId, "status", { task_id: delegated.task_id });
      if (["completed", "failed", "cancelled", "blocked"].includes(status.state)) return status;
      await delay(500);
    }
    return {
      task_id: delegated.task_id,
      state: "pending",
      timed_out: true,
      message: "The delegated Agent is still working. Call get_task_result with this task id.",
    };
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
