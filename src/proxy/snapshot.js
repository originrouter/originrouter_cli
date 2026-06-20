// Stage 4: small helpers for handing proxy status to the three launchers
// (local / SDK / daemon).
//
// `buildAgentProviderEnv()` is synchronous and reads `options.proxyStatus()`
// synchronously, so the launcher must pass a function that returns a frozen
// snapshot — NOT a Promise. Daemon paths resolve the snapshot once at
// session-startup time and pass the resolved object as `proxyStatus`.

import { readProxyState } from "../persistence/state.js";

export const NOOP_PROXY_SNAPSHOT = Object.freeze({
  state: "not-installed",
  port: null,
  version: null,
  pid: null,
  host: null,
  currentProvider: null,
  mode: null,
  routesHash: null,
  aliases: [],
});

// Synchronous factory: returns `() => snapshot`. Used by all three
// launchers. `snapshot` should be frozen so the launcher can't mutate it.
export function staticProxyStatusFn(snapshot = NOOP_PROXY_SNAPSHOT) {
  return () => snapshot;
}

function isPidPresent(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but the current user/sandbox cannot
    // signal it. Treat it as present; the health endpoint/status command can
    // do the stronger check.
    return error?.code === "EPERM";
  }
}

// Synchronous helper for direct CLI launchers (`originrouter claude` and
// `originrouter claude-sdk`). They cannot await ProxyManager.status() inside
// buildAgentProviderEnv(), so they read the persisted process snapshot and do
// the cheap pid-presence check here.
export function readLocalProxySnapshot() {
  try {
    const state = readProxyState();
    if (!state || state.state !== "running") return NOOP_PROXY_SNAPSHOT;
    if (!isPidPresent(state.pid)) return { ...NOOP_PROXY_SNAPSHOT, state: "stopped", currentProvider: state.provider || null };
    return Object.freeze({
      state: "running",
      port: state.port,
      version: state.version_pinned || state.version || null,
      pid: state.pid,
      host: state.host || "127.0.0.1",
      currentProvider: state.provider || null,
      mode: state.mode || "provider",
      routesHash: state.routesHash || null,
      aliases: state.aliases || [],
      startedAt: state.startedAt,
      configPath: state.configPath,
      logPath: state.logPath,
    });
  } catch {
    return NOOP_PROXY_SNAPSHOT;
  }
}

// Async helper for the daemon: takes a snapshot once at session startup,
// freezes it, and returns a sync getter. Failures degrade to NOOP_PROXY_SNAPSHOT
// (the launcher's legacy hard-error path will trigger for openai-compatible
// providers, which is the safe default).
export async function snapshotProxyStatus(proxyManager) {
  if (!proxyManager || typeof proxyManager.status !== "function") {
    return NOOP_PROXY_SNAPSHOT;
  }
  try {
    const snap = await proxyManager.status();
    return Object.freeze({ ...snap });
  } catch {
    return NOOP_PROXY_SNAPSHOT;
  }
}
