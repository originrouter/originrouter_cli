import { ROUTE_DEFS } from "../config/routes.js";
import { routeModelControl } from "../proxy/sessionModels.js";

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

export function projectRoutesForApi(routes, agent = "claude", config = null) {
  // Project every slot defined for the agent, with missing slots becoming
  // null. Claude returns main plus the four auxiliary families; Codex returns
  // just { main } because that's all ROUTE_DEFS.codex.slots contains.
  const def = ROUTE_DEFS[agent];
  const slots = def ? def.slots : [];
  // The whole agent's routes share one transport, and that transport is what
  // decides whether a run here can be told which model to use — so the answer
  // is the same on every slot, and it is the device's own statement rather
  // than something the App could work out from `provider`/`model`.
  //
  // It is copied onto each slot rather than returned beside them because the
  // App reads a slot as one row; a second top-level field would be a second
  // thing to keep in step with the rows.
  const modelControl = config ? routeModelControl(config, agent) : "";
  const out = {};
  for (const slot of slots) {
    const route = (routes && routes[slot]) || null;
    out[slot] = route && modelControl
      ? { ...route, modelControl }
      : route;
  }
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
