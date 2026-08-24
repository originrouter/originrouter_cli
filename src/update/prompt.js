import { emitKeypressEvents } from "node:readline";

export const UPDATE_SELECTIONS = Object.freeze(["update", "skip", "dismiss"]);

export function nextUpdateSelection(current, direction) {
  const index = Math.max(0, UPDATE_SELECTIONS.indexOf(current));
  const delta = direction === "up" ? -1 : 1;
  return UPDATE_SELECTIONS[(index + delta + UPDATE_SELECTIONS.length) % UPDATE_SELECTIONS.length];
}

export function updateSelectionForKey(current, key = {}, text = "") {
  if (key.ctrl && ["c", "d"].includes(key.name)) return { done: true, selection: "skip" };
  if (key.name === "escape") return { done: true, selection: "skip" };
  if (key.name === "return" || key.name === "enter") return { done: true, selection: current };
  if (key.name === "up" || text === "k") return { done: false, selection: nextUpdateSelection(current, "up") };
  if (key.name === "down" || text === "j") return { done: false, selection: nextUpdateSelection(current, "down") };
  if (text === "1") return { done: true, selection: "update" };
  if (text === "2") return { done: true, selection: "skip" };
  if (text === "3") return { done: true, selection: "dismiss" };
  return { done: false, selection: current };
}

export function renderUpdatePrompt({ currentVersion, latestVersion, selection = "update" }) {
  const options = [
    ["update", "Update now"],
    ["skip", "Skip"],
    ["dismiss", "Skip until next version"],
  ];
  const lines = [
    "",
    `  ✨ Update available!  ${currentVersion} → ${latestVersion}`,
    "",
    `  Release notes: https://github.com/originrouter/originrouter_cli/releases/tag/v${latestVersion}`,
    "",
    ...options.map(([id, label], index) => `${id === selection ? "›" : " "} ${index + 1}. ${label}`),
    "",
    "  ↑/↓ selects · Enter continues",
  ];
  return lines.join("\n");
}

export async function promptForUpdate({
  currentVersion,
  latestVersion,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!input.isTTY || !output.isTTY) return "skip";
  emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  let selection = "update";
  let renderedLines = 0;
  const render = () => {
    if (renderedLines > 0) output.write(`\x1b[${renderedLines}F\x1b[J`);
    const block = renderUpdatePrompt({ currentVersion, latestVersion, selection });
    renderedLines = block.split("\n").length;
    output.write(`${block}\n`);
  };
  input.setRawMode?.(true);
  input.resume();
  render();
  try {
    return await new Promise((resolve) => {
      const onKeypress = (text, key) => {
        const result = updateSelectionForKey(selection, key, text);
        selection = result.selection;
        if (result.done) {
          input.off("keypress", onKeypress);
          resolve(selection);
        } else {
          render();
        }
      };
      input.on("keypress", onKeypress);
    });
  } finally {
    input.setRawMode?.(wasRaw);
    if (!wasRaw) input.pause();
  }
}
