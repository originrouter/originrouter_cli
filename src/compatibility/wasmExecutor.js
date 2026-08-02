import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class WasmPatchExecutionError extends Error {
  constructor(message, code = "originrouter_wasm_patch_failed") {
    super(message);
    this.name = "WasmPatchExecutionError";
    this.code = code;
  }
}

export class WasmPatchExecutor {
  constructor(moduleBytes, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    initializationTimeoutMs = DEFAULT_INITIALIZATION_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  } = {}) {
    this.moduleBytes = Buffer.from(moduleBytes).toString("base64");
    this.timeoutMs = timeoutMs;
    this.initializationTimeoutMs = initializationTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.worker = null;
    this.ready = false;
    this.closed = false;
    this.queue = [];
    this.current = null;
    this.nextId = 1;
    this.startupTimer = null;
  }

  execute(document, context, state = {}) {
    if (this.closed) return Promise.reject(new WasmPatchExecutionError("WASM patch executor is closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, document, context, state, resolve, reject, timer: null });
      this.#ensureWorker();
      this.#drain();
    });
  }

  #ensureWorker() {
    if (this.worker || this.closed) return;
    const worker = new Worker(new URL("./wasmWorker.js", import.meta.url), {
      workerData: {
        moduleBytes: this.moduleBytes,
        maxOutputBytes: this.maxOutputBytes,
      },
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
    this.worker = worker;
    this.ready = false;
    this.startupTimer = setTimeout(() => {
      if (this.worker !== worker || this.ready) return;
      this.#resetWorker(new WasmPatchExecutionError(
        `WASM patch worker did not initialize within ${this.initializationTimeoutMs}ms`,
        "originrouter_wasm_patch_initialization_timeout",
      ));
    }, this.initializationTimeoutMs);
    this.startupTimer.unref?.();
    worker.on("message", (message) => this.#onMessage(message));
    worker.on("error", (error) => this.#resetWorker(error));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      if (code !== 0 && !this.closed) {
        this.#resetWorker(new WasmPatchExecutionError(`WASM patch worker exited with code ${code}`));
      } else {
        this.worker = null;
        this.ready = false;
      }
    });
  }

  #onMessage(message) {
    if (message?.ready) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.ready = true;
      this.#drain();
      return;
    }
    if (!this.current || message?.id !== this.current.id) return;
    const task = this.current;
    this.current = null;
    clearTimeout(task.timer);
    if (message.ok) task.resolve(message.result);
    else task.reject(new WasmPatchExecutionError(message.error?.message, message.error?.code));
    this.#drain();
  }

  #drain() {
    if (!this.ready || this.current || this.closed || this.queue.length === 0) return;
    const task = this.queue.shift();
    this.current = task;
    task.timer = setTimeout(() => {
      if (this.current !== task) return;
      this.current = null;
      task.reject(new WasmPatchExecutionError(
        `WASM patch exceeded ${this.timeoutMs}ms execution limit`,
        "originrouter_wasm_patch_timeout",
      ));
      this.#terminateWorker();
      if (!this.closed) {
        this.#ensureWorker();
        this.#drain();
      }
    }, this.timeoutMs);
    task.timer.unref?.();
    this.worker.postMessage({
      id: task.id,
      document: task.document,
      context: task.context,
      state: task.state,
    });
  }

  #resetWorker(error) {
    const failure = error instanceof WasmPatchExecutionError
      ? error
      : new WasmPatchExecutionError(error?.message || "WASM patch worker failed");
    const initialized = this.ready;
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(failure);
      this.current = null;
    }
    this.#terminateWorker();
    if (!initialized && !this.current) {
      this.closed = true;
      for (const task of this.queue.splice(0)) task.reject(failure);
      return;
    }
    if (!this.closed) {
      this.#ensureWorker();
      this.#drain();
    }
  }

  #terminateWorker() {
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (worker) void worker.terminate();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const failure = new WasmPatchExecutionError("WASM patch executor was closed");
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(failure);
      this.current = null;
    }
    for (const task of this.queue.splice(0)) task.reject(failure);
    this.#terminateWorker();
  }
}
