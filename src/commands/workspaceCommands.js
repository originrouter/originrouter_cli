const COMMANDS = [
  {
    name: "help",
    description: "show available Workspace commands",
  },
  {
    name: "status",
    description: "show workspace settings and the most recent Run",
  },
  {
    name: "runs",
    aliases: ["run"],
    args: "[active|recent|all]",
    description: "list collaboration Runs",
  },
  {
    name: "resume",
    args: "<session-id>",
    description: "restore a Workspace Session at its latest Run",
  },
  {
    name: "attach",
    args: "<run-id>",
    description: "follow an existing Run without creating one",
  },
  {
    name: "pause",
    args: "[run-id]",
    description: "pause the current or named Run",
  },
  {
    name: "retry",
    args: "[run-id]",
    description: "retry the current or named Run",
  },
  {
    name: "cancel",
    args: "[run-id]",
    description: "cancel the current or named Run",
  },
  {
    name: "agents",
    args: "[run-id]",
    description: "show Agents assigned to a Run",
  },
  {
    name: "new",
    description: "start a fresh collaboration after a completed Run",
  },
  {
    name: "mode",
    args: "[name]",
    description: "show or change the collaboration mode",
  },
  {
    name: "approval",
    args: "[profile|policy]",
    description: "show or change Session approval",
  },
  {
    name: "coordinator",
    args: "<codex|claude>",
    description: "choose the preferred coordinator",
  },
  {
    name: "team",
    description: "show the next collaboration team",
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "leave OriginRouter",
  },
];

export const WORKSPACE_COMMANDS = Object.freeze(
  COMMANDS.map((command) => Object.freeze({ ...command, aliases: Object.freeze(command.aliases || []) })),
);

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/^\/+/, "");
}

export function findWorkspaceCommand(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  return WORKSPACE_COMMANDS.find((command) => (
    command.name === normalized || command.aliases.includes(normalized)
  )) || null;
}

export function parseWorkspaceCommand(input) {
  const text = String(input || "").trim();
  if (!text.startsWith("/")) return null;
  const [rawName = "", ...args] = text.slice(1).split(/\s+/);
  const command = findWorkspaceCommand(rawName);
  return {
    rawName,
    command,
    args,
    argumentText: args.join(" "),
  };
}

export function workspaceCommandSuggestions(input, { limit = 6 } = {}) {
  const text = String(input || "").trimStart();
  if (!text.startsWith("/") || /\s/.test(text.slice(1))) return [];
  const prefix = normalizeName(text);
  return WORKSPACE_COMMANDS
    .filter((command) => command.name.startsWith(prefix) || command.aliases.some((alias) => alias.startsWith(prefix)))
    .slice(0, Math.max(1, Number(limit) || 6));
}

const DEFAULT_COMMAND_ARGUMENTS = Object.freeze({
  runs: Object.freeze([
    { value: "active", description: "Running collaboration Runs." },
    { value: "recent", description: "Completed, failed, and cancelled Runs." },
    { value: "all", description: "Every saved collaboration Run." },
  ]),
  mode: Object.freeze([
    { value: "auto", description: "Choose the smallest safe team." },
    { value: "solo", description: "Use one managed Agent." },
    { value: "build_review", description: "Implement, then independently review." },
    { value: "plan_build_verify", description: "Plan, implement, and verify." },
    { value: "parallel_research", description: "Investigate in parallel before synthesis." },
    { value: "review_panel", description: "Compare independent proposals." },
    { value: "remote_ops", description: "Coordinate a trusted remote device." },
  ]),
  approval: Object.freeze([
    { value: "manual", description: "Ask before every child Agent permission." },
    { value: "guarded", description: "Allow routine work and ask for elevated actions." },
    { value: "ai_review", description: "Have an independent reviewer assess requests." },
    { value: "unrestricted", description: "Allow actions without Session approval." },
    { value: "custom:protected", description: "Use the built-in Rules policy." },
  ]),
  coordinator: Object.freeze([
    { value: "codex", description: "Prefer Codex as the coordinator." },
    { value: "claude", description: "Prefer Claude as the coordinator." },
  ]),
});

