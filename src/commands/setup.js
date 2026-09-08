import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { platform } from "node:os";
import {
  detectCliAvailability,
  runCapture,
} from "../utils/detect.js";
import { handleServiceCommand, isServiceInstalled, waitForLocalApiReady } from "./service.js";
import { ProxyManager } from "../proxy/manager.js";
import { ensureStateDir } from "../persistence/state.js";
import { isInstalled as isProxyInstalled, LITELLM_VERSION } from "../proxy/litellm.js";
import { detectShell, installCompletion } from "./completion.js";
import {
  ensureManagedPython,
  managedPythonStatus,
  MANAGED_PYTHON_VERSION,
} from "../runtime/managedPython.js";

const AGENT_INSTALLERS = Object.freeze({
  claude: {
    label: "Claude Code",
    checks: ["claude", "--version"],
    darwin: { kind: "brew", args: ["install", "--cask", "claude-code"], display: "brew install --cask claude-code" },
    linux: { kind: "script", command: "curl -fsSL https://claude.ai/install.sh | bash", display: "curl -fsSL https://claude.ai/install.sh | bash" },
    win32: { kind: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", "irm https://claude.ai/install.ps1 | iex"], display: "irm https://claude.ai/install.ps1 | iex" },
  },
  codex: {
    label: "Codex",
    checks: ["codex", "--version"],
    darwin: { kind: "brew", args: ["install", "--cask", "codex"], display: "brew install --cask codex" },
    linux: { kind: "script", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", display: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
    win32: { kind: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "ByPass", "-Command", "irm https://chatgpt.com/codex/install.ps1 | iex"], display: "irm https://chatgpt.com/codex/install.ps1 | iex" },
  },
});

async function commandAvailable(command) {
  const result = await runCapture(command, ["--version"], { timeoutMs: 2500 });
  return result.ok;
}

async function runInstaller(installer) {
  if (installer.kind === "brew") {
    return runProcess("brew", installer.args);
  }
  if (installer.kind === "powershell") {
    return runProcess("powershell.exe", installer.args);
  }
  return runProcess("bash", ["-lc", installer.command]);
}

function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.once("error", (error) => resolve({ ok: false, error }));
    child.once("exit", (code, signal) => resolve({ ok: code === 0, code, signal }));
  });
}

