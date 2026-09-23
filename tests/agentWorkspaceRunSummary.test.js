import assert from "node:assert/strict";
import test from "node:test";

import {
  compactRunState,
  recentWorkspaceSessions,
  runLabel,
} from "../src/commands/agentWorkspace/runSummary.js";

test("Run summary projections remain display-safe and deterministic", () => {
  assert.equal(
    compactRunState({
      state: "executing",
      tasks: [
        { task_key: "__planner__", state: "completed" },
        { task_key: "build", state: "completed" },
        { task_key: "verify", state: "waiting" },
      ],
      attention: [{ status: "pending" }],
    }),
    "executing · 1/2 tasks · 1 needs attention",
  );
  assert.equal(runLabel({ objective: "  build   the   thing  " }), " build the thing ");
});

test("workspace session projection keeps the first Run per session", () => {
  const first = { run_id: "run-1", workspace_session_id: "session-1" };
  const second = { run_id: "run-2", workspace_session_id: "session-1" };
  const third = { run_id: "run-3", workspaceSessionId: "session-2" };
  assert.deepEqual(recentWorkspaceSessions([first, second, third]), [
    { sessionId: "session-1", run: first },
    { sessionId: "session-2", run: third },
  ]);
});