function completionCandidate(value) {
  if (typeof value === "string") return { value, description: "", aliases: [] };
  return {
    value: String(value?.value || ""),
    description: String(value?.description || ""),
    aliases: Array.isArray(value?.aliases) ? value.aliases.map((alias) => String(alias)) : [],
  };
}

function matchingCandidates(candidates, prefix) {
  const normalizedPrefix = String(prefix || "").toLowerCase();
  return candidates
    .map(completionCandidate)
    .filter((candidate) => candidate.value && (
      candidate.value.toLowerCase().startsWith(normalizedPrefix)
      || candidate.aliases.some((alias) => alias.toLowerCase().startsWith(normalizedPrefix))
    ));
}

/**
 * Return selectable slash-command suggestions for a composer buffer.
 *
 * The suggestions carry the exact replacement text. Consumers must insert it
 * on an explicit completion action; rendering a suggestion never changes the
 * submitted command.
 */
export function workspaceInputSuggestions(input, {
  limit = 6,
  modeOptions = DEFAULT_COMMAND_ARGUMENTS.mode,
  approvalOptions = DEFAULT_COMMAND_ARGUMENTS.approval,
  runIds = [],
  sessionIds = [],
} = {}) {
  const text = String(input || "").trimStart();
  const max = Math.max(1, Number(limit) || 6);
  const commandNameMatch = text.match(/^\/([^\s]*)$/);
  if (commandNameMatch) {
    const prefix = normalizeName(commandNameMatch[1]);
    return WORKSPACE_COMMANDS
      .filter((command) => command.name.startsWith(prefix)
        || command.aliases.some((alias) => alias.startsWith(prefix)))
      .slice(0, max)
      .map((command) => ({
        kind: "command",
        value: `/${command.name}${command.args ? " " : ""}`,
        label: workspaceCommandUsage(command),
        description: command.description,
        command,
      }));
  }

  const argumentMatch = text.match(/^\/([^\s]+)\s+([^\s]*)$/);
  if (!argumentMatch) return [];
  const command = findWorkspaceCommand(argumentMatch[1]);
  if (!command) return [];

  let candidates = [];
  if (command.name === "runs") candidates = DEFAULT_COMMAND_ARGUMENTS.runs;
  if (command.name === "mode") candidates = modeOptions;
  if (command.name === "approval") candidates = approvalOptions;
  if (command.name === "coordinator") candidates = DEFAULT_COMMAND_ARGUMENTS.coordinator;
  if (command.name === "resume") {
    candidates = [...new Set(sessionIds.map((sessionId) => String(sessionId || "").trim()).filter(Boolean))]
      .map((sessionId) => ({ value: sessionId, description: "Saved Workspace Session." }));
  }
  if (["attach", "pause", "retry", "cancel", "agents"].includes(command.name)) {
    candidates = [...new Set(runIds.map((runId) => String(runId || "").trim()).filter(Boolean))]
      .map((runId) => ({ value: runId, description: "Saved collaboration Run." }));
  }

  return matchingCandidates(candidates, argumentMatch[2])
    .slice(0, max)
    .map((candidate) => ({
      kind: "argument",
      value: `/${command.name} ${candidate.value}`,
      label: candidate.value,
      description: candidate.description,
      command,
    }));
}

/** Return the selected completion without mutating the input buffer. */
export function completeWorkspaceCommandInput(input, options = {}) {
  const suggestions = workspaceInputSuggestions(input, options);
  if (!suggestions.length) return null;
  const requested = Number(options.selection || 0);
  const index = Math.max(0, Math.min(suggestions.length - 1, Number.isFinite(requested) ? requested : 0));
  return suggestions[index];
}

export function workspaceCommandUsage(command) {
  if (!command) return "";
  return `/${command.name}${command.args ? ` ${command.args}` : ""}`;
}