async function ask(rl, question, defaultValue = true) {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

function installerFor(agent, currentPlatform, { hasBrew = false, hasCurl = false } = {}) {
  const definition = AGENT_INSTALLERS[agent];
  if (currentPlatform === "darwin") {
    if (hasBrew) return definition.darwin;
    return hasCurl ? definition.linux : null;
  }
  if (currentPlatform === "linux" && !hasCurl) return null;
  return definition[currentPlatform] || null;
}

async function installProxyRuntime(pythonCommand) {
  const stateDir = ensureStateDir();
  const proxy = new ProxyManager({ stateDir, pythonCommand });
  try {
    const result = await proxy.install({ version: LITELLM_VERSION });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

export async function verifySetupEnvironment({ includeProxy = true } = {}) {
  const stateDir = ensureStateDir();
  const serviceInstalled = isServiceInstalled();
  const proxy = new ProxyManager({ stateDir });
  const [claude, codex, python, serviceReady, proxyReady] = await Promise.all([
    detectCliAvailability("claude"),
    detectCliAvailability("codex"),
    managedPythonStatus(stateDir),
    serviceInstalled
      ? waitForLocalApiReady({ timeoutMs: 3000 }).then(() => true, () => false)
      : Promise.resolve(false),
    includeProxy ? proxy.verifyInstall(LITELLM_VERSION) : Promise.resolve(false),
  ]);
  const codexAppServer = codex.available
    ? await runCapture("codex", ["app-server", "--help"], { timeoutMs: 4000 })
    : { ok: false };
  const checks = [
    { name: "Claude Code", ok: claude.available, detail: claude.version || "not available on PATH" },
    { name: "Codex", ok: codex.available && codexAppServer.ok, detail: !codex.available ? "not available on PATH" : codexAppServer.ok ? (codex.version || "installed") : "app-server is unavailable" },
    { name: "Background service", ok: serviceInstalled && serviceReady, detail: !serviceInstalled ? "not installed" : serviceReady ? "installed and running" : "installed but not ready" },
  ];
  if (includeProxy) {
    checks.splice(2, 0,
      { name: "Managed Python", ok: python.available, detail: python.available ? `${python.version} at ${python.path}` : "not installed" },
      { name: "Local Proxy runtime", ok: proxyReady, detail: proxyReady ? `LiteLLM ${LITELLM_VERSION}` : isProxyInstalled(stateDir, LITELLM_VERSION) ? "installed files failed verification" : "not installed" },
    );
  }
  return checks;
}

function printSetupVerification(checks) {
  console.log("\nInstallation verification");
  for (const check of checks) console.log(`  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
    console.error(`\nInstallation is incomplete (${failed.length} check${failed.length === 1 ? "" : "s"} failed). Re-run \`originrouter setup\` after resolving the reported issue.`);
    return false;
  }
  console.log("\n✓ OriginRouter is ready.");
  console.log("\nContinue in OriginRouter App");
  console.log("Open the App to review this device, manage model routes, follow Agent sessions, and handle approvals:");
  console.log("https://originrouter.com/app\n");
  return true;
}

export async function handleSetupCommand(args = []) {
  const flags = new Set(args);
  const dryRun = flags.has("--dry-run");
  const verifyOnly = flags.has("--verify");
  const nonInteractive = flags.has("--yes") || dryRun || verifyOnly;
  // Proxy is part of the complete first-run environment. Keep --proxy as a
  // backwards-compatible explicit alias, and offer --no-proxy for the rare
  // case where a user does not need local Provider routing.
  const skipProxy = flags.has("--no-proxy") || flags.has("--noproxy");
  if (!nonInteractive && (!input.isTTY || !output.isTTY)) {
    throw new Error("`originrouter setup` requires an interactive terminal. Re-run it in a terminal, or use `--yes`.");
  }

  const currentPlatform = platform();
  const hasBrew = currentPlatform === "darwin" && await commandAvailable("brew");
  const hasCurl = await commandAvailable("curl");
  if (verifyOnly) {
    printSetupVerification(await verifySetupEnvironment({ includeProxy: !skipProxy }));
    return;
  }

  const [claude, codex, managedPython] = await Promise.all([
    detectCliAvailability("claude"),
    detectCliAvailability("codex"),
    managedPythonStatus(ensureStateDir()),
  ]);
  const missing = [
    ["claude", claude],
    ["codex", codex],
  ].filter(([, result]) => !result.available).map(([agent]) => agent);

  const rl = nonInteractive ? null : createInterface({ input, output });
  try {
    console.log("\nOriginRouter setup\n");
    console.log("Required runtimes");
    console.log(`  ${claude.available ? "✓" : "✗"} Claude Code${claude.version ? ` (${claude.version})` : ""}`);
    console.log(`  ${codex.available ? "✓" : "✗"} Codex${codex.version ? ` (${codex.version})` : ""}`);
    console.log(`  ${managedPython.available ? "✓" : skipProxy ? "○" : "✗"} Managed Python ${managedPython.available ? managedPython.version : skipProxy ? "not needed (--no-proxy)" : `${MANAGED_PYTHON_VERSION} will be installed`}`);
    console.log("");

    const installAgents = missing.length > 0
      ? (nonInteractive || await ask(rl, `Install missing required runtimes (${missing.map((agent) => AGENT_INSTALLERS[agent].label).join(" and ")})?`, true))
      : false;
    const installService = nonInteractive || await ask(rl, "Install and start the OriginRouter background service?", true);
    const installProxy = !skipProxy;

    const plan = [];
    if (installAgents) {
      for (const agent of missing) {
        const installer = installerFor(agent, currentPlatform, { hasBrew, hasCurl });
        if (installer) plan.push(`${AGENT_INSTALLERS[agent].label}: ${installer.display}`);
        else plan.push(`${AGENT_INSTALLERS[agent].label}: no supported installer for this platform`);
      }
    }
    if (installService) plan.push("OriginRouter background service: install and start");
    if (installProxy) {
      if (!managedPython.available) plan.push(`Managed Python ${MANAGED_PYTHON_VERSION}: install in the OriginRouter runtime directory`);
      plan.push(`Local Proxy runtime: ensure LiteLLM ${LITELLM_VERSION} is installed`);
    }
    if (plan.length === 0) {
      console.log("Everything selected is already installed.\n");
      if (!dryRun) printSetupVerification(await verifySetupEnvironment({ includeProxy: !skipProxy }));
      return;
    }

    console.log("\nSetup plan");
    for (const item of plan) console.log(`  • ${item}`);
    const confirmed = dryRun || nonInteractive || await ask(rl, "\nProceed with this plan?", true);
    if (!confirmed) {
      console.log("Setup cancelled.");
      process.exitCode = 2;
      return;
    }

    if (installAgents && !dryRun) {
      for (const agent of missing) {
        const installer = installerFor(agent, currentPlatform, { hasBrew, hasCurl });
        if (!installer) {
          console.error(`\n✗ ${AGENT_INSTALLERS[agent].label}: no supported installer for ${currentPlatform}.`);
          process.exitCode = 1;
          continue;
        }
        console.log(`\nInstalling ${AGENT_INSTALLERS[agent].label}...`);
        const result = await runInstaller(installer);
        if (!result.ok) {
          console.error(`✗ ${AGENT_INSTALLERS[agent].label} installation failed.`);
          process.exitCode = 1;
          continue;
        }
        const check = await detectCliAvailability(agent);
        if (!check.available) {
          console.error(`✗ ${AGENT_INSTALLERS[agent].label} installed but is not available on PATH. Restart the terminal and rerun setup.`);
          process.exitCode = 1;
        } else if (agent === "codex") {
          const appServer = await runCapture("codex", ["app-server", "--help"], { timeoutMs: 4000 });
          if (!appServer.ok) {
            console.error("✗ Codex is installed, but this version does not expose the required app-server command.");
            process.exitCode = 1;
          } else {
            console.log(`✓ Codex ${check.version || "installed"} (app-server ready)`);
          }
        } else {
          console.log(`✓ ${AGENT_INSTALLERS[agent].label} ${check.version || "installed"}`);
        }
      }
    }

    if (installService && !dryRun) {
      try {
        await handleServiceCommand(["install"]);
        await handleServiceCommand(["start"]);
        console.log("✓ OriginRouter background service is running.");
      } catch (error) {
        console.error(`✗ Background service setup failed: ${error.message || error}`);
        process.exitCode = 1;
      }
    }

    if (installProxy && !dryRun) {
      console.log("\nPreparing managed Python...");
      try {
        const python = await ensureManagedPython(ensureStateDir());
        console.log(`✓ Managed Python ${python.version} ${python.alreadyInstalled ? "is ready" : "installed"}.`);
        console.log("\nInstalling Local Proxy runtime...");
        const result = await installProxyRuntime(python.path);
        if (!result.ok) {
          console.error(`✗ Local Proxy was not installed: ${result.error}`);
          process.exitCode = 1;
        } else {
          console.log("✓ Local Proxy runtime installed. Configure a Provider before starting it.");
        }
      } catch (error) {
        console.error(`✗ Managed Python setup failed: ${error.message || error}`);
        process.exitCode = 1;
      }
    }

    if (!dryRun && !nonInteractive) {
      const shell = detectShell();
      if (shell && await ask(rl, `Configure OriginRouter shell completion for ${shell}?`, false)) {
        try {
          const result = installCompletion(shell);
          console.log(result.changed
            ? `✓ Shell completion configured for ${shell}.`
            : `✓ Shell completion is already configured for ${shell}.`);
        } catch (error) {
          console.error(`✗ Shell completion setup failed: ${error.message || error}`);
          process.exitCode = 1;
        }
      }
    }

    if (dryRun) {
      console.log("\nDry run complete. No installation or service changes were made.\n");
    } else {
      printSetupVerification(await verifySetupEnvironment({ includeProxy: !skipProxy }));
    }
  } finally {
    rl?.close();
  }
}
