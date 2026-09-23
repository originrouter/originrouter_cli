import { ROUTE_DEFS } from "../config/routes.js";

export function flattenCollaborationSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    ...snapshot.run,
    schema_version: snapshot.schema_version,
    revision: snapshot.revision,
    last_sequence: snapshot.last_sequence,
    plan: snapshot.plan,
    tasks: snapshot.tasks,
    agents: Object.fromEntries(
      (snapshot.participants || []).map((participant) => [
        participant.participant_id,
        participant,
      ]),
    ),
    attention: snapshot.attention,
    artifacts: snapshot.artifacts,
    budget: snapshot.budget,
    usage: snapshot.usage,
    final_report: snapshot.final_report,
    capabilities: snapshot.capabilities,
  };
}

export function placeholderProxyStatus() {
  return {
    state: "not-installed",
    port: null,
    version: null,
    pid: null,
    currentProvider: null,
    note: "LiteLLM proxy control lands in Stage 4.",
  };
}

export function projectRoutesForApi(routes, agent = "claude") {
  // Project every slot defined for the agent, with missing slots becoming
  // null. Older agents (Claude) return { main, small }; Codex returns
  // just { main } because that's all ROUTE_DEFS.codex.slots contains.
  const def = ROUTE_DEFS[agent];
  const slots = def ? def.slots : ["main", "small"];
  const out = {};
  for (const slot of slots) out[slot] = (routes && routes[slot]) || null;
  return out;
}

// JSON-safe view of an internal session. Strips adapter/executor instances,
// scanTimer handles, and other non-serializable fields.
export function projectSession(session) {
  return {
    sessionId: session.id || session.sessionId,
    agent: session.agent,
    command: session.command,
    args: session.args,
    status: session.status,
    cwd: session.cwd,
    pid: session.pid,
    executor: session.executorKind,
    startedAt: session.startedAt || session.createdAt,
  };
}
