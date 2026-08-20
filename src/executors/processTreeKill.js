// Shared SIGTERM → SIGKILL escalation for terminating managed agent processes.

// SIGTERM → SIGKILL escalation window. A graceful SIGTERM lets the agent flush;
// if it has not exited within this window, send SIGKILL. The real exit handler
// clears the timer, so a quick exit never waits the full window.
const SESSION_FORCE_KILL_MS = 2_000;
//
// Context:
//   - pty executor runs the child via node-pty's forkpty(), which makes the
//     child a session/process-group leader. Signaling the negative pid
//     (-pid) reaches the whole process tree.
//   - pipe executor runs the child via node:child_process.spawn() WITHOUT
//     detaching, so the child is NOT a process-group leader: signaling -pid
//     would hit the caller's own group. Only the single pid is safe there.
//   - tmux executor delegates teardown to `tmux kill-session`, which tears
//     down the whole pane process tree itself.
//
// groupLead=true is only correct when the caller guarantees the pid is a
// distinct process-group leader (pty). Callers pass forceKillMs so tests reuse
// the same code path with a short window.
export function scheduleForceKill(pid, { groupLead = false, graceMs = SESSION_FORCE_KILL_MS, isExited = () => false } = {}) {
  signalProcessTree(pid, "SIGTERM", { groupLead });
  const timer = setTimeout(() => {
    if (isExited()) return;
    signalProcessTree(pid, "SIGKILL", { groupLead });
  }, graceMs);
  // Let the caller clear the timer once the real exit lands without keeping a
  // process-alive reference here.
  return timer;
}

export function signalProcessTree(pid, signal, { groupLead = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (groupLead) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      // ESRCH = no such group (already gone) — treat as success.
      if (error?.code === "ESRCH") return true;
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
