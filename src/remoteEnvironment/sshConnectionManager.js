import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import ssh2 from 'ssh2';

const { Client } = ssh2;

const MAX_SESSIONS = 32;
const MAX_CONNECTIONS = 16;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// A terminated command is given a grace period to end on SIGTERM before the
// group is killed. The grace also bounds how long a session close waits.
const TERMINATE_GRACE_MS = 3000;
const TERMINATE_SETTLE_MS = 500;
const MAX_BACKGROUND_JOBS = 8;
// What a device does with the remote processes a session starts. Both are on
// by default; only an explicit false turns one off.
const DEFAULT_BEHAVIOR = Object.freeze({killRemoteProcesses: true, backgroundTasks: true});

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
 * The script that runs one command on the remote host.
 *
 * The command travels inside a quoted here-document, so no byte of it is
 * re-parsed by the outer shell, and it runs as a child of the reading shell in
 * the requested directory. sshd addresses an SSH signal request to the
 * session's process group: the reading shell traps SIGTERM and forwards it to
 * the child, so the command ends on the first signal while the shell stays
 * alive to receive the SIGKILL escalation. The shell must not wait for EOF —
 * a signal request is dropped once the channel reaches EOF — so the script
 * ends with an explicit exit.
 *
 * @param {string|null} cwd - the absolute directory the command runs in; null
 *   leaves the remote shell where it is.
 * @param {string} command - the command text, run by the remote shell.
 * @returns {string} the complete script for the exec channel.
 */
function runScript(cwd, command) {
  let delimiter = `__DSH_${randomUUID().replaceAll('-', '')}__`;
  while (command.includes(delimiter)) delimiter = `__DSH_${randomUUID().replaceAll('-', '')}__`;
  return [
    '__dsh_terminated=0',
    '__dsh_child=',
    `trap '__dsh_terminated=1; kill -TERM "$__dsh_child" 2>/dev/null' TERM`,
    `__dsh_command=$(cat <<'${delimiter}'`,
    command,
    delimiter,
    ')',
    cwd ? `cd -- ${shellQuote(cwd)} || exit 1` : '',
    '{ eval "$__dsh_command"; } &',
    '__dsh_child=$!',
    'if [ "$__dsh_terminated" = 1 ]; then kill -TERM "$__dsh_child" 2>/dev/null; fi',
    'wait "$__dsh_child"',
    '__dsh_status=$?',
    'exit "$__dsh_status"',
    '',
  ].join('\n');
}

/**
 * A bounded, incrementally readable buffer of remote output.
 *
 * Bytes are retained up to a limit. A read from an offset that has already
 * slid out of the window is marked lossy, so the caller renders the gap
 * instead of splicing two unrelated pieces of output together.
 */
class OutputTail {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
    this.total = 0;
    this.start = 0;
  }
  write(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    this.total += data.length;
    while (this.total - this.start > this.maxBytes && this.buffer.length) {
      const drop = Math.min(this.buffer.length, this.total - this.start - this.maxBytes);
      this.buffer = this.buffer.subarray(drop);
      this.start += drop;
    }
  }
  read(fromByte) {
    const offset = Math.max(0, Number(fromByte) || 0);
    const lost = offset < this.start;
    const begin = Math.max(offset, this.start);
    return {text: this.buffer.subarray(begin - this.start).toString('utf8'), nextOffset: this.total, lost};
  }
}

/**
 * Device-side SSH transports. This class intentionally has no API or storage
 * of its own: callers must authenticate the owner and supply a verified target
 * and its secret from device-owned storage. It never logs or returns credentials.
 */
