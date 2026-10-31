// Runtime tasks: the cards a user turns on to have the daemon watch a running
// Agent and step in at three fixed moments (docs/runtime-tasks.md in the App
// repo). This module is pure: card validation, error classification and the
// built-in judges. The engine that applies them is runtimeSupervisor.js.

export const RUNTIME_TASK_CHECKPOINTS = Object.freeze(["turn_ended", "abnormal_stop", "idle"]);
export const RUNTIME_TASK_BUILTIN_RULES = Object.freeze(["retryable_error", "empty_reply", "always"]);
export const RUNTIME_TASK_ACTIONS = Object.freeze(["send", "notify", "stop"]);
export const RUNTIME_TASK_TEMPLATES = Object.freeze([
  "auto_continue_on_error",
  "continue_empty_reply",
  "idle_reminder",
  "dont_stop_to_ask",
  "completion_check",
]);
export const RUNTIME_TASK_ERROR_CLASSES = Object.freeze([
  "overloaded", "rate_limited", "server_error", "network", "auth", "max_tokens", "other",
]);

const RETRYABLE = new Set(["overloaded", "rate_limited", "server_error", "network"]);
const AGENTS = new Set(["claude", "codex"]);
// Which checkpoints a built-in rule can be true at. A card that pairs a rule
// with a checkpoint where it can never hold is a mistake the editor should
// hear about, not a card that silently never fires.
const RULE_CHECKPOINTS = {
  retryable_error: new Set(["abnormal_stop"]),
  empty_reply: new Set(["turn_ended", "abnormal_stop"]),
  always: new Set(RUNTIME_TASK_CHECKPOINTS),
};

export const MAX_RUNTIME_TASK_CARDS = 32;
export const RETRY_BACKOFF_SECONDS = Object.freeze([30, 60, 120, 240, 480]);
// A rate limit that names its reset can be hours away (Claude's five-hour
// window). Waiting for it is the point; the cap only stops a bogus timestamp
// from parking a timer for days.
const MAX_RETRY_AFTER_SECONDS = 6 * 60 * 60;

function text(value, max) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, "").trim().slice(0, max);
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_RUNTIME_TASK" });
}

function boundedInt(value, { min, max, fallback, field }) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function oneOf(value, allowed, field) {
  const item = text(value, 64);
  if (!allowed.includes(item)) throw invalid(`${field} must be one of ${allowed.join(", ")}`);
  return item;
}

