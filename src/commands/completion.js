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
// PowerShell 5.1 drops a trailing empty argument when it invokes a native
// command, so `node x __complete provider ""` arrives as `__complete provider`
// and `provider` is then mistaken for the word under completion (the CLI would
// echo it back instead of offering `add`, `list`, `show`, ...). PowerShell
// cannot pass an empty string at all — an empty variable, String.Empty, a
// splat, and a literal all arrive as nothing, while `" "` survives — so the
// generated PowerShell script sends this sentinel instead and the CLI maps it
// back. Only the last word is translated: everything before it is complete
// typed input, and a literal `__OR_EMPTY__` there would be a real (if odd)
// command word the user typed.
const EMPTY_WORD_SENTINEL = "__OR_EMPTY__";

function translateEmptyWordSentinel(argv) {
  if (argv.length === 0) return argv;
  const words = argv.map(String);
  if (words.at(-1) !== EMPTY_WORD_SENTINEL) return words;
  return [...words.slice(0, -1), ""];
}

export function getCompletionRichCandidates(argv = []) {
  const words = translateEmptyWordSentinel(argv);
  const candidates = getCompletionCandidates(words);
  const completed = words.slice(0, -1);
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
  # PowerShell 5.1 drops a trailing empty argument when calling a native
  # command, so an empty word here would vanish and the CLI would mistake the
  # previous word for the one being completed. Send the sentinel the CLI maps
  # back to an empty word instead; it survives @-splatting where '' does not.
  if ($words.Count -eq 0 -or $words[-1] -eq '') {
    $words = @($words | Where-Object { $_ -ne '' }) + '__OR_EMPTY__'
  }
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

// Windows ships two PowerShells that read *different* profile paths: Windows
// PowerShell 5.1 (the default powershell.exe) reads
// Documents\WindowsPowerShell\ while PowerShell 7+ (pwsh) reads
// Documents\PowerShell\. Writing only the 7+ path — as this did — leaves 5.1
// users with completion that is installed yet never loaded, and 5.1 is what
// plain `powershell` starts. Install into both so whichever the person uses
// picks it up; on non-Windows there is only ever one.
export function completionTargets(shell, options = {}) {
  const { env = process.env, platformName = process.platform } = options;
  const primary = completionTarget(shell, options);
  if (shell !== "powershell" || platformName !== "win32") return [primary];
  const documents = path.join(env.USERPROFILE || homeDirectory(env), "Documents");
  const legacy = path.join(documents, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
  if (legacy === primary.file) return [primary];
  return [primary, { ...primary, file: legacy, legacyFor: "Windows PowerShell 5.1" }];
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

function installOne(target, shell, { dryRun, force = false }) {
  const existing = fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : "";
  const state = managedBlockState(existing);
  // `force` rewrites a block that is already there, which is what an upgrade
  // needs: the block's *contents* can change between CLI versions, so
  // "complete" is not the same as "current".
  if (state === "complete" && !force) return { ...target, changed: false, reason: "already-installed" };
  if (dryRun) return { ...target, changed: true, dryRun: true };
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  const block = managedBlock(shell);
  if (target.kind === "file") fs.writeFileSync(target.file, block, { mode: 0o644 });
  else {
    // Replacing means dropping the old block first, then appending the new one,
    // so a refresh cannot leave two blocks (or stale text) behind.
    const clean = (force || state === "damaged") ? removeManagedBlocks(existing) : existing;
    const prefix = clean && !clean.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(target.file, clean + prefix + "\n" + block, { mode: 0o644 });
  }
  // A no-op write (the block was already exactly right) reports the same
  // reason the early return above does, so callers keep one code path.
  if (existing === fs.readFileSync(target.file, "utf8")) {
    return { ...target, changed: false, reason: "already-installed", repaired: false };
  }
  return { ...target, changed: true, repaired: state === "damaged" };
}

export function installCompletion(shell = detectShell(), { env = process.env, platformName = process.platform, dryRun = false } = {}) {
  const targets = completionTargets(shell, { env, platformName });
  const results = targets.map((target) => installOne(target, shell, { dryRun }));
  // The primary target drives the report. On Windows a second profile is
  // written for the other PowerShell; it is reported so the person can see
  // which files were touched rather than having one silently appear.
  return {
    ...results[0],
    additionalTargets: results.slice(1).map((entry) => ({
      file: entry.file,
      legacyFor: entry.legacyFor,
      changed: entry.changed,
      reason: entry.reason,
    })),
  };
}

// Re-apply the managed block to a profile that already carries one, and do
// nothing to a profile that does not. The generated script changes between CLI
// versions, so a block being present is not the same as it being current — but
// an upgrade is not consent to configure a shell the person never configured,
// which is why a profile with no block is left alone rather than created.
// On Windows this means one profile is refreshed and the other is still only
// written by an explicit `completion install`.
export function refreshCompletion(shell = detectShell(), { env = process.env, platformName = process.platform, dryRun = false } = {}) {
  const targets = completionTargets(shell, { env, platformName });
  const results = [];
  for (const target of targets) {
    const exists = fs.existsSync(target.file);
    const state = exists ? managedBlockState(fs.readFileSync(target.file, "utf8")) : "absent";
    if (state === "absent") continue;
    results.push(installOne(target, shell, { dryRun, force: true }));
  }
  return {
    refreshed: results.filter((entry) => entry.changed).map((entry) => entry.file),
    unchanged: results.filter((entry) => !entry.changed).map((entry) => entry.file),
    installed: results.length > 0,
  };
}

function quotePosixShellPath(file) {
  return `'${String(file).replaceAll("'", `'\\''`)}'`;
}

export function completionActivationCommand(shell, file) {
  if (shell === "powershell") return `. '${String(file).replaceAll("'", "''")}'`;
  if (["bash", "zsh", "fish"].includes(shell)) return `source ${quotePosixShellPath(file)}`;
  return null;
}

export function printCompletionActivationHint(shell, file, { lead = true } = {}) {
  const command = completionActivationCommand(shell, file);
  if (!command) return;
  if (lead) console.log("  Completion is saved for future terminals.");
  console.log(`  To enable it in this terminal now, run: ${command}`);
}

function uninstallOne(target, { dryRun }) {
  if (!fs.existsSync(target.file)) return { ...target, changed: false, reason: "not-installed" };
  const existing = fs.readFileSync(target.file, "utf8");
  if (managedBlockState(existing) === "absent") return { ...target, changed: false, reason: "not-managed" };
  if (dryRun) return { ...target, changed: true, dryRun: true };
  if (target.kind === "file") fs.unlinkSync(target.file);
  else fs.writeFileSync(target.file, removeManagedBlocks(existing));
  return { ...target, changed: true };
}

export function uninstallCompletion(shell = detectShell(), { env = process.env, platformName = process.platform, dryRun = false } = {}) {
  const targets = completionTargets(shell, { env, platformName });
  const results = targets.map((target) => uninstallOne(target, { dryRun }));
  // Report the primary target, but let a failure to remove the other
  // PowerShell's block surface instead of leaving it behind silently.
  const primary = results[0];
  if (primary.reason === "not-installed" || primary.reason === "not-managed") {
    const removed = results.find((entry) => entry.changed);
    if (removed) return { ...removed, reason: primary.reason, additionalTargets: [] };
  }
  return {
    ...primary,
    additionalTargets: results.slice(1).map((entry) => ({
      file: entry.file,
      legacyFor: entry.legacyFor,
      changed: entry.changed,
      reason: entry.reason,
    })),
  };
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
  // Windows has a second PowerShell with its own profile path; say so, so a
  // person who switched versions is not left wondering which file to check.
  for (const extra of result.additionalTargets || []) {
    const verb = action === "install"
      ? (extra.changed ? "Configured " : "Already configured ")
      : (extra.changed ? "Removed " : "No change ");
    console.log("  " + verb + (extra.legacyFor ? extra.legacyFor + " at " : "") + extra.file);
  }
  if (action === "install" && !result.dryRun) {
    // On Windows both profiles were written, and the CLI cannot tell which
    // PowerShell the person is sitting in. Naming only the PowerShell 7 path
    // would hand a 5.1 user a command that loads nothing, so print the
    // activation line for each file actually written.
    let lead = true;
    const seen = new Set();
    for (const file of [result.file, ...(result.additionalTargets || []).map((entry) => entry.file)]) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      printCompletionActivationHint(shell, file, { lead });
      lead = false;
    }
  }
}

export function printCompletion(shell) {
  console.log(completionScript(shell));
}
