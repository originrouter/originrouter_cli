import { redactDisplayText, redactDisplayValue } from "../security/displayRedaction.js";

const SENSITIVE_INTERACTION_FIELD = /token|secret|password|passphrase|api[_-]?key|authorization|cookie|credential/i;

function safeText(value, maxLength = 16_384) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function interactionQuestionsProjection(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.slice(0, 8).map((question, index) => ({
    id: safeText(question?.id, 128) || `q${index + 1}`,
    header: safeText(question?.header, 128) || "Question",
    question: redactDisplayText(question?.question, 2048),
    multiple: question?.multiple === true,
    allow_other: question?.allow_other !== false,
    requires_local_entry: question?.secret === true,
    options: Array.isArray(question?.options)
      ? question.options.slice(0, 16).map((option, optionIndex) => ({
          id: safeText(option?.id, 128) || `o${optionIndex + 1}`,
          label: redactDisplayText(option?.label, 256),
          description: redactDisplayText(option?.description, 1024),
        }))
      : [],
  }));
}

export function interactionFormFieldsProjection(schema) {
  const properties = schema?.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : []);
  return Object.entries(properties).slice(0, 32).map(([name, field]) => ({
    name: safeText(name, 128),
    label: safeText(field?.title, 256) || safeText(name, 128),
    description: redactDisplayText(field?.description, 1024),
    type: safeText(field?.type, 64) || "string",
    required: required.has(name),
    requires_local_entry: SENSITIVE_INTERACTION_FIELD.test(name) || field?.writeOnly || field?.format === "password",
    options: Array.isArray(field?.enum)
      ? field.enum.slice(0, 32).map((value) => redactDisplayText(value, 256))
      : [],
  }));
}

export function interactionApprovalOptionsProjection(options) {
  if (!Array.isArray(options)) return [];
  return options.slice(0, 16).map((option, index) => ({
    id: safeText(option?.id, 128) || `option-${index + 1}`,
    label: redactDisplayText(option?.label, 256),
  }));
}

export function attentionRequestProjection(request = {}) {
  const evidence = request?.payload && typeof request.payload === "object" ? request.payload : {};
  const preview = (value, maxLength = 4096) => {
    if (value == null || value === "") return null;
    if (typeof value === "string") return redactDisplayText(value, maxLength) || null;
    try {
      return redactDisplayText(JSON.stringify(redactDisplayValue(value)), maxLength) || null;
    } catch {
      return "[details unavailable]";
    }
  };
  return {
    kind: safeText(request.kind, 64) || "input",
    title: safeText(request.title, 512) || null,
    prompt: redactDisplayText(request.prompt, 2048) || null,
    tool: safeText(evidence.tool, 128) || null,
    display_name: safeText(evidence.display_name, 256) || null,
    blocked_path: safeText(evidence.blocked_path, 4096) || null,
    command: preview(evidence.command),
    cwd: safeText(evidence.cwd, 4096) || null,
    tool_input_preview: preview(evidence.tool_input),
    file_changes_preview: preview(evidence.file_changes),
    additional_permissions_preview: preview(evidence.additional_permissions),
    network_context_preview: preview(evidence.network_approval_context),
    questions: interactionQuestionsProjection(evidence.questions),
    form_fields: Array.isArray(evidence.form_fields) ? evidence.form_fields : [],
    url: safeText(evidence.url, 4096) || null,
    plan: redactDisplayText(evidence.plan, 65_536) || null,
    approval_options: interactionApprovalOptionsProjection(evidence.approval_options),
    contains_secret: request.containsSecret === true,
  };
}

export function interactionAttentionKind(kind) {
  if (kind === "permission") return "approval";
  if (["confirm", "questions", "form", "url"].includes(kind)) return kind;
  return "input";
}

export function interactionAttentionActions(kind, request = {}, containsSecret = false) {
  if (containsSecret && ["questions", "form"].includes(kind)) return ["cancel"];
  if (kind === "permission") {
    const options = request?.payload?.approval_options || request?.approval_options || [];
    if (Array.isArray(options) && options.length) {
      return [
        ...options.map((option) => `allow_option:${safeText(option?.id, 48)}`).filter((action) => action !== "allow_option:"),
        "deny",
      ];
    }
    return ["allow", "deny"];
  }
  if (kind === "confirm") return ["allow", "cancel"];
  return ["submit", "cancel"];
}

export function collaborationSnapshotSummary(snapshot) {
  if (!snapshot) return null;
  return {
    ...snapshot.run,
    schema_version: snapshot.schema_version,
    revision: snapshot.revision,
    last_sequence: snapshot.last_sequence,
    plan: snapshot.plan,
    tasks: snapshot.tasks,
    agents: Object.fromEntries(
      (snapshot.participants || []).map((participant) => [participant.participant_id, participant]),
    ),
    attention: snapshot.attention,
    artifacts: snapshot.artifacts,
    budget: snapshot.budget,
    usage: snapshot.usage,
    final_report: snapshot.final_report,
    capabilities: snapshot.capabilities,
  };
}
