// Reports what our transport override replaced, and where it cannot reach.
//
// Motivation: the override mechanism itself is only half the fix. The failure
// this module exists for looked like a routing bug but was a visibility bug —
// the route resolved correctly, the session used a stale ~/.claude/settings.json
// instead, and nothing anywhere said so. One line of output turns that into a
// ten-second diagnosis.

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Filesystem settings layers that our --settings (flagSettings) layer
// outranks. Project/local settings live in the workspace, so they are read
// relative to the session cwd.
export function claudeUserSettingsPaths(cwd = process.cwd()) {
  const home = homedir();
  return [
    { source: "~/.claude/settings.json", path: join(home, ".claude", "settings.json") },
    { source: ".claude/settings.json", path: join(cwd, ".claude", "settings.json") },
    { source: ".claude/settings.local.json", path: join(cwd, ".claude", "settings.local.json") },
  ];
}

// Enterprise managed settings. This layer (policySettings) outranks
// flagSettings by design in Claude Code, so an env key set here wins over
// ours and we can only report it.
export function claudeManagedSettingsPaths() {
  if (platform() === "darwin") {
    return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  }
  if (platform() === "win32") {
    const programData = process.env.ProgramData;
    return programData
      ? [join(programData, "ClaudeCode", "managed-settings.json")]
      : [];
  }
  return ["/etc/claude-code/managed-settings.json"];
}

function readJsonIfPresent(path) {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // An unreadable or malformed settings file is Claude Code's problem to
    // report, not a reason to fail the launch.
    return null;
  }
}

export function readClaudeForeignSettings(cwd = process.cwd()) {
  const layers = [];
  for (const { source, path } of claudeUserSettingsPaths(cwd)) {
    const settings = readJsonIfPresent(path);
    if (settings) layers.push({ source, settings, outranksUs: false });
  }
  for (const path of claudeManagedSettingsPaths()) {
    const settings = readJsonIfPresent(path);
    if (settings) layers.push({ source: path, settings, outranksUs: true });
  }
  return layers;
}

// One line per settings file we actually collided with. Key names only, never
// values: these files hold API keys.
export function formatClaudeSettingsConflicts(override, layers, describeConflicts) {
  if (!override) return [];
  const lines = [];
  for (const layer of layers) {
    const keys = describeConflicts(override, layer.settings);
    if (keys.length === 0) continue;
    lines.push(layer.outranksUs
      ? `[originrouter] ${layer.source} is enterprise-managed and outranks OriginRouter for: `
        + `${keys.join(", ")}. Those keys keep the managed values; the session may not follow `
        + "your OriginRouter route."
      : `[originrouter] using OriginRouter routing instead of ${layer.source} for: `
        + `${keys.join(", ")}.`);
  }
  return lines;
}
