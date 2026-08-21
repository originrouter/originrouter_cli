const INTERNAL_EVENT_TYPES = new Set([
  "agent.adapter.status",
  "agent.autonomy.status",
  "agent.budget.status",
  "agent.detail.status",
  "agent.message.result",
  "agent.mode.status",
  "agent.ready",
  "agent.session_id",
  "agent.task.complete",
  "agent.task.completed",
  "agent.task.started",
  "agent.usage",
  "user.text",
]);

const SIGNIFICANT_EVENT_TYPES = new Set([
  "agent.task.aborted",
  "agent.task.failed",
  "budget.exhausted",
  "budget.warning",
  "device.reconnected",
  "device.waiting",
  "plan.generated",
  "run.blocked",
  "run.cancelled",
  "run.failed",
  "run.paused",
  "run.recovered",
  "run.resumed",
  "task.failed",
  "task.progress",
  "task.retry_scheduled",
]);

const PERMISSION_RESOLUTION_TYPES = new Set([
  "agent.interaction.auto_resolved",
  "agent.permission.resolved",
  "approval.resolved",
  "interaction.resolved",
]);

const ACTIVITY_BY_METADATA = Object.freeze({
  command: "commands",
  exec: "commands",
  exploration: "explored",
  inspect: "explored",
  read: "explored",
  search: "explored",
  service_query: "queried",
  tool: "actions",
  workspace_change: "changed",
  write: "changed",
});

function clean(value, maxLength = 2048) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sentence(value) {
  const text = clean(value);
  if (!text) return "";
  return /[.!?。！？]$/.test(text) ? text : `${text}.`;
}

function participantLabel(participantId, labels = {}) {
  return clean(labels[participantId], 128)
    || clean(participantId, 128).replaceAll("_", " ")
    || "Agent";
}

