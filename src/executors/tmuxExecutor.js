import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { detectTmuxAvailability } from "../utils/detect.js";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function tmux(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `tmux exited with ${code}`));
    });
  });
}

export class TmuxExecutor {
  constructor() {
    this.sessionName = null;
    this.pollTimer = null;
    this.lastOutput = "";
  }

  async start({ command, args = [], cwd, env, onOutput, onExit }) {
    const available = await detectTmuxAvailability();
    if (!available.available) {
      throw new Error("tmux is not installed.");
    }

    this.sessionName = `originrouter-${randomUUID().slice(0, 8)}`;
    const envArgs = Object.entries(env || {})
      .filter(([, value]) => value !== undefined)
      .flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const fullCommand = [command, ...args].map(shellQuote).join(" ");

    await tmux([
      "new-session",
      "-d",
      "-s",
      this.sessionName,
      "-c",
      cwd || process.cwd(),
      ...envArgs,
      fullCommand,
    ]);

    this.pollTimer = setInterval(async () => {
      try {
        const result = await tmux(["capture-pane", "-t", this.sessionName, "-p"]);
        if (result.stdout !== this.lastOutput) {
          onOutput(result.stdout.slice(this.lastOutput.length));
          this.lastOutput = result.stdout;
        }
      } catch {
        clearInterval(this.pollTimer);
        onExit?.({ code: 0, signal: null });
      }
    }, 500);

    return {
      pid: null,
      executor: "tmux",
      tmuxSession: this.sessionName,
    };
  }

  write(data) {
    if (!this.sessionName) return;
    const parts = data.endsWith("\n") ? [data.slice(0, -1), "Enter"] : [data];
    tmux(["send-keys", "-t", this.sessionName, ...parts]).catch(() => {});
  }

  resize() {}

  interrupt() {
    if (!this.sessionName) return;
    tmux(["send-keys", "-t", this.sessionName, "C-c"]).catch(() => {});
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (!this.sessionName) return;
    tmux(["kill-session", "-t", this.sessionName]).catch(() => {});
  }
}
