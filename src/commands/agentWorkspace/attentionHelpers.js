import { listApprovalPolicies } from "../../runtime/approvalPolicyStore.js";
import { WORKSPACE_MODES } from "../../collaboration/workspaceModes.js";
import { workspaceInputSuggestions } from "../workspaceCommands.js";

export function workspaceEditorDevice(configuration, participant) {
  return configuration?._workspace_editor?.devices?.find(
    (device) => device.device_id === participant?.device_id,
  ) || null;
}

export function workspaceRuntimeOptions(configuration, participant) {
  return (workspaceEditorDevice(configuration, participant)?.runtimes || [])
    .map((runtime) => runtime.id)
    .filter((runtime) => ["codex", "claude"].includes(runtime));
}

export function workspaceRouteOptions(configuration, participant, selectedRuntime = participant?.runtime) {
  const device = workspaceEditorDevice(configuration, participant);
  if (!device) return [{ provider: null, model: null, label: "Use device default route" }];
  const configured = device.resolved_routes?.[selectedRuntime] || null;
  const options = [{
    provider: null,
    model: null,
    label: configured
      ? `Device default · ${configured.provider}/${configured.model}`
      : "Device native/default configuration",
  }];
  for (const provider of device.providers || []) {
    for (const model of provider.models || []) {
      if (!provider.name || !model.id) continue;
      options.push({
        provider: provider.name,
        model: model.id,
        label: `${provider.name}/${model.id}`,
      });
    }
  }
  return options;
}

export function workspacePermissionOptions(configuration, participant) {
  const supported = new Set(["manual", "guarded", "ai_review", "unrestricted", "custom"]);
  const current = String(participant?.permission_profile || "guarded");
  supported.add(current);
  const profiles = workspaceEditorDevice(configuration, participant)?.permission_profiles || [];
  const options = profiles.filter((profile) => supported.has(profile.id)).map((profile) => (
    profile.id === "custom"
      ? { ...profile, label: "Rules", description: "Use the built-in protected rule policy.", policyId: "protected" }
      : profile
  ));
  if (options.length) return options;
  return [
    { id: "manual", label: "Manual", description: "Ask before every blocking action." },
    { id: "guarded", label: "Guarded", description: "Allow routine work; ask for elevated or uncertain actions." },
    { id: "unrestricted", label: "Full", description: "Allow permission prompts for this managed Agent." },
    { id: "ai_review", label: "AI Review", description: "Use an independent reviewer; uncertain or high-risk actions still ask." },
    { id: "custom", label: "Rules", description: "Use the built-in protected rule policy.", policyId: "protected" },
  ];
}

export function sessionPermissionOptions({ includePolicies = false } = {}) {
  const options = [
    { id: "manual", label: "Manual", description: "Ask before every child Agent permission." },
    { id: "guarded", label: "Guarded", description: "Approve routine work and ask for elevated or uncertain actions." },
    { id: "ai_review", label: "AI Review", description: "Use an independent reviewer and escalate high-risk or uncertain actions." },
    { id: "custom", label: "Rules", description: "Use the built-in protected rule policy.", policyId: "protected" },
    { id: "unrestricted", label: "Full", description: "Add no restriction beyond each Agent's own access limit." },
  ];
  if (!includePolicies) return options;
  for (const policy of listApprovalPolicies()) {
    if (!policy?.id || policy.id === "protected" || policy.source === "invalid") continue;
    options.splice(options.length - 1, 0, {
      id: "custom",
      policyId: policy.id,
      label: `Rules · ${policy.name || policy.id}`,
      description: policy.description || `Use approval policy ${policy.id}.`,
    });
  }
  return options;
}

export function workspaceCommandCompletionContext({
  approvalOptions = sessionPermissionOptions({ includePolicies: true }),
  runIds = [],
  sessionIds = [],
} = {}) {
  return {
    modeOptions: WORKSPACE_MODES.map((mode) => ({
      value: mode.id,
      description: mode.description,
    })),
    approvalOptions: approvalOptions.map((option) => ({
      value: option.id === "custom"
        ? `custom:${option.policyId || "protected"}`
        : option.id,
      description: option.description,
    })),
    runIds,
    sessionIds,
  };
}

