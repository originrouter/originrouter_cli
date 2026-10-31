// The reasoning effort of a run.
//
// One vocabulary, two runtimes. The App's picker lists the levels a reader
// may choose and sends the wire value; the device applies it to the runtime
// that is answering the run. The wire values are lowercase because that is
// how both runtimes spell them:
//
//   Claude (Agent SDK)  low | medium | high | xhigh        — `none` is
//                       `alwaysThinkingEnabled: false`, and `max` exists
//                       only as the launch-time `--effort` flag, never as a
//                       setting a running session can hold.
//   Codex (app-server)  none | minimal | low | medium | high | xhigh | max |
//                       ultra
//
// The app-server also knows `persistent`, which asks for reasoning to persist
// across turns. That is a session's behaviour rather than a level of this
// turn, so it is not a level the App sends: the list below is the levels a
// turn can run on.
//
// So the levels a device publishes are the ones *its* runtime can apply to a
// running turn, and the App draws exactly those. A level the runtime cannot
// take is a row that fails when tapped, and the App does not offer rows that
// fail.

export const AGENT_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

// What a session runs on before anyone picks a level. Both runtimes land
// near it: Codex's protocol default is `medium`, and Claude's own default is
// `high` — the device states its own when it knows it.
export const DEFAULT_AGENT_EFFORT = "medium";

// Claude's settings layer holds four levels, plus the one that turns
// thinking off. `max` is deliberately absent: it is a launch flag, and a
// running session has no way to take it.
export const CLAUDE_EFFORT_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
];

// The app-server takes every level the App knows, including `max`, and two
// the App's shared list did not have to name: `minimal` below `low`, and
// `ultra` above `max`.
export const CODEX_EFFORT_LEVELS = [...AGENT_EFFORT_LEVELS];

// The terminal's slider offers these five, in this order, and applies one of
// them to a running session for that session alone. `none` is not among
// them: the terminal has no way to turn thinking off, only to choose how
// much of it there is.
export const CLAUDE_PTY_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// The wire value of a level, or null when it is not a level at all.
export function normalizeAgentEffort(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  return AGENT_EFFORT_LEVELS.includes(text) ? text : null;
}

// The levels a runtime can apply to a running turn.
//
// The terminal is not in this list: its levels are the ones its own slider
// offers, and whether it has a slider at all is something the terminal says
// when it draws its effort badge — not something a table can say for it.
export function effortLevelsForRuntime(runtime) {
  if (runtime === "codex-app-server") return [...CODEX_EFFORT_LEVELS];
  if (runtime === "claude-sdk") return [...CLAUDE_EFFORT_LEVELS];
  return [];
}

// The settings a Claude session applies to reach a level.
//
// `none` is not a level of thinking but the absence of it, so it is the
// flag that turns thinking off rather than an `effortLevel`. Every other
// level turns thinking back on, because a session that was put on `none` is
// still carrying that flag when the reader asks for a level again.
export function claudeEffortSettings(level) {
  if (level === "none") return { alwaysThinkingEnabled: false };
  return { effortLevel: level, alwaysThinkingEnabled: true };
}

// The levels a model supports, as our catalogue states them.
//
// The catalogue is where we say what a model can do: a model entry's
// `metadata.reasoning` holds `enabled`, and `effort_levels` holds the levels
// themselves. Nothing else fixes the spelling, so the reader takes the keys
// the list may be written under and the shapes a level may be written in —
// a bare word, or the `{effort, description}` pair the app-server speaks.
//
// A level the App has no name for is still a level: the catalogue says the
// model takes it, and the catalogue is what decides.
const EFFORT_LEVEL_KEYS = [
  "effort_levels",
  "effortLevels",
  "levels",
  "supported_reasoning_levels",
  "supportedReasoningEfforts",
  "supported_reasoning_efforts",
  "reasoning_levels",
];

// The levels written in one place, in the order they were written.
//
// Unknown words are dropped: a level the runtime cannot spell is a row that
// fails when it is tapped.
export function effortLevelsFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return [];
  const sources = [];
  const reasoning = metadata.reasoning;
  if (reasoning && typeof reasoning === "object") sources.push(reasoning);
  sources.push(metadata);
  for (const source of sources) {
    for (const key of EFFORT_LEVEL_KEYS) {
      const levels = readEffortLevelList(source[key]);
      if (levels.length) return levels;
    }
  }
  return [];
}

// The levels of one model, read out of a catalogue.
//
// The catalogue is a list of model entries: `{id, effortLevels}` or
// `{id, metadata}`. An empty answer means the catalogue does not know this
// model — which is a different thing from the model having no levels, and
// the caller decides what to do about it.
export function effortLevelsForModel(modelId, catalogue) {
  const id = String(modelId || "").trim();
  if (!id || !Array.isArray(catalogue)) return [];
  const entry = catalogue.find((item) => String(item?.id || "").trim() === id);
  if (!entry) return [];
  if (Array.isArray(entry.effortLevels) && entry.effortLevels.length) {
    return entry.effortLevels
      .map((level) => String(level || "").trim().toLowerCase())
      .filter((level) => AGENT_EFFORT_LEVELS.includes(level));
  }
  return effortLevelsFromMetadata(entry.metadata);
}

function readEffortLevelList(value) {
  if (!Array.isArray(value)) return [];
  const levels = [];
  for (const item of value) {
    const word =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? String(item.effort ?? item.reasoning_effort ?? item.level ?? "")
          : "";
    const level = word.trim().toLowerCase();
    if (!level || !AGENT_EFFORT_LEVELS.includes(level)) continue;
    if (levels.includes(level)) continue;
    levels.push(level);
  }
  return levels;
}
