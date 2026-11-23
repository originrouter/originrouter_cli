import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function parseAgyModels(text) {
  return String(text).split('\n').flatMap(line => {
    const m = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._/-]*)\t(.+)$/);
    return m ? [{ id: m[1], displayName: m[2].trim() }] : [];
  }).slice(0, 256);
}

export async function loadAgyCatalog(env) {
  const [models, version] = await Promise.allSettled([
    exec('agy', ['models'], { env, timeout: 15000, maxBuffer: 256000, windowsHide: true }),
    exec('agy', ['--version'], { env, timeout: 5000, maxBuffer: 16000, windowsHide: true }),
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
  return { mode: match[1], model: selected?.id || null };
}
