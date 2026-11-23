import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGY_HOOK_KEY = 'originrouter-cli-v1';
export function agyHookBlock(script = fileURLToPath(new URL('../../../scripts/agy-session-hook-forwarder.cjs', import.meta.url))) {
  const quote = value => process.platform === 'win32' ? `"${value.replaceAll('"', '')}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const handler = { type: 'command', command: `${quote(process.execPath)} ${quote(script)}`, timeout: 300 };
  const block = Object.fromEntries(['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'].map(name => [name, [handler]]));
  for (const name of ['PreToolUse', 'PostToolUse']) block[name] = [{ matcher: '*', hooks: [handler] }];
  return block;
}

export async function configureAgyHooks({ home = homedir(), remove = false } = {}) {
  const target = join(home, '.gemini', 'config', 'hooks.json');
  const forwarder = join(home, '.gemini', 'config', 'originrouter', 'agy-session-hook-forwarder.cjs');
  mkdirSync(dirname(target), { recursive: true });
  const lock = `${target}.originrouter-lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      acquired = true; break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) { if (probe.code === 'ESRCH') rmSync(lock, { recursive: true, force: true }); }
        } else throw new Error('invalid_lock_owner');
      } catch {
        // A crash between mkdir and owner.json must not block every later launch.
        // A fresh incomplete lock may still belong to a live concurrent installer.
        try { if (Date.now() - statSync(lock).mtimeMs > 60000) rmSync(lock, { recursive: true, force: true }); } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw new Error('Antigravity Hook configuration is busy; retry this command');
  const temporary = `${target}.originrouter-${process.pid}.tmp`;
  try {
    const original = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const config = original ? JSON.parse(original) : {};
    if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Antigravity hooks.json must be an object');
    const existing = config[AGY_HOOK_KEY];
    if (existing && !JSON.stringify(existing).includes('agy-session-hook-forwarder.cjs')) {
      throw new Error(`Antigravity Hook name ${AGY_HOOK_KEY} is already in use`);
    }
    if (remove) delete config[AGY_HOOK_KEY];
    else {
      // Global configuration must not depend on an npm version directory or
      // a development checkout that the user can move/remove later.
      mkdirSync(dirname(forwarder), { recursive: true });
      const source = fileURLToPath(new URL('../../../scripts/agy-session-hook-forwarder.cjs', import.meta.url));
      const stagedForwarder = `${forwarder}.${process.pid}.tmp`;
      try {
        writeFileSync(stagedForwarder, readFileSync(source), { mode: 0o600 });
        renameSync(stagedForwarder, forwarder);
      } finally { rmSync(stagedForwarder, { force: true }); }
      config[AGY_HOOK_KEY] = agyHookBlock(forwarder);
    }
    const content = JSON.stringify(config, null, 2) + '\n';
    if (content === original || (remove && !existing)) return { path: target, changed: false };
    writeFileSync(temporary, content, { mode: 0o600 });
    if ((existsSync(target) ? readFileSync(target, 'utf8') : '') !== original) throw new Error('Antigravity Hook configuration changed during setup; retry');
    renameSync(temporary, target);
    if (remove) rmSync(forwarder, { force: true });
    return { path: target, changed: true };
  } finally { rmSync(temporary, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}
