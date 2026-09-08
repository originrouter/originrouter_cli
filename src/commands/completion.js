import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readConfig } from "../persistence/state.js";

const COMPLETION_START = "# >>> originrouter completion >>>";
const COMPLETION_END = "# <<< originrouter completion <<<";

const TOP_LEVEL = [
  "status", "doctor", "sessions", "devices", "env", "agent", "history", "remote",
  "collaborate", "collaboration", "provider", "route", "proxy",
  "compatibility", "login", "logout", "auth", "security", "service", "services",
  "local", "config", "completion", "help", "update", "setup", "claude", "codex", "run",
];

const SUBCOMMANDS = {
  agent: ["setup", "detail", "budget", "history"],
  auth: ["status", "login", "logout"],
  collaboration: ["templates", "list", "drafts", "draft", "show", "attach", "attention", "resolve", "doctor", "create", "confirm", "revise", "pause", "resume", "retry", "cancel", "archive", "delete", "export"],
  compatibility: ["status", "list", "inspect", "check", "update", "refresh", "rollback"],
  completion: ["bash", "zsh", "fish", "powershell", "install", "uninstall"],
  config: ["show", "set", "unset"],
  help: ["all"],
  env: ["print"],
  local: ["key", "token", "config", "api"],
  provider: ["add", "update", "list", "show", "use", "remove"],
  proxy: ["install", "start", "stop", "restart", "switch", "status"],
  route: ["list", "show", "set", "clear", "cloud", "remote"],
  security: ["status", "rotate"],
  service: ["install", "start", "stop", "restart", "status", "uninstall"],
  services: ["install", "start", "stop", "restart", "status", "uninstall"],
  update: ["status", "check", "install"],
};

const NESTED = {
  "agent budget": ["show", "set", "clear"],
  "agent detail": ["set"],
  "agent history": ["show"],
  "collaboration draft": ["show", "resume", "delete"],
  "local api": ["status", "set-host", "set-port"],
  "local config": ["show", "set"],
  "local key": ["show", "rotate"],
  "local token": ["show", "rotate"],
  "route cloud": ["models", "set"],
  "route remote": ["devices", "set"],
  remote: ["setup", "status", "share", "workspace"],
  "remote share": ["status", "start", "stop", "restart"],
  "remote workspace": ["list", "authorize", "request"],
};

const OPTIONS = {
  workspace: ["-c", "--coordinator", "-m", "--mode", "--team", "--review", "--yes", "--detach"],
  doctor: ["--json"],
  sessions: ["--json"],
  devices: ["--json"],
  history: ["--agent", "--device", "--workspace", "--since", "--until", "--limit", "--archived", "--json"],
  provider: ["--type", "--engine", "--litellm-provider", "--base-url", "--api-key", "--auth-token", "--model", "--small-fast-model", "--agent", "--force"],
  route: ["--provider", "--model", "--main-model", "--small-model", "--device"],
  remote: ["--device", "--workspace", "--providers", "--port"],
  proxy: ["--provider", "--port", "--version"],
  login: ["--no-browser"],
  collaboration: ["--objective", "--participant", "--role", "--route", "--permission", "--preference", "--template", "--coordination-prompt", "--concurrency", "--token-limit", "--amount-limit", "--currency", "--yes", "--detach", "--no-wait", "--timeout", "--review", "--json"],
  claude: ["--native-config", "--originrouter-autonomy", "--originrouter-policy", "--originrouter-detail"],
  codex: ["--native-config", "--originrouter-autonomy", "--originrouter-policy", "--originrouter-detail"],
  update: ["--json"],
  setup: ["--no-proxy", "--noproxy", "--proxy", "--yes", "--dry-run", "--verify"],
  completion: ["--shell", "--dry-run"],
};

function providerNames() {
  try {
    return Object.keys(readConfig()?.providers || {}).sort();
  } catch {
    return [];
  }
}

function valuesFor(previous) {
  if (["-c", "--coordinator"].includes(previous)) return ["codex", "claude"];
  if (["-m", "--mode", "--team"].includes(previous)) {
    return ["auto", "solo", "build-review", "plan-build-verify", "parallel-research", "review-panel", "remote-ops"];
  }
  if (previous === "--agent") return ["claude", "codex"];
  if (previous === "--type") return ["proxy", "litellm"];
  if (previous === "--engine") return ["litellm"];
  if (previous === "--provider") return providerNames();
  if (previous === "--originrouter-autonomy") return ["manual", "guarded", "ai_review", "unrestricted", "custom"];
  if (previous === "--originrouter-detail") return ["concise", "standard", "detailed"];
  if (previous === "--allow-lan") return ["on", "off"];
  if (previous === "--relay-mode") return ["auto", "cloud", "local", "custom"];
  if (previous === "--format") return ["json", "markdown"];
  if (previous === "--shell") return ["bash", "zsh", "fish", "powershell"];
  if (previous === "updates.mode") return ["prompt", "auto", "off"];
  return [];
}

