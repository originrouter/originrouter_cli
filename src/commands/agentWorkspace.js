import { cwd, stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { emitKeypressEvents } from "node:readline";

import { handleCollaborationCommand } from "./collaboration.js";
import {
  WORKSPACE_MODES,
  nextWorkspaceMode,
  normalizeCoordinator,
  normalizeWorkspaceMode,
  workspaceModeDefinition,
  workspaceModeSummary,
  workspaceRequiresPlanReview,
} from "../collaboration/workspaceModes.js";

const FORWARDED_FLAGS = new Set([
  "--detach",
  "--json",
  "--no-wait",
  "--plain",
  "--raw",
  "--review",
  "--verbose",
  "--yes",
  "--cloud-advice",
]);

function optionValue(argv, index, option) {
  const item = String(argv[index]);
  if (item.startsWith(`${option}=`)) return { value: item.slice(option.length + 1), consumed: 1 };
  if (index + 1 >= argv.length) throw new Error(`${option} requires a value.`);
  return { value: String(argv[index + 1]), consumed: 2 };
}

export function parseAgentWorkspaceArgs(argv = []) {
  const objective = [];
  const forwarded = [];
  let coordinator = "codex";
  let mode = "auto";
  for (let index = 0; index < argv.length;) {
    const item = String(argv[index]);
    if (item === "-c" || item === "--coordinator" || item.startsWith("--coordinator=")) {
      const parsed = item === "-c"
        ? optionValue(argv, index, "-c")
        : optionValue(argv, index, "--coordinator");
      coordinator = normalizeCoordinator(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (item === "-m" || item === "--mode" || item === "--team" || item.startsWith("--mode=") || item.startsWith("--team=")) {
      const option = item === "-m" ? "-m" : item.startsWith("--team") ? "--team" : "--mode";
      const parsed = optionValue(argv, index, option);
      mode = normalizeWorkspaceMode(parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (item === "--timeout" || item.startsWith("--timeout=")) {
      const parsed = optionValue(argv, index, "--timeout");
      forwarded.push("--timeout", parsed.value);
      index += parsed.consumed;
      continue;
    }
    if (FORWARDED_FLAGS.has(item)) {
      forwarded.push(item);
      index += 1;
      continue;
    }
    if (item.startsWith("-")) throw new Error(`Unknown Agent Workspace option '${item}'.`);
    objective.push(item);
    index += 1;
  }
  return {
    coordinator,
    mode,
    objective: objective.join(" ").trim(),
    forwarded,
  };
}

function workspaceHeader({ coordinator, mode }) {
  const directory = cwd().split(/[\\/]/).filter(Boolean).at(-1) || cwd();
  const selected = workspaceModeDefinition(mode);
  return [
    "OriginRouter Agent Workspace",
    `Workspace ${directory}`,
    `Team      ${selected.label}`,
    `Lead      ${coordinator === "codex" ? "Codex" : "Claude Code"}`,
    "Access    Guarded",
  ].join("\n");
}

function printModes(output) {
  output.write("\nCollaboration modes\n\n");
  for (const mode of WORKSPACE_MODES) {
    output.write(`  ${mode.label.padEnd(23)} ${mode.description}\n`);
  }
  output.write("\nUse /mode <name> or Shift+Tab to change mode.\n");
}

function printWorkspaceHelp(output) {
  output.write([
    "\nAgent Workspace commands",
    "",
    "  /mode [name]          Show or change collaboration mode",
    "  /coordinator <agent>  Use codex or claude as coordinator",
    "  /team                 Show the current mode",
    "  /help                 Show this help",
    "  /exit                 Exit Agent Workspace",
    "",
    "  Shift+Tab             Cycle collaboration mode",
    "",
  ].join("\n"));
}

function redrawPrompt(output, buffer, mode) {
  output.write(`\r\x1b[2K[${workspaceModeDefinition(mode).label}] > ${buffer}`);
}

async function readWorkspaceLine({ input, output, mode, onModeChange }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive Agent Workspace requires a terminal. Pass an objective, for example: originrouter \"fix the failing test\"");
  }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  let buffer = "";
  redrawPrompt(output, buffer, mode);
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.off("error", onError);
      input.setRawMode(false);
      input.pause();
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        resolve("/exit");
        return;
      }
      if (key.ctrl && key.name === "d" && !buffer) {
        cleanup();
        output.write("\n");
        resolve("/exit");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(buffer.trim());
        return;
      }
      if ((key.shift && key.name === "tab") || key.sequence === "\x1b[Z") {
        mode = onModeChange().id;
        redrawPrompt(output, buffer, mode);
        return;
      }
      if (key.name === "backspace") {
        buffer = [...buffer].slice(0, -1).join("");
        redrawPrompt(output, buffer, mode);
        return;
      }
      if (key.name === "escape" || key.ctrl || key.meta) return;
      if (text && !key.name?.startsWith("f")) {
        buffer += text;
        redrawPrompt(output, buffer, mode);
      }
    };
    input.on("keypress", onKeypress);
    input.once("error", onError);
  });
}

function collaborationArgs({ objective, coordinator, mode, forwarded }) {
  const args = [
    "create",
    objective,
    "--workspace-mode", mode,
    "--coordinator", coordinator,
    ...forwarded,
  ];
  const explicitlyReviewed = forwarded.includes("--review");
  const explicitlyConfirmed = forwarded.includes("--yes");
  if (!explicitlyReviewed && !explicitlyConfirmed && !workspaceRequiresPlanReview(objective, mode)) {
    args.push("--yes");
  }
  return args;
}

export async function handleAgentWorkspaceCommand(argv = [], {
  input = defaultInput,
  output = defaultOutput,
  collaborationRunner = handleCollaborationCommand,
} = {}) {
  const parsed = parseAgentWorkspaceArgs(argv);
  if (parsed.objective) {
    await collaborationRunner(collaborationArgs(parsed));
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Agent Workspace requires an interactive terminal when no objective is provided.");
  }
  let coordinator = parsed.coordinator;
  let mode = parsed.mode;
  output.write(`${workspaceHeader({ coordinator, mode })}\n\n`);
  output.write("Describe the outcome you want. OriginRouter will choose and manage the Agent team.\n");
  output.write("Use Shift+Tab to change collaboration mode or /help for commands.\n\n");
  while (true) {
    const line = await readWorkspaceLine({
      input,
      output,
      mode,
      onModeChange: () => {
        const next = nextWorkspaceMode(mode);
        mode = next.id;
        return next;
      },
    });
    if (!line) continue;
    if (["/exit", "/quit", "exit", "quit"].includes(line.toLowerCase())) return;
    if (line === "/help") {
      printWorkspaceHelp(output);
      continue;
    }
    if (line === "/mode") {
      printModes(output);
      continue;
    }
    if (line.startsWith("/mode ")) {
      mode = normalizeWorkspaceMode(line.slice(6));
      output.write(`Mode: ${workspaceModeSummary(mode)}\n`);
      continue;
    }
    if (line === "/team") {
      output.write(`Team: ${workspaceModeSummary(mode)} · Coordinator: ${coordinator}\n`);
      continue;
    }
    if (line.startsWith("/coordinator ")) {
      coordinator = normalizeCoordinator(line.slice(13));
      output.write(`Coordinator: ${coordinator === "codex" ? "Codex" : "Claude Code"}\n`);
      continue;
    }
    await collaborationRunner(collaborationArgs({
      objective: line,
      coordinator,
      mode,
      forwarded: parsed.forwarded,
    }));
    output.write("\nReady for another objective.\n");
  }
}
