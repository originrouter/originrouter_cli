import { HeadlessCredentialVault } from './headlessCredentialVault.js';

// SSH secrets live in the operating system's persistent credential store.
// Linux must use Secret Service explicitly: the library's default fallback to
// the kernel keyring loses credentials after reboot, which is unsafe to present
// as persistent configuration for unattended servers.
const SERVICE = 'com.originrouter.ssh-environments.v1';
function unavailable() {
  return Object.assign(new Error('Persistent system credential storage is unavailable or locked'), {code:'REMOTE_ENV_SECRET_STORE_UNAVAILABLE'});
}

export class SystemCredentialVault {
  constructor({ Entry = null } = {}) { this.Entry = Entry; }
  identity() { return 'system-v1'; }
  async entry(key) {
    try {
      const Entry = this.Entry || (await import('@napi-rs/keyring')).AsyncEntry;
      return new Entry(SERVICE, key, {linux:{store:'secret-service'}});
    } catch { throw unavailable(); }
  }
  async put(key, value) {
    try { await (await this.entry(key)).setPassword(JSON.stringify(value)); }
    catch { throw unavailable(); }
  }
  async get(key) {
    try {
      const value = await (await this.entry(key)).getPassword();
      if (value == null) throw new Error('missing');
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      return parsed;
    } catch { throw unavailable(); }
  }
  async remove(key) {
    try { return await (await this.entry(key)).deleteCredential(); }
    catch { throw unavailable(); }
  }
}

export function createCredentialVault({stateDir, env = process.env} = {}) {
  const keyFile = String(env.ORIGINROUTER_SSH_VAULT_KEY_FILE || '').trim();
  return keyFile ? new HeadlessCredentialVault({stateDir,keyFile}) : new SystemCredentialVault();
}