export class SshConnectionManager {
  constructor({ targetProvider, credentialProvider, accountProvider, settingsProvider = () => DEFAULT_BEHAVIOR, clientFactory = () => new Client(), idleMs = 5 * 60_000, now = () => Date.now() } = {}) {
    if (typeof targetProvider !== 'function' || typeof credentialProvider !== 'function' || typeof accountProvider !== 'function') {
      throw new TypeError('targetProvider, credentialProvider and accountProvider are required');
    }
    this.targetProvider = targetProvider;
    this.credentialProvider = credentialProvider;
    this.accountProvider = accountProvider;
    this.settingsProvider = settingsProvider;
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

  /**
   * What this device does with the remote processes a session starts.
   *
   * A device that has never been told otherwise kills them: only an explicit
   * false turns a behavior off, so a missing or unreadable setting never
   * silently changes what a running session does.
   */
  async behavior() {
    let account = this.account;
    try { account = await this.currentAccount(); } catch { account = this.account; }
    return this.behaviorFor(account);
  }

  /**
   * The behavior of one account, read without awaiting.
   *
   * The paths that end a session outside a call — owner detach, target change,
   * account switch, shutdown — have no place to wait, but they still have to
   * honor the setting, so the provider is read directly here.
   */
  behaviorFor(account) {
    let provided = null;
    try {
      provided = typeof this.settingsProvider === 'function' ? this.settingsProvider(account) : null;
    } catch { provided = null; }
    return {
      killRemoteProcesses: provided?.killRemoteProcesses !== false,
      backgroundTasks: provided?.backgroundTasks !== false,
    };
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
      entry = { key, targetId, revision:target.revision, account, client: this.clientFactory(), references: 0, active: 0, terminations: 0, idleTimer: null, ready: null, dead: false, connected: false };
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
      const result = await this.execute(entry, runScript(initial, 'pwd -P'), { timeoutMs: 15_000, maxOutputBytes: 8192 });
      checkOwner();
      if (result.exitCode !== 0 || result.truncated) throw fail('REMOTE_ENV_DIRECTORY_UNAVAILABLE', 'remote directory is unavailable');
      const cwd = result.exitCode === 0 && !result.truncated ? result.stdout.trimEnd() : '';
      directory(cwd);
      if (entry.dead || await this.currentAccount() !== account) throw fail('REMOTE_ENV_DISCONNECTED', 'SSH connection is no longer available');
      checkOwner();
      const handle = `re_${randomUUID()}`;
      this.sessions.set(handle, { handle, owner, account, entry, cwd, tail: Promise.resolve(), pending: 0, closed: false, outcomeUnknown: false, abort: new AbortController(), runs: new Set(), jobs: new Map() });
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
    const behavior = await this.behavior();
    return this.withSession(owner, handle, async (session) => {
      const workingDirectory = cwd == null ? session.cwd : directory(cwd);
      // The command travels inside the script, and the script changes to the
      // requested directory before it runs: a command that fails to change
      // directory never runs, and no byte of it is re-parsed by the shell
      // that carries it.
      const abortSignal = signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
      const running = this.execute(session.entry, runScript(workingDirectory, command), {
        timeoutMs, maxOutputBytes, signal: abortSignal, killRemoteProcesses: behavior.killRemoteProcesses,
      });
      session.runs.add(running);
      running.then(() => session.runs.delete(running), () => session.runs.delete(running));
      try {
        return await running;
      } catch (error) {
        if (error?.code === 'REMOTE_ENV_OUTCOME_UNKNOWN') session.outcomeUnknown = true;
        throw error;
      }
    }, signal);
  }

  async chdir(owner, handle, path, {signal} = {}) {
    path = directory(path);
    const behavior = await this.behavior();
    return this.withSession(owner, handle, async (session) => {
      const abortSignal = signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal;
      const result = await this.execute(session.entry, runScript(path, 'pwd -P'), {
        timeoutMs: 15_000, maxOutputBytes: 8192, signal: abortSignal, killRemoteProcesses: behavior.killRemoteProcesses,
      });
      if (result.exitCode !== 0 || result.truncated) throw fail('REMOTE_ENV_DIRECTORY_UNAVAILABLE', 'remote directory is unavailable');
      const cwd = directory(result.stdout.trimEnd());
      session.cwd = cwd;
      return { cwd };
    }, signal);
  }

  execute(entry, script, { timeoutMs, maxOutputBytes, signal: abortSignal, killRemoteProcesses = false }) {
    if (entry.dead) return Promise.reject(fail('REMOTE_ENV_DISCONNECTED', 'SSH connection is no longer available'));
    if (abortSignal?.aborted) return Promise.reject(fail('REMOTE_ENV_DISCONNECTED', 'SSH session is no longer available'));
    entry.active++;
    return new Promise((resolve, reject) => {
      let channel, done = false, exitCode = null, signal = null, length = 0, truncated = false;
      let terminated = false, timedOut = false, escalateTimer = null, settleTimer = null;
      const stdout = [], stderr = [];
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(escalateTimer);
        clearTimeout(settleTimer);
        entry.client.removeListener('close', connectionClosed);
        abortSignal?.removeEventListener('abort', cancelled);
        entry.active--;
        if (terminated) entry.terminations = Math.max(0, (entry.terminations || 0) - 1);
        if (!entry.references) this.scheduleIdle(entry);
        if (error) reject(error);
        // A command that was terminated ended in the middle of its work. What
        // it had already done on the host stays unknown, so the session is
        // frozen the same way it is for a command that may still be running.
        else if (terminated) reject(fail('REMOTE_ENV_OUTCOME_UNKNOWN', timedOut
          ? 'SSH command timed out and was terminated on the host; what it had already done is unknown'
          : 'SSH session closed and the command was terminated on the host; what it had already done is unknown'));
        else if (exitCode == null && signal == null) reject(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command ended without a confirmed exit status'));
        else resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), truncated, terminated, timedOut });
      };
      const connectionClosed = () => finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH connection closed; command outcome is unknown'));
      // End the remote command and everything it started. sshd addresses a
      // signal request to the session's process group, so one request ends
      // the command and its children; the group is killed if it did not end
      // within the grace period.
      const terminate = () => {
        if (done || terminated) return;
        terminated = true;
        entry.terminations = (entry.terminations || 0) + 1;
        try { channel?.signal('TERM'); } catch {}
        escalateTimer = setTimeout(() => {
          if (done) return;
          try { channel?.signal('KILL'); } catch {}
          settleTimer = setTimeout(() => {
            if (done) return;
            try { channel?.close(); } catch {}
            finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command did not end after it was terminated'));
          }, TERMINATE_SETTLE_MS);
          settleTimer.unref?.();
        }, TERMINATE_GRACE_MS);
        escalateTimer.unref?.();
      };
      const cancelled = () => {
        if (killRemoteProcesses) return terminate();
        try { channel?.close(); } catch {}
        finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH session closed; command outcome is unknown'));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (killRemoteProcesses) return terminate();
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
        entry.client.exec(script, (error, stream) => {
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
          // The command was cancelled or timed out before its channel
          // opened: the request reached the host, so what it started must end.
          if (terminated) { try { channel.signal('TERM'); } catch {} }
        });
      } catch { finish(fail('REMOTE_ENV_OUTCOME_UNKNOWN', 'SSH command start was not confirmed; its remote outcome is unknown')); }
    });
  }

  /**
   * Start a command that keeps running after the call returns.
   *
   * The job holds its own channel on the session's transport, so it never
   * blocks the session's other commands. It lives on the device: a restart
   * ends it, and the output it keeps is bounded.
   */
  async start(owner, handle, command, { cwd, maxOutputBytes } = {}) {
    command = nonempty(command, 'command', MAX_COMMAND_BYTES);
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw fail('REMOTE_ENV_INVALID', 'command is too large');
    maxOutputBytes = bounded(maxOutputBytes, 128 * 1024, MAX_OUTPUT_BYTES);
    const behavior = await this.behavior();
    if (!behavior.backgroundTasks) throw fail('REMOTE_ENV_BACKGROUND_DISABLED', 'background remote tasks are turned off on this device');
    const account = await this.currentAccount();
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.closed || session.owner !== owner || session.account !== account) {
      throw fail('REMOTE_ENV_SESSION_NOT_FOUND', 'remote session not found');
    }
    if (session.outcomeUnknown) throw fail('REMOTE_ENV_SESSION_UNCERTAIN', 'A previous command may still be running. Inspect the host independently before closing this session and opening another.');
    const running = [...session.jobs.values()].filter((job) => !job.done).length;
    if (running >= MAX_BACKGROUND_JOBS) throw fail('REMOTE_ENV_LIMIT', 'too many background remote tasks');
    const entry = session.entry;
    if (entry.dead) throw fail('REMOTE_ENV_DISCONNECTED', 'SSH connection is no longer available');
    const workingDirectory = cwd == null ? session.cwd : directory(cwd);
    let settle;
    const job = { id: `rj_${randomUUID()}`, entry, channel: null, tail: new OutputTail(maxOutputBytes), done: false,
      exitCode: null, signal: null, terminated: false, escalate: null, startedAt: this.now(), settled: new Promise((resolve) => { settle = resolve; }) };
    session.jobs.set(job.id, job);
    entry.active++;
    const settleJob = (exitCode, exitSignal) => {
      if (job.done) return;
      job.done = true;
      if (exitCode != null) job.exitCode = exitCode;
      if (exitSignal != null) job.signal = exitSignal;
      if (job.escalate) { clearTimeout(job.escalate); job.escalate = null; }
      entry.active = Math.max(0, entry.active - 1);
      settle();
      this.pruneJobs(session);
    };
    job.settleJob = settleJob;
    try {
      entry.client.exec(runScript(workingDirectory, command), (error, stream) => {
        if (job.done) { try { stream?.close(); } catch {} return; }
        if (error || !stream) return settleJob(null, null);
        job.channel = stream;
        stream.on('data', (data) => { if (!job.done) job.tail.write(data); });
        stream.stderr.on('data', (data) => { if (!job.done) job.tail.write(data); });
        stream.on('exit', (code, exitSignal) => { job.exitCode = typeof code === 'number' ? code : null; job.signal = exitSignal || null; });
        stream.on('error', () => settleJob(job.exitCode, job.signal));
        stream.on('close', (code, exitSignal) => {
          if (job.exitCode == null && typeof code === 'number') job.exitCode = code;
          if (!job.signal && exitSignal) job.signal = exitSignal;
          settleJob(job.exitCode, job.signal);
        });
        if (job.terminated) { try { stream.signal('TERM'); } catch {} }
      });
    } catch { settleJob(null, null); }
    return { jobId: job.id };
  }

  /**
   * Read what a background task has produced so far.
   *
   * The offset is a byte count the caller keeps: reading from an offset that
   * has already slid out of the retained window is reported as lossy rather
   * than silently spliced.
   */
  async jobOutput(owner, handle, jobId, { fromByte = 0 } = {}) {
    const account = await this.currentAccount();
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.closed || session.owner !== owner || session.account !== account) {
      throw fail('REMOTE_ENV_SESSION_NOT_FOUND', 'remote session not found');
    }
    const job = session.jobs.get(String(jobId || ''));
    if (!job) throw fail('REMOTE_ENV_JOB_NOT_FOUND', 'background remote task not found');
    const read = job.tail.read(fromByte);
    return { jobId: job.id, output: read.text, nextOffset: read.nextOffset, lost: read.lost,
      done: job.done, exitCode: job.exitCode, signal: job.signal, terminated: job.terminated };
  }

  /**
   * Stop a background task.
   *
   * This is a deliberate request to end the task, so it ends the remote
   * process whatever the device does when a session is closed.
   */
  async killJob(owner, handle, jobId) {
    const account = await this.currentAccount();
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.closed || session.owner !== owner || session.account !== account) {
      throw fail('REMOTE_ENV_SESSION_NOT_FOUND', 'remote session not found');
    }
    const job = session.jobs.get(String(jobId || ''));
    if (!job) throw fail('REMOTE_ENV_JOB_NOT_FOUND', 'background remote task not found');
    if (job.done) return { killed: false, ended: true };
    this.terminateJob(job);
    const ended = await Promise.race([
      job.settled.then(() => true),
      new Promise((resolve) => { const timer = setTimeout(() => resolve(false), TERMINATE_GRACE_MS + TERMINATE_SETTLE_MS + 500); timer.unref?.(); }),
    ]);
    return { killed: true, ended };
  }

  terminateJob(job) {
    if (job.done || job.terminated) return;
    job.terminated = true;
    job.entry.terminations = (job.entry.terminations || 0) + 1;
    try { job.channel?.signal('TERM'); } catch {}
    job.escalate = setTimeout(() => {
      if (job.done) return;
      try { job.channel?.signal('KILL'); } catch {}
      try { job.channel?.close(); } catch {}
    }, TERMINATE_GRACE_MS);
    job.escalate.unref?.();
  }

  pruneJobs(session) {
    if (session.jobs.size <= 32) return;
    for (const [id, job] of session.jobs) {
      if (session.jobs.size <= 32) break;
      if (job.done) session.jobs.delete(id);
    }
  }

  /**
   * End everything a session started, and wait for the end to be reported.
   *
   * The remote processes end because the signal request reaches the session's
   * process group. The wait is bounded: a host that does not answer must not
   * hold a session close open.
   */
  async terminateSession(session) {
    const pending = [...session.runs];
    for (const job of session.jobs.values()) this.terminateJob(job);
    if (!pending.length) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => { const timer = setTimeout(resolve, TERMINATE_GRACE_MS + TERMINATE_SETTLE_MS + 500); timer.unref?.(); }),
    ]);
  }

  /**
   * End a session without waiting for the host to answer.
   *
   * The paths that end a session outside a call — owner detach, target change,
   * account switch, shutdown — have no place to await, but they still have to
   * honor the device's setting. Running commands follow the abort signal, and
   * background tasks are ended here or only lose their channels.
   */
  retire(session) {
    session.closed = true;
    session.abort.abort();
    if (this.behaviorFor(session.account).killRemoteProcesses) {
      for (const job of session.jobs.values()) this.terminateJob(job);
    } else {
      for (const job of session.jobs.values()) { try { job.channel?.close(); } catch {} }
    }
  }

  async close(owner, handle) {
    await this.currentAccount();
    const session = this.sessions.get(String(handle || ''));
    if (!session || session.owner !== owner || session.account !== this.account) throw fail('REMOTE_ENV_SESSION_NOT_FOUND', 'remote session not found');
    this.retire(session);
    if (this.behaviorFor(session.account).killRemoteProcesses) await this.terminateSession(session);
    this.sessions.delete(session.handle);
    this.release(session.entry);
    return { closed: true };
  }

  release(entry) {
    entry.references = Math.max(0, entry.references - 1);
    if (!entry.references) this.scheduleIdle(entry);
  }
  scheduleIdle(entry) {
    if (entry.dead || entry.references || entry.active || entry.idleTimer || entry.terminations) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.references || entry.active || entry.terminations) return;
      entry.dead = true;
      if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
      try { entry.client.end(); } catch {}
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }
  /**
   * Close a transport.
   *
   * A connection that is still delivering a termination stays open long enough
   * for the signal to reach the host: closing it first would leave the remote
   * process running, which is the one outcome the device promised to end.
   */
  teardown(entry) {
    const end = () => {
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
      try { entry.client.end(); } catch {}
    };
    if (entry.terminations > 0) {
      const timer = setTimeout(end, TERMINATE_GRACE_MS + TERMINATE_SETTLE_MS + 500);
      timer.unref?.();
      return;
    }
    end();
  }
  invalidateTarget(targetId, account) {
    for (const [handle, session] of this.sessions) {
      if (session.account !== account || session.entry.targetId !== targetId) continue;
      this.retire(session);
      this.sessions.delete(handle);
      this.release(session.entry);
    }
    for (const entry of this.connections.values()) {
      if (entry.account !== account || entry.targetId !== targetId) continue;
      entry.dead = true;
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      this.connections.delete(entry.key);
      this.teardown(entry);
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
      this.retire(session);
      this.sessions.delete(handle);
      this.release(session.entry);
    }
    for (const entry of affected) {
      const usedBySession = [...this.sessions.values()].some((session) => session.entry === entry);
      const usedByPending = [...this.pendingOwners.values()].some((tokens) =>
        [...tokens].some((token) => token.entry === entry && !token.cancelled));
      if (usedBySession || usedByPending) continue;
      entry.dead = true;
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
      this.teardown(entry);
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
    for (const session of this.sessions.values()) this.retire(session);
    this.sessions.clear();
    for (const entry of this.connections.values()) {
      entry.dead = true;
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      this.teardown(entry);
    }
    this.connections.clear();
  }
  shutdown() { this.closeAll(); this.closed = true; }
}

export { fingerprint as sshHostFingerprint };
