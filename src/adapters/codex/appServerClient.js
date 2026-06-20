import { createInterface } from "node:readline";
import { runCapture } from "../../utils/detect.js";
import { spawnCommand } from "../../utils/spawn.js";
import { mapDecisionToWire as mapDecisionToWireImpl } from "./decisionMapping.js";

// Stage 8.0A: gate Codex app-server support on semver, matching happy's
// reference at packages/happy-cli/src/codex/codexAppServerClient.ts:66-78
// (`major > 0 || minor >= 100`). Pre-0.100 Codex CLIs can print
// `app-server` in `--help` but the v2 protocol methods are not implemented
// — fail closed.
const CODEX_MIN_MINOR = 100;

// Stage 8.1: RPC timeout bumped from 10s to 30s to match happy's reference.
// Per-server-request approval timeout = 30s. RUST_LOG filter suppresses
// codex_core::rollout::list noise unless the user has set their own value.
const CODEX_RPC_TIMEOUT_MS = 30_000;
const CODEX_APPROVAL_TIMEOUT_MS = 30_000;
const CODEX_ROLLOUT_RUST_LOG = "codex_core::rollout::list=off";

// Stage 8.4: SIGTERM → SIGKILL escalation window. After this many
// milliseconds the client sends SIGKILL if the child has not exited.
// The exit handler clears the timer when the real exit arrives.
const CODEX_FORCE_KILL_MS = 2_000;

// FIFO cap for the completedTurnIds dedup set. Long-running daemons stay
// within ~1000 unique turn ids without unbounded memory growth.
const COMPLETED_TURN_CAP = 1000;

