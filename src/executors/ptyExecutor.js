export class PtyExecutor {
  constructor() {
    this.terminal = null;
  }

  async start({ command, args = [], cwd, env, cols = 100, rows = 30, onOutput, onExit, onError }) {
    let pty;
    try {
      pty = await import("node-pty");
    } catch {
      throw new Error("node-pty is not installed. Install it before using --executor pty.");
    }

    this.terminal = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    this.terminal.onData((data) => onOutput(data));
    this.terminal.onExit((event) => onExit?.({ code: event.exitCode, signal: event.signal }));
    this.terminal.on("error", (error) => onError?.(error));

    return {
      pid: this.terminal.pid,
      executor: "pty",
    };
  }

  write(data) {
    this.terminal?.write(data);
  }

  async submitMessage(data) {
    this.write(String(data || ""));
    // Claude/Codex distinguish a standalone Enter key from a newline that is
    // part of a pasted input chunk. Keep them as separate PTY writes.
    await new Promise((resolve) => setTimeout(resolve, 30));
    this.write("\r");
  }

  resize(cols, rows) {
    this.terminal?.resize(cols, rows);
  }

  interrupt() {
    this.write("\x03");
  }

  stop() {
    this.terminal?.kill();
  }
}
