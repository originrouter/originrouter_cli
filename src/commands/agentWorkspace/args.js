import {
  normalizeCoordinator,
  normalizeWorkspaceMode,
} from "../../collaboration/workspaceModes.js";

const FORWARDED_FLAGS = new Set([
  "--detach",
  "--json",
  "--no-wait",
  "--plain",
  "--raw",
  "--review",
  "--verbose",
  "--yes",
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
  if (forwarded.includes("--yes") && forwarded.includes("--review")) {
    throw new Error("--yes and --review cannot be used together.");
  }
  return {
    coordinator,
    mode,
    objective: objective.join(" ").trim(),
    forwarded,
  };
}
