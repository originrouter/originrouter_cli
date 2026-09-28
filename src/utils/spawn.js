import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { platform } from "node:os";

// Stage 8.6 spawn defaults cleanup + Windows .cmd shim hardening. This
// helper is NOT a full cross-spawn replacement. It adds these defaults to
// the child_process.spawn options passed by call sites:
//   - shell: false  — already what every candidate site passes
//                     today; centralized so future sites inherit it.
//   - windowsHide: true — Windows-only flag (no-op on macOS/Linux)
//                     that prevents a console window from flashing
//                     when an agent process is spawned on Windows.
//
// Windows .cmd/.bat shims (npm-installed commands like npm.cmd, claude.cmd,
// codex.cmd) cannot run through CreateProcess: Node >= 18.20 throws EINVAL
// (CVE-2024-27980 hardening) and spawn never finds them by bare name.
// spawnCommand routes those shims through cmd.exe and resolves bare names
// against PATH/PATHEXT so shim scripts are found.

const IS_WINDOWS = platform() === "win32";
export const CMD_SHIM_PATTERN = /\.(cmd|bat)$/i;
const WINDOWS_EXECUTABLE_EXTENSIONS = String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

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

// Quote a single argument per the MS C runtime rules Node uses when building
// a Windows command line. Only needed for the cmd.exe shim route where we
// build the command line ourselves.
export function quoteWindowsArgument(value) {
    if (value !== "" && !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, "$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

export function toWindowsCommandLine(command, args) {
    return [command, ...args].map(quoteWindowsArgument).join(" ");
}

// Resolve a bare command name (e.g. "claude") to a real executable on PATH.
// Returns the input unchanged when it already has an extension/path or when
// nothing is found (the spawn will fail with ENOENT as before).
export function resolveWindowsCommand(command) {
    if (path.isAbsolute(command) || command.includes("/") || command.includes("\\") || path.extname(command)) {
        return command;
    }
    const directories = String(process.env.PATH || "")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);
    for (const directory of directories) {
        for (const extension of WINDOWS_EXECUTABLE_EXTENSIONS) {
            const candidate = path.join(directory, `${command}${extension}`);
            try {
                if (fs.statSync(candidate).isFile()) return candidate;
            } catch {
                // Not here; keep scanning.
            }
        }
    }
    return command;
}

// Thin wrapper that applies SPAWN_DEFAULTS, resolves Windows command shims,
// and delegates to node:child_process.spawn. Caller-supplied options win.
export function spawnCommand(command, args, options = {}) {
    const mergedOptions = buildSpawnOptions(options);
    if (!IS_WINDOWS || mergedOptions.shell) {
        return spawn(command, args, mergedOptions);
    }
    const resolved = resolveWindowsCommand(command);
    if (!CMD_SHIM_PATTERN.test(resolved)) {
        return spawn(resolved, args, mergedOptions);
    }
    // Route the shim through cmd.exe. windowsVerbatimArguments passes our
    // pre-quoted single /c argument through untouched; /s tells cmd to strip
    // exactly the outer quotes we add around the whole command line.
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${toWindowsCommandLine(resolved, args)}"`], {
        ...mergedOptions,
        windowsVerbatimArguments: true,
    });
}
