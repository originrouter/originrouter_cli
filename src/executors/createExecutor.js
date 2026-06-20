import { PipeExecutor } from "./pipeExecutor.js";
import { PtyExecutor } from "./ptyExecutor.js";
import { TmuxExecutor } from "./tmuxExecutor.js";

export function createExecutor(kind) {
  if (kind === "pty") return new PtyExecutor();
  if (kind === "tmux") return new TmuxExecutor();
  return new PipeExecutor();
}
