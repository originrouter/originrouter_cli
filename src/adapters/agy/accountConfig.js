import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Inspect configuration selection only. Google credentials remain owned by
// the official executable and are never opened by OriginRouter.
export function assertAgyAccountConfig(args = [], { home = homedir() } = {}) {
  let settings = {};
  const path = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  if (existsSync(path)) settings = JSON.parse(readFileSync(path, 'utf8'));
  for (let i = 0; i < args.length; i++) {
    let override;
    if (args[i] === '--settings') override = args[++i];
    else if (args[i].startsWith('--settings=')) override = args[i].slice(11);
    if (override) {
      const data = override.trim().startsWith('{') ? override : readFileSync(override, 'utf8');
      settings = { ...settings, ...JSON.parse(data) };
    }
  }
  if (settings.modelProvider) throw new Error('OriginRouter agy supports the official Antigravity account login only. Remove the alternate modelProvider from your agy configuration to use this runtime.');
}
