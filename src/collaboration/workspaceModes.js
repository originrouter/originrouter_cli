import { cwd as processCwd } from "node:process";

export const WORKSPACE_MODES = Object.freeze([
  {
    id: "auto",
    label: "Auto",
    description: "Choose the smallest safe team for the objective.",
    templateId: "adaptive",
    participantCount: null,
  },
  {
    id: "solo",
    label: "Solo",
    description: "Use one managed Agent session.",
    templateId: "adaptive",
    participantCount: 1,
  },
  {
    id: "build_review",
    label: "Build + Review",
    description: "One Agent implements and another independently reviews.",
    templateId: "adaptive",
    participantCount: 2,
  },
  {
    id: "plan_build_verify",
    label: "Plan + Build + Verify",
    description: "Plan first, implement second, then verify independently.",
    templateId: "plan_implement_verify",
    participantCount: 3,
  },
  {
    id: "parallel_research",
    label: "Parallel Research",
    description: "Run several read-only investigations and synthesize them.",
    templateId: "parallel_research",
    participantCount: 3,
  },
  {
    id: "review_panel",
    label: "Review Panel",
    description: "Compare independent proposals and produce a judged conclusion.",
    templateId: "review_panel",
    participantCount: 3,
  },
  {
    id: "remote_ops",
    label: "Remote Ops",
    description: "Coordinate at least one task on a trusted remote device.",
    templateId: "adaptive",
    participantCount: 2,
  },
]);

const MODE_ALIASES = Object.freeze({
  auto: "auto",
  solo: "solo",
  single: "solo",
  build: "build_review",
  review: "build_review",
  "build-review": "build_review",
  build_review: "build_review",
  plan: "plan_build_verify",
  verify: "plan_build_verify",
  "plan-build-verify": "plan_build_verify",
  plan_build_verify: "plan_build_verify",
  parallel: "parallel_research",
  research: "parallel_research",
  "parallel-research": "parallel_research",
  parallel_research: "parallel_research",
  panel: "review_panel",
  debate: "review_panel",
  "review-panel": "review_panel",
  review_panel: "review_panel",
  remote: "remote_ops",
  "remote-ops": "remote_ops",
  remote_ops: "remote_ops",
});

const MODE_PREFERENCES = Object.freeze({
  solo: "Use exactly one participant. Keep the task graph small and have that participant verify its own result.",
  build_review: "Assign implementation to one participant and independent review to another. A failed review must return to the implementation participant for rework.",
  plan_build_verify: "Use distinct planning, implementation, and independent verification stages. Do not complete the run until verification passes.",
  parallel_research: "Use multiple independent read-only research tasks followed by one synthesis task. Do not modify files or external state.",
  review_panel: "Produce at least two independent proposals or critiques, then assign a final judge or synthesis task. Do not modify files unless the user later changes mode.",
  remote_ops: "Assign at least one task to a trusted remote device. Remote inspection is read-only unless the objective and approval policy explicitly permit mutation.",
});

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeWorkspaceMode(value = "auto") {
  const normalized = clean(value).toLowerCase();
  const id = MODE_ALIASES[normalized];
  if (!id) {
    throw new Error(`Unknown Agent Workspace mode '${value}'. Use auto, solo, build-review, plan-build-verify, parallel-research, review-panel, or remote-ops.`);
  }
  return id;
}

export function workspaceModeDefinition(value = "auto") {
  const id = normalizeWorkspaceMode(value);
  return WORKSPACE_MODES.find((mode) => mode.id === id);
}

export function inferWorkspaceMode(objective) {
  const text = clean(objective).toLowerCase();
  if (/\b(?:debate|compare approaches|trade-?offs?|architecture decision|rfc)\b|方案对比|技术选型|架构决策|辩论/.test(text)) {
    return "review_panel";
  }
  if (/\b(?:research|investigate|audit|survey|analy[sz]e alternatives)\b|调研|调查|审计|多方向分析/.test(text)) {
    return "parallel_research";
  }
  if (/\b(?:production|deploy|release|migration|security|payment|billing|database|cross[- ]module|large refactor)\b|生产|部署|发布|迁移|安全|支付|数据库|跨模块|大型重构/.test(text)) {
    return "plan_build_verify";
  }
  if (/\b(?:fix|implement|add|build|refactor|change|update|write|test)\b|修复|实现|新增|开发|重构|修改|更新|编写|测试/.test(text)) {
    return "build_review";
  }
  return "solo";
}

