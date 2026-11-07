import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';

const { Client } = ssh2;

const MAX_SESSIONS = 32;
const MAX_CONNECTIONS = 16;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function nonempty(value, field, limit = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw fail('REMOTE_ENV_INVALID', `${field} is invalid`);
  }
  return value;
}
function fingerprint(blob) {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}
function equalFingerprint(expected, received) {
  const a = Buffer.from(String(expected).replace(/=+$/, ''));
  const b = Buffer.from(received.replace(/=+$/, ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function directory(value) {
  const path = nonempty(value, 'directory', 4096);
  if (!path.startsWith('/') || /[\r\n]/.test(path)) throw fail('REMOTE_ENV_INVALID', 'directory must be an absolute path');
  return path;
}
function bounded(value, fallback, max) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw fail('REMOTE_ENV_INVALID', 'invalid execution limit');
  return value;
}

/**
 * Device-side SSH transports. This class intentionally has no API or storage
 * of its own: callers must authenticate the owner and supply a verified target
 * and its secret from device-owned storage. It never logs or returns credentials.
 */
export class SshConnectionManager {
  constructor({ targetProvider, credentialProvider, accountProvider, clientFactory = () => new Client(), idleMs = 5 * 60_000, now = () => Date.now() } = {}) {
    if (typeof targetProvider !== 'function' || typeof credentialProvider !== 'function' || typeof accountProvider !== 'function') {
      throw new TypeError('targetProvider, credentialProvider and accountProvider are required');
    }
    this.targetProvider = targetProvider;
    this.credentialProvider = credentialProvider;
    this.accountProvider = accountProvider;
    this.clientFactory = clientFactory;
    this.idleMs = idleMs;
    this.now = now;
    this.account = null;
    this.connections = new Map();
    this.sessions = new Map();
    this.pendingOpens = 0;
    this.pendingOwners = new Map();
    this.closed = false;
  }

  async currentAccount() {
    if (this.closed) throw fail('REMOTE_ENV_CLOSED', 'remote environment manager is closed');
    const account = nonempty(await this.accountProvider(), 'account', 512);
    if (this.account !== null && this.account !== account) this.closeAll();
    this.account = account;
    return account;
  }

  async open(owner, targetId, {expectedRevision = null} = {}) {
    owner = nonempty(owner, 'session owner', 191);
    if (this.sessions.size + this.pendingOpens >= MAX_SESSIONS) throw fail('REMOTE_ENV_LIMIT', 'too many open remote sessions');
    this.pendingOpens++;
    const token = {cancelled:false, entry:null};
    const pending = this.pendingOwners.get(owner) || new Set();
    pending.add(token);
    this.pendingOwners.set(owner, pending);
    try { return await this.openSession(owner, targetId, expectedRevision, token); }
    finally {
      this.pendingOpens--;
      pending.delete(token);
      if (!pending.size && this.pendingOwners.get(owner) === pending) this.pendingOwners.delete(owner);
    }
  }

  async openSession(owner, targetId, expectedRevision, token) {
    const checkOwner = () => { if (token.cancelled) throw fail('REMOTE_ENV_SESSION_ENDED', 'Agent session ended while the SSH connection was opening'); };
    owner = nonempty(owner, 'session owner', 191);
    targetId = nonempty(targetId, 'target id', 191);
    const account = await this.currentAccount();
    checkOwner();
    const target = await this.targetProvider(targetId, account);
    if (await this.currentAccount() !== account) throw fail('REMOTE_ENV_ACCOUNT_CHANGED', 'account changed before SSH connection');
    checkOwner();
    if (!target || target.id !== targetId) throw fail('REMOTE_ENV_NOT_FOUND', 'remote target not found');
    if (expectedRevision != null && target.revision !== expectedRevision) throw fail('REMOTE_ENV_CONFLICT', 'remote target changed after approval');
    const host = nonempty(target.host, 'host', 253);
    const username = nonempty(target.username, 'username', 255);
    const port = target.port == null ? 22 : Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('REMOTE_ENV_INVALID', 'invalid SSH port');
    if (typeof target.hostFingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}={0,2}$/.test(target.hostFingerprint)) {
      throw fail('REMOTE_ENV_HOST_KEY_REQUIRED', 'a verified SHA256 host fingerprint is required');
    }
    // A revision binds a transport to the exact configuration and secret version.
    const revision = nonempty(String(target.revision ?? ''), 'target revision', 191);
    const key = JSON.stringify([account, targetId, revision, host, port, username, target.hostFingerprint]);
    let entry = this.connections.get(key);
    if (!entry) {
      if (this.connections.size >= MAX_CONNECTIONS) throw fail('REMOTE_ENV_LIMIT', 'too many SSH connections');
      entry = { key, targetId, revision:target.revision, account, client: this.clientFactory(), references: 0, active: 0, idleTimer: null, ready: null, dead: false, connected: false };
      this.connections.set(key, entry);
      entry.ready = this.connect(entry, target, { host, username, port });
    }
    token.entry = entry;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    entry.references++;
    let retained = false;
    try {
      try { await entry.ready; }
      catch (error) { checkOwner(); throw error; }
      checkOwner();
      if (await this.currentAccount() !== account || entry.dead) throw fail('REMOTE_ENV_DISCONNECTED', 'SSH connection is no longer available');
      // Probe the directory on the actual host; a transport is not a shell and
      // does not itself retain cd or environment state between exec channels.
      const initial = target.defaultDirectory ? directory(target.defaultDirectory) : null;
      const result = await this.execute(entry, initial ? `cd -- ${shellQuote(initial)} && pwd -P` : 'pwd -P', { timeoutMs: 15_000, maxOutputBytes: 8192 });
      checkOwner();
      if (result.exitCode !== 0 || result.truncated) throw fail('REMOTE_ENV_DIRECTORY_UNAVAILABLE', 'remote directory is unavailable');
      const cwd = result.exitCode === 0 && !result.truncated ? result.stdout.trimEnd() : '';
      directory(cwd);
      if (entry.dead || await this.currentAccount() !== account) throw fail('REMOTE_ENV_DISCONNECTED', 'SSH connection is no longer available');
      checkOwner();
      const handle = `re_${randomUUID()}`;
      this.sessions.set(handle, { handle, owner, account, entry, cwd, tail: Promise.resolve(), pending: 0, closed: false, outcomeUnknown: false, abort: new AbortController() });
      retained = true;
      return { handle, targetId, cwd };
    } finally {
      if (!retained) this.release(entry);
    }
  }

  async connect(entry, target, connection) {
    let credential;
    try {
      credential = await this.credentialProvider(target, entry.account);
      if (entry.dead || await this.currentAccount() !== entry.account) throw fail('REMOTE_ENV_ACCOUNT_CHANGED', 'account changed before SSH authentication');
      if (!credential || typeof credential !== 'object') throw fail('REMOTE_ENV_CREDENTIAL_UNAVAILABLE', 'SSH credential is unavailable');
      const auth = {};
      if (credential.kind === 'password' && typeof credential.password === 'string' && credential.password) auth.password = credential.password;
      else if (credential.kind === 'private_key' && (typeof credential.privateKey === 'string' || Buffer.isBuffer(credential.privateKey))) {
        auth.privateKey = credential.privateKey;
        if (typeof credential.passphrase === 'string') auth.passphrase = credential.passphrase;
      } else if (credential.kind === 'agent' && typeof credential.agent === 'string' && credential.agent) auth.agent = credential.agent;
      else throw fail('REMOTE_ENV_CREDENTIAL_UNAVAILABLE', 'SSH credential is unavailable');
      await new Promise((resolve, reject) => {
        let settled = false;
        let rejectedHostKey = false;
        const client = entry.client;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error); else resolve();
        };
        client.on('error', () => {
          if (settled) {
            entry.dead = true;
            if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
            try { client.end(); } catch {}
          }
          finish(fail(rejectedHostKey ? 'REMOTE_ENV_HOST_KEY_MISMATCH' : 'REMOTE_ENV_CONNECT_FAILED', rejectedHostKey ? 'SSH host key did not match the verified fingerprint' : 'SSH connection failed'));
        });
        client.on('close', () => {
          entry.dead = true;
          if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
          finish(fail('REMOTE_ENV_CONNECT_FAILED', 'SSH connection closed before authentication completed'));
        });
        client.once('ready', () => { entry.connected = true; finish(); });
        try {
          client.connect({ ...connection, ...auth, readyTimeout: 20_000, keepaliveInterval: 30_000, keepaliveCountMax: 3,
            hostVerifier: (key) => { const ok = equalFingerprint(target.hostFingerprint, fingerprint(key)); rejectedHostKey = !ok; return ok; },
          });
        } catch { finish(fail('REMOTE_ENV_CONNECT_FAILED', 'SSH connection failed')); }
      });
    } catch (error) {
      entry.dead = true;
      if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
      try { entry.client.end(); } catch {}
      throw error;
    } finally { credential = null; }
  }

  async withSession(owner, handle, operation, signal) {
    if (signal?.aborted) throw fail('REMOTE_ENV_CANCELLED', 'SSH operation was cancelled before execution');
    const account = await this.currentAccount();
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.closed || session.owner !== owner || session.account !== account) {
      throw fail('REMOTE_ENV_SESSION_NOT_FOUND', 'remote session not found');
    }
    if (session.pending >= 8) throw fail('REMOTE_ENV_LIMIT', 'too many queued commands for this session');
    session.pending++;
    const perform = async () => {
      if (signal?.aborted) throw fail('REMOTE_ENV_CANCELLED', 'SSH operation was cancelled before execution');
      if (session.closed || session.entry.dead || await this.currentAccount() !== account) throw fail('REMOTE_ENV_DISCONNECTED', 'SSH session is no longer available');
      if (session.outcomeUnknown) throw fail('REMOTE_ENV_SESSION_UNCERTAIN', 'A previous command may still be running. Inspect the host independently before closing this session and opening another.');
      if (signal?.aborted) throw fail('REMOTE_ENV_CANCELLED', 'SSH operation was cancelled before execution');
      return operation(session);
    };
    const result = session.tail.then(perform, perform).finally(() => { session.pending--; });
    session.tail = result.catch(() => {});
    return result;
  }

  async sessionInfo(owner, handle) {
    const account = await this.currentAccount();
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.closed || session.owner !== owner || session.account !== account) throw fail('REMOTE_ENV_SESSION_NOT_FOUND', 'remote session not found');
    if (session.entry.dead) throw fail('REMOTE_ENV_DISCONNECTED', 'SSH session is no longer available');
    return {targetId:session.entry.targetId, revision:session.entry.revision, cwd:session.cwd, account, outcomeUnknown:session.outcomeUnknown};
  }

  async run(owner, handle, command, { cwd, timeoutMs, maxOutputBytes, signal } = {}) {
    command = nonempty(command, 'command', MAX_COMMAND_BYTES);
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw fail('REMOTE_ENV_INVALID', 'command is too large');
    timeoutMs = bounded(timeoutMs, 60_000, MAX_TIMEOUT_MS);
    maxOutputBytes = bounded(maxOutputBytes, 128 * 1024, MAX_OUTPUT_BYTES);
    return this.withSession(owner, handle, async (session) => {
      const workingDirectory = cwd == null ? session.cwd : directory(cwd);
      // Group the command: a semicolon in it must not cause a later command
      // to run when changing to the requested directory failed.
      const abortSignal = signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
      try {
        return await this.execute(session.entry, `cd -- ${shellQuote(workingDirectory)} && (\n${command}\n)`, { timeoutMs, maxOutputBytes, signal:abortSignal });
      } catch (error) {
        if (error?.code === 'REMOTE_ENV_OUTCOME_UNKNOWN') session.outcomeUnknown = true;
        throw error;
      }
    }, signal);
  }

  async chdir(owner, handle, path, {signal} = {}) {
    path = directory(path);
    return this.withSession(owner, handle, async (session) => {
      const abortSignal = signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
      const result = await this.execute(session.entry, `cd -- ${shellQuote(path)} && pwd -P`, { timeoutMs: 15_000, maxOutputBytes: 8192, signal:abortSignal });
      if (result.exitCode !== 0 || result.truncated) throw fail('REMOTE_ENV_DIRECTORY_UNAVAILABLE', 'remote directory is unavailable');
      const cwd = directory(result.stdout.trimEnd());
      session.cwd = cwd;
      return { cwd };
    }, signal);
  }

  execute(entry, command, { timeoutMs, maxOutputBytes, signal: abortSignal }) {
    if (entry.dead) return Promise.reject(fail('REMOTE_ENV_DISCONNECTED', 'SSH connection is no longer available'));
    if (abortSignal?.aborted) return Promise.reject(fail('REMOTE_ENV_DISCONNECTED', 'SSH session is no longer available'));
    entry.active++;
    return new Promise((resolve, reject) => {
      let channel, done = false, exitCode = null, signal = null, length = 0, truncated = false;
      const stdout = [], stderr = [];
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        entry.client.removeListener('close', connectionClosed);
        abortSignal?.removeEventListener('abort', cancelled);
        entry.active--;
        if (!entry.references) this.scheduleIdle(entry);
        if (error) reject(error);
        else if (exitCode == null && signal == null) reject(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command ended without a confirmed exit status'));
        else resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated });
      };
      const connectionClosed = () => finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH connection closed; command outcome is unknown'));
      const cancelled = () => {
        try { channel?.close(); } catch {}
        finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH session closed; command outcome is unknown'));
      };
      const timer = setTimeout(() => {
        try { channel?.close(); } catch {}
        finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command timed out; its remote outcome is unknown'));
      }, timeoutMs);
      timer.unref?.();
      entry.client.once('close', connectionClosed);
      abortSignal?.addEventListener('abort', cancelled, {once:true});
      const collect = (bucket, chunk) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const take = Math.min(data.length, Math.max(0, maxOutputBytes - length));
        if (take) { bucket.push(data.subarray(0, take)); length += take; }
        if (take < data.length) truncated = true;
      };
      try {
        entry.client.exec(command, (error, stream) => {
          if (done) { try { stream?.close(); } catch {} return; }
          // The request may have reached the host even when its reply is lost
          // or rejected. Neither a callback error nor a missing channel proves
          // the remote command did not run.
          if (error || !stream) return finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command start was not confirmed; its remote outcome is unknown'));
          channel = stream;
          stream.on('data', (data) => collect(stdout, data));
          stream.stderr.on('data', (data) => collect(stderr, data));
          stream.on('exit', (code, exitSignal) => { exitCode = typeof code === 'number' ? code : null; signal = exitSignal || null; });
          stream.on('error', () => finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command channel failed; its outcome is unknown')));
          stream.on('close', (code, exitSignal) => {
            if (exitCode == null && typeof code === 'number') exitCode = code;
            if (!signal && exitSignal) signal = exitSignal;
            finish();
          });
        });
      } catch { finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command start was not confirmed; its remote outcome is unknown')); }
    });
  }

  async close(owner, handle) {
    await this.currentAccount();
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.owner !== owner || session.account !== this.account) throw fail('REMOTE_ENV_SESSION_NOT_FOUND', 'remote session not found');
    session.closed = true;
    session.abort.abort();
    this.sessions.delete(session.handle);
    this.release(session.entry);
    return { closed: true };
  }

  release(entry) {
    entry.references = Math.max(0, entry.references - 1);
    if (!entry.references) this.scheduleIdle(entry);
  }
  scheduleIdle(entry) {
    if (entry.dead || entry.references || entry.active || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.references || entry.active) return;
      entry.dead = true;
      if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
      try { entry.client.end(); } catch {}
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }
  invalidateTarget(targetId, account) {
    for (const [handle, session] of this.sessions) {
      if (session.account !== account || session.entry.targetId !== targetId) continue;
      session.closed = true;
      session.abort.abort();
      this.sessions.delete(handle);
      this.release(session.entry);
    }
    for (const entry of this.connections.values()) {
      if (entry.account !== account || entry.targetId !== targetId) continue;
      entry.dead = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this.connections.delete(entry.key);
      try { entry.client.end(); } catch {}
    }
  }
  closeOwner(owner) {
    const affected = new Set();
    for (const token of this.pendingOwners.get(owner) || []) {
      token.cancelled = true;
      if (token.entry) affected.add(token.entry);
    }
    for (const [handle, session] of this.sessions) {
      if (session.owner !== owner) continue;
      session.closed = true;
      session.abort.abort();
      this.sessions.delete(handle);
      this.release(session.entry);
    }
    for (const entry of affected) {
      const usedBySession = [...this.sessions.values()].some((session) => session.entry === entry);
      const usedByPending = [...this.pendingOwners.values()].some((tokens) =>
        [...tokens].some((token) => token.entry === entry && !token.cancelled));
      if (usedBySession || usedByPending) continue;
      entry.dead = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
      try { entry.client.end(); } catch {}
    }
  }
  statusFor(targetId, account) {
    const entries = [...this.connections.values()].filter((entry) => entry.targetId === targetId && entry.account === account && !entry.dead);
    return entries.some((entry) => entry.connected) ? 'connected' : entries.length ? 'connecting' : 'disconnected';
  }
  managementSessions(account) {
    return [...this.sessions.values()]
      .filter((session) => session.account === account && !session.closed && !session.owner.startsWith('user-test:'))
      .map((session) => ({
        handle: session.handle,
        targetId: session.entry.targetId,
        agentSessionId: session.owner,
        cwd: session.cwd,
        outcomeUnknown: session.outcomeUnknown,
        connected: !session.entry.dead && session.entry.connected,
      }));
  }
  async closeManagedSession(targetId, handle, account) {
    if (await this.currentAccount() !== account) throw fail('REMOTE_ENV_ACCOUNT_CHANGED', 'account changed during remote environment operation');
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.account !== account || session.entry.targetId !== targetId || session.owner.startsWith('user-test:')) {
      return {closed:false};
    }
    return this.close(session.owner, session.handle);
  }
  closeAll() {
    for (const session of this.sessions.values()) { session.closed = true; session.abort.abort(); }
    this.sessions.clear();
    for (const entry of this.connections.values()) {
      entry.dead = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      try { entry.client.end(); } catch {}
    }
    this.connections.clear();
  }
  shutdown() { this.closeAll(); this.closed = true; }
}

export { fingerprint as sshHostFingerprint };
