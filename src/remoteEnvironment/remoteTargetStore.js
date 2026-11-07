import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir } from '../persistence/state.js';
import { activeAccountStateDir } from '../persistence/accounts.js';
import { createCredentialVault } from './credentialVault.js';

function fail(code, message) { return Object.assign(new Error(message), {code}); }
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw fail('REMOTE_ENV_INVALID', `${name} is invalid`);
  return value.trim();
}
function targetDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('REMOTE_ENV_INVALID', 'target is required');
  const id = text(raw.id, 'id', 64);
  if (!/^ssh_[A-Za-z0-9_-]{1,60}$/.test(id)) throw fail('REMOTE_ENV_INVALID', 'invalid target id');
  const name = text(raw.name, 'name', 120);
  const host = text(raw.host, 'host', 253);
  const username = text(raw.username, 'username', 255);
  const port = Number(raw.port ?? 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('REMOTE_ENV_INVALID', 'invalid SSH port');
  const hostFingerprint = text(raw.hostFingerprint, 'host fingerprint', 64).replace(/=+$/, '');
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostFingerprint)) throw fail('REMOTE_ENV_HOST_KEY_REQUIRED', 'a verified SHA256 host fingerprint is required');
  let defaultDirectory = null;
  if (raw.defaultDirectory != null && raw.defaultDirectory !== '') {
    defaultDirectory = text(raw.defaultDirectory, 'default directory', 4096);
    if (!defaultDirectory.startsWith('/')) throw fail('REMOTE_ENV_INVALID', 'default directory must be absolute');
  }
  return {id, name, host, port, username, hostFingerprint, defaultDirectory};
}
function normalizeCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('REMOTE_ENV_INVALID', 'credential is required');
  const allowed = (s, max) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= max && !s.includes('\0');
  if (value.kind === 'password' && allowed(value.password, 16_384)) return {kind:'password',password:value.password};
  if (value.kind === 'private_key' && allowed(value.privateKey, 128_000)
    && (value.passphrase == null || (typeof value.passphrase === 'string' && Buffer.byteLength(value.passphrase) <= 16_384 && !value.passphrase.includes('\0')))) {
    return {kind:'private_key',privateKey:value.privateKey,...(value.passphrase ? {passphrase:value.passphrase} : {})};
  }
  if (value.kind === 'agent' && allowed(value.agent, 4096) && !/[\r\n]/.test(value.agent)) return {kind:'agent',agent:value.agent};
  throw fail('REMOTE_ENV_INVALID', 'invalid SSH credential');
}

