import { AgentCatalog } from "../persistence/agentCatalog.js";
import { ensureStateDir } from "../persistence/state.js";
import { assessRegisteredWorkspaceForUnattended } from "../runtime/unattendedWorkspaceReadiness.js";
import { updateCachedCollaborationWorkspace } from "../collaboration/collaborationCapabilityCache.js";
import { handleSecurityCommand } from "./security.js";
import { parseOptionArgs } from "./shared/cliArgs.js";
import { remoteLocalRequest } from "./localApi.js";

function remoteProviderNames(value) {
  return String(value || "").split(",").map((name) => name.trim()).filter(Boolean);
}

function printRemoteShareStatus(value) {
  console.log(`Remote Share: ${value.enabled && value.state === "running" ? "on" : "off"}`);
  console.log(`  port: ${value.port || "-"}`);
  console.log(`  providers: ${(value.providers || []).join(", ") || "none"}`);
  console.log(`  shared models: ${(value.catalog || []).length}`);
  console.log(`  transport: ${value.e2eePolicy === "required" ? "trusted-device E2EE required" : "not configured"}`);
}

function printRemoteWorkspaces() {
  const catalog = new AgentCatalog({ stateDir: ensureStateDir() });
  try {
    const workspaces = catalog.listWorkspaces();
    if (workspaces.length === 0) {
      console.log("No remote workspaces are registered.");
      return;
    }
    for (const workspace of workspaces) {
      const readiness = assessRegisteredWorkspaceForUnattended(workspace);
      console.log(`${workspace.canonical_path} · ${readiness.status}`);
      if (!readiness.remote_eligible) console.log(`  ${readiness.action}`);
    }
  } finally {
    catalog.close();
  }
}

async function authorizeRemoteWorkspace(path) {
  if (process.env.ORIGINROUTER_MANAGED_AGENT === "1") {
    const error = new Error("A managed Agent cannot authorize or expand remote workspace access. Run this command from a human-controlled target-device terminal, SSH session, screen-sharing session, or device-management tool.");
    error.code = "REMOTE_WORKSPACE_SELF_AUTHORIZATION_FORBIDDEN";
    throw error;
  }
  if (!path) throw new Error("Usage: originrouter remote workspace authorize <path>");
  const result = await remoteLocalRequest("/agent/catalog/workspaces/authorize", {
    method: "POST",
    body: { path },
  });
  console.log(`Remote workspace authorized: ${result.workspace.canonical_path}`);
  console.log("The target daemon verified unattended access with its current runtime identity.");
  console.log("Physical access is needed only when the operating system requests interactive approval.");
}

function remoteWorkspaceRequestArgs(args) {
  let deviceId = "";
  let path = "";
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index] || "");
    if (item === "--device") {
      deviceId = String(args[index + 1] || "").trim();
      index += 1;
    } else if (item.startsWith("--device=")) {
      deviceId = item.slice("--device=".length).trim();
    } else if (!path) {
      path = item;
    } else {
      throw new Error(`Unexpected argument: ${item}`);
    }
  }
  if (!deviceId || !path) {
    throw new Error("Usage: originrouter remote workspace request <path> --device <device-id>");
  }
  return { deviceId, path };
}

async function requestRemoteWorkspace(args) {
  if (process.env.ORIGINROUTER_MANAGED_AGENT === "1") {
    const error = new Error("A managed Agent cannot request or expand remote workspace access. Run this command from a human-controlled OriginRouter control plane.");
    error.code = "REMOTE_WORKSPACE_SELF_AUTHORIZATION_FORBIDDEN";
    throw error;
  }
  const { deviceId, path } = remoteWorkspaceRequestArgs(args);
  const result = await remoteLocalRequest(
    `/collaboration/devices/${encodeURIComponent(deviceId)}/workspaces/trust`,
    { method: "POST", body: { path } },
  );
  const workspace = result.workspace || {};
  updateCachedCollaborationWorkspace(deviceId, workspace);
  const readiness = workspace.unattended_execution || {};
  console.log(`Remote workspace registered on target: ${workspace.canonical_path || path}`);
  console.log(`Unattended status: ${readiness.status || "registered"}`);
  if (readiness.action) console.log(readiness.action);
}

export async function handleRemoteCommand(args) {
  const [section = "setup", action, ...rest] = args;
  if (["--help", "-h", "help"].includes(section)) {
    console.log("Usage: originrouter remote setup|status|share|workspace");
    console.log("  remote setup [--workspace <path>] [--providers <name[,name...]>] [--port <p>]");
    console.log("  remote share status|start|stop|restart [--providers <name[,name...]>] [--port <p>]");
    console.log("  remote workspace list|authorize <path>");
    console.log("  remote workspace request <path> --device <device-id>");
    return;
  }
  if (section === "workspace") {
    if (!action || action === "list") return printRemoteWorkspaces();
    if (action === "authorize") return authorizeRemoteWorkspace(rest[0]);
    if (action === "request") return requestRemoteWorkspace(rest);
    throw new Error("Usage: originrouter remote workspace list|authorize <path>|request <path> --device <device-id>");
  }
  if (section === "share") {
    const operation = action || "status";
    if (!["status", "start", "stop", "restart"].includes(operation)) {
      throw new Error("Usage: originrouter remote share status|start|stop|restart [--providers <name[,name...]>] [--port <p>]");
    }
    if (operation === "status") return printRemoteShareStatus(await remoteLocalRequest("/remote-share/status"));
    const options = parseOptionArgs(rest);
    const body = {};
    if (options["--providers"]) body.providers = remoteProviderNames(options["--providers"]);
    if (options["--port"]) body.port = options["--port"];
    return printRemoteShareStatus(await remoteLocalRequest(`/remote-share/${operation}`, { method: "POST", body }));
  }
  if (section === "status") {
    await handleSecurityCommand(["status"]);
    printRemoteShareStatus(await remoteLocalRequest("/remote-share/status"));
    printRemoteWorkspaces();
    return;
  }
  if (section !== "setup") throw new Error("Usage: originrouter remote setup|status|share|workspace");
  const options = parseOptionArgs([action, ...rest].filter(Boolean));
  await handleSecurityCommand(["status"]);
  if (options["--providers"]) {
    const body = { providers: remoteProviderNames(options["--providers"]) };
    if (options["--port"]) body.port = options["--port"];
    printRemoteShareStatus(await remoteLocalRequest("/remote-share/start", { method: "POST", body }));
  } else {
    printRemoteShareStatus(await remoteLocalRequest("/remote-share/status"));
  }
  if (options["--workspace"]) await authorizeRemoteWorkspace(options["--workspace"]);
  else printRemoteWorkspaces();
  console.log("Setup complete. Device trust, Remote Share, and workspace access remain independently scoped.");
}
