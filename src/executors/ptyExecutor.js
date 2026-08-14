import { execFileSync } from "node:child_process";

function ttyUsesOutputPostprocessing({ input = process.stdin, exec = execFileSync } = {}) {
  if (!input?.isTTY) return false;
  try {
    const settings = String(exec("stty", ["-a"], {
      encoding: "utf8",
      stdio: [input, "pipe", "ignore"],
    }) || "");
    return /(?:^|[\s;])opost(?:[\s;]|$)/.test(settings)
      && !/(?:^|[\s;])-opost(?:[\s;]|$)/.test(settings);
  } catch {
    return false;
  }
}

export function disableNestedPtyOutputPostprocessing(
  terminal,
  {
    platform = process.platform,
    exec = execFileSync,
  } = {},
) {
  const ttyPath = terminal?._pty;
  if (
    typeof ttyPath !== "string"
    || !/^\/dev\/(?:tty[^/]*|pts\/\d+)$/.test(ttyPath)
  ) {
    return false;
  }
  const pathFlag = platform === "darwin" || platform === "freebsd" ? "-f" : "-F";
  try {
    exec("stty", [pathFlag, ttyPath, "-opost"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export class PtyExecutor {
  constructor() {
    this.terminal = null;
  }

  async start({
    command,
    args = [],
    cwd,
    env,
    cols = 100,
    rows = 30,
    relayToParentTty = false,
    onOutput,
    onExit,
    onError,
  }) {
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

    // A PTY slave normally applies OPOST/ONLCR before its master receives
    // output. When that already-processed stream is written through another
    // TTY, the parent line discipline applies it again (LF -> CRLF becomes
    // CRCRLF). Apart from being different from a native CLI session, those
    // redundant carriage-return operations substantially increase the cost
    // of rendering and scrolling long transcripts in Apple Terminal.
    // Disable only the inner layer when the outer TTY will do the native
    // output processing for us.
    if (relayToParentTty && ttyUsesOutputPostprocessing()) {
      disableNestedPtyOutputPostprocessing(this.terminal);
    }

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