export function objectiveMentionsRemoteTarget(objective) {
  const text = clean(objective);
  return /\b(?:remote|server|host|machine|device|mac mini|workstation|vm|vps)\b|远程|服务器|远端|另一台|其他电脑|远程电脑|远程机器/i.test(text);
}

export function workspaceRequiresPlanReview(objective, mode = "auto") {
  return classifyWorkspaceRisk(objective, mode) !== "green";
}

export function classifyWorkspaceRisk(objective, mode = "auto") {
  const selected = normalizeWorkspaceMode(mode);
  const effectiveMode = selected === "auto" ? inferWorkspaceMode(objective) : selected;
  const text = clean(objective);
  if (/\b(?:production|prod|deploy|release|publish|payment|billing|database migration|sudo|delete|destroy|drop table|force push)\b|生产|部署|发布|支付|数据库迁移|删除|销毁|提权|强制推送/i.test(text)) {
    return "red";
  }
  if (effectiveMode === "remote_ops" || /\b(?:remote write|restart service|systemctl|kubectl apply|terraform apply)\b|远程写入|重启服务|修改服务器/i.test(text)) {
    return "yellow";
  }
  return "green";
}

export function nextWorkspaceMode(value = "auto") {
  const current = normalizeWorkspaceMode(value);
  const index = WORKSPACE_MODES.findIndex((mode) => mode.id === current);
  return WORKSPACE_MODES[(index + 1) % WORKSPACE_MODES.length];
}

export function normalizeCoordinator(value = "codex") {
  const coordinator = clean(value || "codex").toLowerCase();
  if (!["codex", "claude"].includes(coordinator)) {
    throw new Error(`Unknown coordinator '${value}'. Use codex or claude.`);
  }
  return coordinator;
}

function capabilitiesFor(device) {
  return device.capabilities || device.cachedCapabilities || null;
}

function runtimeAvailable(device, runtime) {
  return capabilitiesFor(device)?.runtimes?.some(
    (candidate) => candidate.id === runtime && candidate.available,
  );
}

function chooseDevice(devices, runtime, { remote = false } = {}) {
  const eligible = devices.filter((device) => (
    !device.unavailableReason
    && (device.local === true || device.trustStatus === "trusted")
    && runtimeAvailable(device, runtime)
  ));
  const preferred = eligible.find((device) => remote ? device.local !== true : device.local === true);
  return preferred || eligible[0] || null;
}

function chooseWorkspace(device, currentDirectory, preferredWorkspaceId = "") {
  const capabilities = capabilitiesFor(device);
  const workspaces = capabilities?.trusted_workspaces || [];
  const preferred = workspaces.find((workspace) => (
    workspace.workspace_id === preferredWorkspaceId
    || workspace.canonical_path === preferredWorkspaceId
    || workspace.repo_root === preferredWorkspaceId
  ));
  if (preferred) return preferred.workspace_id || preferred.canonical_path;
  const exact = workspaces.find((workspace) => (
    workspace.workspace_id === currentDirectory
    || workspace.canonical_path === currentDirectory
    || workspace.repo_root === currentDirectory
  ));
  if (exact) return exact.workspace_id || exact.canonical_path;
  if (device.local === true) {
    const defaultPath = capabilities?.device?.default_workspace_path;
    const fromDefault = workspaces.find((workspace) => (
      workspace.workspace_id === defaultPath
      || workspace.canonical_path === defaultPath
      || workspace.repo_root === defaultPath
    ));
    if (fromDefault) return fromDefault.workspace_id || fromDefault.canonical_path;
  }
  if (workspaces.length === 1) return workspaces[0].workspace_id || workspaces[0].canonical_path;
  return null;
}

