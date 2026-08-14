import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";

import { enabledProviderModelEntries } from "../config/providerModels.js";
import { listProviders } from "../config/providers.js";
import { ROUTE_AGENTS, ROUTE_DEFS, getAgentRoutes } from "../config/routes.js";
import { AGENT_AUTONOMY_PROFILES } from "../runtime/agentAutonomyPolicy.js";

function findExecutable(command, env = process.env) {
  const pathEntries = String(env.PATH || "")
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const extensions = process.platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .map((entry) => entry.toLowerCase())
    : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = joinPath(
        directory,
        process.platform === "win32" ? `${command}${extension}` : command,
      );
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function routeProjection(routes, agent) {
  const slots = ROUTE_DEFS[agent]?.slots || ["main"];
  return Object.fromEntries(slots.map((slot) => [slot, routes?.[slot] || null]));
}

function providerProjection(provider) {
  return {
    name: provider.name,
    type: provider.type,
    engine: provider.engine || null,
    device_id: provider.deviceId || null,
    target: provider.target || null,
    models: enabledProviderModelEntries(provider).map((model) => ({
      id: model.id,
      remote_enabled: Boolean(model.remoteEnabled),
      priced: Boolean(model.pricing),
      ...(model.pricing ? {
        pricing: {
          currency: model.pricing.currency,
          unit: model.pricing.unit,
        },
      } : {}),
    })),
  };
}

export function buildCollaborationCapabilities({
  config,
  agentCatalog = null,
  agentBudgetStore,
  deviceId = "local-dev",
  version = "0.1.0",
  env = process.env,
  source = "authenticated_loopback",
  capturedAt = new Date().toISOString(),
} = {}) {
  const safeConfig = config || {};
  const providers = listProviders(safeConfig).map(providerProjection);
  const resolvedRoutes = Object.fromEntries(
    ROUTE_AGENTS.map((agent) => [
      agent,
      routeProjection(getAgentRoutes(safeConfig, agent), agent),
    ]),
  );
  const workspaces = agentCatalog
    ? agentCatalog.listWorkspaces({ deviceId, limit: 200 })
        .filter((workspace) => workspace.trusted)
        .map((workspace) => ({
          workspace_id: workspace.workspace_id,
          display_name: workspace.display_name,
          canonical_path: workspace.canonical_path,
          repo_root: workspace.repo_root || null,
          updated_at: workspace.updated_at,
        }))
    : [];
  const runtimes = ["claude", "codex"].map((runtime) => {
    const executable = findExecutable(runtime, env);
    return {
      id: runtime,
      available: Boolean(executable),
      executable,
      route_slots: [...(ROUTE_DEFS[runtime]?.slots || [])],
    };
  });
  return {
    schema_version: 1,
    captured_at: capturedAt,
    freshness: { captured_at: capturedAt, stale: false, source },
    device: {
      device_id: deviceId,
      name: safeConfig.device?.name || safeConfig.deviceName || null,
      cli_version: version,
      platform: process.platform,
      architecture: process.arch,
      default_workspace_path: process.cwd(),
    },
    runtimes,
    providers,
    models: providers.flatMap((provider) => provider.models.map((model) => ({
      provider: provider.name,
      ...model,
    }))),
    resolved_routes: resolvedRoutes,
    trusted_workspaces: workspaces,
    permission_profiles: AGENT_AUTONOMY_PROFILES.map((profile) => ({ ...profile })),
    defaults: {
      permission_profile: "guarded",
    },
    budget_policy: agentBudgetStore?.snapshot?.() || null,
    protocol_versions: {
      collaboration_snapshot: 2,
      collaboration_event: 2,
      collaboration_attention: 1,
      capability_snapshot: 1,
      agent_mcp_gateway: 1,
    },
    actions: {
      can_confirm_plan: true,
      can_resolve_approval: true,
      can_pause: true,
      can_resume: true,
      can_cancel: true,
      can_retry_task: true,
      can_change_budget: true,
      can_archive: true,
      can_delete: true,
      can_view_diagnostics: true,
    },
  };
}
