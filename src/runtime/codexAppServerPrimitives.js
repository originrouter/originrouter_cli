import { REMOTE_INTERACTION_DECISION_TIMEOUT_MS } from "../adapters/codex/appServerClient.js";

const CODEX_MODES = Object.freeze([
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
]);

const codexApprovalExpiresAt = () =>
  Math.ceil((Date.now() + REMOTE_INTERACTION_DECISION_TIMEOUT_MS) / 1000);

export function createSerialAgentEventQueue(handler) {
  let tail = Promise.resolve();
  return {
    enqueue(event) {
      tail = tail.then(() => handler(event)).catch(() => {});
      return tail;
    },
    drain() {
      return tail;
    },
  };
}

export function buildCodexCollaborationMode(mode, model) {
  const resolvedModel = String(model || "").trim();
  if (!resolvedModel) {
    throw new Error("Codex collaboration mode requires a resolved model.");
  }
  return {
    mode,
    settings: {
      model: resolvedModel,
      reasoning_effort: null,
      developer_instructions: null,
    },
  };
}

function extractOptions(args) {
  const options = {};
  const prompt = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const take = (key) => {
      options[key] = args[index + 1];
      index += 1;
    };
    if (arg === "--originrouter-relay") take("relay");
    else if (arg === "--originrouter-relay-mode") take("relayMode");
    else if (arg === "--originrouter-device") take("device");
    else if (arg === "--originrouter-session") take("session");
    else if (arg === "--originrouter-conversation") take("conversationId");
    else if (arg === "--originrouter-run") take("runId");
    else if (arg === "--originrouter-task") take("taskId");
    else if (arg === "--originrouter-telemetry-owner") take("telemetryOwner");
    else if (arg === "--originrouter-workspace") take("workspaceId");
    else if (arg === "--originrouter-title") take("title");
    else if (arg === "--provider") take("provider");
    else if (arg === "--model" || arg === "-m") take("model");
    else if (arg === "--prompt") take("initialMessage");
    else if (arg === "--resume") take("resume");
    else if (arg.startsWith("--resume=")) {
      options.resume = arg.slice("--resume=".length);
    } else if (arg === "--originrouter-autonomy") take("autonomyProfile");
    else if (arg === "--originrouter-policy") take("approvalPolicyReference");
    else if (arg === "--originrouter-detail") take("detailProfile");
    else if (arg === "--originrouter-auto-approve")
      options.autonomyProfile = "guarded";
    else if (arg === "--originrouter-auto-allow") {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...String(args[index + 1] || "").split(","),
      ];
      index += 1;
    } else if (arg.startsWith("--originrouter-autonomy=")) {
      options.autonomyProfile = arg.slice("--originrouter-autonomy=".length);
    } else if (arg.startsWith("--originrouter-detail=")) {
      options.detailProfile = arg.slice("--originrouter-detail=".length);
    } else if (arg.startsWith("--originrouter-auto-allow=")) {
      options.autonomyAllowedScopes = [
        ...(options.autonomyAllowedScopes || []),
        ...arg.slice("--originrouter-auto-allow=".length).split(","),
      ];
    } else if (!arg.startsWith("-")) prompt.push(arg);
  }
  if (!options.initialMessage && prompt.length)
    options.initialMessage = prompt.join(" ");
  return options;
}

function textInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

// Codex's turn/start result is provider-owned data. Keep only explicitly
// named response identifiers; turn/thread/item ids are local app-server ids
// and must never be presented as gateway response ids.
export function gatewayResponseIdsFromTurnResult(result = {}) {
  const values = [
    result?.gateway_response_id,
    result?.gatewayResponseId,
    result?.response_id,
    result?.responseId,
    result?.response?.id,
    result?.response?.response_id,
    result?.turn?.gateway_response_id,
    result?.turn?.gatewayResponseId,
    result?.turn?.response_id,
    result?.turn?.responseId,
    result?.turn?.response?.id,
    result?.turn?.response?.response_id,
  ];
  return [...new Set(values
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().slice(0, 255)))];
}

function requestInteractionId(method, params, id) {
  return String(params?.itemId || params?.elicitationId || `${method}:${id}`);
}

export function codexQuestions(params) {
  return {
    questions: (Array.isArray(params?.questions) ? params.questions : [])
      .slice(0, 8)
      .map((question, index) => ({
        id: String(question?.id || `q${index + 1}`).slice(0, 128),
        header: String(question?.header || "Question").slice(0, 64),
        question: String(question?.question || "").slice(0, 2048),
        multiple: Boolean(question?.multiSelect || question?.multiple),
        allow_other: question?.allowOther !== false,
        secret: Boolean(question?.isSecret),
        options: (Array.isArray(question?.options) ? question.options : [])
          .slice(0, 16)
          .map((option, index) => ({
            id: `o${index + 1}`,
            label: String(option?.label || "").slice(0, 128),
            description: String(option?.description || "").slice(0, 512),
          })),
      })),
    auto_resolution_ms: Number.isFinite(params?.autoResolutionMs)
      ? params.autoResolutionMs
      : null,
  };
}

export function codexQuestionResponse(params, response) {
  const answers =
    response?.answers && typeof response.answers === "object"
      ? response.answers
      : {};
  const mapped = {};
  (Array.isArray(params?.questions) ? params.questions : []).forEach(
    (question, index) => {
      const id = String(question?.id || `q${index + 1}`);
      const raw = answers[id];
      mapped[id] = {
        answers: (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(
          String,
        ),
      };
    },
  );
  return { answers: mapped };
}

function decisionFor(action, remember) {
  if (action === "allow" || action === "submit")
    return remember ? "acceptForSession" : "accept";
  if (action === "cancel") return "cancel";
  return "decline";
}

function codexDecisionLabel(decision) {
  if (decision === "accept") return "Allow once";
  if (decision === "acceptForSession") return "Allow for this session";
  if (decision?.acceptWithExecpolicyAmendment)
    return "Allow and apply the suggested command rule";
  if (decision?.applyNetworkPolicyAmendment)
    return "Apply the suggested network rule";
  return null;
}

export function codexCommandApprovalPresentation(params = {}) {
  const available = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : null;
  if (!available) {
    return {
      remember_allowed: true,
      approval_options: undefined,
      default_approval_option: undefined,
    };
  }
  const approvalOptions = available.flatMap((decision, index) => {
    const label = codexDecisionLabel(decision);
    return label ? [{ id: `decision-${index}`, label }] : [];
  });
  return {
    remember_allowed: false,
    approval_options: approvalOptions,
    default_approval_option: approvalOptions[0]?.id,
  };
}

export function codexCommandApprovalDecision(params = {}, resolved = {}) {
  if (resolved.action === "cancel") return "cancel";
  if (resolved.action !== "allow" && resolved.action !== "submit")
    return "decline";
  const available = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : null;
  if (!available) {
    return decisionFor(
      resolved.action,
      Boolean(resolved.response?.remember_for_session),
    );
  }
  const selected = String(resolved.response?.approval_option || "");
  const selectedIndex = /^decision-(\d+)$/.exec(selected)?.[1];
  const decision =
    selectedIndex == null ? null : available[Number(selectedIndex)];
  if (codexDecisionLabel(decision)) return decision;
  return available.find((item) => item === "accept") || "decline";
}

function containsSecretSchema(schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.writeOnly || schema.format === "password") return true;
  return Object.values(schema).some(containsSecretSchema);
}

export {
  CODEX_MODES,
  codexApprovalExpiresAt,
  containsSecretSchema,
  decisionFor,
  extractOptions,
  requestInteractionId,
  textInput,
};
