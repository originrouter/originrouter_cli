import { spawnCommand } from "../utils/spawn.js";

import { scheduleForceKill } from "./processTreeKill.js";

export class PipeExecutor {
  constructor() {
    this.child = null;
    this._exited = false;
    this._stopTimer = null;
  }

  async start({ command, args = [], cwd, env, onOutput, onExit, onError, forceKillMs }) {
    this.child = spawnCommand(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (data) => onOutput(data.toString("utf8")));
    this.child.stderr.on("data", (data) => onOutput(data.toString("utf8")));
    this.child.on("error", (error) => onError?.(error));
    this.child.on("exit", (code, signal) => {
      this._exited = true;
      if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
      onExit?.({ code, signal });
    });
    this.forceKillMs = forceKillMs;

    return {
      pid: this.child.pid,
      executor: "pipe",
    };
  }

  write(data) {
    this.child?.stdin.write(data);
  }

  submitMessage(data) {
    this.child?.stdin.write(`${String(data || "")}\n`);
  }

  resize() {}

  interrupt() {
    this.child?.kill("SIGINT");
  }

  stop() {
    const pid = this.child?.pid;
    if (!Number.isInteger(pid) || pid <= 0) return;

    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }

    // The child is spawned without detaching, so it is NOT a process-group
    // leader; signal only the single pid (signaling -pid would hit our own
    // group). SIGTERM first, then SIGKILL escalation after the window. The
    // exit handler clears the timer on a real exit.
    this._stopTimer = scheduleForceKill(pid, {
      groupLead: false,
      graceMs: this.forceKillMs,
      isExited: () => this._exited,
    });
  }
}