export function commandSuggestionsForInput(buffer, context, { limit = 6, dismissed = false } = {}) {
  if (dismissed) return [];
  return workspaceInputSuggestions(buffer, { ...context, limit });
}

export function permissionLabel(value, policyId = "") {
  if (value === "custom" && policyId && policyId !== "protected") return `Rules · ${policyId}`;
  return sessionPermissionOptions().find((option) => option.id === value)?.label || "Guarded";
}

export function samePermissionOption(option, profile, policyId = "") {
  return option.id === profile
    && (option.id !== "custom" || (option.policyId || "protected") === (policyId || "protected"));
}

export function nextSessionPermission(profile, policyId = "") {
  const options = sessionPermissionOptions();
  const current = options.findIndex((option) => samePermissionOption(option, profile, policyId));
  return options[(current + 1 + options.length) % options.length];
}

export function resolveSessionPermission(value) {
  const requested = String(value || "").trim().toLowerCase();
  if (!requested) return null;
  const aliases = new Map([
    ["ask", "manual"],
    ["ai", "ai_review"],
    ["review", "ai_review"],
    ["rules", "custom:protected"],
    ["protected", "custom:protected"],
    ["full", "unrestricted"],
  ]);
  const normalized = aliases.get(requested) || requested;
  const options = sessionPermissionOptions({ includePolicies: true });
  if (normalized.startsWith("custom:") || normalized.startsWith("rules:")) {
    const policyId = normalized.slice(normalized.indexOf(":") + 1);
    return options.find((option) => option.id === "custom" && option.policyId === policyId) || null;
  }
  return options.find((option) => (
    option.id === normalized
    || option.policyId?.toLowerCase() === normalized
    || option.label.toLowerCase() === normalized
  )) || null;
}

export function participantRouteLabel(configuration, participant) {
  if (participant?.provider && participant?.model) return `${participant.provider}/${participant.model}`;
  return workspaceRouteOptions(configuration, participant, participant?.runtime)[0]?.label || "Device default route";
}

export function runtimeDisplayName(runtime) {
  return runtime === "claude" ? "Claude Code" : "Codex";
}

export function attentionRequestKind(attention) {
  return String(attention?.payload?.kind || attention?.payload?.request?.kind || attention?.kind || "input");
}

export function attentionNeedsTypedResponse(attention) {
  const request = attention?.payload?.request || {};
  const kind = attentionRequestKind(attention);
  if (kind === "questions") return (request.questions || []).some((question) => !question.requires_local_entry);
  if (kind === "form") return (request.form_fields || []).some((field) => !field.requires_local_entry);
  return kind === "input";
}

export function attentionActionLabel(action, attention = null) {
  const kind = attentionRequestKind(attention);
  if (String(action).startsWith("allow_option:")) {
    const id = String(action).slice("allow_option:".length);
    const option = (attention?.payload?.request?.approval_options || [])
      .find((candidate) => candidate.id === id);
    return option?.label || "Allow with selected option";
  }
  if (action === "allow" && kind === "confirm") return "Continue";
  if (action === "submit" && kind === "questions") return "Answer questions";
  if (action === "submit" && kind === "form") return "Submit form";
  if (action === "submit" && kind === "url") return "Continue after authorization";
  return {
    allow: "Allow once",
    deny: "Deny",
    submit: "Reply",
    cancel: "Cancel",
    rebuild: "Rebuild this Agent",
    confirm_team_change: "Confirm Team change",
    reject_team_change: "Keep current Team",
  }[action] || String(action || "").replaceAll("_", " ");
}

