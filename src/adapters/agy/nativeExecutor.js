import { PtyExecutor } from '../../executors/ptyExecutor.js';

// The wrapper/OR session survives a session-scoped native reconfiguration.
// Each physical PTY owns its own exit/kill state; old exits cannot close a new run.
export class AgyNativeExecutor {
  constructor(adapter, createPty = () => new PtyExecutor()) {
    this.adapter = adapter;
    this.createPty = createPty;
    this.epoch = 0;
    this.stopped = false;
  }
  get terminal() { return this.child?.terminal; }
  async start(options) {
    this.options = options;
    this.stopped = false;
    this.adapter.executor = this;
    return this.launch(options);
  }
  async launch(options) {
    const epoch = ++this.epoch;
    const child = this.createPty();
    this.child = child;
    this.adapter.resetScreen?.(options.cols, options.rows);
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    const resolveExit = this.resolveExit;
    const result = await child.start({ ...options,
      onOutput: data => { if (epoch === this.epoch) options.onOutput(data); },
      onError: error => { if (epoch === this.epoch) options.onError?.(error); },
      onExit: result => {
        if (epoch === this.epoch) { this.childExitedEpoch = epoch; this.childExitResult = result; }
        resolveExit(result);
        if (epoch === this.epoch && (epoch !== this.replacedEpoch || this.stopped)) this.reportExit(epoch, result);
      },
    });
    this.adapter.afterNativeStart?.(result, epoch);
    return result;
  }
  reportExit(epoch, result) {
    if (this.exitReportedEpoch === epoch) return;
    this.exitReportedEpoch = epoch;
    this.options.onExit?.(result);
  }
  async restart(launch) {
    if (this.stopped || this.restarting) throw new Error('native_restart_unavailable');
    this.restarting = true;
    this.replacedEpoch = this.epoch;
    try {
      this.child.stop();
      let timer;
      await Promise.race([this.exitPromise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('native_process_did_not_exit')), 7000);
      })]).finally(() => clearTimeout(timer));
      if (this.stopped) throw new Error('session_stopped');
      try {
        return await this.launch({ ...this.options, ...launch, env: { ...this.options.env, ...launch.env } });
      } catch (error) {
        this.stopped = true;
        this.options.onError?.(error);
        this.reportExit(this.epoch, { code: 1, signal: null });
        throw error;
      }
    } finally {
      this.restarting = false; this.replacedEpoch = null;
      if (this.childExitedEpoch === this.epoch) this.reportExit(this.epoch, this.childExitResult);
    }
  }
  write(data) { if (!this.stopped) this.child?.write(data); }
  async submitMessage(text) {
    if (this.stopped || !this.child || this.restarting) return false;
    const child = this.child, epoch = this.epoch, generation = this.inputGeneration || 0;
    child.write(String(text || ''));
    await new Promise(resolve => setTimeout(resolve, 30));
    if (this.stopped || this.child !== child || epoch !== this.epoch || generation !== (this.inputGeneration || 0)) {
      // The text is already in the native editor but Enter will never follow;
      // leaving it there means the next submission appends to stale text.
      // Kill-line clears the in-progress draft — once per line it occupied.
      try { child.write('\x15'.repeat(String(text || '').split('\n').length)); } catch {}
      return false;
    }
    child.write('\r');
    return true;
  }
  resize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 500) return false;
    this.options = { ...this.options, cols, rows };
    this.child?.resize(cols, rows); this.adapter.resizeScreen?.(cols, rows); return true;
  }
  interrupt() { this.inputGeneration = (this.inputGeneration || 0) + 1; this.child?.interrupt(); }
  stop() { this.stopped = true; this.inputGeneration = (this.inputGeneration || 0) + 1; this.child?.stop(); }
}
