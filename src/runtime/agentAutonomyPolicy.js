import path from "node:path";

import { INTERACTION_KINDS } from "./agentInteractionContract.js";
import { evaluateApprovalRequest } from "./approvalPolicy.js";

export const AGENT_AUTONOMY_PROFILES = Object.freeze([
  {
    id: "manual",
    label: "Manual",
    description: "Ask before every blocking action.",
  },
  {
    id: "guarded",
    label: "Guarded",
    description: "Continue routine workspace work, but stop for elevated or destructive actions.",
  },
  {
    id: "ai_review",
    label: "AI review",
    description: "Let an independent AI reviewer decide routine actions; high-risk or uncertain requests still require you.",
  },
  {
    id: "unrestricted",
    label: "Full",
    description: "Allow all permission and continue prompts, including destructive, elevated, and network actions.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Allow only the selected unattended execution scopes.",
  },
]);

export const AGENT_AUTONOMY_SCOPES = Object.freeze([
  {
    id: "plan_continue",
    label: "Plan continuation",
    description: "Implement an accepted plan or continue a confirmation step.",
    risk: "normal",
  },
  {
    id: "explicit_continue_questions",
    label: "Explicit Continue/Yes",
    description: "Answer only an unambiguous Continue/Cancel or Yes/No question.",
    risk: "normal",
  },
  {
    id: "read_tools",
    label: "Read and search tools",
    description: "Allow file reads, search, listing, and read-only web tools.",
    risk: "normal",
  },
  {
    id: "workspace_edits",
    label: "Workspace file edits",
    description: "Create or modify files inside the current workspace.",
    risk: "normal",
  },
  {
    id: "workspace_commands",
    label: "Routine workspace commands",
    description: "Run displayable commands in the workspace that are not classified as destructive, elevated, or remote mutations.",
    risk: "normal",
  },
  {
    id: "additional_permissions",
    label: "Additional sandbox permissions",
    description: "Grant extra filesystem or network permissions requested by the runtime.",
    risk: "high",
  },
  {
    id: "destructive_commands",
    label: "Destructive commands",
    description: "Allow deletion, destructive Git operations, disk tools, and destructive database commands.",
    risk: "high",
  },
  {
    id: "elevated_commands",
    label: "Elevated and system commands",
    description: "Allow sudo, service control, container orchestration, and infrastructure tools.",
    risk: "high",
  },
  {
    id: "network_mutations",
    label: "Remote and network mutations",
    description: "Allow SSH/SCP, pushes, releases, and mutating HTTP requests.",
    risk: "high",
  },
  {
    id: "outside_workspace",
    label: "Outside-workspace access",
    description: "Allow file changes or commands whose path is outside the current workspace.",
    risk: "high",
  },
  {
    id: "unknown_tools",
    label: "Unknown tools",
    description: "Allow permission requests OriginRouter cannot classify into a known scope.",
    risk: "high",
  },
]);

const GUARDED_SCOPE_IDS = Object.freeze([
  "plan_continue",
  "read_tools",
  "workspace_edits",
  "workspace_commands",
]);
const ALL_SCOPE_IDS = Object.freeze(AGENT_AUTONOMY_SCOPES.map((item) => item.id));

const SAFE_READ_TOOLS = new Set([
  "glob",
  "grep",
  "ls",
  "read",
  "search",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
]);

const WORKSPACE_WRITE_TOOLS = new Set([
  "applypatch",
  "edit",
  "file_change",
  "multiedit",
  "notebookedit",
  "write",
]);

const COMMAND_TOOLS = new Set([
  "bash",
  "command",
  "exec",
  "execcommand",
  "shell",
]);

const ELEVATED_COMMAND = [
  /(^|[;&|]\s*)(sudo|doas|su)(\s|$)/i,
  /(^|[;&|]\s*)(systemctl|service|launchctl)(\s|$)/i,
  /(^|[;&|]\s*)(docker|podman|kubectl|helm|terraform)(\s|$)/i,
];

