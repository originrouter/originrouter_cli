import { z } from "zod";


const PARTICIPANT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const WORKFLOW_TEMPLATES = new Set([
  "adaptive",
  "plan_implement_verify",
  "parallel_research",
  "review_panel",
]);
const PERMISSION_RANK = Object.freeze({
  manual: 0,
  guarded: 1,
  ai_review: 1,
  custom: 1,
  unrestricted: 2,
});

const participantSchema = z.object({
  participant_id: z.string().min(1).max(32),
  display_name: z.string().min(1).max(80),
  runtime: z.enum(["claude", "codex"]),
  device_id: z.string().min(1).max(191),
  workspace_id: z.string().max(191),
  role_hint: z.string().min(1).max(2000),
  permission_profile: z.string().min(1).max(64),
  provider: z.string().max(191).nullable(),
  model: z.string().max(191).nullable(),
}).strict();

export const COLLABORATION_AUTO_CONFIG_SCHEMA = z.object({
  participants: z.array(participantSchema).min(1).max(16),
  planner: z.string().min(1).max(32),
  workflow_template_id: z.string().min(1).max(64),
  collaboration_preferences: z.string().max(16_000),
  max_concurrency: z.number().int().min(1).max(16),
  independent_review: z.boolean(),
  budget: z.object({
    token_limit: z.number().int().positive().nullable(),
    amount_limit_micros: z.number().int().positive().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  }).strict(),
}).strict();

function cleanText(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function capabilityForDevice(device) {
  return device.capabilities || device.cachedCapabilities || null;
}

function remainingLimit(status, policyKey, usageKey) {
  const limit = Number(status?.policy?.[policyKey]);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, limit - Number(status?.[usageKey.split(".")[0]]?.[usageKey.split(".")[1]] || 0));
}

function budgetCeiling(capabilities, runtimes) {
  const snapshot = capabilities?.budget_policy;
  if (!snapshot) return { token: null, amount: null, currency: null, blocked: false };
  const statuses = [snapshot.device, ...runtimes.map((runtime) => snapshot.agents?.[runtime])]
    .filter(Boolean);
  const tokens = statuses.flatMap((status) => [
    remainingLimit(status, "daily_token_limit", "daily.sampled_tokens"),
    remainingLimit(status, "weekly_token_limit", "weekly.sampled_tokens"),
  ]).filter((value) => value != null);
  const amounts = statuses.flatMap((status) => [
    remainingLimit(status, "daily_amount_limit_micros", "daily.amount_micros"),
    remainingLimit(status, "weekly_amount_limit_micros", "weekly.amount_micros"),
  ]).filter((value) => value != null);
  return {
    token: tokens.length ? Math.min(...tokens) : null,
    amount: amounts.length ? Math.min(...amounts) : null,
    currency: statuses.map((status) => status.policy?.currency).find(Boolean) || null,
    blocked: statuses.some((status) => status.blocked === true),
  };
}

export function publicCapabilitySnapshot(devices) {
  return { devices: devices.map((device) => {
    const capabilities = capabilityForDevice(device);
    const defaultWorkspacePath = cleanText(capabilities?.device?.default_workspace_path, 512);
    const defaultWorkspace = (capabilities?.trusted_workspaces || []).find((workspace) => (
      cleanText(workspace?.canonical_path, 512) === defaultWorkspacePath
      && workspace?.unattended_execution?.remote_eligible !== false
    ));
    return {
      device_id: device.deviceId,
      device_name: cleanText(
        device.deviceName || capabilities?.device?.name || device.deviceId,
        191,
      ),
      online: device.online !== false,
      trusted: device.trustStatus === "trusted" || device.local === true,
      capability_available: Boolean(capabilities),
      cli_version: cleanText(capabilities?.device?.cli_version, 64) || null,
      platform: cleanText(capabilities?.device?.platform, 32) || null,
      architecture: cleanText(capabilities?.device?.architecture, 32) || null,
      default_workspace_id: cleanText(defaultWorkspace?.workspace_id, 191) || null,
      runtimes: (capabilities?.runtimes || []).map(({ id, available }) => ({ id, available })),
      trusted_workspaces: (capabilities?.trusted_workspaces || [])
        .filter((workspace) => workspace?.unattended_execution?.remote_eligible !== false)
        .map((workspace) => ({
          workspace_id: workspace.workspace_id,
          display_name: workspace.display_name,
          repo_name: cleanText(workspace.repo_root || workspace.canonical_path, 256).split(/[\\/]/).filter(Boolean).at(-1) || "workspace",
        })),
      providers: (capabilities?.providers || []).map((provider) => ({
        name: provider.name,
        models: (provider.models || []).map((model) => model.id),
      })),
      resolved_routes: capabilities?.resolved_routes || {},
      permission_profiles: (capabilities?.permission_profiles || []).map((profile) => profile.id),
      default_permission_profile: capabilities?.defaults?.permission_profile || "guarded",
      budget_policy: capabilities?.budget_policy || null,
      protocol_versions: capabilities?.protocol_versions || {},
    };
  }) };
}

