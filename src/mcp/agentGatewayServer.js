import { setTimeout as delay } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readApiToken } from "../persistence/authToken.js";
import { DEFAULT_BIND_ADDRESS } from "../local/localApi.js";
import { loopbackDialHost } from "../local/localApiHttp.js";
import { ensureStateDir, readDaemonState } from "../persistence/state.js";
import { optionValue } from "../commands/shared/cliArgs.js";

function localApi() {
  const stateDir = ensureStateDir();
  const state = readDaemonState();
  const token = readApiToken(stateDir);
  if (!state?.localApiPort || !token) {
    throw new Error("OriginRouter daemon is unavailable; start it before using Agent collaboration tools.");
  }
  const host = loopbackDialHost(state.localApiBindAddress || DEFAULT_BIND_ADDRESS);
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { baseUrl: `http://${urlHost}:${state.localApiPort}`, token };
}

async function gatewayRequest(sessionId, action, payload = {}, signal) {
  const api = localApi();
  const response = await fetch(`${api.baseUrl}/agent/local/mcp-gateway`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${api.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId, action, payload }),
    signal,
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
  const sessionId = String(optionValue(args, "--originrouter-session") || "").trim();
  const deviceTools = args.includes("--device-tools");
  if (!sessionId) throw new Error("--originrouter-session is required");

  const server = new McpServer({
    name: "originrouter-agent-gateway",
    version: "0.1.0",
  });

  if (!deviceTools) {
  server.registerTool("list_participants", {
    description: "List the other OriginRouter collaboration participants that this Agent may contact.",
    inputSchema: {},
  }, async () => toolResult(() => gatewayRequest(sessionId, "list")));

  server.registerTool("request_team_change", {
    description: "Request a versioned change to the persistent Workspace Session Team. This never changes devices, workspaces, runtimes, models, or permissions until the user explicitly confirms it in OriginRouter.",
    inputSchema: {
      operation: z.enum(["add", "replace", "remove"]),
      reason: z.string().min(1).max(2_048),
      participant_id: z.string().min(1).max(32).optional(),
      participant: z.object({
        participant_id: z.string().min(1).max(32),
        display_name: z.string().max(80).optional(),
        runtime: z.enum(["claude", "codex"]),
        device_id: z.string().min(1).max(191),
        workspace_id: z.string().max(191).optional(),
        provider: z.string().max(191).optional(),
        model: z.string().max(191).optional(),
        permission_profile: z.string().max(64).optional(),
        approval_policy_id: z.string().max(64).optional(),
        role_hint: z.string().max(2_000).optional(),
      }).optional(),
    },
  }, async (input) => toolResult(() => gatewayRequest(sessionId, "team_change", input)));

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

  } else {
    const deviceTool = (name, description, inputSchema, operation) => server.registerTool(name, {
      description, inputSchema,
    }, async (input, extra) => toolResult(() => gatewayRequest(sessionId, `device.${operation}`, input, extra.signal)));
    const id = z.string().min(1).max(191);
    const handle = z.string().min(1).max(191);
    const schedule = z.discriminatedUnion("kind", [
      z.object({kind:z.literal("once"),at:z.string().min(1).max(64)}).strict(),
      z.object({kind:z.literal("interval"),anchor:z.string().min(1).max(64),seconds:z.number().int().min(60).max(31622400)}).strict(),
      z.object({kind:z.literal("weekly"),timezone:z.string().min(1).max(100),days:z.array(z.number().int().min(1).max(7)).min(1).max(7),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59)}).strict(),
    ]);
    deviceTool("scheduled_list", "List scheduled Agent tasks on this CLI device. Existing permission rules apply.", {}, "scheduled.list");
    deviceTool("scheduled_history", "Read recent executions of an Agent schedule on this device.", {taskId:id.optional()}, "scheduled.history");
    deviceTool("scheduled_save", "Create or update a scheduled Agent task on this CLI device. Scheduled launches follow the specified permission profile; this operation is reviewed under the current session's permissions. AI approval requires a user-selected template in the App and cannot be configured with this tool. Times require explicit UTC offsets; weekly times use the given IANA timezone.", {
      task:z.object({id:id.optional(), name:z.string().min(1).max(120), enabled:z.boolean().optional(), schedule,
        launch:z.object({agentType:z.enum(["claude","codex"]),workspaceId:id,initialMessage:z.string().min(1).max(8192),
          permissionProfile:z.enum(["manual","guarded","unrestricted"]).optional(),provider:id.optional(),model:id.optional()}).strict(),
      }).strict(), baseRevision:z.number().int().min(0).optional(),
    }, "scheduled.save");
    deviceTool("scheduled_run", "Start an existing scheduled task now; it will not overlap an active execution.", {id,baseRevision:z.number().int().min(1).optional()}, "scheduled.run");
    deviceTool("scheduled_delete", "Delete an existing scheduled task without stopping an already running Agent.", {id,baseRevision:z.number().int().min(1).optional()}, "scheduled.delete");
    deviceTool("remote_env_list", "List SSH hosts configured by the user on this CLI device. No credentials are returned.", {}, "remote.list");
    deviceTool("remote_env_open", "Open a session to a configured SSH host, reusing the device's verified connection. Returns a session handle and working directory.", {id}, "remote.open");
    deviceTool("remote_env_exec", "Run a command through an open SSH session. The command uses the session working directory unless cwd is supplied. Output can be truncated; a timeout or disconnect means the remote outcome is unknown and must not be automatically retried. A session with an unknown outcome cannot run further commands; investigate the host before explicitly closing it and opening another.", {
      handle,command:z.string().min(1).max(8192),cwd:z.string().min(1).max(4096).optional(),
      timeoutMs:z.number().int().min(1).max(600000).optional(),maxOutputBytes:z.number().int().min(1).max(1048576).optional(),
    }, "remote.exec");
    deviceTool("remote_env_chdir", "Change the working directory for one SSH session; path must be absolute.", {handle,path:z.string().min(1).max(4096)}, "remote.chdir");
    deviceTool("remote_env_close", "Close an SSH session; other sessions can continue to use the same transport.", {handle}, "remote.close");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
