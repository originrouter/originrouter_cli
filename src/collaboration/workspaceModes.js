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
  if (objectiveMentionsRemoteTarget(text)) return "remote_ops";
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

export function workspaceCapabilityCounts(capabilities = {}) {
  const workspaces = Array.isArray(capabilities?.trusted_workspaces)
    ? capabilities.trusted_workspaces
    : [];
  const ready = workspaces.filter((workspace) => (
    workspace?.unattended_execution?.remote_eligible !== false
  ));
  const actionRequired = workspaces.filter((workspace) => (
    workspace?.unattended_execution?.remote_eligible === false
    && workspace?.unattended_execution?.status === "requires_local_authorization"
  ));
  const blocked = workspaces.filter((workspace) => (
    workspace?.unattended_execution?.remote_eligible === false
    && workspace?.unattended_execution?.status !== "requires_local_authorization"
  ));
  return {
    registered: workspaces.length,
    ready: ready.length,
    action_required: actionRequired.length,
    blocked: blocked.length,
  };
}

export function workspaceModeSummary(value) {
  const mode = workspaceModeDefinition(value);
  return `${mode.label} — ${mode.description}`;
}
