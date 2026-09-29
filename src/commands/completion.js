import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readConfig } from "../persistence/state.js";
import {
  COMPLETION_VALUES,
  VALUE_FLAGS,
  WORKSPACE_OPTIONS,
  resolveCommand,
  topLevelCommands,
} from "./commandCatalog.js";

const COMPLETION_START = "# >>> originrouter completion >>>";
const COMPLETION_END = "# <<< originrouter completion <<<";

function providerNames() {
  try {
    return Object.keys(readConfig()?.providers || {}).sort();
  } catch {
    return [];
  }
}

// Flags whose value is a live resource name rather than a fixed string. The
// list comes from local state, so it is resolved on every TAB instead of
// being baked into the catalog.
const DYNAMIC_VALUE_FOR = {
  "--provider": providerNames,
};

// Values the CLI will accept after `previous`, from the catalog plus the
// dynamic resource lookups. A flag's values can be declared either globally
// (COMPLETION_VALUES) or on the command that defines the flag; the dynamic
// lookup wins, then the command-local declaration, then the global map.
function valuesFor(previous, node = null) {
  const dynamic = DYNAMIC_VALUE_FOR[previous]?.();
  if (dynamic?.length) return dynamic;
  const local = node?.valuesFor?.[previous];
  if (local?.length) return local;
  return COMPLETION_VALUES[previous] || [];
}

function unique(values) {
  return [...new Set(values)].sort();
}

// Which catalog node the already-typed words point at. A flag such as
// `remote --port 1` must not be read as a subcommand, so words that start
// with `-` (and the value that follows a value-taking flag) are skipped.
function flagTakesValue(word, node) {
  if (word.includes("=")) return false;
  if (VALUE_FLAGS.has(word)) return true;
  return Boolean(node?.valuesFor?.[word]?.length);
}

function catalogPathFor(completed) {
  const path = [];
  let expectValue = false;
  for (const word of completed) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (word.startsWith("-")) {
      const { node } = resolveCommand(path);
      if (flagTakesValue(word, node)) expectValue = true;
      continue;
    }
    path.push(word);
  }
  return path;
}

// True once a passthrough command has been handed something to forward, i.e.
// an argument other than OriginRouter's own leading flags. `claude` alone
// still offers its wrapper flags; `claude --model x` or `run -- ls` does not.
// A bare `--` is itself the boundary (`originrouter run -- <cmd>`).
//
// A passthrough command (`run -- cmd`, `claude <native args>`) hands the rest
// of its argv to another program. Until something has actually been handed
// over, OriginRouter still offers its own wrapper flags; once any argument
// follows, completion defers to the shell.
function isForwarding(completed) {
  for (let end = completed.length; end > 0; end -= 1) {
    const { node } = resolveCommand(completed.slice(0, end));
    if (!node?.passthrough) continue;
    return completed.length > end;
  }
  return false;
}

export function getCompletionCandidates(argv = []) {
  const words = argv.map(String);
  const current = words.at(-1) || "";
  const completed = words.slice(0, -1);
  const previous = completed.at(-1) || "";
  const path = catalogPathFor(completed);
  const { node, children } = resolveCommand(path);

  // A value-taking flag wins over everything else: `--provider <TAB>` must
  // list providers even though the path still resolves to a command, and
  // `claude --originrouter-autonomy g<TAB>` is still OriginRouter's own flag
  // rather than something handed to the forwarded program.
  let candidates = valuesFor(previous, node);

  // Past a passthrough boundary the shell should complete files, not
  // OriginRouter flags: `run -- ls <TAB>` must not suggest `--json`.
  if (candidates.length === 0 && isForwarding(completed)) return [];

  if (candidates.length === 0 && !current.startsWith("-")) {
    if (path.length === 0) {
      candidates = topLevelCommands().map((entry) => entry.name);
    } else {
      // Positional values declared on the node (e.g. `route set <TAB>`
      // offering agent.slot names) join the subcommands rather than
      // replacing them: a command may accept both.
      const positional = node?.valuesFor?.["(positional)"] || [];
      candidates = [...children.map((entry) => entry.name), ...positional];
    }
  }

  if (current.startsWith("-") || candidates.length === 0) {
    const nodeOptions = node?.options || [];
    const visibleChildren = path.length === 0 ? [] : children.map((entry) => entry.name);
    candidates = [
      ...candidates,
      ...nodeOptions,
      ...visibleChildren,
      ...(path.length === 0 ? WORKSPACE_OPTIONS : []),
    ];
  }

  // A provider name is also a positional on the subcommands that take one,
  // and on `route ... --provider <name>`.
  if (path[0] === "provider" && ["show", "use", "remove", "update"].includes(path[1])) {
    if (current && !current.startsWith("-")) candidates.push(...providerNames());
  }

  return unique(candidates).filter((candidate) => candidate.startsWith(current));
}

// Same candidate set, with the description the shell shows next to each
// value. Cobra's wire format is `value\tdescription` with a trailing
// `:<directive>` line, and every generated script below parses exactly that.
export function getCompletionRichCandidates(argv = []) {
  const candidates = getCompletionCandidates(argv);
  const completed = argv.map(String).slice(0, -1);
  const path = catalogPathFor(completed);
  const { node, children } = resolveCommand(path);

  const described = candidates.map((candidate) => {
    const child = children.find((entry) => entry.name === candidate);
    return { value: candidate, description: child?.summary || "" };
  });

  // A forwarded command's empty answer means "let the shell complete files",
  // which is directive 0 rather than 4.
  const directive = described.length === 0 && isForwarding(completed)
    ? SHELL_COMP_DEFAULT
    : SHELL_COMP_DIRECTIVE;

  return { candidates: described, directive };
}