export function attentionReplyPrompt(attention) {
  const kind = attentionRequestKind(attention);
  if (kind === "questions") {
    const questions = (attention?.payload?.request?.questions || [])
      .filter((question) => !question.requires_local_entry);
    if (questions.length === 1) return "Enter an answer, or a JSON object keyed by question ID";
    return "Enter a JSON object keyed by question ID";
  }
  if (kind === "form") return "Enter a JSON object containing the form fields";
  return "Reply to the Agent";
}

export function attentionResponseFromText(attention, text) {
  const reply = String(text || "").trim();
  const request = attention?.payload?.request || {};
  const kind = attentionRequestKind(attention);
  if (kind === "questions") {
    const questions = (request.questions || []).filter((question) => !question.requires_local_entry);
    if (!questions.length) return { answers: {} };
    let values;
    if (questions.length === 1 && !reply.startsWith("{")) {
      values = { [questions[0].id]: reply };
    } else {
      try { values = JSON.parse(reply); } catch {
        throw new Error("Enter valid JSON keyed by question ID");
      }
    }
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Answers must be a JSON object keyed by question ID");
    }
    const allowed = new Set(questions.map((question) => question.id));
    const answers = {};
    for (const [id, value] of Object.entries(values)) {
      if (!allowed.has(id)) throw new Error(`Unknown question ID: ${id}`);
      answers[id] = (Array.isArray(value) ? value : [value]).map(String);
    }
    return { answers };
  }
  if (kind === "form") {
    let values;
    try { values = JSON.parse(reply); } catch {
      throw new Error("Enter valid JSON containing the form fields");
    }
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Form values must be a JSON object");
    }
    const fields = (request.form_fields || []).filter((field) => !field.requires_local_entry);
    const allowed = new Set(fields.map((field) => field.name));
    for (const name of Object.keys(values)) {
      if (!allowed.has(name)) throw new Error(`Unknown form field: ${name}`);
    }
    const missing = fields.find((field) => field.required && values[field.name] == null);
    if (missing) throw new Error(`Enter a value for ${missing.label || missing.name}`);
    return { values };
  }
  return { text: reply };
}

export function attentionParticipantLabel(attention, runtime) {
  const participantId = attention?.participant_id;
  const participant = [
    ...(runtime.configuration?.participants || []),
    ...(runtime.snapshot?.participants || []),
  ].find((item) => item.participant_id === participantId);
  return participant?.display_name || participantId || "Agent";
}

export function attentionTaskLabel(attention, runtime) {
  const taskId = attention?.task_id;
  const task = (runtime.snapshot?.tasks || []).find((item) => (
    item.task_id === taskId || item.task_key === taskId || item.id === taskId
  ));
  return task?.title || task?.task_key || "";
}

export function attentionReasonLabel(reason) {
  return {
    user_confirmation_required: "The active policy requires a person to decide this request.",
    supervisor_evaluation_failed: "The automatic policy check could not complete safely.",
  }[reason] || String(reason || "").replaceAll("_", " ");
}

export function attentionPolicyLayerLabel(layer = {}) {
  const owner = layer.name === "session" ? "Session approval" : "Agent access limit";
  const effect = layer.effect === "ask" ? "asks you"
    : layer.effect === "deny" ? "denies" : "allows";
  return `${owner}: ${permissionLabel(layer.profile || "manual")} · ${effect}`;
}

