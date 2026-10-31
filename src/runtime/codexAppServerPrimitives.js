import {
  agentInteractionExpiresAt,
  agentInteractionTimeoutMsFromConfig,
} from "../config/agentInteractionTimeout.js";
import { readConfig } from "../persistence/state.js";

const CODEX_MODES = Object.freeze([
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
]);

// Read per request rather than captured once at import: `originrouter config
// set agent.interactionTimeoutMs` should take effect on the next approval
// without a daemon restart, and this is called a handful of times a turn.
const codexApprovalExpiresAt = (config = readConfig()) =>
  agentInteractionExpiresAt(agentInteractionTimeoutMsFromConfig(config));

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

// The permission surface Codex is allowed to reach, and who owns each decision.
//
// OriginRouter is the approval authority for a managed session: every action
// that is not pre-approved must become a request that travels to our broker and
// then to the App. Three independent knobs decide whether that happens, and any
// one of them left on a permissive default silently takes the request away:
//
//   approvalPolicy     — which actions become a request at all
//   approvalsReviewer  — who is asked; anything but "user" routes to Codex's
//                        own Guardian subagent, which decides without us
//   sandboxPolicy      — what a command may do before a request is generated
//
// "on-request" + "workspace-write" is the floor that still keeps a session
// usable: routine workspace work runs inside the sandbox, and anything that
// needs an escape (network, out-of-workspace writes, dangerous commands) is
// asked. "read-only" would turn every file edit into a prompt, and "untrusted"
// is rejected by Codex's config layer as an explicit value, so neither is a
// candidate for the default.
//
// These values have to be sent on *every* request that can change them
// (`thread/start`, `thread/resume`, `thread/settings/update`, `turn/start`),
// for two separate reasons:
//
//   1. The protocol documents all of these as "for this turn and subsequent
//      turns", so a later request that omits them inherits whatever the last
//      one set. The client that does not re-pin is trusting its own history.
//   2. `core/src/session/step_settings.rs` escalates an omitted
//      `approvals_reviewer` to `AutoReview` on its own when the selected model
//      requires auto-review and the collaboration mode's model changes. That is
//      a silent Guardian takeover: the request would never reach us.
//
// The explicit `sandboxPolicy` object (rather than Codex's `sandbox` mode
// string) is what turn-level updates take. Every field is spelled out even
// though all of them are `#[serde(default)]`, because a default that changes
// upstream would otherwise change what the user has allowed.
const CODEX_APPROVALS_REVIEWER = "user";
const CODEX_APPROVAL_POLICY = "on-request";
const CODEX_SANDBOX_POLICY = Object.freeze({
  type: "workspaceWrite",
  writableRoots: Object.freeze([]),
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});

// Thread-level shape: `thread/start` and `thread/resume` take the `SandboxMode`
// string in `sandbox`, not the tagged policy object.
export function codexThreadPermissionPin() {
  return {
    approvalPolicy: CODEX_APPROVAL_POLICY,
    approvalsReviewer: CODEX_APPROVALS_REVIEWER,
    sandbox: "workspace-write",
  };
}

// Turn-level shape used by `turn/start` and `thread/settings/update`. Both take
// `sandboxPolicy` (camelCase tagged union) rather than the `sandbox` string.
export function codexTurnPermissionPin() {
  return {
    approvalPolicy: CODEX_APPROVAL_POLICY,
    approvalsReviewer: CODEX_APPROVALS_REVIEWER,
    sandboxPolicy: {
      type: CODEX_SANDBOX_POLICY.type,
      writableRoots: [...CODEX_SANDBOX_POLICY.writableRoots],
      networkAccess: CODEX_SANDBOX_POLICY.networkAccess,
      excludeTmpdirEnvVar: CODEX_SANDBOX_POLICY.excludeTmpdirEnvVar,
      excludeSlashTmp: CODEX_SANDBOX_POLICY.excludeSlashTmp,
    },
  };
}

// The permission pin an unattended profile asks the thread for.
//
// There is no autonomy-specific shape: every profile asks for the same pin. See
// `withCodexTurnPermission` below for why widening it would be wrong.
export function codexAutonomyPermissionPin() {
  return codexTurnPermissionPin();
}