// Cobra's ShellCompDirectiveNoFileComp (4): the shell must not fall back to
// filename completion, which otherwise turns a wrong TAB into a directory
// listing. ShellCompDirectiveDefault (0) explicitly allows the fallback, and
// is what a passthrough command needs.
export const SHELL_COMP_DIRECTIVE = 4;
export const SHELL_COMP_DEFAULT = 0;

export function formatCompletionOutput(argv = []) {
  const { candidates, directive } = getCompletionRichCandidates(argv);
  const lines = candidates.map(({ value, description }) => (
    description ? `${value}\t${description}` : value
  ));
  lines.push(`:${directive}`);
  return lines.join("\n");
}

const BASH = `# bash completion for OriginRouter CLI
_originrouter_completion() {
  # No global IFS override: it also applies to the command substitution below
  # and collapses the multi-line reply down to its last line.
  local out directive="" line
  out=$( "\${COMP_WORDS[0]}" __complete "\${COMP_WORDS[@]:1}" 2>/dev/null )
  local -a values=()
  while IFS= read -r line; do
    case "$line" in
      :*) directive="\${line#:}" ;;
      *) values+=( "\${line%%$'\\t'*}" ) ;;
    esac
  done <<< "$out"
  COMPREPLY=()
  if [ "\${#values[@]}" -gt 0 ]; then
    COMPREPLY=( $(compgen -W "\${values[*]}" -- "$2") )
  fi
  # 4 = ShellCompDirectiveNoFileComp: suppress bash's filename fallback.
  # Anything else (0) leaves the shell's own file completion in place.
  if [ "$directive" = "4" ]; then compopt +o default 2>/dev/null || true; fi
}
complete -o default -F _originrouter_completion originrouter or`;

const ZSH = `#compdef originrouter
_originrouter_completion() {
  local -a lines candidates
  local line
  # '(@)' is required: without it zsh joins \${words[2,-1]} into a single
  # word, so the CLI receives "remote " instead of "remote" "".
  lines=("\${(@f)$( "\${words[1]}" __complete "\${(@)words[2,-1]}" 2>/dev/null )}")
  for line in "\${lines[@]}"; do
    # Trailing ':directive' line is Cobra's wire format, not a candidate.
    [[ "$line" == :* ]] && continue
    candidates+=( "\${line%%$'\\t'*}" )
  done
  (( \${#candidates[@]} )) && compadd -- "\${candidates[@]}"
}
compdef _originrouter_completion originrouter or`;

const FISH = `# fish completion for OriginRouter CLI
function __originrouter_complete
  set -l args (commandline -opc)
  # $args[2..-1] is the already-typed words, (commandline -ct) the word being
  # completed. The reply is 'value<TAB>description' lines plus a ':directive'
  # trailer, which fish must strip before offering anything.
  set -l out ($args[1] __complete $args[2..-1] (commandline -ct) 2>/dev/null)
  for line in $out
    if string match -q ':*' -- $line
      continue
    end
    echo (string split -m 1 \\t -- $line)[1]
  end
end
complete -c originrouter -f -a '(__originrouter_complete)'
complete -c or -f -a '(__originrouter_complete)'`;

const POWERSHELL = `# PowerShell completion for OriginRouter CLI
$originrouterCompleter = {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
  if ($words.Count -eq 0 -or $words[-1] -ne $wordToComplete) {
    $words += $wordToComplete
  }
  $exe = $commandAst.CommandElements[0].Extent.Text
  # Each line is 'value<TAB>description'; the final line is ':directive'.
  # The backtick-t below is PowerShell's tab escape.
  & $exe __complete @words 2>$null | ForEach-Object {
    if ($_ -like ':*') { return }
    $parts = $_ -split "\`t", 2
    $tip = if ($parts.Count -gt 1) { $parts[1] } else { $parts[0] }
    [System.Management.Automation.CompletionResult]::new($parts[0], $parts[0], 'ParameterValue', $tip)
  }
}
Register-ArgumentCompleter -Native -CommandName originrouter,or -ScriptBlock $originrouterCompleter`;

const SCRIPTS = { bash: BASH, zsh: ZSH, fish: FISH, powershell: POWERSHELL };

// The script text for one shell, without printing it. Used by `printCompletion`
// and by the tests that pin the constructs each shell needs.
export function completionScript(shell) {
  const script = SCRIPTS[shell];
  if (!script) throw new Error("Usage: originrouter completion bash|zsh|fish|powershell");
  return script;
}

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

function quotePosixShellPath(file) {
  return `'${String(file).replaceAll("'", `'\\''`)}'`;
}

export function completionActivationCommand(shell, file) {
  if (shell === "powershell") return `. '${String(file).replaceAll("'", "''")}'`;
  if (["bash", "zsh", "fish"].includes(shell)) return `source ${quotePosixShellPath(file)}`;
  return null;
}

export function printCompletionActivationHint(shell, file) {
  const command = completionActivationCommand(shell, file);
  if (!command) return;
  console.log("  Completion is saved for future terminals.");
  console.log(`  To enable it in this terminal now, run: ${command}`);
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
  if (action === "install" && !result.dryRun) printCompletionActivationHint(shell, result.file);
}

export function printCompletion(shell) {
  console.log(completionScript(shell));
}
