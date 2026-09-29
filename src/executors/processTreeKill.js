// Shared SIGTERM → SIGKILL escalation for terminating managed agent processes.

import { spawnSync } from "node:child_process";
import { platform } from "node:os";

// SIGTERM → SIGKILL escalation window. A graceful SIGTERM lets the agent flush;
// if it has not exited within this window, send SIGKILL. The real exit handler
// clears the timer, so a quick exit never waits the full window.
const SESSION_FORCE_KILL_MS = 2_000;

const IS_WINDOWS = platform() === "win32";

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
//   - Windows has no POSIX signals: process.kill(pid, "SIGTERM") maps to an
//     unconditional TerminateProcess (nothing can flush), and negative pids
//     are invalid. `taskkill /T` reaches the whole descendant tree instead,
//     so both escalation stages route through it.
//     Measured caveat: taskkill without /F sends WM_CLOSE, which only a GUI
//     process with a message loop answers. A console child (claude, node)
//     ignores it and survives the graceful stage, so on Windows the process
//     usually exits at the /F stage after graceMs rather than before it.
//     The stage is kept because it is the only non-destructive attempt
//     available, and a GUI-ish child can still exit cleanly.
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
  if (IS_WINDOWS) {
    const force = signal === "SIGKILL";
    const args = ["/pid", String(pid), "/T"];
    if (force) args.push("/F");
    const result = spawnSync("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.status === 0) return true;
    // Measured on Windows 11 (26200): taskkill exits 128 for "already gone",
    // for a pid that never existed, AND for a live console process it could
    // not close gracefully — the code cannot tell those apart. Only /F
    // exiting 128 actually implies the process is gone, so report success
    // just for that case; a graceful attempt reports failure and lets the
    // SIGKILL escalation do the real work.
    return force && result.status === 128;
  }
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
