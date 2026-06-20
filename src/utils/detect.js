import { spawn } from "node:child_process";

export function runCapture(command, args = [], { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let output = "";
    child.stdout.on("data", (data) => {
      output += data.toString("utf8");
    });
    child.stderr.on("data", (data) => {
      output += data.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, output: "", error });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: code === 0, output: output.trim() });
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, output: output.trim(), error: new Error(`${command} ${args.join(" ")} timed out`) });
    }, timeoutMs);
  });
}

export async function detectCliAvailability(command) {
  const result = await runCapture(command, ["--version"]);
  return {
    command,
    available: result.ok,
    version: result.output.split("\n")[0] || null,
  };
}

export async function detectTmuxAvailability() {
  const result = await runCapture("tmux", ["-V"]);
  return {
    available: result.ok,
    version: result.output.split("\n")[0] || null,
  };
}

export async function detectNodePtyAvailability() {
  try {
    await import("node-pty");
    return { available: true };
  } catch {
    return { available: false };
  }
}

export async function detectClaudeAgentSdkAvailability() {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return { available: typeof sdk.query === "function" };
  } catch {
    return { available: false };
  }
}

// Stage 4: detects the system Python 3 interpreter. Used by `originrouter
// proxy install` to verify Python 3.10+ is available before creating a venv.
// Returns { available, version, command, path, error? }.
export async function detectPythonAvailability() {
  // Try the common invocations. `python3` is preferred (PEP 394); fall back
  // to `python` if needed. macOS and Linux distros ship python3 by default.
  const candidates = ["python3", "python"];
  for (const cmd of candidates) {
    const versionResult = await runCapture(cmd, ["--version"]);
    if (!versionResult.ok) continue;
    const pathResult = await runCapture(cmd, ["-c", "import sys; print(sys.executable); print(sys.prefix)"]);
    let pythonPath = null;
    let prefix = null;
    if (pathResult.ok) {
      const lines = pathResult.output.split("\n");
      pythonPath = lines[0] || null;
      prefix = lines[1] || null;
    }
    // Parse "Python 3.10.10" or "Python 3.11" — second whitespace-separated token.
    const match = versionResult.output.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) continue;
    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2], 10);
    // LiteLLM 1.83.0 requires Python ≥3.10.
    const meetsMin = major > 3 || (major === 3 && minor >= 10);
    return {
      available: meetsMin,
      command: cmd,
      path: pythonPath,
      prefix,
      version: versionResult.output.split("\n")[0] || null,
      meetsMin,
      error: meetsMin ? null : `Python ≥3.10 required (found ${major}.${minor})`,
    };
  }
  return {
    available: false,
    command: null,
    path: null,
    prefix: null,
    version: null,
    meetsMin: false,
    error: "Python 3 not found on PATH. Install Python 3.10+ from https://www.python.org/downloads/.",
  };
}