export function collaborationConfigurationEditor(devices) {
  return {
    devices: devices.map((device) => {
      const capabilities = capabilityForDevice(device) || {};
      return {
        device_id: device.deviceId,
        device_name: cleanText(
          device.deviceName || capabilities?.device?.name || device.deviceId,
          191,
        ),
        local: device.local === true,
        runtimes: (capabilities.runtimes || [])
          .filter((runtime) => runtime?.available && ["codex", "claude"].includes(runtime.id))
          .map((runtime) => ({ id: runtime.id })),
        resolved_routes: Object.fromEntries(
          ["codex", "claude"].map((runtime) => {
            const route = capabilities.resolved_routes?.[runtime]?.main;
            return [runtime, route?.provider && route?.model
              ? { provider: route.provider, model: route.model }
              : null];
          }),
        ),
        providers: (capabilities.providers || []).map((provider) => ({
          name: provider.name,
          models: (provider.models || []).map((model) => ({ id: model.id })),
        })).filter((provider) => provider.name && provider.models.length),
        permission_profiles: (capabilities.permission_profiles || [])
          .map((profile) => ({
            id: profile.id,
            label: profile.label || profile.id,
            description: profile.description || "",
          }))
          .filter((profile) => ["manual", "guarded", "ai_review", "unrestricted", "custom"].includes(profile.id)),
      };
    }),
  };
}

export function attachCollaborationConfigurationEditor(payload, devices, {
  enumerable = false,
} = {}) {
  Object.defineProperty(payload, "_workspace_editor", {
    value: collaborationConfigurationEditor(devices),
    enumerable,
    configurable: true,
  });
  return payload;
}

function routeExists(capabilities, providerName, modelId) {
  return (capabilities.providers || []).some((provider) => provider.name === providerName
    && (provider.models || []).some((model) => model.id === modelId));
}

