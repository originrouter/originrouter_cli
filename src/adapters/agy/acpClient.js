import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { VERSION } from '../../constants.js';
import { spawnCommand } from '../../utils/spawn.js';
import { inheritSystemProxyEnv } from '../../utils/systemProxy.js';

export class AgyAcpClient extends EventEmitter {
  constructor({ spawn = spawnCommand, requestTimeoutMs = 30000 } = {}) {
    super(); this.spawn = spawn; this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map(); this.sequence = 0; this.child = null; this.closed = false;
    this.onRequest = null;
  }
  async connect({ cwd, env = process.env } = {}) {
    if (this.child) throw new Error('ACP client already started');
    this.child = this.spawn('agy', ['acp'], { cwd, env: inheritSystemProxyEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', error => {
      if (error.code === 'ENOENT') error.message = 'Antigravity CLI was not found. Run `originrouter setup --with-agy`, then sign in using official `agy`.';
      this.fail(error);
    });
    this.child.on('exit', (code, signal) => { this.closed = true; this.fail(new Error(`Antigravity exited (${code ?? signal})`)); this.emit('exit', { code, signal }); });
    this.child.stdin.on('error', error => { this.fail(error); this.emit('protocolError', error); });
    // Stderr is diagnostic only; it must never contaminate the JSON-RPC stream.
    this.child.stderr.on('data', data => this.emit('diagnostic', String(data)));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => { void this.receive(line); });
    const result = await this.request('initialize', { protocolVersion: 1,
      clientInfo: { name: 'originrouter', version: VERSION },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
        elicitation: { form: {} } } });
    if (result.protocolVersion !== 1) throw new Error('Unsupported Antigravity ACP protocol version');
    this.capabilities = result.agentCapabilities || {};
    return result;
  }
  send(message) {
    if (!this.child || this.closed || this.child.stdin.destroyed) throw new Error('ACP connection closed');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  notify(method, params) { this.send({ method, params }); }
  async receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.emit('protocolError', new Error('Invalid ACP JSON')); return; }
    if (!message.method) {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'ACP request failed');
        error.code = message.error.code; item.reject(error);
      } else item.resolve(message.result);
      return;
    }
    if (message.id == null) { this.emit('notification', message); return; }
    try {
      if (!this.onRequest) throw Object.assign(new Error('Unsupported client method'), { code: -32601 });
      const result = await this.onRequest(message.method, message.params, message.id);
      this.send({ id: message.id, result });
    } catch (error) {
      try {
        if (!this.closed) this.send({ id: message.id, error: { code: typeof error.code === 'number' ? error.code : -32603, message: error.message } });
      } catch { /* The peer may exit while a client interaction is pending. */ }
    }
  }
  fail(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  close() {
    if (!this.child || this.closed) return;
    this.closed = true; this.fail(new Error('ACP connection closed'));
    this.child.stdin.end(); this.child.kill('SIGTERM');
    const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 2000);
    this.child.once('exit', () => clearTimeout(timer)); timer.unref();
  }
}