function unique(values) {
  return [...new Set(values)].sort();
}

export function getCompletionCandidates(argv = []) {
  const words = argv.map(String);
  const current = words.at(-1) || "";
  const completed = words.slice(0, -1);
  const first = completed[0] || "";
  const second = completed[1] || "";
  const previous = completed.at(-1) || "";

  let candidates = valuesFor(previous);
  if (candidates.length === 0) {
    if (completed.length === 0) candidates = TOP_LEVEL;
    else if (completed.length === 1 && !current.startsWith("-")) candidates = SUBCOMMANDS[first] || [];
    else if (completed.length === 2 && !current.startsWith("-")) candidates = NESTED[`${first} ${second}`] || [];
  }

  if (current.startsWith("-") || candidates.length === 0) {
    candidates = [...candidates, ...(OPTIONS[first] || []), ...(completed.length === 0 ? OPTIONS.workspace : [])];
  }

  if (["provider", "route"].includes(first) && ["show", "use", "remove", "update"].includes(second)) {
    candidates.push(...providerNames());
  }

  return unique(candidates).filter((candidate) => candidate.startsWith(current));
}

const BASH = `# bash completion for OriginRouter CLI
_originrouter_completion() {
  local IFS=$'\\n'
  COMPREPLY=( $(originrouter __complete "\${COMP_WORDS[@]:1}") )
}
complete -o default -F _originrouter_completion originrouter or`;

const ZSH = `#compdef originrouter
_originrouter_completion() {
  local -a candidates
  candidates=("\${(@f)$(originrouter __complete "\${words[@]:1}")}")
  compadd -- $candidates
}
compdef _originrouter_completion originrouter or`;

const FISH = `# fish completion for OriginRouter CLI
complete -c originrouter -f -a '(originrouter __complete (commandline -opc)[2..-1] (commandline -ct))'
complete -c or -f -a '(or __complete (commandline -opc)[2..-1] (commandline -ct))'`;

const POWERSHELL = `# PowerShell completion for OriginRouter CLI
$originrouterCompleter = {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
  if ($words.Count -eq 0 -or $words[-1] -ne $wordToComplete) {
    $words += $wordToComplete
  }
  originrouter __complete @words | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
Register-ArgumentCompleter -Native -CommandName originrouter,or -ScriptBlock $originrouterCompleter`;

const SCRIPTS = { bash: BASH, zsh: ZSH, fish: FISH, powershell: POWERSHELL };