export function normalizeRuntimeTaskCard(input, { aiJudgeAvailable = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("card must be an object");
  const id = text(input.id, 64);
  if (!/^rt_[A-Za-z0-9_-]{1,61}$/.test(id)) throw invalid("card id must look like rt_<id>");
  const name = text(input.name, 64);
  if (!name) throw invalid("card name is required");
  const template = input.template == null || input.template === ""
    ? null
    : oneOf(input.template, RUNTIME_TASK_TEMPLATES, "template");

  const scopeInput = input.scope && typeof input.scope === "object" ? input.scope : {};
  const agents = Array.isArray(scopeInput.agents) ? [...new Set(scopeInput.agents.map((a) => text(a, 16)))] : [];
  if (agents.some((agent) => !AGENTS.has(agent))) throw invalid("scope.agents may only name claude or codex");
  const workspaces = Array.isArray(scopeInput.workspaces)
    ? [...new Set(scopeInput.workspaces.map((w) => text(w, 1024)).filter(Boolean))]
    : [];
  if (workspaces.length > 16) throw invalid("scope.workspaces holds at most 16 paths");

  const checkpoints = Array.isArray(input.checkpoints)
    ? [...new Set(input.checkpoints.map((c) => oneOf(c, RUNTIME_TASK_CHECKPOINTS, "checkpoints")))]
    : [];
  if (checkpoints.length === 0) throw invalid("a card needs at least one checkpoint");
  const idleMinutes = boundedInt(input.idleMinutes, { min: 5, max: 1440, fallback: 30, field: "idleMinutes" });

  const judgeInput = input.judge && typeof input.judge === "object" ? input.judge : {};
  const judgeKind = oneOf(judgeInput.kind, ["builtin", "ai"], "judge.kind");
  let judge;
  if (judgeKind === "builtin") {
    const rule = oneOf(judgeInput.rule, RUNTIME_TASK_BUILTIN_RULES, "judge.rule");
    const reachable = RULE_CHECKPOINTS[rule];
    if (!checkpoints.every((checkpoint) => reachable.has(checkpoint))) {
      throw invalid(`judge rule ${rule} only applies at ${[...reachable].join(", ")}`);
    }
    judge = { kind: "builtin", rule };
  } else {
    if (!aiJudgeAvailable) {
      throw Object.assign(new Error("AI judgement is not available on this device yet"), {
        code: "AI_JUDGE_UNAVAILABLE",
      });
    }
    const instruction = text(judgeInput.instruction, 1000);
    if (!instruction) throw invalid("judge.instruction is required for an AI judge");
    judge = { kind: "ai", instruction };
  }

  const actionInput = input.action && typeof input.action === "object" ? input.action : {};
  const actionKind = oneOf(actionInput.kind, RUNTIME_TASK_ACTIONS, "action.kind");
  let action;
  if (actionKind === "send") {
    // A message sent while the Agent is still running would have to
    // interrupt it first; that path is not built, so idle cards cannot send.
    if (checkpoints.includes("idle")) throw invalid("an idle card can only notify or stop");
    const message = text(actionInput.message, 2000);
    if (!message) throw invalid("action.message is required");
    action = { kind: "send", message };
  } else {
    action = { kind: actionKind };
  }

  const limitsInput = input.limits && typeof input.limits === "object" ? input.limits : {};
  const limits = {
    maxFires: boundedInt(limitsInput.maxFires, { min: 1, max: 20, fallback: 5, field: "limits.maxFires" }),
    cooldownSeconds: boundedInt(limitsInput.cooldownSeconds, {
      min: 0, max: 3600, fallback: 30, field: "limits.cooldownSeconds",
    }),
    onExhausted: limitsInput.onExhausted == null
      ? "notify"
      : oneOf(limitsInput.onExhausted, ["notify", "nothing"], "limits.onExhausted"),
  };

  return {
    id,
    name,
    enabled: input.enabled !== false,
    template,
    scope: { agents, workspaces },
    checkpoints,
    idleMinutes,
    judge,
    action,
    limits,
  };
}

export function normalizeRuntimeTaskCards(input, options = {}) {
  if (!Array.isArray(input)) throw invalid("cards must be a list");
  if (input.length > MAX_RUNTIME_TASK_CARDS) throw invalid(`at most ${MAX_RUNTIME_TASK_CARDS} cards`);
  const cards = input.map((card) => normalizeRuntimeTaskCard(card, options));
  const ids = new Set();
  for (const card of cards) {
    if (ids.has(card.id)) throw invalid(`duplicate card id ${card.id}`);
    ids.add(card.id);
  }
  return cards;
}

// The runtimes' own error vocabularies: the Claude SDK's
// SDKAssistantMessageError (also what the StopFailure hook carries as
// `error`) and the few Codex names that arrive as identifiers.
const ERROR_ENUM_CLASSES = {
  overloaded: "overloaded",
  rate_limit: "rate_limited",
  server_error: "server_error",
  authentication_failed: "auth",
  oauth_org_not_allowed: "auth",
  billing_error: "auth",
  max_output_tokens: "max_tokens",
  invalid_request: "other",
  model_not_found: "other",
  unknown: "other",
};

const TEXT_CLASSES = [
  ["max_tokens", /max_output_tokens|max[_ ]tokens|output token limit/i],
  ["auth", /authentication|unauthori[sz]ed|invalid (?:api )?key|forbidden|oauth|billing|credit balance/i],
  ["rate_limited", /rate[_ ]?limit|too many requests|usage limit|quota exceeded/i],
  ["overloaded", /overloaded/i],
  ["server_error", /server[_ ]error|bad gateway|service unavailable|gateway timeout/i],
  ["network", /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|stream disconnected|connection (?:reset|closed|error|refused)|network error/i],
];

function statusFromText(value) {
  const match = value.match(/(?:api error|status(?: code)?|http(?:\/\d(?:\.\d)?)?)\s*:?\s*(\d{3})\b/i)
    || value.match(/\b(\d{3})\s+(?:too many requests|overloaded|internal server error|bad gateway|service unavailable|gateway timeout)/i);
  const status = match ? Number(match[1]) : null;
  return status && status >= 400 && status <= 599 ? status : null;
}

function classForStatus(status) {
  if (status === 429) return "rate_limited";
  if (status === 529) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server_error";
  return null;
}

function eventErrorText(event) {
  return [event?.error, event?.reason, event?.errorDetails, event?.message, event?.result]
    .filter((item) => typeof item === "string" && item.trim())
    .join("\n")
    .slice(0, 4096);
}

// Whether a turn-ending event says the user stopped it. An interrupt is never
// an error to recover from, so this is asked before anything is classified.
export function isUserInterrupt(event) {
  const reason = text(event?.terminalReason, 64);
  if (reason.startsWith("aborted")) return true;
  return /request interrupted by user|interrupted by user/i.test(eventErrorText(event));
}

// What went wrong with a turn that ended in error. `hint` carries what the
// runtime said earlier in the same turn: the SDK's assistant error enum and a
// rate-limit reset time, neither of which rides on the final event.
export function classifyTurnError(event, hint = {}, now = Date.now()) {
  const errorText = eventErrorText(event);
  const enumValue = text(hint.assistantError || event?.reason || event?.error, 64);
  // "unknown" and its kin name no cause, so the text still gets a say.
  let errorClass = ERROR_ENUM_CLASSES[enumValue] || null;
  if (errorClass === "other") errorClass = null;
  const status = Number.isInteger(event?.status) ? event.status : statusFromText(errorText);
  if (!errorClass && status) errorClass = classForStatus(status);
  if (!errorClass) errorClass = TEXT_CLASSES.find(([, pattern]) => pattern.test(errorText))?.[0] || "other";

  let retryAfterSeconds = null;
  const resetsAt = Number(hint.rateLimitResetsAt);
  if (errorClass === "rate_limited" && Number.isFinite(resetsAt) && resetsAt > 0) {
    const resetsAtMs = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
    const seconds = Math.ceil((resetsAtMs - now) / 1000);
    if (seconds > 0) retryAfterSeconds = Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  }
  return {
    class: errorClass,
    status: status || null,
    message: text(errorText, 512),
    retryAfterSeconds,
  };
}

export function isRetryableErrorClass(errorClass) {
  return RETRYABLE.has(errorClass);
}

// How long to wait before the next try. A named reset wins, plus a little
// slack so the retry does not land a second before the window reopens.
export function retryDelaySeconds(error, attempt) {
  if (error?.retryAfterSeconds) return error.retryAfterSeconds + 15;
  const index = Math.max(0, Math.min(Number(attempt) || 0, RETRY_BACKOFF_SECONDS.length - 1));
  return RETRY_BACKOFF_SECONDS[index];
}

export function cardMatchesSession(card, { agent, cwd }) {
  if (card.scope.agents.length > 0 && !card.scope.agents.includes(agent)) return false;
  if (card.scope.workspaces.length === 0) return true;
  const path = String(cwd || "");
  if (!path) return false;
  return card.scope.workspaces.some((workspace) => {
    const root = workspace.replace(/\/+$/, "");
    return path === root || path.startsWith(`${root}/`);
  });
}

// A built-in judge's verdict on one snapshot. `attempt` is how many times the
// card has already fired for this session, which sets the backoff.
export function judgeBuiltin(rule, snapshot, { attempt = 0 } = {}) {
  if (rule === "retryable_error") {
    if (snapshot.checkpoint !== "abnormal_stop" || !isRetryableErrorClass(snapshot.error?.class)) {
      return { match: false };
    }
    return { match: true, waitSeconds: retryDelaySeconds(snapshot.error, attempt) };
  }
  if (rule === "empty_reply") {
    if (!["turn_ended", "abnormal_stop"].includes(snapshot.checkpoint)) return { match: false };
    const truncated = snapshot.endReason === "max_tokens" || snapshot.error?.class === "max_tokens";
    return { match: truncated || snapshot.lastReplyEmpty === true, waitSeconds: 0 };
  }
  if (rule === "always") return { match: true, waitSeconds: 0 };
  return { match: false };
}
