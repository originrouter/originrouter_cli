export const AGENT_DETAIL_PROFILES = Object.freeze([
  Object.freeze({
    id: "concise",
    label: "Concise",
    description: "Show conversation, blocking requests, errors, and one work summary per turn.",
  }),
  Object.freeze({
    id: "standard",
    label: "Standard",
    description: "Also show key plans, commands, file changes, and subagent milestones.",
  }),
  Object.freeze({
    id: "detailed",
    label: "Detailed",
    description: "Show all display-safe structured Agent activity.",
  }),
]);

export const DEFAULT_AGENT_DETAIL_PROFILE = "concise";

const PROFILE_IDS = new Set(AGENT_DETAIL_PROFILES.map((item) => item.id));

export function normalizeAgentDetailProfile(value, fallback = DEFAULT_AGENT_DETAIL_PROFILE) {
  const normalized = String(value || "").trim().toLowerCase();
  return PROFILE_IDS.has(normalized) ? normalized : fallback;
}

export function requireAgentDetailProfile(value) {
  const normalized = normalizeAgentDetailProfile(value, "");
  if (!normalized) {
    throw new Error("agent detail profile must be concise, standard, or detailed");
  }
  return normalized;
}

export function agentDetailDefaultFromConfig(config) {
  return normalizeAgentDetailProfile(config?.agent?.detailProfile);
}

export function setAgentDetailDefault(config, profile) {
  const normalized = requireAgentDetailProfile(profile);
  return {
    ...(config || {}),
    agent: {
      ...(config?.agent || {}),
      detailProfile: normalized,
    },
  };
}

export function resolveAgentDetailProfile({ config, launchOverride } = {}) {
  const configured = agentDetailDefaultFromConfig(config);
  const hasLaunchOverride = String(launchOverride || "").trim().length > 0;
  const explicit = hasLaunchOverride ? requireAgentDetailProfile(launchOverride) : "";
  return {
    profile: explicit || configured,
    source: explicit ? "launch_argument" : config?.agent?.detailProfile
      ? "global_default"
      : "builtin_default",
  };
}