export function attentionRequestContext(attention, runtime) {
  const request = attention?.payload?.request || {};
  const evaluation = attention?.payload?.supervisor_evaluation || {};
  const participant = attentionParticipantLabel(attention, runtime);
  const task = attentionTaskLabel(attention, runtime);
  const currentProfile = runtime.sessionApprovalOverride?.profile
    || runtime.snapshot?.run?.supervisor_permission_profile
    || runtime.configuration?.supervisor_permission_profile
    || "guarded";
  const currentPolicyId = runtime.sessionApprovalOverride?.policyId
    || runtime.snapshot?.run?.supervisor_policy_id
    || runtime.configuration?.supervisor_policy_id
    || "";
  const requestedProfile = evaluation.session_profile || currentProfile;
  const requestedPolicyId = evaluation.session_policy_id || "";
  const lines = [];
  if (attention?.kind === "team_change") {
    const before = attention.payload?.before || null;
    const after = attention.payload?.after || null;
    lines.push({
      label: "Team revision",
      value: `${attention.payload?.current_revision || "?"} → ${attention.payload?.proposed_revision || "?"}`,
    });
    lines.push({ label: "Operation", value: attention.payload?.operation || "change" });
    lines.push({ label: "Participant", value: attention.payload?.participant_id || "unknown" });
    if (before) {
      lines.push({
        label: "Current binding",
        value: `${before.runtime} · ${before.device_id} · ${before.workspace_id || "default workspace"} · ${before.permission_profile || "guarded"}`,
      });
    }
    if (after) {
      lines.push({
        label: "Proposed binding",
        value: `${after.runtime} · ${after.device_id} · ${after.workspace_id || "default workspace"} · ${after.permission_profile || "guarded"}`,
      });
    }
    if (attention.payload?.reason) lines.push({ label: "Reason", value: attention.payload.reason });
    return lines;
  }
  lines.push({ label: "Requested by", value: task ? `${participant} · ${task}` : participant });
  if (request.display_name || request.tool) {
    lines.push({ label: "Action", value: request.display_name || request.tool });
  }
  if (request.command) lines.push({ label: "Command", value: request.command, code: true });
  if (request.cwd) lines.push({ label: "Working directory", value: request.cwd, code: true });
  if (request.blocked_path) lines.push({ label: "Path", value: request.blocked_path, code: true });
  if (request.file_changes_preview) lines.push({ label: "File changes", value: request.file_changes_preview });
  if (request.additional_permissions_preview) {
    lines.push({ label: "Additional access", value: request.additional_permissions_preview });
  }
  if (request.network_context_preview) lines.push({ label: "Network access", value: request.network_context_preview });
  if (request.tool_input_preview && !request.command) {
    lines.push({ label: "Input", value: request.tool_input_preview, code: true });
  }
  for (const question of request.questions || []) {
    const options = (question.options || []).map((option) => option.label).filter(Boolean);
    lines.push({
      label: question.header || question.id || "Question",
      value: question.requires_local_entry
        ? "Sensitive answer required on the executing device"
        : `${question.question || "Answer required"}${options.length ? ` (${options.join(" / ")})` : ""}`,
    });
  }
  for (const field of request.form_fields || []) {
    const options = (field.options || []).join(" / ");
    lines.push({
      label: field.label || field.name || "Field",
      value: field.requires_local_entry
        ? "Sensitive value required on the executing device"
        : `${field.type || "string"}${field.required ? " · required" : ""}${options ? ` (${options})` : ""}${field.description ? ` · ${field.description}` : ""}`,
    });
  }
  if (request.url) lines.push({ label: "Authorization URL", value: request.url, code: true });
  if (request.plan) lines.push({ label: "Plan", value: request.plan });
  if (attention?.kind === "approval" && attention?.title && attention.title !== request.prompt) {
    lines.push({ label: "Request", value: attention.title });
  }
  const prompt = request.prompt || attention?.title || attention?.summary || "";
  if (prompt) lines.push({ label: attention?.kind === "approval" ? "Reason" : "Request", value: prompt });
  for (const layer of evaluation.layers || []) {
    lines.push({ label: "Policy", value: attentionPolicyLayerLabel(layer) });
  }
  if (evaluation.reason) {
    lines.push({ label: "Why you are seeing this", value: attentionReasonLabel(evaluation.reason) });
  }
  const requestedLabel = permissionLabel(requestedProfile, requestedPolicyId);
  const currentLabel = permissionLabel(currentProfile, currentPolicyId);
  lines.push({ label: "Session approval", value: currentLabel });
  if (requestedLabel !== currentLabel) {
    lines.push({
      label: "Pending request",
      value: `Evaluated under ${requestedLabel}. The new policy applies to later requests; this decision remains yours.`,
    });
  }
  return lines.filter((item) => item.value);
}