function homeDirectory(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function detectShell(env = process.env, platformName = process.platform) {
  if (platformName === "win32" && env.PSModulePath) return "powershell";
  const shell = String(env.SHELL || "").toLowerCase();
  if (shell.endsWith("/zsh") || shell === "zsh") return "zsh";
  if (shell.endsWith("/bash") || shell === "bash") return "bash";
  if (shell.endsWith("/fish") || shell === "fish") return "fish";
  if (env.PSModulePath) return "powershell";
  return null;
}

function configDirectory(env = process.env) {
  return env.XDG_CONFIG_HOME || path.join(homeDirectory(env), ".config");
}

function completionTarget(shell, { env = process.env, platformName = process.platform } = {}) {
  const home = homeDirectory(env);
  if (shell === "zsh") {
    const zdotdir = env.ZDOTDIR || home;
    return { shell, kind: "profile", file: path.join(zdotdir, ".zshrc") };
  }
  if (shell === "bash") {
    return { shell, kind: "profile", file: path.join(home, ".bashrc") };
  }
  if (shell === "fish") {
    return { shell, kind: "file", file: path.join(configDirectory(env), "fish", "completions", "originrouter.fish") };
  }
  if (shell === "powershell") {
    const base = platformName === "win32"
      ? path.join(env.USERPROFILE || home, "Documents")
      : configDirectory(env);
    const folder = platformName === "win32" ? "PowerShell" : "powershell";
    return { shell, kind: "profile", file: path.join(base, folder, "Microsoft.PowerShell_profile.ps1") };
  }
  throw new Error("Usage: originrouter completion install|uninstall [--shell zsh|bash|fish|powershell]");
}

function managedBlock(shell) {
  if (shell === "fish") return COMPLETION_START + "\n" + FISH + "\n" + COMPLETION_END + "\n";
  if (shell === "powershell") return COMPLETION_START + "\noriginrouter completion powershell | Out-String | Invoke-Expression\n" + COMPLETION_END + "\n";
  return COMPLETION_START + "\nsource <(originrouter completion " + shell + ")\n" + COMPLETION_END + "\n";
}

function managedBlockState(content) {
  const starts = content.split(COMPLETION_START).length - 1;
  const ends = content.split(COMPLETION_END).length - 1;
  if (starts === 0 && ends === 0) return "absent";
  if (starts === 1 && ends === 1 && content.indexOf(COMPLETION_START) < content.indexOf(COMPLETION_END)) {
    return "complete";
  }
  return "damaged";
}

function removeManagedBlocks(content) {
  let remaining = content;
  while (remaining.includes(COMPLETION_START)) {
    const start = remaining.indexOf(COMPLETION_START);
    const end = remaining.indexOf(COMPLETION_END, start);
    if (end < 0) {
      remaining = remaining.slice(0, start);
      break;
    }
    remaining = remaining.slice(0, start) + remaining.slice(end + COMPLETION_END.length);
  }
  remaining = remaining.replaceAll(COMPLETION_END, "");
  return remaining.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export function installCompletion(shell = detectShell(), { env = process.env, platformName = process.platform, dryRun = false } = {}) {
  const target = completionTarget(shell, { env, platformName });
  const existing = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : "";
  const state = managedBlockState(existing);
  if (state === "complete") return { ...target, changed: false, reason: "already-installed" };
  if (dryRun) return { ...target, changed: true, dryRun: true };
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  const block = managedBlock(shell);
  if (target.kind === "file") fs.writeFileSync(target.file, block, { mode: 0o644 });
  else {
    const clean = state === "damaged" ? removeManagedBlocks(existing) : existing;
    const prefix = clean && !clean.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(target.file, clean + prefix + "\n" + block, { mode: 0o644 });
  }
  return { ...target, changed: true, repaired: state === "damaged" };
}

export function uninstallCompletion(shell = detectShell(), { env = process.env, platformName = process.platform, dryRun = false } = {}) {
  const target = completionTarget(shell, { env, platformName });
  if (!fs.existsSync(target.file)) return { ...target, changed: false, reason: "not-installed" };
  const existing = fs.readFileSync(target.file, "utf8");
  if (managedBlockState(existing) === "absent") return { ...target, changed: false, reason: "not-managed" };
  if (dryRun) return { ...target, changed: true, dryRun: true };
  if (target.kind === "file") fs.unlinkSync(target.file);
  else fs.writeFileSync(target.file, removeManagedBlocks(existing));
  return { ...target, changed: true };
}

export function handleCompletionCommand(args = []) {
  const action = args[0];
  if (action !== "install" && action !== "uninstall") {
    printCompletion(action);
    return;
  }
  let shell = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--shell") shell = args[++index];
    else if (args[index]?.startsWith("--shell=")) shell = args[index].slice("--shell=".length);
  }
  shell ||= detectShell();
  if (!shell) throw new Error("Unable to detect the current shell. Specify --shell zsh|bash|fish|powershell.");
  const result = action === "install"
    ? installCompletion(shell, { dryRun: args.includes("--dry-run") })
    : uninstallCompletion(shell, { dryRun: args.includes("--dry-run") });
  if (result.reason === "already-installed") console.log("Shell completion is already configured for " + shell + ": " + result.file);
  else if (result.reason === "not-installed") console.log("No OriginRouter completion was found for " + shell + ": " + result.file);
  else if (result.reason === "not-managed") console.log("The completion target is not managed by OriginRouter: " + result.file);
  else if (result.dryRun) console.log((action === "install" ? "Would configure " : "Would remove ") + shell + " completion: " + result.file);
  else console.log((action === "install" ? "Configured " : "Removed ") + shell + " completion: " + result.file);
}

export function printCompletion(shell) {
  if (!SCRIPTS[shell]) throw new Error("Usage: originrouter completion bash|zsh|fish|powershell");
  console.log(SCRIPTS[shell]);
}
