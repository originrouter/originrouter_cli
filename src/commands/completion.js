import { readConfig } from "../persistence/state.js";

const TOP_LEVEL = [
  "status", "doctor", "sessions", "devices", "env", "agent", "history",
  "collaborate", "collaboration", "provider", "route", "proxy",
  "compatibility", "login", "logout", "auth", "security", "service",
  "local", "completion", "help", "claude", "codex", "run",
];

const SUBCOMMANDS = {
  agent: ["setup", "detail", "budget", "history"],
  auth: ["status", "login", "logout"],
  collaboration: ["templates", "list", "drafts", "draft", "show", "attach", "attention", "resolve", "doctor", "create", "confirm", "revise", "pause", "resume", "retry", "cancel", "archive", "delete", "export"],
  compatibility: ["status", "list", "inspect", "check", "update", "refresh", "rollback"],
  completion: ["bash", "zsh", "fish", "powershell"],
  help: ["all"],
  env: ["print"],
  local: ["key", "token", "config", "api"],
  provider: ["add", "update", "list", "show", "use", "remove"],
  proxy: ["install", "start", "stop", "restart", "switch", "status"],
  route: ["list", "show", "set", "clear", "cloud", "remote"],
  security: ["status", "rotate"],
  service: ["install", "start", "stop", "restart", "status", "uninstall"],
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
};

const OPTIONS = {
  workspace: ["-c", "--coordinator", "-m", "--mode", "--team", "--review", "--yes", "--detach", "--cloud-advice"],
  doctor: ["--json"],
  sessions: ["--json"],
  devices: ["--json"],
  history: ["--agent", "--device", "--workspace", "--since", "--until", "--limit", "--archived", "--json"],
  provider: ["--type", "--engine", "--litellm-provider", "--base-url", "--api-key", "--auth-token", "--model", "--small-fast-model", "--agent", "--force"],
  route: ["--provider", "--model", "--main-model", "--small-model", "--device"],
  proxy: ["--provider", "--port", "--version"],
  login: ["--no-browser"],
  collaboration: ["--objective", "--participant", "--role", "--route", "--permission", "--preference", "--template", "--coordination-prompt", "--concurrency", "--token-limit", "--amount-limit", "--currency", "--yes", "--detach", "--no-wait", "--timeout", "--review", "--json"],
  claude: ["--originrouter-native-config", "--originrouter-autonomy", "--originrouter-policy", "--originrouter-detail"],
  codex: ["--originrouter-native-config", "--originrouter-autonomy", "--originrouter-policy", "--originrouter-detail"],
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

export function printCompletion(shell) {
  const scripts = { bash: BASH, zsh: ZSH, fish: FISH, powershell: POWERSHELL };
  if (!scripts[shell]) throw new Error("Usage: originrouter completion bash|zsh|fish|powershell");
  console.log(scripts[shell]);
}
