import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Preserve user servers; do not put session IDs or credentials in global config.
export async function configureAgyDeviceMcp({ home = homedir(), remove = false } = {}) {
  const target = join(home, '.gemini/config/mcp_config.json');
  const forwarder = join(home, '.gemini/config/originrouter/agy-device-mcp-forwarder.cjs');
  mkdirSync(dirname(target), { recursive: true });
  const lock = `${target}.originrouter-lock`;
  let acquired = false;
  for (let i = 0; i < 40; i++) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') rmSync(lock, { recursive: true, force: true }); }
        } else throw new Error('invalid_lock_owner');
      } catch {
        try { if (Date.now() - statSync(lock).mtimeMs > 60000) rmSync(lock, { recursive: true, force: true }); } catch {}
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }
  if (!acquired) throw new Error('Antigravity MCP configuration is busy');
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    const original = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const config = original ? JSON.parse(original) : {};
    if (!config || Array.isArray(config) || typeof config !== 'object'
        || (config.mcpServers != null && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw new Error('Invalid Antigravity MCP configuration');
    config.mcpServers ||= {};
    // Keep a distinct name: ACP may inject its own session-scoped originrouter_device.
    const name = 'originrouter_native_device';
    const existing = config.mcpServers[name];
    if (existing && existing.args?.[0] !== forwarder) throw new Error(`The ${name} MCP name is already in use`);
    const legacyOwned = config.mcpServers.originrouter_device?.args?.[0] === forwarder;
    if (legacyOwned) delete config.mcpServers.originrouter_device;
    if (remove) delete config.mcpServers[name];
    else {
      mkdirSync(dirname(forwarder), { recursive: true });
      writeFileSync(temporary, readFileSync(fileURLToPath(new URL('../../../scripts/agy-device-mcp-forwarder.cjs', import.meta.url))), { mode: 0o600 });
      renameSync(temporary, forwarder);
      config.mcpServers[name] = { command: process.execPath, args: [forwarder], timeout: 720000 };
    }
    const content = JSON.stringify(config, null, 2) + '\n';
    if (content !== original && !(remove && !existing && !legacyOwned)) {
      writeFileSync(temporary, content, { mode: 0o600 });
      if ((existsSync(target) ? readFileSync(target, 'utf8') : '') !== original) throw new Error('Antigravity MCP configuration changed during setup');
      renameSync(temporary, target);
    }
    if (remove && (existing || legacyOwned)) rmSync(forwarder, { force: true });
    return { path: target };
  } finally { rmSync(temporary, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}