// Each account has its own database. Credential references are random and
// scoped to the account; actual secrets are stored in the selected secure vault.
export class RemoteTargetStore {
  constructor({stateDir = ensureStateDir(), vault = null, onChanged = () => {}} = {}) {
    this.stateDir = stateDir; this.vault = vault || createCredentialVault({stateDir}); this.onChanged = onChanged; this.db = null; this.openDir = null; this.mutations = Promise.resolve(); this.stopped = false;
  }
  serialize(operation) {
    const result = this.mutations.then(operation, operation);
    this.mutations = result.catch(() => {});
    return result;
  }
  dir() { return activeAccountStateDir(this.stateDir); }
  checkAccount(dir) {
    if (this.stopped) throw fail('REMOTE_ENV_CLOSED', 'remote environment store is closed');
    if (this.dir() !== dir) throw fail('REMOTE_ENV_ACCOUNT_CHANGED', 'account changed during remote environment operation');
  }
  vaultKey(dir, ref) { return `${createHash('sha256').update(dir).digest('hex')}:${ref}`; }
  database() {
    if (this.stopped) throw fail('REMOTE_ENV_CLOSED', 'remote environment store is closed');
    const dir = this.dir();
    if (this.db && this.openDir === dir) return this.db;
    this.close();
    mkdirSync(dir, {recursive:true,mode:0o700});
    const path = join(dir, 'remote-environments.sqlite3');
    const db = new Database(path);
    chmodSync(path, 0o600);
    db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 3000');
    db.exec(`CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL,
      credential_ref TEXT NOT NULL, auth_kind TEXT NOT NULL, updated_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_target_ids (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS credential_gc (ref TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db = db; this.openDir = dir; return db;
  }
  close() { if (this.db) this.db.close(); this.db = null; this.openDir = null; }
  ensureVaultIdentity(db) {
    const identity = typeof this.vault.identity === 'function' ? this.vault.identity() : 'injected-v1';
    db.transaction(() => {
      let saved = db.prepare("SELECT value FROM metadata WHERE key='credential_vault'").get()?.value;
      if (!saved) {
        // Data created before vault selection existed always used the OS vault.
        const hasData = db.prepare('SELECT 1 FROM targets UNION ALL SELECT 1 FROM credential_gc LIMIT 1').get();
        saved = hasData ? 'system-v1' : identity;
        db.prepare("INSERT INTO metadata(key,value) VALUES('credential_vault',?)").run(saved);
      }
      if (saved !== identity) {
        // Once every target and cleanup record is gone, switching vaults is
        // safe. Never switch while any encrypted credential still exists.
        const hasData = db.prepare('SELECT 1 FROM targets UNION ALL SELECT 1 FROM credential_gc LIMIT 1').get();
        if (!hasData) {
          db.prepare("UPDATE metadata SET value=? WHERE key='credential_vault'").run(identity);
          saved = identity;
        }
      }
      if (saved !== identity) throw fail('REMOTE_ENV_VAULT_MISMATCH', 'SSH credential vault or its key changed; restore the original vault configuration');
    }).immediate();
    return identity;
  }
  shutdown() { this.stopped = true; this.close(); }
  public(row) { return {...JSON.parse(row.document),revision:row.revision,authKind:row.auth_kind,updatedAt:new Date(row.updated_ms).toISOString()}; }
  list() { return this.database().prepare('SELECT * FROM targets ORDER BY updated_ms DESC, id').all().map((row) => this.public(row)); }
  pendingCleanup() { return this.database().prepare('SELECT COUNT(*) AS n FROM credential_gc').get().n; }
  get(id, dir = this.dir()) {
    this.checkAccount(dir);
    const row = this.database().prepare('SELECT * FROM targets WHERE id=?').get(id);
    return row ? {...this.public(row), credentialRef:row.credential_ref} : null;
  }
  async getCredential(target, dir) {
    this.checkAccount(dir);
    const identity = this.ensureVaultIdentity(this.database());
    const current = this.get(target.id, dir);
    if (!current || current.revision !== target.revision || current.credentialRef !== target.credentialRef) throw fail('REMOTE_ENV_CONFLICT', 'remote target changed');
    const credential = await this.vault.get(this.vaultKey(dir, current.credentialRef), {expectedIdentity:identity});
    this.checkAccount(dir);
    const again = this.get(target.id, dir);
    if (!again || again.revision !== target.revision || again.credentialRef !== target.credentialRef) throw fail('REMOTE_ENV_CONFLICT', 'remote target changed');
    return normalizeCredential(credential);
  }
  save(input, options = {}) {
    const dir = this.dir();
    return this.serialize(() => { this.checkAccount(dir); return this.saveNow(input, options, dir); });
  }
  async saveNow(input, {baseRevision = null, credential = null} = {}, dir = this.dir()) {
    const identity = this.ensureVaultIdentity(this.database());
    const document = targetDocument(input);
    const existing = this.get(document.id, dir);
    if (existing ? baseRevision !== existing.revision : baseRevision != null && baseRevision !== 0) throw fail('REMOTE_ENV_CONFLICT', 'remote target changed');
    if (!existing && this.database().prepare('SELECT 1 FROM deleted_target_ids WHERE id=?').get(document.id)) {
      throw fail('REMOTE_ENV_CONFLICT', 'remote target id was already used; create a new target');
    }
    const secret = credential == null ? null : normalizeCredential(credential);
    if (!existing && !secret) throw fail('REMOTE_ENV_INVALID', 'credential is required for a new target');
    const ref = secret ? `credential_${randomUUID()}` : existing.credentialRef;
    if (secret) {
      // Record cleanup intent before the keychain write. A crash between the
      // two stores cannot make an unreferenced secret permanently invisible.
      this.database().prepare('INSERT INTO credential_gc(ref) VALUES(?)').run(ref);
      await this.vault.put(this.vaultKey(dir, ref), secret, {expectedIdentity:identity});
      this.checkAccount(dir);
    }
    let saved;
    try {
      const db = this.database();
      saved = db.transaction(() => {
        const current = db.prepare('SELECT * FROM targets WHERE id=?').get(document.id);
        if (current ? current.revision !== baseRevision : baseRevision != null && baseRevision !== 0) throw fail('REMOTE_ENV_CONFLICT', 'remote target changed');
        if (!current && db.prepare('SELECT 1 FROM deleted_target_ids WHERE id=?').get(document.id)) throw fail('REMOTE_ENV_CONFLICT', 'remote target id was already used; create a new target');
        if (!current && db.prepare('SELECT COUNT(*) AS n FROM targets').get().n >= 128) throw fail('REMOTE_ENV_LIMIT', 'too many remote targets');
        const revision = (current?.revision || 0) + 1;
        db.prepare(`INSERT INTO targets(id,document,revision,credential_ref,auth_kind,updated_ms) VALUES(?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET document=excluded.document,revision=excluded.revision,credential_ref=excluded.credential_ref,auth_kind=excluded.auth_kind,updated_ms=excluded.updated_ms`)
          .run(document.id, JSON.stringify(document), revision, ref, secret?.kind || current.auth_kind, Date.now());
        if (secret) db.prepare('DELETE FROM credential_gc WHERE ref=?').run(ref);
        if (current && current.credential_ref !== ref) db.prepare('INSERT OR IGNORE INTO credential_gc(ref) VALUES(?)').run(current.credential_ref);
        return this.public(db.prepare('SELECT * FROM targets WHERE id=?').get(document.id));
      }).immediate();
    } catch (error) {
      if (secret) await this.collectGarbageNow(dir).catch(() => {});
      throw error;
    }
    this.onChanged(document.id, dir);
    await this.collectGarbageNow(dir).catch(() => {});
    return saved;
  }
  remove(id, baseRevision) {
    const dir = this.dir();
    return this.serialize(() => { this.checkAccount(dir); return this.removeNow(id, baseRevision, dir); });
  }
  async removeNow(id, baseRevision, dir = this.dir()) {
    const db = this.database();
    this.ensureVaultIdentity(db);
    const removed = db.transaction(() => {
      const row = db.prepare('SELECT * FROM targets WHERE id=?').get(id);
      if (!row) return false;
      if (row.revision !== baseRevision) throw fail('REMOTE_ENV_CONFLICT', 'remote target changed');
      db.prepare('INSERT OR IGNORE INTO credential_gc(ref) VALUES(?)').run(row.credential_ref);
      db.prepare('INSERT OR IGNORE INTO deleted_target_ids(id) VALUES(?)').run(id);
      db.prepare('DELETE FROM targets WHERE id=?').run(id);
      return true;
    }).immediate();
    if (removed) this.onChanged(id, dir);
    await this.collectGarbageNow(dir).catch(() => {});
    return removed;
  }
  collectGarbage(dir = this.dir()) { return this.serialize(() => this.collectGarbageNow(dir)); }
  async collectGarbageNow(dir) {
    this.checkAccount(dir);
    const refs = this.database().prepare('SELECT ref FROM credential_gc LIMIT 128').all();
    const identity = refs.length ? this.ensureVaultIdentity(this.database()) : null;
    for (const {ref} of refs) {
      await this.vault.remove(this.vaultKey(dir, ref), {expectedIdentity:identity});
      this.checkAccount(dir);
      this.database().prepare('DELETE FROM credential_gc WHERE ref=?').run(ref);
    }
  }
}
