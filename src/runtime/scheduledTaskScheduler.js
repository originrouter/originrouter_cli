import { canonicalTurnEventType } from '../local/externalAgentRegistry.js';

// Bound concurrent launch handshakes while allowing unrelated tasks to proceed.
const MAX_CONCURRENT_LAUNCHES = 16;

const VALIDATION_ERRORS = new Set([
  'INVALID_LAUNCH_REQUEST', 'UNSUPPORTED_AGENT', 'AGENT_BUDGET_EXHAUSTED',
  'INVALID_PERMISSION_PROFILE', 'WORKSPACE_REQUIRED', 'WORKSPACE_NOT_FOUND',
  'WORKSPACE_NOT_TRUSTED', 'WORKSPACE_UNATTENDED_UNAVAILABLE',
  // These are returned by the unattended-workspace check before spawn.
  'WORKSPACE_PATH_REQUIRED', 'WORKSPACE_ACCESS_UNAVAILABLE',
  'MACOS_TCC_PROTECTED_WORKSPACE', 'MACOS_UNATTENDED_MOUNT_WORKSPACE',
  'WINDOWS_PROTECTED_OR_SYNCED_WORKSPACE', 'WINDOWS_NETWORK_WORKSPACE',
  'LINUX_INTERACTIVE_MOUNT_WORKSPACE',
  'APPROVAL_POLICY_INVALID', 'APPROVAL_POLICY_REVISION_NOT_FOUND',
  'AI_REVIEW_POLICY_INVALID', 'AI_REVIEW_POLICY_NOT_APPLICABLE',
  'RESUME_PERMISSION_STATE_UNAVAILABLE', 'INVALID_RESUME_REQUEST',
]);
function error(code, message) { return Object.assign(new Error(message), { code }); }