function uniqueParticipantId(base, used) {
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function roleDefinitions(mode, coordinator) {
  const other = coordinator === "codex" ? "claude" : "codex";
  const definitions = {
    solo: [
      { id: "coordinator", name: "Coordinator", runtime: coordinator, role: "Complete the objective and verify the result." },
    ],
    build_review: [
      { id: "coordinator", name: "Lead Implementer", runtime: coordinator, role: "Understand the objective, implement the scoped change, run focused checks, and respond to review feedback." },
      { id: "reviewer", name: "Reviewer", runtime: other, role: "Independently review the implementation and request rework when needed." },
    ],
    plan_build_verify: [
      { id: "coordinator", name: "Planner", runtime: coordinator, role: "Plan the work and coordinate the approved task graph." },
      { id: "implementer", name: "Implementer", runtime: other, role: "Implement the approved plan and run focused checks." },
      { id: "verifier", name: "Verifier", runtime: coordinator, role: "Verify independently and report evidence and remaining risks." },
    ],
    parallel_research: [
      { id: "coordinator", name: "Coordinator", runtime: coordinator, role: "Decompose the investigation and synthesize the findings." },
      { id: "researcher_a", name: "Researcher A", runtime: other, role: "Investigate one independent read-only direction." },
      { id: "researcher_b", name: "Researcher B", runtime: coordinator, role: "Investigate a different read-only direction." },
    ],
    review_panel: [
      { id: "coordinator", name: "Judge", runtime: coordinator, role: "Compare the independent positions and produce the final decision." },
      { id: "panelist_a", name: "Panelist A", runtime: other, role: "Produce an independent proposal or critique." },
      { id: "panelist_b", name: "Panelist B", runtime: coordinator, role: "Challenge assumptions and produce an alternative position." },
    ],
    remote_ops: [
      { id: "coordinator", name: "Coordinator", runtime: coordinator, role: "Coordinate the remote investigation and synthesize the result." },
      { id: "remote_operator", name: "Remote Operator", runtime: other, role: "Inspect the selected remote environment under the active approval policy.", remote: true },
    ],
  };
  return definitions[mode] || [];
}

function createParticipant(definition, devices, currentDirectory, usedIds, workspaceSelections = {}) {
  let device = chooseDevice(devices, definition.runtime, { remote: definition.remote });
  let runtime = definition.runtime;
  if (!device) {
    runtime = definition.runtime === "codex" ? "claude" : "codex";
    device = chooseDevice(devices, runtime, { remote: definition.remote });
  }
  if (!device) {
    const location = definition.remote ? "trusted remote device" : "trusted device";
    throw new Error(`No ${location} has an available ${definition.runtime} or fallback Agent runtime.`);
  }
  if (definition.remote && device.local === true) {
    throw new Error("Remote Ops requires an online or cached trusted remote device capability snapshot.");
  }
  const workspaceId = chooseWorkspace(device, currentDirectory, workspaceSelections[device.deviceId]);
  if (!workspaceId) {
    const error = new Error(`Choose a trusted workspace for ${device.deviceName || device.deviceId} before using Agent Workspace auto configuration.`);
    error.code = device.local === true
      ? "AUTO_CONFIG_WORKSPACE_REQUIRED"
      : "AUTO_CONFIG_REMOTE_WORKSPACE_REQUIRED";
    error.setup = {
      kind: "workspace_trust",
      device_id: device.deviceId,
      device_name: device.deviceName || device.deviceId,
      default_path: capabilitiesFor(device)?.device?.default_workspace_path || "",
      remote: device.local !== true,
      workspaces: (capabilitiesFor(device)?.trusted_workspaces || []).map((workspace) => ({
        workspace_id: workspace.workspace_id || workspace.canonical_path,
        display_name: workspace.display_name || workspace.canonical_path,
        canonical_path: workspace.canonical_path,
      })),
    };
    throw error;
  }
  const capabilities = capabilitiesFor(device);
  const profiles = new Set((capabilities?.permission_profiles || []).map((profile) => profile.id));
  const defaultProfile = capabilities?.defaults?.permission_profile || "guarded";
  const permissionProfile = profiles.has(defaultProfile)
    ? defaultProfile
    : profiles.has("guarded")
      ? "guarded"
      : profiles.values().next().value || "manual";
  return {
    participant_id: uniqueParticipantId(definition.id, usedIds),
    display_name: definition.name,
    runtime,
    device_id: device.deviceId,
    workspace_id: workspaceId,
    role_hint: definition.role,
    permission_profile: permissionProfile,
    planner: definition.id === "coordinator",
    waiting_for_device: device.online === false,
  };
}

export function applyWorkspaceConfiguration(payload, {
  mode = "auto",
  coordinator = "codex",
  devices = [],
  currentDirectory = processCwd(),
  workspaceSelections = {},
} = {}) {
  const selectedMode = workspaceModeDefinition(mode);
  const selectedCoordinator = normalizeCoordinator(coordinator);
  const next = structuredClone(payload);

  if (selectedMode.id === "auto") {
    let planner = next.participants.find((participant) => participant.runtime === selectedCoordinator);
    if (!planner) {
      const used = new Set(next.participants.map((participant) => participant.participant_id));
      planner = createParticipant({
        id: "coordinator",
        name: "Coordinator",
        runtime: selectedCoordinator,
        role: "Understand the objective, coordinate the task graph, and own the final result.",
      }, devices, currentDirectory, used, workspaceSelections);
      next.participants.unshift(planner);
    }
    for (const participant of next.participants) participant.planner = participant === planner;
    next.budget.max_concurrency = Math.max(1, Math.min(
      next.budget.max_concurrency || next.participants.length,
      next.participants.length,
    ));
    next.auto_configuration = {
      ...(next.auto_configuration || {}),
      workspace_mode: "auto",
      coordinator: selectedCoordinator,
    };
    return next;
  }

  const usedIds = new Set();
  const participants = roleDefinitions(selectedMode.id, selectedCoordinator)
    .map((definition) => createParticipant(
      definition,
      devices,
      currentDirectory,
      usedIds,
      workspaceSelections,
    ));
  next.participants = participants;
  next.workflow_template_id = selectedMode.templateId;
  next.preferences = [next.preferences, MODE_PREFERENCES[selectedMode.id]]
    .map(clean)
    .filter(Boolean)
    .join("\n\n");
  next.budget = {
    ...next.budget,
    max_concurrency: selectedMode.id === "plan_build_verify" ? 1 : Math.min(3, participants.length),
  };
  next.auto_configuration = {
    ...(next.auto_configuration || {}),
    independent_review: ["build_review", "plan_build_verify"].includes(selectedMode.id),
    workspace_mode: selectedMode.id,
    coordinator: selectedCoordinator,
    safe_to_skip_confirmation: selectedMode.id !== "remote_ops"
      && next.auto_configuration?.safe_to_skip_confirmation !== false,
    requires_explicit_confirmation: selectedMode.id === "remote_ops"
      || next.auto_configuration?.requires_explicit_confirmation === true,
  };
  return next;
}

export function buildLocalWorkspaceConfiguration({
  objective,
  mode = "auto",
  coordinator = "codex",
  devices = [],
  currentDirectory = processCwd(),
  workspaceSelections = {},
} = {}) {
  const requestedMode = normalizeWorkspaceMode(mode);
  const resolvedMode = requestedMode === "auto" ? inferWorkspaceMode(objective) : requestedMode;
  const base = {
    objective: clean(objective).slice(0, 16_000),
    participants: [],
    preferences: "",
    workflow_template_id: "adaptive",
    budget: { max_concurrency: 1 },
    auto_configuration: {
      schema_version: 1,
      independent_review: false,
      inherited_budget: true,
      requires_explicit_confirmation: false,
      safe_to_skip_confirmation: true,
      runtimes: [],
    },
  };
  const configured = applyWorkspaceConfiguration(base, {
    mode: resolvedMode,
    coordinator,
    devices,
    currentDirectory,
    workspaceSelections,
  });
  configured.auto_configuration.workspace_mode = requestedMode;
  configured.auto_configuration.resolved_workspace_mode = resolvedMode;
  configured.auto_configuration.runtimes = [...new Set(
    configured.participants.map((participant) => participant.runtime),
  )];
  const riskTier = classifyWorkspaceRisk(objective, resolvedMode);
  configured.workspace_mode = requestedMode;
  configured.resolved_workspace_mode = resolvedMode;
  configured.coordinator_runtime = normalizeCoordinator(coordinator);
  configured.planning_source = "local";
  configured.risk_tier = riskTier;
  configured.auto_configuration.risk_tier = riskTier;
  if (riskTier !== "green") {
    configured.auto_configuration.safe_to_skip_confirmation = false;
    configured.auto_configuration.requires_explicit_confirmation = true;
  }
  return configured;
}

export function workspaceModeSummary(value) {
  const mode = workspaceModeDefinition(value);
  return `${mode.label} — ${mode.description}`;
}
