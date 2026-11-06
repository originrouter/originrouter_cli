// Handing a terminal over from one conversation to another.
//
// Claude Code can switch conversations while it is running: `/resume` picks
// another conversation, `/branch` forks into a new one, `/clear` starts an
// empty one. Each of those swaps the conversation id and the transcript file
// under the running process, and the SessionStart hook fires again with the
// new id.
//
// That is a problem for us, because the running process is registered as one
// run of one conversation. Left alone the run keeps reporting itself as the
// conversation it started in, so the App shows the old conversation's
// messages under the new one's name, and two runs of the same conversation
// end up sharing one identity.
//
// The fix is to stop pretending the run survived the switch: close this run
// and open the other conversation as a new one. Restarting the *wrapper*
// rather than the agent underneath it is what makes that cheap. A fresh
// wrapper mints its own session id, registers itself, and resolves its
// conversation from scratch — none of which a running wrapper can do, because
// its session id is captured by value in a dozen places.
//
// The wrapper is re-executed rather than forked into the background: a
// detached child would land in its own process group, and the terminal's
// foreground group would be gone, taking the keyboard with it.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { claudeTranscriptPathForSession } from "../runtime/claudeConversationHistory.js";

// The wrapper's own entry point, next to the sources that re-execute it.
export function originrouterBinPath() {
  return fileURLToPath(new URL("../../bin/originrouter.js", import.meta.url));
}

// The command line for the replacement wrapper.
//
// The old `--resume` goes away whatever it pointed at, and the new one goes
// in right after the subcommand — before any `--` separator and before the
// flags that belong to the agent, so nothing can swallow it.
//
// `argv` is the wrapper's own argument vector (`process.argv.slice(2)`), so
// the replacement is the same invocation the reader typed, with one thing
// changed.
export function rewriteResumeArgv(argv, nativeSessionId) {
  const args = Array.isArray(argv) ? argv.map((arg) => String(arg)) : [];
  const kept = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--resume") {
      // The value belongs to the flag; drop both.
      index += 1;
      continue;
    }
    if (arg.startsWith("--resume=")) continue;
    kept.push(arg);
  }
  const resume = nativeSessionId ? ["--resume", String(nativeSessionId)] : [];
  return [kept[0] ?? "claude", ...resume, ...kept.slice(1)];
}

// The conversation the reader asked to open, if they named one.
//
// `--resume <id>` resumes that conversation. `--resume` on its own opens
// Claude Code's own picker, in which case the conversation is not known
// until the agent reports it — so there is nothing to check up front.
export function parseResumeArgv(args) {
  const list = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length).trim();
      return value || null;
    }
    if (arg === "--resume") {
      const next = list[index + 1];
      if (!next || next.startsWith("-")) return null;
      return next.trim() || null;
    }
  }
  return null;
}

// Where the handover should land.
//
// `target-open` means the conversation the reader asked for is being used
// somewhere else; we go back to the one they came from rather than leaving
// them with nothing.
//
// A conversation with no transcript of its own cannot be resumed — Claude
// Code would answer "no conversation found" — so a fresh start is the only
// way in. `/clear` produces exactly that: a new, empty conversation.
export function resolveHandoverTarget({
  fromNativeSessionId = null,
  toNativeSessionId = null,
  transcriptPath = null,
  cwd = process.cwd(),
  holder = null,
  transcriptPathFor = (nativeId) => claudeTranscriptPathForSession(cwd, nativeId),
  transcriptSize = defaultTranscriptSize,
} = {}) {
  const blocked = Boolean(holder);
  const target = blocked ? fromNativeSessionId : toNativeSessionId;
  const path = transcriptPathFor(target);
  const size = path ? transcriptSize(path) : 0;

  return {
    mode: size > 0 ? "resume" : "fresh",
    resumeNativeSessionId: size > 0 ? target : null,
    transcriptPath: path,
    reason: blocked ? "target-open" : "switch",
    holder,
  };
}

function defaultTranscriptSize(path) {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

// Start the replacement wrapper.
//
// The note travels in the environment rather than on the terminal: the
// replacement opens a full-screen agent UI, and anything printed before it
// starts is scrolled away.
export function spawnReplacementWrapper({
  argv,
  binPath = originrouterBinPath(),
  note = "",
  env = process.env,
  spawnFn = spawn,
} = {}) {
  const childEnv = note
    ? { ...env, ORIGINROUTER_HANDOFF_NOTE: String(note) }
    : env;
  return spawnFn(process.execPath, [binPath, ...argv], {
    stdio: "inherit",
    env: childEnv,
  });
}

// The note the previous run left for us, if any.
export function readHandoffNote(env = process.env) {
  const note = String(env.ORIGINROUTER_HANDOFF_NOTE || "").trim();
  return note || "";
}