// Exported for direct unit testing in tests/codexSemver.test.js.
export function parseCodexSemver(output) {
  const m = (output || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function meetsCodexAppServerGate(semver) {
  if (!semver) return false;
  if (semver.major > 0) return true;
  return semver.minor >= CODEX_MIN_MINOR;
}

export async function isCodexAppServerAvailable() {
  const version = await runCapture("codex", ["--version"]);
  if (!version.ok) return false;

  const semver = parseCodexSemver(version.output);
  if (!meetsCodexAppServerGate(semver)) return false;

  const help = await runCapture("codex", ["app-server", "--help"]);
  return help.ok || /app-server/i.test(help.output);
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.child = null;
    this.readline = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandler = null;
    this.approvalHandler = null;
    // Stage 8.1: lifecycle dedup + protocol lock + timeout configuration.
    this.notificationProtocol = "unknown"; // "unknown" | "legacy" | "raw"
    this.completedTurnIds = new Set();
    this.completedTurnOrder = [];
    this.currentTurnId = null;
    this.turnOpen = false;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? CODEX_RPC_TIMEOUT_MS;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? CODEX_APPROVAL_TIMEOUT_MS;
    this._approvalTimers = new Map();
    // Stage 8.4: processEpoch guards every async callback so messages
    // from a previous child process cannot reach the new one. It is
    // incremented ONLY at the top of connect(). disconnect() must not
    // touch it — otherwise the in-flight exit listener would become
    // stale and the cleanup path would never run.
    this.processEpoch = 0;
    // disconnecting is the orthogonal "we're tearing down" flag. It
    // guards the SIGKILL escalation timer but does NOT block the exit
    // handler — we still want codex.app_server.exit to fire.
    this.disconnecting = false;
    // childExited is set by _handleChildExit when the real exit lands.
    // It is the authoritative signal for "is the process still alive"
    // (Node's ChildProcess.killed is "signal sent", not "process
    // exited", so we cannot rely on it).
    this.childExited = false;
    this.forceKillTimer = null;
    this.forceKillMs = options.forceKillMs ?? CODEX_FORCE_KILL_MS;
    // Test seams: spawnFn / createInterfaceFn let unit tests inject a
    // fake child and a fake readline without spawning a real Codex.
    // Stage 8.6: default spawnFn is now spawnCommand (which applies
    // SPAWN_DEFAULTS = { shell: false, windowsHide: true }). The 30
    // existing tests inject their own spawnFn and are unaffected.
    this.spawnFn = options.spawnFn ?? spawnCommand;
    this.createInterfaceFn = options.createInterfaceFn ?? createInterface;
  }

  onEvent(handler) {
    this.eventHandler = handler;
  }

  onApproval(handler) {
    this.approvalHandler = handler;
  }

  async connect({ cwd = process.cwd(), env = process.env } = {}) {
    // Stage 8.0A: pass `--listen stdio://` to match happy's reference
    // (codexAppServerClient.ts:394). Pre-0.100 Codex CLIs never reach
    // this line because isCodexAppServerAvailable() returns false.
    // Stage 8.1: build a fresh childEnv so we never mutate process.env.
    // The RUST_LOG filter suppresses noisy codex_core::rollout::list logs
    // unless the user has set their own value.
    const childEnv = { ...env, RUST_LOG: env.RUST_LOG || CODEX_ROLLOUT_RUST_LOG };
    // Stage 8.4: increment processEpoch at the top of connect() so all
    // listeners registered below share the same epoch and are atomically
    // invalidated if connect() is called again. disconnect() must not
    // touch this — see the field comment.
    this.processEpoch += 1;
    const epoch = this.processEpoch;
    this.disconnecting = false;
    this.childExited = false;
    this.child = this.spawnFn("codex", ["app-server", "--listen", "stdio://"], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.readline = this.createInterfaceFn({ input: this.child.stdout });
    this.readline.on("line", (line) => {
      if (!this._isCurrentEpoch(epoch)) return;
      this.handleLine(line);
    });
    this.child.stderr.on("data", (data) => {
      if (!this._isCurrentEpoch(epoch)) return;
      this.eventHandler?.({ type: "codex.stderr", data: data.toString("utf8") });
    });

    this.child.on("exit", (code, signal) => {
      if (!this._isCurrentEpoch(epoch)) return;
      this._handleChildExit({ code, signal, epoch });
    });

    try {
      await this.request("initialize", {
        clientInfo: { name: "originrouter", title: "OriginRouter", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      // Stage 8.4: gate the ready signal on the epoch. If a fast
      // disconnect() (or a fast crash) happens during initialize, the
      // connect-time epoch no longer matches this processEpoch and we
      // skip _emitReady. _handleChildExit has already done the
      // cleanup and emitted codex.app_server.exit.
      if (this._isCurrentEpoch(epoch) && !this.disconnecting && !this.childExited) {
        this._emitReady();
      }
    } catch (error) {
      if (this._isCurrentEpoch(epoch) && !this.disconnecting && !this.childExited) {
        this._emitInitError(error.message);
      }
    }
  }

  // Stage 8.1: signal readiness to the relay once the handshake succeeds.
  // The eventMapper turns this into `agent.ready` for downstream consumers.
  _emitReady() {
    this.eventHandler?.({ type: "codex.initialized" });
  }

  _emitInitError(message) {
    this.eventHandler?.({ type: "codex.initialize.error", message });
  }

  // ---- Stage 8.4 lifecycle helpers ----

  // True when the captured epoch still matches the current epoch. Every
  // async callback that captured an epoch at registration time should
  // gate on this before doing anything.
  _isCurrentEpoch(epoch) {
    return epoch === this.processEpoch;
  }

  // Reject all pending RPC with a uniform error and clear the map. Used
  // by both _handleChildExit (crash) and disconnect() (graceful).
  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  // Clear every entry in _approvalTimers. Accepts both the Stage 8.4
  // { timer, epoch } shape and the legacy raw-handle shape, so a unit
  // test that hand-builds a timer can drive this helper without an
  // epoch stamp.
  _clearApprovalTimers() {
    for (const entry of this._approvalTimers.values()) {
      const timer = entry?.timer ?? entry;
      if (timer) clearTimeout(timer);
    }
    this._approvalTimers.clear();
  }

  _resetTurnState() {
    this.completedTurnIds.clear();
    this.completedTurnOrder.length = 0;
    this.turnOpen = false;
    this.currentTurnId = null;
  }

  // Stage 8.4: the single cleanup point for child exit. Rejects pending
  // RPC, clears approval timers, resets turn state, clears the
  // force-kill timer (if any), sets childExited so the SIGKILL
  // escalation can short-circuit, and emits the structured
  // codex.app_server.exit event. The eventMapper renders this as
  // `agent.adapter.status { state: "exited" }` for the relay.
  _handleChildExit({ code, signal, epoch }) {
    if (!this._isCurrentEpoch(epoch)) return;
    this.childExited = true;
    this.disconnecting = false;
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
    }
    this._rejectPending(
      new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
    );
    this._clearApprovalTimers();
    this._resetTurnState();
    this.eventHandler?.({
      type: "codex.app_server.exit",
      code,
      signal,
      epoch,
    });
  }

  request(method, params = {}) {
    // Stage 8.4: capture the epoch on entry. A response that arrives
    // after a new connect() has bumped processEpoch will see a stale
    // pending.epoch and be ignored. The timeout also gates on it.
    const epoch = this.processEpoch;
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    // Stage 8.1: refuse to write after disconnect so callers see a clean
    // rejection rather than a synchronous write error.
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("codex app-server disconnected before request"));
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      // Stage 8.1: store the timer handle so handleLine / disconnect can
      // clear it. Without this the timer can fire after the response
      // already arrived, surfacing a spurious timeout error.
      const timer = setTimeout(() => {
        if (!this._isCurrentEpoch(epoch)) return;
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`codex app-server request timeout: ${method}`));
        }
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, method, timer, epoch });
    });
  }

  respond(id, result = {}) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.eventHandler?.({ type: "codex.raw", data: line });
      return;
    }

    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      // Stage 8.4: drop stale responses from a previous child. The
      // pending entry's epoch was captured when the request was sent;
      // if a new connect() has bumped processEpoch since then, this
      // response belongs to the dead process. Clear the timer (so it
      // can't fire later) and ignore the payload.
      if (pending.epoch !== this.processEpoch) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        return;
      }
      // Stage 8.1: clear the RPC timeout timer so it can't fire after resolution.
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex app-server error"));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.id === "number" && message.method) {
      this.handleServerRequest(message.id, message.method, message.params || {}).catch((error) => {
        this.eventHandler?.({ type: "codex.approval.error", method: message.method, message: error.message });
        this.respond(message.id, { decision: "decline" });
      });
      return;
    }

    this.handleNotification(message);
  }

  mapDecisionToWire(decision, legacy = false) {
    // Stage 8.0A: thin wrapper around the pure helper in decisionMapping.js.
    // Kept here as a class method so existing internal call sites
    // (`this.mapDecisionToWire` from handleServerRequest) and external
    // consumers (tests/adapters.test.js) are unchanged.
    return mapDecisionToWireImpl(decision, legacy);
  }

  async requestApproval(params) {
    if (!this.approvalHandler) return "denied";
    return this.approvalHandler(params);
  }

  // ---- Stage 8.1 helpers ----

  isAbortStatus(status) {
    return status === "interrupted" || status === "cancelled" || status === "canceled" || status === "aborted";
  }

  extractTurnId(params) {
    return params.turn?.id || params.turnId || params.turn_id || null;
  }

  extractTurnStatus(params) {
    return params.turn?.status || params.status || null;
  }

  markProtocol(kind) {
    if (this.notificationProtocol !== kind) {
      this.notificationProtocol = kind;
      return true;
    }
    return false;
  }

  isRawLifecycleMethod(method) {
    return method === "turn/started" || method === "turn/completed" || method === "thread/status/changed";
  }

  isRawItemMethod(method) {
    return method === "item/started" || method === "item/completed";
  }

  closeTurnIfOpen({ turnId, status = "complete", error = null, source }) {
    // Allow close when we have a turnId even if turnOpen is false (the
    // turn/started may have been missed or we attached late). The dedup
    // invariant is preserved by `completedTurnIds`.
    if (!this.turnOpen && !turnId) return;
    if (turnId && this.completedTurnIds.has(turnId)) {
      this.turnOpen = false;
      this.currentTurnId = null;
      return;
    }
    if (turnId) {
      this.completedTurnIds.add(turnId);
      this.completedTurnOrder.push(turnId);
      // Bounded FIFO: drop oldest once we exceed COMPLETED_TURN_CAP unique
      // turns. Long-running daemons stay within ~1000 unique turn ids.
      while (this.completedTurnOrder.length > COMPLETED_TURN_CAP) {
        const oldest = this.completedTurnOrder.shift();
        this.completedTurnIds.delete(oldest);
      }
    }
    this.turnOpen = false;
    this.currentTurnId = null;
    const aborted = this.isAbortStatus(status);
    this.eventHandler?.({
      type: aborted ? "turn_aborted" : "task_complete",
      turn_id: turnId,
      status,
      error,
      source,
    });
  }

  denyPayloadFor(approvalType, legacy) {
    if (approvalType === "mcp") return { action: "decline", content: null, _meta: null };
    if (legacy) return { decision: "denied" };
    return { decision: "decline" };
  }

  async withApprovalTimeout({ id, method, callId, approvalType, legacy, fn }) {
    // Single `responded` flag. The timeout promise and the user-decision
    // promise race; whichever wins writes exactly one response. A late
    // `fn()` result after the timeout already responded is dropped.
    // Stage 8.4: capture the current epoch so a crash (which clears
    // _approvalTimers) and a stale timeout (from a previous child)
    // are both no-ops.
    const epoch = this.processEpoch;
    let responded = false;
    const timer = setTimeout(() => {
      if (responded) return;
      if (!this._isCurrentEpoch(epoch)) {
        this._approvalTimers.delete(id);
        return;
      }
      responded = true;
      this.eventHandler?.({
        type: "codex.approval.timeout",
        method,
        callId, // same callId the UI used to create the permission card
        approvalType,
      });
      this.respond(id, this.denyPayloadFor(approvalType, legacy));
    }, this.approvalTimeoutMs);
    this._approvalTimers.set(id, { timer, epoch });
    try {
      const result = await fn();
      if (responded) return;
      if (!this._isCurrentEpoch(epoch) || this.disconnecting || this.childExited) {
        clearTimeout(timer);
        this._approvalTimers.delete(id);
        return;
      }
      responded = true;
      clearTimeout(timer);
      this._approvalTimers.delete(id);
      this.respond(id, result);
    } catch (error) {
      if (!this._isCurrentEpoch(epoch) || this.disconnecting || this.childExited) {
        clearTimeout(timer);
        this._approvalTimers.delete(id);
        return;
      }
      if (!responded) {
        responded = true;
        clearTimeout(timer);
        this._approvalTimers.delete(id);
      }
      throw error;
    }
  }

  async handleServerRequest(id, method, params) {
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      const legacy = method === "execCommandApproval";
      const callId = params.itemId || params.callId || String(id);
      // Stage 8.1: wrap in withApprovalTimeout so a non-responding user
      // produces a single deny response + codex.approval.timeout event.
      await this.withApprovalTimeout({
        id, method, callId,
        approvalType: "exec", legacy,
        fn: async () => {
          const decision = await this.requestApproval({
            method,
            type: "exec",
            callId,
            command: params.command,
            cwd: params.cwd,
            reason: params.reason,
            input: params,
          });
          return { decision: this.mapDecisionToWire(decision, legacy) };
        },
      });
      return;
    }

    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      const legacy = method === "applyPatchApproval";
      const callId = params.itemId || params.callId || String(id);
      await this.withApprovalTimeout({
        id, method, callId,
        approvalType: "patch", legacy,
        fn: async () => {
          const decision = await this.requestApproval({
            method,
            type: "patch",
            callId,
            fileChanges: params.fileChanges,
            reason: params.reason,
            input: params,
          });
          return { decision: this.mapDecisionToWire(decision, legacy) };
        },
      });
      return;
    }

    if (method === "mcpServer/elicitation/request") {
      const callId = `${params.serverName || "mcp"}:${id}`;
      await this.withApprovalTimeout({
        id, method, callId,
        approvalType: "mcp", legacy: false,
        fn: async () => {
          const decision = await this.requestApproval({
            method,
            type: "mcp",
            callId,
            serverName: params.serverName,
            message: params.message,
            input: params,
          });
          const action = decision === "approved" || decision === "approved_for_session" || decision === "accept" || decision === "acceptForSession"
            ? "accept"
            : decision === "abort" || decision === "cancel"
              ? "cancel"
              : "decline";
          return { action, content: action === "accept" ? {} : null, _meta: null };
        },
      });
      return;
    }

    this.eventHandler?.({ type: "codex.server_request", method, params });
    this.respond(id, {});
  }

  handleNotification(message) {
    const method = message.method;
    const params = message.params || {};

    // Stage 8.1: lifecycle-only protocol lock.
    // The legacy `codex/event` wrapper carries its own `type` field on
    // `params.msg`. We only suppress cross-channel lifecycle duplicates
    // (`task_started` / `task_complete` / `turn_aborted`); other event
    // types still pass through either side.
    if ((method === "codex/event" || method?.startsWith("codex/event/")) && params.msg) {
      const lifecycleTypes = ["task_started", "task_complete", "turn_aborted"];
      const isLifecycleWrapper = lifecycleTypes.includes(params.msg?.type);
      if (this.notificationProtocol === "raw" && isLifecycleWrapper) {
        // raw lock set and this legacy wrapper would duplicate a lifecycle event — drop it
        return;
      }
      if (isLifecycleWrapper) this.markProtocol("legacy");
      this.eventHandler?.(params.msg);
      return;
    }

    // Mark raw on first lifecycle raw method. Item/* never marks protocol.
    // If the legacy channel already won, suppress raw lifecycle events to
    // avoid double lifecycle emission. (The wrapper branch above handles
    // the symmetric case — legacy wrappers dropped under raw lock.)
    if (this.isRawLifecycleMethod(method)) {
      if (this.notificationProtocol === "legacy") return;
      this.markProtocol("raw");
    }

    if (method === "turn/started") {
      const turnId = this.extractTurnId(params);
      this.currentTurnId = turnId;
      this.turnOpen = true;
      this.eventHandler?.({ type: "task_started", turn_id: turnId });
      return;
    }

    if (method === "turn/completed") {
      const turnId = this.extractTurnId(params);
      const status = this.extractTurnStatus(params) || "complete";
      const error = params.turn?.error || params.error || null;
      this.closeTurnIfOpen({ turnId, status, error, source: "turn/completed" });
      return;
    }

    // Stage 8.1: idle fallback. Some Codex flows end without an explicit
    // turn/completed; the thread-level status flip is the alternative signal.
    if (method === "thread/status/changed") {
      const statusType = params.status?.type || params.status;
      if (statusType === "idle" && this.turnOpen) {
        this.closeTurnIfOpen({
          turnId: this.currentTurnId,
          status: "complete",
          error: null,
          source: "thread/status/changed idle",
        });
      }
      return;
    }

    if (method === "thread/tokenUsage/updated" && params.tokenUsage) {
      this.eventHandler?.({ type: "token_count", ...params.tokenUsage });
      return;
    }

    if (method === "item/started" && params.item?.type === "commandExecution") {
      const item = params.item;
      this.eventHandler?.({
        type: "exec_command_begin",
        call_id: item.id,
        command: item.command,
        cwd: item.cwd,
      });
      return;
    }

    if (method === "item/completed" && params.item?.type === "commandExecution") {
      const item = params.item;
      this.eventHandler?.({
        type: "exec_command_end",
        call_id: item.id,
        command: item.command,
        cwd: item.cwd,
        output: item.aggregatedOutput || "",
        exit_code: item.exitCode,
        status: item.status,
      });
      return;
    }

    if (method === "item/started" && params.item?.type === "fileChange") {
      const item = params.item;
      this.eventHandler?.({
        type: "patch_apply_begin",
        call_id: item.id,
        changes: item.changes || {},
      });
      return;
    }

    if (method === "item/completed" && params.item?.type === "fileChange") {
      const item = params.item;
      this.eventHandler?.({
        type: "patch_apply_end",
        call_id: item.id,
        status: item.status,
      });
      return;
    }

    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const item = params.item;
      this.eventHandler?.({
        type: "agent_message",
        message: item.text || "",
        item_id: item.id,
        phase: item.phase,
      });
      // Stage 8.1: close the turn on a final-ish agent message. The
      // predicate is intentionally narrow — Codex can mark intermediate
      // items with `status: "completed"` during streaming. Close only on
      // an explicit final-phase marker with text, or `status:completed`
      // with no phase (non-streaming CLI variant).
      const hasFinalPhase = item.phase === "final" || item.phase === "final_answer";
      const completedNoPhase = item.status === "completed" && item.phase === undefined;
      const hasText = typeof item.text === "string" && item.text.length > 0;
      const isFinal = (hasFinalPhase && hasText) || completedNoPhase;
      if (isFinal) {
        this.closeTurnIfOpen({
          turnId: this.currentTurnId,
          status: "complete",
          error: null,
          source: "item/completed agentMessage",
        });
      }
      return;
    }

    this.eventHandler?.({ type: "codex.notification", method, params });
  }

  disconnect() {
    // Stage 8.4: idempotent. A second call is a no-op. The
    // `disconnecting` flag is the only state we touch on the first
    // call BEFORE deciding what to do — it is also reset by
    // _handleChildExit when the real exit lands, so a fast crash
    // after a disconnect() still calls _handleChildExit cleanly.
    if (this.disconnecting) return;
    this.disconnecting = true;

    const child = this.child;
    const epoch = this.processEpoch;

    this.readline?.close();
    this._rejectPending(new Error("codex app-server disconnected"));
    this._clearApprovalTimers();
    this._resetTurnState();

    // processEpoch is intentionally NOT touched here. The exit
    // listener registered at connect() time still uses the current
    // epoch, so the real exit fires _handleChildExit which clears
    // forceKillTimer. Bumping the epoch here would orphan the
    // cleanup path (see processEpoch field comment).
    if (!child || this.childExited) return;

    try { child.kill("SIGTERM"); } catch {}

    // Stage 8.4: SIGKILL escalation. We gate on this.childExited
    // (set by _handleChildExit), NOT on Node's ChildProcess.killed
    // which is "signal sent" and would always be true after the
    // SIGTERM above. The try/catch swallows ESRCH if the process
    // is already gone.
    this.forceKillTimer = setTimeout(() => {
      if (this.childExited) return;
      try { child.kill("SIGKILL"); } catch {}
      this.eventHandler?.({ type: "codex.app_server.force_kill", epoch });
    }, this.forceKillMs);
  }
}
