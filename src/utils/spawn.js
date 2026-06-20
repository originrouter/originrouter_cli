import { spawn } from "node:child_process";

// Stage 8.6 spawn defaults cleanup. This helper is NOT a
// cross-spawn replacement. We add two extra defaults to the
// child_process.spawn options passed by call sites:
//   - shell: false  — already what every candidate site passes
//                     today; centralized so future sites inherit it.
//   - windowsHide: true — Windows-only flag (no-op on macOS/Linux)
//                     that prevents a console window from flashing
//                     when an agent process is spawned on Windows.
//
// `cross-spawn` migration (for .cmd / .ps1 shim safety) remains
// deferred to platform hardening.

export const SPAWN_DEFAULTS = Object.freeze({
  shell: false,
  windowsHide: true,
});

// Pure function: caller options override defaults. This is the
// part tests cover directly — no spawn() involved. Splitting
// buildSpawnOptions out from spawnCommand keeps the option-merge
// logic testable without monkey-patching node:child_process.spawn
// (which is a static ESM import that cannot be reliably patched).
export function buildSpawnOptions(options = {}) {
  return {
    ...SPAWN_DEFAULTS,
    ...options,
  };
}

// Thin wrapper that applies SPAWN_DEFAULTS and delegates to
// node:child_process.spawn. Caller-supplied options win.
export function spawnCommand(command, args, options = {}) {
  return spawn(command, args, buildSpawnOptions(options));
}