const NETWORK_MUTATION_COMMAND = [
  /(^|[;&|]\s*)(ssh|scp|rsync)(\s|$)/i,
  /(^|[;&|]\s*)(git\s+push|gh\s+release)(\s|$)/i,
  /(^|[;&|]\s*)curl\b[^\n]*(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
  /(^|[;&|]\s*)wget\b[^\n]*(?:--post-data|--post-file)\b/i,
];

const DESTRUCTIVE_COMMAND = [
  /(^|[;&|]\s*)rm\s+/i,
  /(^|[;&|]\s*)rmdir\s+/i,
  /(^|[;&|]\s*)git\s+(?:reset\s+--hard|clean\b|checkout\s+--|restore\b)/i,
  /(^|[;&|]\s*)(?:mkfs|fdisk|diskutil|dd)(\s|$)/i,
  /(^|[;&|]\s*)(?:chmod|chown)\s+(?:-R\s+)?(?:\/|\.\.)/i,
  /(^|[;&|]\s*)(?:drop|truncate)\s+(?:database|table)\b/i,
];

function normalizedTool(request) {
  return String(
    request?.payload?.tool
      || request?.tool
      || request?.payload?.display_name
      || "",
  ).replace(/[^a-z0-9_]/gi, "").toLowerCase();
}

function isInsideWorkspace(candidate, workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  const value = String(candidate || "").trim();
  if (!value) return true;
  if (value === "~" || value.startsWith("~/") || value.startsWith("$")) return false;
  const resolved = path.resolve(root, value);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

function collectPathCandidates(value, key = "", result = []) {
  if (result.length >= 64 || value == null) return result;
  if (Array.isArray(value)) {
    for (const item of value) collectPathCandidates(item, key, result);
    return result;
  }
  if (typeof value !== "object") {
    if (/^(?:file_?path|path|cwd|destination|target)$/i.test(key)) {
      result.push(String(value));
    }
    return result;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if ((childKey.includes("/") || childKey.startsWith(".")) && childKey.length < 4096) {
      result.push(childKey);
    }
    collectPathCandidates(childValue, childKey, result);
  }
  return result;
}

function hasMeaningfulValue(value) {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulValue);
  return true;
}

export function classifyPermissionScope(request, workspaceRoot) {
  if (request?.containsSecret) {
    return { scope: null, reason: "secret_input" };
  }
  const tool = normalizedTool(request);
  if (tool === "permissions") {
    return { scope: "additional_permissions", reason: "additional_sandbox_permissions" };
  }
  if (SAFE_READ_TOOLS.has(tool)) {
    return { scope: "read_tools", reason: "routine_read_tool" };
  }
  if (WORKSPACE_WRITE_TOOLS.has(tool)) {
    const candidates = collectPathCandidates(request?.payload);
    if (candidates.every((candidate) => isInsideWorkspace(candidate, workspaceRoot))) {
      return { scope: "workspace_edits", reason: "workspace_file_change" };
    }
    return { scope: "outside_workspace", reason: "path_outside_workspace" };
  }
  if (COMMAND_TOOLS.has(tool)) {
    const command = String(request?.payload?.command || "").trim();
    const cwd = request?.payload?.cwd;
    if (
      hasMeaningfulValue(request?.payload?.additional_permissions)
      || hasMeaningfulValue(request?.payload?.network_approval_context)
    ) {
      return { scope: "additional_permissions", reason: "additional_command_permissions" };
    }
    if (!isInsideWorkspace(cwd, workspaceRoot)) {
      return { scope: "outside_workspace", reason: "cwd_outside_workspace" };
    }
    if (!command) return { scope: "unknown_tools", reason: "command_not_displayable" };
    if (DESTRUCTIVE_COMMAND.some((pattern) => pattern.test(command))) {
      return { scope: "destructive_commands", reason: "destructive_command" };
    }
    if (ELEVATED_COMMAND.some((pattern) => pattern.test(command))) {
      return { scope: "elevated_commands", reason: "elevated_command" };
    }
    if (NETWORK_MUTATION_COMMAND.some((pattern) => pattern.test(command))) {
      return { scope: "network_mutations", reason: "network_mutation" };
    }
    return { scope: "workspace_commands", reason: "routine_workspace_command" };
  }
  return { scope: "unknown_tools", reason: "unknown_tool" };
}

function affirmativeQuestionResponse(request) {
  const questions = Array.isArray(request?.payload?.questions)
    ? request.payload.questions
    : [];
  if (questions.length !== 1 || questions[0]?.multiple) return null;
  const question = questions[0];
  const options = Array.isArray(question?.options) ? question.options : [];
  const affirmative = options.filter((option) => /^(?:yes|continue|proceed|allow|approve|implement|confirm|是|继续|允许|确认|执行)$/i.test(
    String(option?.label || "").trim(),
  ));
  const negative = options.filter((option) => /^(?:no|cancel|stop|deny|reject|不|否|取消|停止|拒绝)$/i.test(
    String(option?.label || "").trim(),
  ));
  if (affirmative.length !== 1 || negative.length === 0) return null;
  const questionId = String(question.id || "q1");
  return {
    answers: {
      [questionId]: [String(affirmative[0].label)],
    },
    auto_approved: true,
  };
}

export function normalizeAutonomyProfile(value, fallback = "manual") {
  const normalized = String(value || "").trim().toLowerCase();
  if (AGENT_AUTONOMY_PROFILES.some((item) => item.id === normalized)) {
    return normalized;
  }
  return fallback;
}

export function normalizeAutonomyScopes(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const known = new Set(ALL_SCOPE_IDS);
  return [...new Set(raw.map((item) => String(item || "").trim()).filter((item) => known.has(item)))];
}

export function invalidAutonomyScopes(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const known = new Set(ALL_SCOPE_IDS);
  return [...new Set(
    raw
      .map((item) => String(item || "").trim())
      .filter((item) => item && !known.has(item)),
  )];
}

export function effectiveAutonomyScopes(profile, allowedScopes = []) {
  const normalizedProfile = normalizeAutonomyProfile(profile);
  if (normalizedProfile === "guarded") return GUARDED_SCOPE_IDS.slice();
  if (normalizedProfile === "unrestricted") return ALL_SCOPE_IDS.slice();
  if (normalizedProfile === "custom") return normalizeAutonomyScopes(allowedScopes);
  return [];
}

export function buildAutonomyStatusEvent({
  provider,
  runtime,
  profile,
  control = "supported",
  allowedScopes = [],
  requestId = null,
  reason = null,
  approvalPolicy = null,
  aiReviewPolicy = null,
  accepted = null,
} = {}) {
  const normalizedProfile = normalizeAutonomyProfile(profile);
  return {
    type: "agent.autonomy.status",
    provider: provider || null,
    runtime: runtime || null,
    autonomyProfile: normalizedProfile,
    autonomyControl: control === "supported" ? "supported" : "unsupported",
    availableAutonomyProfiles: control === "supported" ? AGENT_AUTONOMY_PROFILES : [],
    allowedAutonomyScopes: control === "supported"
      ? effectiveAutonomyScopes(normalizedProfile, allowedScopes)
      : [],
    availableAutonomyScopes: control === "supported" ? AGENT_AUTONOMY_SCOPES : [],
    approvalPolicy: normalizedProfile === "custom" && approvalPolicy
      ? {
          id: approvalPolicy.policy?.id || approvalPolicy.summary?.id || null,
          name: approvalPolicy.policy?.name || approvalPolicy.summary?.name || null,
          revision: approvalPolicy.revision || null,
          source: approvalPolicy.summary?.source || "device",
        }
      : null,
    aiReviewPolicy: normalizedProfile === "ai_review" && aiReviewPolicy
      ? {
          templateId: aiReviewPolicy.template_id,
          name: aiReviewPolicy.name,
          version: aiReviewPolicy.version,
          contentHash: aiReviewPolicy.content_hash,
        }
      : null,
    requestId,
    reason,
    ...(typeof accepted === "boolean" ? { accepted } : {}),
  };
}

export function evaluateAutonomyInteraction(request, {
  profile = "manual",
  allowedScopes = [],
  workspaceRoot = process.cwd(),
} = {}) {
  const normalizedProfile = normalizeAutonomyProfile(profile);
  const effectiveScopes = new Set(effectiveAutonomyScopes(normalizedProfile, allowedScopes));
  if (effectiveScopes.size === 0) {
    return { autoResolve: false, reason: "manual_profile" };
  }
  if (request?.containsSecret) {
    return { autoResolve: false, reason: "secret_input" };
  }
  if (request?.kind === INTERACTION_KINDS.QUESTIONS) {
    const response = effectiveScopes.has("explicit_continue_questions")
      ? affirmativeQuestionResponse(request)
      : null;
    if (response) {
      return {
        autoResolve: true,
        action: "submit",
        response,
        reason: "explicit_continue_question",
        scope: "explicit_continue_questions",
      };
    }
    return { autoResolve: false, reason: "answer_required" };
  }
  if (request?.kind === INTERACTION_KINDS.FORM) {
    return { autoResolve: false, reason: "form_values_required" };
  }
  if (request?.kind === INTERACTION_KINDS.URL) {
    return { autoResolve: false, reason: "external_authorization_required" };
  }
  if (request?.kind === INTERACTION_KINDS.CONFIRM) {
    if (!effectiveScopes.has("plan_continue")) {
      return { autoResolve: false, reason: "scope_not_allowed", scope: "plan_continue" };
    }
    return {
      autoResolve: true,
      action: "allow",
      response: { permission_mode: "default", auto_approved: true },
      reason: "continue_confirmation",
      scope: "plan_continue",
    };
  }
  if (request?.kind !== INTERACTION_KINDS.PERMISSION) {
    return { autoResolve: false, reason: "unsupported_interaction_kind" };
  }
  const permission = classifyPermissionScope(request, workspaceRoot);
  if (!permission.scope || !effectiveScopes.has(permission.scope)) {
    return {
      autoResolve: false,
      reason: permission.reason || "scope_not_allowed",
      scope: permission.scope,
    };
  }
  return {
    autoResolve: true,
    reason: permission.reason,
    scope: permission.scope,
    action: "allow",
    response: {
      remember_for_session: false,
      auto_approved: true,
      ...(request?.payload?.default_approval_option
        ? { approval_option: request.payload.default_approval_option }
        : {}),
    },
  };
}

export async function resolveWithAutonomy({
  request,
  profile,
  allowedScopes,
  workspaceRoot,
  requestInteraction,
  onAutoResolved,
  aiReviewer,
  aiReviewPolicy = null,
  runtime,
  approvalPolicy = null,
  stateDir = "",
}) {
  const normalizedProfile = normalizeAutonomyProfile(profile);
  if (normalizedProfile === "custom" && approvalPolicy) {
    const policyResult = evaluateApprovalRequest(request, approvalPolicy, {
      workspace: workspaceRoot,
      stateDir,
    });
    if (policyResult.effect === "ask") return requestInteraction(request);
    const action = policyResult.effect === "allow" ? "allow" : "deny";
    const resolved = {
      interactionId: request.interactionId,
      responseId: `policy:${request.interactionId}`,
      action,
      response: {
        remember_for_session: false,
        policy_evaluated: true,
        ...(action === "allow" && request?.payload?.default_approval_option
          ? { approval_option: request.payload.default_approval_option }
          : {}),
      },
      autoResolved: true,
      reason: `approval_policy_${policyResult.effect}`,
      scope: null,
      decisionSource: "approval_policy",
      policyEvaluation: {
        policyId: policyResult.policyId,
        revision: policyResult.revision,
        effect: policyResult.effect,
        actions: policyResult.atoms.map((atom) => atom.action),
        matchedRuleIds: [...new Set(policyResult.decisions.flatMap((decision) =>
          decision.matchedRules.map((rule) => rule.id)))],
        declarations: policyResult.declarations,
      },
    };
    await onAutoResolved?.({ request, resolved });
    return resolved;
  }
  if (normalizedProfile === "ai_review") {
    if (
      !aiReviewer
      || request?.containsSecret
      || [INTERACTION_KINDS.QUESTIONS, INTERACTION_KINDS.FORM, INTERACTION_KINDS.URL].includes(request?.kind)
    ) {
      return requestInteraction(request);
    }
    const classification = request?.kind === INTERACTION_KINDS.PERMISSION
      ? classifyPermissionScope(request, workspaceRoot)
      : { scope: request?.kind === INTERACTION_KINDS.CONFIRM ? "plan_continue" : null, reason: "unsupported_interaction_kind" };
    const policyScopes = new Set(
      aiReviewPolicy?.allowed_scopes || GUARDED_SCOPE_IDS,
    );
    const scopeAllowed = Boolean(
      classification.scope && policyScopes.has(classification.scope),
    );
    let review;
    try {
      review = await aiReviewer.review({
        request,
        classification,
        runtime,
        workspaceRoot,
        aiReviewPolicy,
      });
    } catch {
      return requestInteraction(request);
    }
    if (!review || !["allow", "deny", "escalate"].includes(review.decision)) {
      return requestInteraction(request);
    }
    const highRisk = AGENT_AUTONOMY_SCOPES.find((item) => item.id === classification.scope)?.risk === "high";
    if (
      review.decision === "escalate"
      || (review.decision === "allow" && (!scopeAllowed || highRisk || review.risk === "high"))
    ) {
      return requestInteraction(request);
    }
    const action = review.decision === "allow" ? "allow" : "deny";
    const resolved = {
      interactionId: request.interactionId,
      responseId: `ai:${request.interactionId}`,
      action,
      response: {
        remember_for_session: false,
        ai_reviewed: true,
        ...(action === "allow" && request?.payload?.default_approval_option
          ? { approval_option: request.payload.default_approval_option }
          : {}),
      },
      autoResolved: true,
      reason: review.reason || `ai_review_${review.decision}`,
      scope: classification.scope || null,
      decisionSource: "ai_reviewer",
      aiReview: {
        decision: review.decision,
        risk: review.risk,
        confidence: review.confidence,
        reviewer: review.reviewer,
        decisionMethod: review.decision_method,
        templateId: aiReviewPolicy?.template_id || null,
        templateVersion: aiReviewPolicy?.version ?? null,
        templateHash: aiReviewPolicy?.content_hash || null,
      },
    };
    await onAutoResolved?.({ request, resolved });
    return resolved;
  }
  const decision = evaluateAutonomyInteraction(request, {
    profile,
    allowedScopes,
    workspaceRoot,
  });
  if (!decision.autoResolve) return requestInteraction(request);
  const resolved = {
    interactionId: request.interactionId,
    responseId: `auto:${request.interactionId}`,
    action: decision.action,
    response: decision.response || {},
    autoResolved: true,
    reason: decision.reason,
    scope: decision.scope || null,
  };
  await onAutoResolved?.({ request, resolved });
  return resolved;
}
