import { spawnCommand } from "../utils/spawn.js";

export class PipeExecutor {
  constructor() {
    this.child = null;
  }

  async start({ command, args = [], cwd, env, onOutput, onExit, onError }) {
    this.child = spawnCommand(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (data) => onOutput(data.toString("utf8")));
    this.child.stderr.on("data", (data) => onOutput(data.toString("utf8")));
    this.child.on("error", (error) => onError?.(error));
    this.child.on("exit", (code, signal) => onExit?.({ code, signal }));

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
    this.child?.kill("SIGTERM");
  }
}
