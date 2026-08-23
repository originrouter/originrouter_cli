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
    args: "[run-id]",
    description: "restore and follow a saved Run",
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

export function workspaceCommandUsage(command) {
  if (!command) return "";
  return `/${command.name}${command.args ? ` ${command.args}` : ""}`;
}