export function validateAndNormalizeAutoConfiguration(rawOutput, { objective, devices }) {
  const parsed = COLLABORATION_AUTO_CONFIG_SCHEMA.parse(rawOutput);
  const ids = new Set();
  const participants = parsed.participants.map((participant) => {
    if (!PARTICIPANT_ID.test(participant.participant_id) || ids.has(participant.participant_id)) {
      throw Object.assign(new Error(`Invalid or duplicate participant id '${participant.participant_id}'.`), { code: "AUTO_CONFIG_INVALID_PARTICIPANT" });
    }
    ids.add(participant.participant_id);
    const device = devices.find((item) => item.deviceId === participant.device_id);
    const capabilities = device && capabilityForDevice(device);
    if (!device || !capabilities || (device.trustStatus !== "trusted" && device.local !== true)) {
      throw Object.assign(new Error(`The model referenced an unknown or untrusted device '${participant.device_id}'.`), { code: "AUTO_CONFIG_UNKNOWN_DEVICE" });
    }
    const runtime = (capabilities.runtimes || []).find((item) => item.id === participant.runtime);
    if (!runtime?.available) throw Object.assign(new Error(`Runtime '${participant.runtime}' is unavailable on '${participant.device_id}'.`), { code: "AUTO_CONFIG_RUNTIME_UNAVAILABLE" });
    const workspaces = capabilities.trusted_workspaces || [];
    const workspace = workspaces.find((item) => item.workspace_id === participant.workspace_id);
    if (!workspace) {
      if (!participant.workspace_id && workspaces.length > 1) {
        const error = new Error(`Choose a workspace for ${participant.display_name}.`);
        error.code = "AUTO_CONFIG_WORKSPACE_AMBIGUOUS";
        error.ambiguity = { participant_id: participant.participant_id, device_id: participant.device_id, workspaces };
        error.proposal = parsed;
        throw error;
      }
      if (!participant.workspace_id && workspaces.length === 1) participant.workspace_id = workspaces[0].workspace_id;
      else throw Object.assign(new Error(`The model referenced an unknown workspace '${participant.workspace_id}'.`), { code: "AUTO_CONFIG_UNKNOWN_WORKSPACE" });
    }
    const selectedWorkspace = workspaces.find((item) => item.workspace_id === participant.workspace_id);
    if (selectedWorkspace?.unattended_execution?.remote_eligible === false) {
      const error = new Error(
        selectedWorkspace.unattended_execution.action
          || `Workspace '${participant.workspace_id}' is registered but is not ready for unattended execution.`,
      );
      error.code = selectedWorkspace.unattended_execution.status === "requires_local_authorization"
        ? "AUTO_CONFIG_WORKSPACE_TARGET_AUTHORIZATION_REQUIRED"
        : "AUTO_CONFIG_WORKSPACE_UNAVAILABLE";
      error.workspace = selectedWorkspace;
      throw error;
    }
    const profiles = new Set((capabilities.permission_profiles || []).map((profile) => profile.id));
    if (!profiles.has(participant.permission_profile)) throw Object.assign(new Error(`Unknown permission profile '${participant.permission_profile}'.`), { code: "AUTO_CONFIG_UNKNOWN_PERMISSION" });
    const defaultPermission = capabilities.defaults?.permission_profile || "guarded";
    if ((PERMISSION_RANK[participant.permission_profile] ?? 99) > (PERMISSION_RANK[defaultPermission] ?? 0)) {
      throw Object.assign(new Error(`The model attempted to widen permissions from '${defaultPermission}' to '${participant.permission_profile}'.`), { code: "AUTO_CONFIG_PERMISSION_ESCALATION" });
    }
    if ((participant.provider == null) !== (participant.model == null)) throw Object.assign(new Error("Provider and model must both be null or both be selected."), { code: "AUTO_CONFIG_INVALID_ROUTE" });
    if (participant.provider && !routeExists(capabilities, participant.provider, participant.model)) throw Object.assign(new Error(`Unknown model route '${participant.provider}/${participant.model}'.`), { code: "AUTO_CONFIG_UNKNOWN_ROUTE" });
    return {
      participant_id: participant.participant_id,
      display_name: participant.display_name,
      runtime: participant.runtime,
      device_id: participant.device_id,
      workspace_id: participant.workspace_id,
      role_hint: participant.role_hint,
      permission_profile: participant.permission_profile,
      planner: participant.participant_id === parsed.planner,
      ...(participant.provider ? { provider: participant.provider, model: participant.model } : {}),
      waiting_for_device: device.online === false,
    };
  });
  if (!ids.has(parsed.planner) || participants.filter((item) => item.planner).length !== 1) throw Object.assign(new Error("The planner must reference exactly one participant."), { code: "AUTO_CONFIG_INVALID_PLANNER" });
  if (!WORKFLOW_TEMPLATES.has(parsed.workflow_template_id)) throw Object.assign(new Error(`Unknown collaboration workflow '${parsed.workflow_template_id}'.`), { code: "AUTO_CONFIG_UNKNOWN_WORKFLOW" });
  if (parsed.max_concurrency > participants.length) throw Object.assign(new Error("max_concurrency exceeds the team size."), { code: "AUTO_CONFIG_INVALID_CONCURRENCY" });
  if (parsed.independent_review && participants.length < 2) throw Object.assign(new Error("Independent review requires at least two participants."), { code: "AUTO_CONFIG_REVIEWER_REQUIRED" });
  const runtimes = [...new Set(participants.map((item) => item.runtime))];
  const ceilings = participants.map((participant) => budgetCeiling(capabilityForDevice(devices.find((item) => item.deviceId === participant.device_id)), [participant.runtime]));
  if (ceilings.some((item) => item.blocked)) throw Object.assign(new Error("A selected device or Agent budget is exhausted."), { code: "AUTO_CONFIG_BUDGET_EXHAUSTED" });
  const tokenCeiling = ceilings.map((item) => item.token).filter((item) => item != null);
  const amountCeiling = ceilings.map((item) => item.amount).filter((item) => item != null);
  if (parsed.budget.token_limit != null && tokenCeiling.length && parsed.budget.token_limit > Math.min(...tokenCeiling)) throw Object.assign(new Error("The proposed token budget exceeds an applicable policy."), { code: "AUTO_CONFIG_BUDGET_EXCEEDED" });
  if (parsed.budget.amount_limit_micros != null && amountCeiling.length && parsed.budget.amount_limit_micros > Math.min(...amountCeiling)) throw Object.assign(new Error("The proposed amount budget exceeds an applicable policy."), { code: "AUTO_CONFIG_BUDGET_EXCEEDED" });
  const currencies = new Set(ceilings.map((item) => item.currency).filter(Boolean));
  if (parsed.budget.amount_limit_micros != null && currencies.size && !currencies.has(parsed.budget.currency)) throw Object.assign(new Error("The proposed budget currency does not match device policy."), { code: "AUTO_CONFIG_BUDGET_CURRENCY" });
  const objectiveRequiresConfirmation = /\b(?:prod|production|deploy|release|publish|billing|payment|database migration)\b|生产|发布|部署|付费|支付|数据库迁移/i.test(objective);
  return {
    objective: cleanText(objective, 16_000),
    participants,
    preferences: parsed.collaboration_preferences,
    workflow_template_id: parsed.workflow_template_id,
    budget: {
      max_concurrency: parsed.max_concurrency,
      ...(parsed.budget.token_limit == null ? {} : { token_limit: parsed.budget.token_limit }),
      ...(parsed.budget.amount_limit_micros == null ? {} : {
        amount_limit_micros: parsed.budget.amount_limit_micros,
        currency: parsed.budget.currency,
      }),
    },
    auto_configuration: {
      schema_version: 1,
      independent_review: parsed.independent_review,
      inherited_budget: parsed.budget.token_limit == null && parsed.budget.amount_limit_micros == null,
      requires_explicit_confirmation: objectiveRequiresConfirmation
        || participants.some((item) => item.permission_profile === "unrestricted")
        || parsed.budget.token_limit != null
        || parsed.budget.amount_limit_micros != null,
      safe_to_skip_confirmation: !objectiveRequiresConfirmation
        && participants.every((item) => item.permission_profile !== "unrestricted")
        && parsed.budget.token_limit == null
        && parsed.budget.amount_limit_micros == null,
      runtimes,
    },
  };
}
