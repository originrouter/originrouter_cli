import { constants } from "node:os";
import { spawnCommand } from "../utils/spawn.js";
import { inheritSystemProxyEnv } from "../utils/systemProxy.js";
import { assertAgyAccountConfig } from '../adapters/agy/accountConfig.js';
import { extractOriginRouterOptions } from '../local/agentSessionPrimitives.js';

const NATIVE_VALUE_FLAGS = new Set(['--add-dir', '--agent', '--conversation', '--effort', '--input-format',
  '--json-schema', '--log-file', '--mode', '--model', '--new-project', '--output-format', '--print-timeout',
  '--project', '--settings', '--prompt-interactive', '-i', '--resume']);

// Decide from the invocation itself, never from whether an App or a terminal
// started the wrapper. In particular --prompt-interactive is a long-lived
// session, while the official --prompt alias really means --print.
export function classifyAgyNativeInvocation(args = []) {
  const { options, passthrough } = extractOriginRouterOptions(args);
  let direct = false;
  for (let index = 0; index < passthrough.length; index++) {
    const arg = passthrough[index];
    if (arg === '--') break;
    if (['--help', '-h', '--version', '-v', '--print', '-p', '--prompt'].includes(arg)
        || ['--print=', '--prompt='].some(prefix => arg.startsWith(prefix))) { direct = true; break; }
    if (NATIVE_VALUE_FLAGS.has(arg)) { index++; continue; }
    if (!arg.startsWith('-')) { direct = true; break; }
  }
  return { mode: direct ? 'native-command' : 'session', options, nativeArgs: passthrough };
}

// This is the native process entry, not an ACP client or a second process
// attached to a TUI. Structured App controls are negotiated separately.
export function buildAgyNativeLaunch(args = [], { env = process.env, cwd = process.cwd() } = {}) {
  if (args.some((arg) => arg === "--provider" || arg.startsWith("--provider="))) {
    throw new Error("Antigravity uses its native configuration; --provider is unavailable.");
  }
  return {
    command: "agy",
    args: args.filter((arg) => arg !== "--native-config"),
    cwd,
    env: inheritSystemProxyEnv(env),
    stdio: "inherit",
  };
}

export async function runAgyNativeSession(args) {
  const invocation = classifyAgyNativeInvocation(args);
  assertAgyAccountConfig(invocation.nativeArgs);
  // Informational subcommands and print-mode scripts keep the native pipe
  // behavior. Interactive runs use the existing registered PTY control path.
  if (invocation.mode === 'session') {
    buildAgyNativeLaunch(args); // Reject OriginRouter provider injection first.
    const { runLocalAgentSession } = await import('../local/localAgentSession.js');
    return runLocalAgentSession('agy', [...args, '--native-config']);
  }
  // Owned registration/permission flags never belong to the official
  // executable, including when it is invoked as a one-shot native command.
  buildAgyNativeLaunch(args); // Reject provider injection before stripping it.
  const { command, args: nativeArgs, ...options } = buildAgyNativeLaunch(invocation.nativeArgs);
  await new Promise((resolve, reject) => {
    const child = spawnCommand(command, nativeArgs, options);
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      handlers.set(signal, handler);
    }
    child.once("error", (error) => {
      cleanup();
      if (error.code === "ENOENT") {
        reject(new Error("Antigravity CLI (agy) was not found on PATH. Install it from https://antigravity.google/cli/install.sh or the official Windows installer."));
      } else reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal ? 128 + (constants.signals[signal] || 1) : 1);
      resolve();
    });
  });
}
