import { randomUUID } from 'node:crypto';
import { RemoteTargetStore } from './remoteTargetStore.js';
import { SshConnectionManager } from './sshConnectionManager.js';
import { probeSshHostKey } from './hostKeyProbe.js';

function fail(code, message) { return Object.assign(new Error(message), {code}); }

// User-facing management operations. Model operations go through a separate
// authorization boundary and must never be routed to this management API.
export class RemoteEnvironmentService {
  constructor({stateDir, vault, probe = probeSshHostKey, managerFactory = (options) => new SshConnectionManager(options)} = {}) {
    this.probe = probe;
    this.store = new RemoteTargetStore({stateDir, ...(vault ? {vault} : {}),
      onChanged:(id, account) => this.manager.invalidateTarget(id, account)});
    this.manager = managerFactory({accountProvider:() => this.store.dir(),
      targetProvider:(id, account) => this.store.get(id, account),
      credentialProvider:(target, account) => this.store.getCredential(target, account)});
    // Retry removal of obsolete keychain entries left by a crash or a locked
    // store. A failure remains recorded and is reported by list/save/delete.
    void this.store.collectGarbage().catch(() => {});
  }
  async handle(action, body = {}) {
    switch (action) {
      case 'list': {
        const account = this.store.dir();
        return {targets:this.store.list().map((target) => ({...target, connection:this.manager.statusFor(target.id, account)})),
          sessions:this.manager.managementSessions(account),
          pendingCredentialCleanup:this.store.pendingCleanup()};
      }
      case 'close_session': {
        const account = this.store.dir();
        const result = await this.manager.closeManagedSession(body.id, body.handle, account);
        this.store.checkAccount(account);
        return result;
      }
      case 'probe': return this.probe({host:body.host, port:body.port == null ? 22 : Number(body.port)});
      case 'cleanup': {
        const account = this.store.dir();
        await this.store.collectGarbage(account);
        this.store.checkAccount(account);
        return {pendingCredentialCleanup:this.store.pendingCleanup()};
      }
      case 'save': {
        const account = this.store.dir();
        if (!body.target || body.confirmedFingerprint !== body.target.hostFingerprint) {
          throw fail('REMOTE_ENV_CONFIRM_FINGERPRINT', 'the SSH host fingerprint must be verified and confirmed');
        }
        const target = await this.store.save(body.target, {baseRevision:body.baseRevision ?? null, credential:body.credential ?? null});
        this.store.checkAccount(account);
        return {target, pendingCredentialCleanup:this.store.pendingCleanup()};
      }
      case 'delete': {
        const account = this.store.dir();
        const deleted = await this.store.remove(body.id, body.baseRevision);
        this.store.checkAccount(account);
        return {deleted, pendingCredentialCleanup:this.store.pendingCleanup()};
      }
      case 'test': {
        const account = this.store.dir();
        const owner = `user-test:${randomUUID()}`;
        const session = await this.manager.open(owner, body.id);
        await this.manager.close(owner, session.handle).catch(() => {});
        this.store.checkAccount(account);
        return {connected:true, cwd:session.cwd};
      }
      default: throw fail('REMOTE_ENV_INVALID', 'unknown remote environment action');
    }
  }
  close() { this.manager.shutdown(); this.store.shutdown(); }
}
