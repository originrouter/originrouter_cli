import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { agyOption } from './nativeLaunch.js';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// The structured menus were exercised against 1.5.13 first. Later 1.5.x
// builds keep the same menu grammar — a minor or major bump is what should
// fall back to 'unsupported', not a patch release that still renders the same
// footer.
export function agyNativeMenusSupported(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === 1 && minor === 5 && patch >= 13;
}

export function parseAgyModels(text) {
  return String(text).split('\n').flatMap(line => {
    const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._/-]*)\t(.+)$/);
    return m ? [{ id: m[1], displayName: m[2].trim() }] : [];
  }).slice(0, 256);
}

function readSettings(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function agyLaunchSelection(args, home = homedir(), cwd = process.cwd()) {
  const base = readSettings(join(home, '.gemini', 'antigravity-cli', 'settings.json'));
  const override = agyOption(args, '--settings');
  let settings = {};
  if (override) {
    try { settings = JSON.parse(override); } catch { settings = readSettings(resolve(cwd, override)); }
  }
  const model = agyOption(args, '--model') || settings?.model || base?.model;
  const planner = settings?.orchestrator?.planner || base?.orchestrator?.planner;
  const levelSource = /^Orchestrator\b/i.test(model) ? planner : model;
  const effort = agyOption(args, '--effort') || settings?.effort || base?.effort
    || String(levelSource || '').match(/(?:-|\()(low|medium|high|xhigh|max)\)?$/i)?.[1];
  return { model: typeof model === 'string' ? model.trim() : null,
    effort: typeof effort === 'string' && /^(low|medium|high|xhigh|max)$/i.test(effort) ? effort.toLowerCase() : null };
}

export async function loadAgyCatalog(env, signal) {
  const [models, version] = await Promise.allSettled([
    exec('agy', ['models'], { env, signal, killSignal: 'SIGKILL', timeout: 45000, maxBuffer: 256000, windowsHide: true }),
    exec('agy', ['--version'], { env, signal, killSignal: 'SIGKILL', timeout: 5000, maxBuffer: 16000, windowsHide: true }),
  ]);
  return { models: models.status === 'fulfilled' ? parseAgyModels(models.value.stdout) : [],
    version: version.status === 'fulfilled' ? version.value.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] : null };
}

export function agyEffortVariants(models, current) {
  if (!Array.isArray(models)) return [];
  const selected = models.find(m => m.id === current);
  const base = selected?.displayName.replace(/\s*\((Low|Medium|High|Xhigh|Max)\)$/i, '');
  if (!base || base === selected.displayName) return [];
  return models.flatMap(m => {
    const match = m.displayName.match(/\s*\((Low|Medium|High|Xhigh|Max)\)$/i);
    return match && m.displayName.slice(0, match.index) === base ? [{ effort: match[1].toLowerCase(), model: m.id }] : [];
  });
}

export function agyFooterConfiguration(models, screen) {
  if (!Array.isArray(models)) return null;
  const statusArea = screen.trimEnd().split('\n').slice(-6).join('\n');
  const match = [...statusArea.matchAll(/\b(auto|plan|accept-edits)\s*·\s*([^\n]+)/g)].at(-1);
  if (!match) return null;
  const [name, effort] = match[2].split('·').map(x => x.trim());
  const candidates = models.filter(m => m.displayName.replace(/\s*\((Low|Medium|High|Xhigh|Max|Thinking)\)$/i, '') === name);
  const selected = candidates.length === 1 ? candidates[0] : candidates.find(m =>
    m.displayName.toLowerCase().endsWith(`(${effort?.toLowerCase()})`));
  return { mode: match[1], model: selected?.id || null, name,
    effort: /^(low|medium|high|xhigh|max)$/i.test(effort) ? effort.toLowerCase() : null };
}