// The daemon is the only scheduler. The App may disappear at any time; every
// claim is committed before launch and every launch has a stable identifier.
export class ScheduledTaskScheduler {
  constructor({ store, supervisor, registry, runtimeSupervisor = null, catalog = null, now = () => Date.now(), intervalMs = 1000, log = console } = {}) {
    this.store = store;
    this.supervisor = supervisor;
    this.registry = registry;
    this.runtimeSupervisor = runtimeSupervisor;
    this.catalog = catalog;
    this.now = now;
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.unsubscribe = null;
    this.ticking = false;
    this.recoveredDir = null;
    this.lastTickError = null;
    this.stopped = false;
    this.inFlight = new Set();
  }
  ensureAccount() {
    const dir = this.store.dir();
    // ManagedAgentSupervisor's workspace catalog is bound when the daemon
    // starts. Never run a new account's tasks through an old account's catalog.
    if (this.catalog?.stateDir && this.catalog.stateDir !== dir) {
      throw error('SCHEDULED_ACCOUNT_RESTART_REQUIRED', 'restart the CLI service after switching account');
    }
    return dir;
  }
  recover() {
    const dir = this.ensureAccount();
    if (dir === this.recoveredDir) return;
    // In-memory supervision is lost on restart and the Agent may have ended
    // while the daemon was offline. An old state is not proof of its outcome.
    this.store.markInterruptedExecutionsUncertain();
    for (const execution of this.store.startingExecutions()) {
      let receipt;
      try { receipt = this.catalog?.getLaunchReceipt?.(execution.launchId); } catch {}
      if (receipt?.accepted && receipt.sessionId === execution.sessionId) {
        this.store.updateExecution(execution.id, 'uncertain', 'launch was accepted before restart; current execution outcome is unknown', { accountDir: dir, from:['starting'] });
      } else {
        this.store.updateExecution(execution.id, 'uncertain', 'daemon restarted before the launch result was confirmed', { accountDir: dir, from:['starting'] });
      }
    }
    this.recoveredDir = dir;
  }
  start() {
    if (this.timer) return this;
    this.stopped = false;
    this.unsubscribe = this.registry?.subscribe((event) => this.onRegistryEvent(event)) || null;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
    return this;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    // Once callbacks are detached, we can no longer establish an in-flight
    // execution's outcome. Persist that fact before daemon stores are closed;
    // late launch acknowledgements cannot turn it back into a known result.
    try {
      this.ensureAccount();
      this.store.markInterruptedExecutionsUncertain();
      this.store.markUncertainStarting();
    } catch (cause) {
      this.log.error?.(`[scheduled-tasks] shutdown: ${cause.code || cause.message}`);
    }
  }
  async drain(timeoutMs = 5000) {
    if (!this.inFlight.size) return true;
    let timer;
    try {
      return await Promise.race([
        Promise.allSettled([...this.inFlight]).then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.recover();
      this.lastTickError = null;
      this.settleFinishedTurns();
      for (const id of this.store.due(this.now())) {
        if (!this.timer || this.inFlight.size >= MAX_CONCURRENT_LAUNCHES) break;
        // Claim is committed synchronously before starting the Agent. Do not
        // wait for its receipt here: one stalled launcher must not block this
        // tick, future ticks, or another task's independent launch.
        void this.launchClaim(this.store.claim(id, { now:this.now() }));
      }
    } catch (cause) {
      const reason = cause.code || cause.message;
      if (reason === 'SCHEDULED_ACCOUNT_RESTART_REQUIRED') this.recoveredDir = null;
      if (reason !== this.lastTickError) this.log.error?.(`[scheduled-tasks] ${reason}`);
      this.lastTickError = reason;
    } finally { this.ticking = false; }
  }
  settleFinishedTurns() {
    for (const execution of this.store.settlingExecutions()) {
      // The supervisor waits for the last output to settle and may then ask
      // AI or schedule a retry. Keep this execution active until that work is
      // resolved, so the next schedule cannot start a duplicate Agent.
      if (this.now() - execution.updatedMs < 3000
        || this.runtimeSupervisor?.hasPendingWork(execution.sessionId)) continue;
      const outcome = ['succeeded', 'failed', 'cancelled'].includes(execution.detail)
        ? execution.detail : 'uncertain';
      this.store.updateExecution(execution.id, outcome, null, {from:['settling']});
    }
  }
  launchClaim(claim) {
    const pending = this.executeClaim(claim);
    this.inFlight.add(pending);
    pending.then(() => this.inFlight.delete(pending), () => this.inFlight.delete(pending));
    return pending;
  }
  async executeClaim(claim) {
    if (!claim || claim.status !== 'starting') return claim;
    try {
      if (this.stopped) return claim;
      if (this.ensureAccount() !== claim.accountDir) throw error('SCHEDULED_ACCOUNT_CHANGED', 'account changed before launch');
      const result = await this.supervisor.start({
        ...claim.launch,
        launchId:claim.launchId, sessionId:claim.sessionId,
        conversationId:claim.sessionId, runId:claim.sessionId,
        startedBy:'scheduled-task',
      });
      if (this.stopped) return claim;
      if (!result?.accepted) throw error('SCHEDULED_LAUNCH_UNKNOWN', 'launch did not return an accepted receipt');
      this.store.updateExecution(claim.executionId, 'running', null, { accountDir:claim.accountDir, from:['starting'] });
    } catch (cause) {
      if (this.stopped) return claim;
      // A thrown launch is not proof that no process was spawned. Only known
      // pre-spawn validation errors are failed; everything else is uncertain.
      const status = VALIDATION_ERRORS.has(cause?.code) ? 'failed' : 'uncertain';
      try { this.store.updateExecution(claim.executionId, status, cause?.message, { accountDir:claim.accountDir, from:['starting'] }); }
      catch (updateError) { this.log.error?.(`[scheduled-tasks] ${updateError.code || updateError.message}`); }
    }
    return claim;
  }
  async runNow(id, {baseRevision = null} = {}) {
    if (this.stopped) throw error('SCHEDULED_TASKS_STOPPED', 'the scheduler is shutting down');
    this.recover();
    return this.launchClaim(this.store.claim(id, { now:this.now(), manual:true, baseRevision }));
  }
  onRegistryEvent({ type, sessionId, payload }) {
    if (!sessionId) return;
    try {
      this.ensureAccount();
      // Registration proves a process attached, not what happened while it
      // was away. Keep an uncertain run uncertain until a live turn or
      // interaction event establishes its state.
      if (type === 'registered') return this.store.updateSession(sessionId, 'running', null, {from:['starting']});
      // A stale attachment does not establish whether the task finished or
      // whether the process is still running. Keep it blocking new launches
      // until a live event or the user resolves the unknown outcome.
      if (type === 'updated' && payload?.attached === false) {
        return this.store.updateSession(sessionId, 'uncertain', 'agent connection was lost before its outcome was confirmed');
      }
      if (type === 'unregistered') {
        const status = String(payload?.status || '');
        if (status === 'completed') {
          // A clean wrapper exit is not itself a task result. Preserve the
          // observed turn outcome; without one the outcome remains unknown.
          const current = this.store.activeExecutionForSession(sessionId);
          if (!current) return false;
          const outcome = current.status === 'settling' && ['succeeded','failed','cancelled'].includes(current.detail)
            ? current.detail : 'uncertain';
          const detail = outcome === 'uncertain' ? 'agent exited before its task outcome was confirmed' : null;
          return this.store.updateExecution(current.id, outcome, detail, {from:[current.status]});
        }
        return this.store.updateSession(sessionId,
          ['failed', 'error'].includes(status) ? 'failed'
            : ['stopped', 'cancelled'].includes(status) ? 'cancelled' : 'uncertain');
      }
      // Enqueuing a stop or interrupt is only an intent: the wrapper may be
      // offline, reject it, or still be running external work. Keep the run
      // active until a subsequent aborted turn or unregister confirms it.
      if (type === 'command' && ['terminal.interrupt', 'session.stop'].includes(payload?.type)) return;
      if (type !== 'event') return;
      // The registry retains a stale detached session briefly, and a queued
      // event can arrive after its attachment expired. Only re-registration
      // establishes that it is live again; old events cannot resolve an
      // uncertain execution or make another launch safe.
      if (!this.registry.sessionFacts(sessionId)?.attached) return;
      const event = payload || {};
      if (event.type === 'agent.supervisor.escalated' && event.reason === 'needs_user') {
        return this.store.updateSession(sessionId, 'waiting_input');
      }
      const kind = canonicalTurnEventType(event.type);
      if (['agent.interaction.requested', 'approval_requested', 'interaction_requested'].includes(kind)) {
        const pending = this.registry.controlSnapshot(sessionId).interactions;
        return this.store.updateSession(sessionId,
          pending.some((item) => item.kind === 'permission' || item.type === 'approval_requested' || item.status === 'waiting_approval')
            ? 'waiting_approval' : 'waiting_input', null,
          {from:['starting', 'running', 'waiting_approval', 'waiting_input', 'uncertain']});
      }
      const interactionFinished = ['agent.interaction.applied', 'agent.interaction.expired',
        'agent.interaction.canceled', 'agent.interaction.failed', 'agent.interaction.auto_resolved',
        'agent.permission.resolved'].includes(kind)
        || (kind === 'agent.interaction.result' && ['applied', 'expired', 'canceled', 'failed', 'not_found'].includes(event.status));
      if (interactionFinished) {
        // The registry has already applied this event. A session can have more
        // than one request; resolving one must not conceal the others. A late
        // result must also never resurrect a finished or disconnected turn.
        const pending = this.registry.controlSnapshot(sessionId).interactions;
        const status = pending.some((item) => item.kind === 'permission' || item.type === 'approval_requested' || item.status === 'waiting_approval') ? 'waiting_approval'
          : pending.length ? 'waiting_input' : 'running';
        return this.store.updateSession(sessionId, status, null, {from:['waiting_approval', 'waiting_input']});
      }
      if (kind === 'agent.task.started') {
        return this.store.updateSession(sessionId, 'running');
      }
      if (kind === 'agent.task.complete') {
        return this.store.updateSession(sessionId, 'settling', event.isError || ['failed','error'].includes(event.status) ? 'failed' : 'succeeded');
      }
      if (kind === 'agent.task.failed' && !event.commandType) return this.store.updateSession(sessionId, 'settling', 'failed');
      if (kind === 'agent.task.aborted') return this.store.updateSession(sessionId, 'settling', 'cancelled');
    } catch (cause) { this.log.error?.(`[scheduled-tasks] ${cause.code || cause.message}`); }
  }
  async handle(action, body = {}) {
    if (this.stopped) throw error('SCHEDULED_TASKS_STOPPED', 'the scheduler is shutting down');
    this.ensureAccount();
    switch (action) {
      case 'list': return { tasks:this.store.list() };
      case 'save': return { task:this.store.save(body.task, {baseRevision:body.baseRevision ?? null}) };
      case 'delete': return { deleted:this.store.remove(body.id, body.baseRevision) };
      case 'run': {
        if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision < 1) throw error('INVALID_SCHEDULED_TASK', 'the task revision is required to run it');
        const claimed = await this.runNow(body.id, {baseRevision:body.baseRevision});
        if (this.stopped) throw error('SCHEDULED_TASKS_STOPPED', 'the scheduler shut down before the launch outcome was confirmed');
        return { execution: claimed ? this.store.executions({taskId:claimed.taskId, limit:200})
          .find((item) => item.id === claimed.executionId) || null : null };
      }
      case 'history': return this.store.executionPage({taskId:body.taskId || null, limit:body.limit, cursor:body.cursor ?? null});
      case 'resolve': {
        if (!['failed','cancelled'].includes(body.status)) throw error('INVALID_SCHEDULED_TASK', 'invalid resolution');
        return { resolved:this.store.updateExecution(body.executionId, body.status, 'resolved by user', {from:['uncertain']}) };
      }
      default: throw error('INVALID_SCHEDULED_TASK', 'unknown scheduled task action');
    }
  }
}
