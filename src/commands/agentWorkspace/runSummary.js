/**
 * Display-safe projections used by the Agent Workspace terminal UI.
 *
 * These helpers deliberately contain no terminal or network behavior. Keeping
 * them separate lets the interactive controller focus on input/state changes
 * while all Run summary formatting stays deterministic and easy to test.
 */

export function compactRunState(run = {}) {
  const tasks = Array.isArray(run.tasks)
    ? run.tasks.filter((task) => task.task_key !== "__planner__")
    : [];
  const complete = tasks.filter((task) => task.state === "completed").length;
  const attention = Array.isArray(run.attention)
    ? run.attention.filter((item) => item.status === "pending").length
    : 0;
  const progress = tasks.length ? `${complete}/${tasks.length} tasks` : "no tasks yet";
  return `${run.state || "unknown"} · ${progress}${attention ? ` · ${attention} needs attention` : ""}`;
}

export function runLabel(run = {}) {
  return String(run.objective || run.plan?.title || run.run_id || "Agent collaboration")
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

export function recentWorkspaceSessions(runs = []) {
  const sessions = new Map();
  for (const run of runs) {
    const sessionId = String(run?.workspace_session_id || run?.workspaceSessionId || "").trim();
    if (sessionId && !sessions.has(sessionId)) sessions.set(sessionId, run);
  }
  return [...sessions.entries()].map(([sessionId, run]) => ({ sessionId, run }));
}
