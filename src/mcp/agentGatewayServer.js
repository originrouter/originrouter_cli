import { setTimeout as delay } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readApiToken } from "../persistence/authToken.js";
import { DEFAULT_BIND_ADDRESS } from "../local/localApi.js";
import { loopbackDialHost } from "../local/localApiHttp.js";
import { ensureStateDir, readDaemonState } from "../persistence/state.js";
import { optionValue } from "../commands/shared/cliArgs.js";

// How the device tools are meant to be used, across calls. MCP clients do not
// have to show this to the model, so the same guidance also lives in the
// descriptions of the tools themselves.
const DEVICE_TOOL_INSTRUCTIONS = [
  "For work on a remote SSH host, prefer the OriginRouter remote_env_* tools when they are available and match the user's intent.",
  "First call remote_env_list and identify the intended configured host; use its returned id, not its display name, with remote_env_open.",
  "If no host matches or the target is ambiguous, ask the user instead of guessing. The user configures hosts and credentials in OriginRouter; never request saved passwords or private keys from these tools.",
  "Reuse the returned handle for commands in this Agent session, then close it when the remote work is complete. The tools follow the current permission and approval settings.",
  "Commands use the session directory, but shell state such as cd and exported variables does not persist between commands. Use remote_env_chdir to change the session directory.",
  "For long commands use runInBackground and read their output with remote_env_job_read. If a command's outcome is unknown after interruption, timeout, or disconnection, do not replay it; inspect the host independently before closing the affected session or opening another.",
  "If these tools cannot support the requested operation, explain the limitation and follow the user's instructions and existing approval policy for any alternative.",
].join(" ");

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
  }, deviceTools ? {instructions: DEVICE_TOOL_INSTRUCTIONS} : undefined);

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
    deviceTool("remote_env_list", "For remote SSH work, prefer the OriginRouter remote_env tools. Start here to discover hosts configured by the user on this CLI device; select the intended host and pass its returned id (not name, hostname, or address) to remote_env_open. Ask the user if no host matches or the choice is ambiguous. Saved credentials are never returned; the user manages hosts and credentials in OriginRouter. Existing permission and approval settings apply.", {}, "remote.list");
    deviceTool("remote_env_open", "Open a logical SSH session for a configured host. First use remote_env_list and pass the selected target's id, not its display name. Returns a handle and initial working directory; reuse this handle for remote_env_exec and other remote_env calls in this Agent session, then close it when done. The device verifies the configured host fingerprint and may reuse an existing SSH connection. Opening can require approval.", {id:id.describe("The selected host's id from remote_env_list, not its name or address.")}, "remote.open");
    deviceTool("remote_env_exec", "Run a command on the host using an open remote_env session. Reuse the handle from remote_env_open. The command runs in the session directory unless cwd is supplied; ordinary shell state, including cd and exported variables, does not persist between calls. Use remote_env_chdir to change the session directory. Output can be truncated. For a long command set runInBackground: true and use remote_env_job_read with the returned jobId; remote_env_job_kill requests termination. If timeout, cancellation, or disconnection leaves the outcome unknown, do not retry: independently inspect the host before closing this session or opening another. Existing permission and approval settings apply.", {
      handle:handle.describe("Session handle returned by remote_env_open for this Agent session."),command:z.string().min(1).max(8192).describe("Remote shell command to run."),cwd:z.string().min(1).max(4096).optional().describe("Absolute remote working directory for this command only; does not change the session directory."),
      timeoutMs:z.number().int().min(1).max(600000).optional().describe("Foreground command timeout in milliseconds."),maxOutputBytes:z.number().int().min(1).max(1048576).optional().describe("Maximum retained output in bytes."),
      runInBackground:z.boolean().optional().describe("Use true for a long-running command and read the returned job with remote_env_job_read."),
    }, "remote.exec");
    deviceTool("remote_env_job_read", "Read what a background remote task has produced so far. Keep the nextOffset the read returns and pass it back as fromByte to read only what is new. A read reported as lossy means the retained window moved past the offset you asked for.", {
      handle,jobId:z.string().min(1).max(191),fromByte:z.number().int().min(0).optional(),
    }, "remote.job_read");
    deviceTool("remote_env_job_kill", "Request that a background remote task stop. Check the result; a lost connection or unconfirmed result does not prove the remote process stopped.", {
      handle,jobId:z.string().min(1).max(191),
    }, "remote.job_kill");
    deviceTool("remote_env_chdir", "Change the working directory for later commands in this logical SSH session; path must be absolute. A cd inside remote_env_exec changes only that command's shell and does not update the session directory.", {handle,path:z.string().min(1).max(4096).describe("Absolute remote directory for later commands in this session.")}, "remote.chdir");
    deviceTool("remote_env_close", "Close this logical SSH session when finished. Other sessions may continue to use the underlying connection. Device settings determine whether closing requests termination of remote processes. Closing or a lost close receipt does not prove every remote process stopped; inspect the host independently if an outcome is unknown.", {handle}, "remote.close");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