function safeStructuredDetail(event) {
  const detail = String(event?.detail || "").trim();
  if (!detail) return "";
  if (/<originrouter_(?:collaboration|agent)/i.test(detail)) {
    return "Internal task instructions were delivered to the Agent.";
  }
  if (/^(?:\{|\[)/.test(detail)) {
    try {
      const value = JSON.parse(detail);
      const source = Array.isArray(value) ? value[0] : value;
      if (!source || typeof source !== "object") return "Structured runtime data received.";
      const selected = ["status", "action", "tool", "command", "path", "message", "result"]
        .filter((key) => source[key] != null)
        .map((key) => `${key}: ${clean(source[key], 240)}`);
      return selected.length ? selected.join(" · ") : "Structured runtime data received.";
    } catch {
      return "Structured runtime data received.";
    }
  }
  return clean(detail, 1200);
}

function activityKind(event) {
  const type = clean(event?.type, 96);
  const tool = clean(event?.metadata?.tool || event?.metadata?.tool_name, 128).toLowerCase();
  const activity = clean(event?.metadata?.activity, 64).toLowerCase();
  if (ACTIVITY_BY_METADATA[activity]) return ACTIVITY_BY_METADATA[activity];
  const combined = `${type} ${tool} ${activity}`;
  if (/read|search|find|glob|grep|list|inspect|explor/.test(combined)) return "explored";
  if (/write|edit|patch|create|delete|move|rename/.test(combined)) return "changed";
  if (/bash|shell|command|exec|terminal/.test(combined)) return "commands";
  if (/mcp|query|fetch|web/.test(combined)) return "queried";
  return "actions";
}

function eventDetailLine(event) {
  const type = clean(event?.type, 96);
  const detail = safeStructuredDetail(event);
  const tool = clean(event?.metadata?.tool || event?.metadata?.tool_name, 128);
  if (type === "agent.tool_call.start") return tool ? `Started ${tool}` : "Started an Agent action";
  if (type === "agent.tool_call.end") return tool ? `Finished ${tool}` : "Finished an Agent action";
  if (type === "agent.interaction.requested") return sentence(event.summary || "Agent requested a decision");
  if (type === "agent.interaction.result") {
    const action = clean(event?.payload?.action || event?.metadata?.status, 64);
    return action ? `Decision applied: ${action}` : "Agent decision applied";
  }
  if (type === "agent.interaction.auto_resolved") return "A routine interaction was resolved by policy";
  if (PERMISSION_RESOLUTION_TYPES.has(type)) return sentence(event.summary || "Permission decision applied");
  if (type === "agent.text") return detail ? `Agent response: ${detail}` : "Agent produced a response";
  if (INTERNAL_EVENT_TYPES.has(type)) return type === "user.text"
    ? "Internal task instructions delivered"
    : `Runtime state updated: ${type.slice("agent.".length).replaceAll(".", " ")}`;
  const summary = clean(event?.summary, 600) || type.replaceAll(".", " ");
  return detail && detail !== summary ? `${summary} · ${detail}` : summary;
}

function operationalEvent(event) {
  const category = clean(event?.category, 32);
  if (["agent", "approval", "interaction"].includes(category)) return true;
  const type = clean(event?.type, 96);
  return type.startsWith("agent.") || type.startsWith("approval.") || type.startsWith("interaction.");
}

function eventIdentity(event, index) {
  return clean(event?.event_id, 195)
    || (event?.sequence != null ? `sequence:${event.sequence}` : "")
    || clean(event?.idempotency_key, 191)
    || [
      clean(event?.participant_id, 128),
      clean(event?.type, 96),
      clean(event?.created_at, 64),
      clean(event?.summary, 256),
      index,
    ].join(":");
}

function projectParticipantGroup(events, participantId, labels, expanded) {
  const toolStarts = events.filter((event) => event.type === "agent.tool_call.start");
  const toolEnds = events.filter((event) => event.type === "agent.tool_call.end");
  const approvals = events.filter((event) => PERMISSION_RESOLUTION_TYPES.has(event.type));
  const requests = events.filter((event) => event.type === "agent.interaction.requested");
  const kinds = new Map();
  for (const event of toolStarts) {
    const kind = activityKind(event);
    kinds.set(kind, Number(kinds.get(kind) || 0) + 1);
  }
  const parts = [];
  for (const [kind, count] of kinds) {
    const labelsByKind = {
      explored: "exploration",
      changed: "workspace change",
      commands: "command",
      queried: "service query",
      actions: "action",
    };
    parts.push(`${count} ${labelsByKind[kind]}${count === 1 ? "" : "s"}`);
  }
  if (!parts.length && Math.max(toolStarts.length, toolEnds.length)) {
    const count = Math.max(toolStarts.length, toolEnds.length);
    parts.push(`${count} action${count === 1 ? "" : "s"}`);
  }
  if (approvals.length) parts.push(`${approvals.length} permission${approvals.length === 1 ? "" : "s"} handled`);
  if (requests.length > approvals.length) parts.push(`${requests.length - approvals.length} decision${requests.length - approvals.length === 1 ? "" : "s"} requested`);
  const running = toolStarts.length > toolEnds.length;
  const details = expanded
    ? events
        .filter((event) => event.visibility !== "diagnostic")
        .map(eventDetailLine)
        .filter(Boolean)
        .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
        .slice(-12)
    : [];
  return {
    key: `participant:${participantId || "agent"}`,
    kind: "activity",
    marker: running ? "active" : "complete",
    title: `${participantLabel(participantId, labels)} ${running ? "is working" : "worked"}`,
    summary: parts.join(" · ") || "Runtime activity grouped",
    details,
    count: events.length,
  };
}

function projectSignificantEvent(event, labels, expanded) {
  const participant = event.participant_id ? `${participantLabel(event.participant_id, labels)} · ` : "";
  const detail = safeStructuredDetail(event);
  return {
    key: `event:${event.event_id || event.sequence || event.type}`,
    kind: "event",
    marker: event.severity === "error" ? "error" : event.severity === "warning" ? "warning" : "complete",
    title: `${participant}${clean(event.summary, 800) || clean(event.type, 96).replaceAll(".", " ")}`,
    summary: expanded ? detail : "",
    details: [],
    count: 1,
  };
}

export function projectCollaborationActivity(events = [], {
  expanded = false,
  participantLabels = {},
  maxGroups = 6,
} = {}) {
  const unique = new Map();
  for (const [index, event] of (events || []).entries()) {
    if (!event) continue;
    unique.set(eventIdentity(event, index), event);
  }
  const visible = [...unique.values()].filter((event) => (
    event.visibility !== "audit_only"
    && (expanded || event.visibility !== "diagnostic")
  ));
  const participantEvents = new Map();
  const significant = [];
  for (const event of visible) {
    if (
      SIGNIFICANT_EVENT_TYPES.has(event.type)
      || event.severity === "warning"
      || event.severity === "error"
    ) significant.push(event);
    if (!operationalEvent(event)) continue;
    if (!expanded && INTERNAL_EVENT_TYPES.has(event.type)) continue;
    const participantId = clean(event.participant_id, 128) || "agent";
    if (!participantEvents.has(participantId)) participantEvents.set(participantId, []);
    participantEvents.get(participantId).push(event);
  }
  const groups = [
    ...[...participantEvents.entries()].map(([participantId, items]) => (
      projectParticipantGroup(items, participantId, participantLabels, expanded)
    )),
    ...significant.slice(expanded ? -8 : -3).map((event) => (
      projectSignificantEvent(event, participantLabels, expanded)
    )),
  ];
  return groups.slice(-Math.max(1, maxGroups));
}
