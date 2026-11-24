import { execFileSync } from "node:child_process";

import { scheduleForceKill } from "./processTreeKill.js";
import {
  CMD_SHIM_PATTERN,
  resolveWindowsCommand,
  toWindowsCommandLine,
} from "../utils/spawn.js";

export function ttyUsesOutputPostprocessing({ input = process.stdin, exec = execFileSync } = {}) {
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

export function disableOuterTtyOutputPostprocessing({
  input = process.stdin,
  output = process.stdout,
  platform = process.platform,
  exec = execFileSync,
} = {}) {
  if (platform === "win32" || !input?.isTTY || !output?.isTTY) return false;
  if (!ttyUsesOutputPostprocessing({ input, exec })) return false;
  try {
    exec("stty", ["-opost"], {
      stdio: [input, "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function restoreOuterTtyOutputPostprocessing({
  input = process.stdin,
  platform = process.platform,
  exec = execFileSync,
} = {}) {
  if (platform === "win32" || !input?.isTTY) return false;
  try {
    exec("stty", ["opost"], {
      stdio: [input, "ignore", "ignore"],
    });
    return true;
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

// Pure helper: pick what node-pty should spawn. On Windows, ConPTY launches
// through CreateProcess, which — unlike PowerShell or the spawnCommand path —
// never resolves bare names against PATH/PATHEXT and cannot execute .cmd/.bat
// shims directly (npm installs `claude` as claude.cmd; node-pty then fails
// with "File not found: claude"). Mirror spawnCommand: resolve the bare name
// against PATH/PATHEXT and route shims through cmd.exe. node-pty does not
// re-quote an argument that is already fully quoted, so the pre-quoted /c
// line passes through untouched.
export function resolvePtySpawnTarget(command, args, { platform = process.platform } = {}) {
  if (platform !== "win32") {
    return { command, args };
  }
  const resolved = resolveWindowsCommand(command);
  if (CMD_SHIM_PATTERN.test(resolved)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `"${toWindowsCommandLine(resolved, args)}"`],
    };
  }
  return { command: resolved, args };
}

export class PtyExecutor {
  constructor({ forceKillMs } = {}) {
    this.terminal = null;
    this._exited = false;
    this._stopTimer = null;
    this._inputGeneration = 0;
    // SIGTERM→SIGKILL escalation window. Injected so unit tests can use a
    // short window (mirrors CodexAppServerClient.forceKillMs).
    this.forceKillMs = forceKillMs;
  }

  async start({
    command,
    args = [],
    cwd,
    env,
    cols = 100,
    rows = 30,
    relayToParentTty = false,
    outerTtyRawOutput = false,
    onOutput,
    onExit,
    onError,
  }) {
    // The exit flag starts fresh for a (re)started session.
    this._exited = false;
    this._inputGeneration += 1;
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }

    let pty;
    try {
      pty = await import("node-pty");
    } catch {
      throw new Error("node-pty is not installed. Install it before using --executor pty.");
    }

    const target = resolvePtySpawnTarget(command, args);
    this.terminal = pty.spawn(target.command, target.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    // A PTY slave normally applies OPOST/ONLCR before its master receives
    // output. When the parent TTY already switched to -opost (the standard
    // PTY-proxy setup used by localAgentSession), leave the inner PTY at its
    // default so cooked children convert LF -> CRLF once while raw-output
    // TUIs like agy can disable OPOST on the inner slave and emit bare LFs
    // without the outer TTY turning them back into CRLF. Fall back to
    // disabling the inner layer only when the outer TTY still applies OPOST.
    if (relayToParentTty && !outerTtyRawOutput && ttyUsesOutputPostprocessing()) {
      disableNestedPtyOutputPostprocessing(this.terminal);
    }

    this.terminal.onData((data) => onOutput(data));
    this.terminal.onExit((event) => {
      this._exited = true;
      this._inputGeneration += 1;
      if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
      onExit?.({ code: event.exitCode, signal: event.signal });
    });
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
    const terminal = this.terminal, generation = this._inputGeneration;
    if (!terminal || this._exited) return false;
    terminal.write(String(data || ""));
    // Claude/Codex distinguish a standalone Enter key from a newline that is
    // part of a pasted input chunk. Keep them as separate PTY writes.
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (this._exited || this.terminal !== terminal || this._inputGeneration !== generation) return false;
    terminal.write("\r");
    return true;
  }

  resize(cols, rows) {
    this.terminal?.resize(cols, rows);
  }

  interrupt() {
    this._inputGeneration += 1;
    this.write("\x03");
  }

  stop() {
    this._inputGeneration += 1;
    const terminal = this.terminal;
    const pid = terminal?.pid;
    if (!terminal || !Number.isInteger(pid) || pid <= 0) return;

    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }

    // Keep node-pty's own teardown (closes the master fd; a no-op if the
    // child already exited) so the PTY resources are released even when the
    // child ignores the signal below.
    if (typeof terminal.kill === "function") {
      try { terminal.kill(); } catch {}
    }

    // Graceful SIGTERM to the whole process group first. If the session the
    // forkpty() child leads is still alive after the escalation window, hard
    // kill it with SIGKILL. The exit handler clears the timer on a real exit,
    // so a fast exit never waits the full window. pty children are session
    // leaders, so groupLead=true lets -pid reach the whole tree.
    this._stopTimer = scheduleForceKill(pid, {
      groupLead: true,
      graceMs: this.forceKillMs,
      isExited: () => this._exited,
    });
  }
}
