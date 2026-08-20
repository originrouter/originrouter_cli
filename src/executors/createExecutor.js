import { PipeExecutor } from "./pipeExecutor.js";
import { PtyExecutor } from "./ptyExecutor.js";
import { TmuxExecutor } from "./tmuxExecutor.js";

const EXECUTOR_KINDS = new Set(["pty", "pipe", "tmux"]);

// Normalizes a requested executor kind (from --executor / --originrouter-executor)
// to a value createExecutor understands. Unknown or missing values fall back to
// "pty", the default used everywhere today.
export function normalizeExecutor(kind) {
  if (typeof kind === "string" && EXECUTOR_KINDS.has(kind)) return kind;
  return "pty";
}

export function createExecutor(kind) {
  const normalized = normalizeExecutor(kind);
  if (normalized === "pty") return new PtyExecutor();
  if (normalized === "tmux") return new TmuxExecutor();
  return new PipeExecutor();
}