// Launch flags that hand a Codex session's approvals to someone other than the
// OriginRouter broker. Each one is a documented, one-flag bypass:
//
//   --approve-for-me / --not-so-yolo
//       injects `approvals_reviewer="auto_review"` + `approval_policy=on-request`
//       + `sandbox_mode=workspace-write`, i.e. a Guardian subagent reviews every
//       request and the App never sees one.
//   --dangerously-bypass-approvals-and-sandbox / --yolo
//       no approval at all and no sandbox.
//   --dangerously-bypass-hook-trust
//       runs hooks that were never trusted, which removes the one remaining
//       place a session can be observed.
//
// Matching is on the flag name only, so `--yolo=1`-style spellings are caught
// too; a value is never expected but rejecting it is still correct, because
// there is no safe interpretation of the flag.
const CODEX_BYPASS_FLAGS = Object.freeze([
  "approve-for-me",
  "not-so-yolo",
  "dangerously-bypass-approvals-and-sandbox",
  "dangerously-bypass-hook-trust",
  "yolo",
]);

export function codexBypassFlagIn(args = []) {
  for (const arg of args) {
    const value = String(arg || "");
    if (!value.startsWith("--")) continue;
    const name = value.slice(2).split("=")[0].toLowerCase();
    if (CODEX_BYPASS_FLAGS.includes(name)) return `--${name}`;
  }
  return null;
}

// The pin applied to a request, rather than a value to copy into one.
//
// The pin wins over anything the caller passed, deliberately. These are the
// three fields that decide whether an escalation reaches the App, and every
// call site that set them by hand would be a place where one of them can be
// dropped — the `turn/start` docs make an omitted field inherit the previous
// turn's value, so a single call site that forgets `approvalsReviewer` hands
// the rest of the session to Codex's Guardian subagent. Routing every request
// through one function leaves exactly one way to build it.
export function withCodexThreadPermission(params = {}) {
  return { ...params, ...codexThreadPermissionPin() };
}

// Also the pin an unattended autonomy profile asks the thread for — there is no
// second shape, and that is the decision rather than an omission.
//
// An OriginRouter autonomy profile answers "who decides once a request reaches
// us": manual shows it, guarded and custom apply their own rules, ai_review
// hands it to our reviewer, unrestricted auto-approves it. None of that is a
// Codex setting, and pushing it down as one would remove the request instead of
// answering it:
//
//   profile → approvalPolicy "never"           = Codex never asks, broker is blind
//   profile → approvalsReviewer "auto_review"  = Codex's Guardian answers, the App
//                                                sees nothing and our policy is
//                                                never consulted
//   profile → sandbox "danger-full-access"     = the sandbox stops generating
//                                                escapes, so the escalations
//                                                "unrestricted" used to approve
//                                                stop existing — and stop being
//                                                audited
//
// `unrestricted` already works through the broker: Codex raises an escalation,
// the broker allows it, and the grant is on the wire for the App to see.
// Widening the sandbox would produce the same actions with none of that.
//
// `agent.autonomy.set` therefore changes only local state, and still pushes this
// pin: it makes the thread match the profile we just reported, and repairs a
// thread whose settings were written by an older client.
export function withCodexTurnPermission(params = {}) {
  return { ...params, ...codexTurnPermissionPin() };
}

export function assertNoCodexBypassFlag(args = []) {
  const flag = codexBypassFlagIn(args);
  if (!flag) return;
  const error = new Error(
    `${flag} would take approval away from OriginRouter, so this session `
    + "cannot start with it. Use the permission control in the App instead.",
  );
  error.code = "CODEX_PERMISSION_BYPASS_FLAG";
  // `bin/originrouter.js` turns a non-zero exit code into the process status,
  // and 64 is sysexits' EX_USAGE: the invocation, not the runtime, is wrong.
  error.exitCode = 64;
  throw error;
}

// The collaboration mode a Codex thread runs under.
//
// The reasoning level rides **inside** the mode, not beside it. The
// app-server gives a collaboration mode precedence over the request's own
// `effort` — and it replaces the mode's settings wholesale rather than
// merging them (codex-rs/core/src/session/step_settings.rs: `apply` takes
// `update.collaboration_mode` when it is set, and only otherwise folds
// `update.effort` into the mode it already had). A mode that left the
// effort out would therefore clear the level the reader chose, and a
// request that sent `effort` beside a mode would have it dropped.
//
// Codex's own TUI keeps the level in the same place for the same reason.
export function buildCodexCollaborationMode(mode, model, effort = null) {
  const resolvedModel = String(model || "").trim();
  if (!resolvedModel) {
    throw new Error("Codex collaboration mode requires a resolved model.");
  }
  const resolvedEffort = String(effort || "").trim();
  return {
    mode,
    settings: {
      model: resolvedModel,
      reasoning_effort: resolvedEffort || null,
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
    else if (arg === "--originrouter-session-kind") take("sessionKind");
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
