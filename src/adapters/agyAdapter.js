import { readFileSync, existsSync, statSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { TerminalAdapter } from './terminalAdapter.js';
import { configureAgyHooks } from './agy/hookSettings.js';
import { startAgyHookServer } from './agy/hookServer.js';
import { agyTranscriptPath, agyTranscriptItems, readAgyConversationHistory } from './agy/history.js';
import { buildInteractionRequest, INTERACTION_KINDS, INTERACTION_SOURCES } from '../runtime/agentInteractionContract.js';
import { agentInteractionTimeoutMsFromConfig } from '../config/agentInteractionTimeout.js';
import { readConfig } from '../persistence/state.js';
import { agyPermissionPayload } from './agy/permissionPayload.js';

export function agyNativeArgs(args) {
  return args.flatMap((arg, index) => {
    if (arg === '--resume') return ['--conversation'];
    if (arg.startsWith('--resume=')) return [arg.replace('--resume=', '--conversation=')];
    return [arg];
  });
}

export class AgyAdapter extends TerminalAdapter {
  constructor({ args = [], cwd } = {}) {
    super({ command: 'agy', args: agyNativeArgs(args) });
    this.kind = 'agy'; this.cwd = cwd; this.pendingEvents = []; this.seen = new Set();
    this.nativeSessionId = null; this.transcriptPath = null; this.ready = false;
    this.output = ''; this.model = null; this.busy = false; this.mode = 'unknown';
    this.toolIdsByStep = new Map();
    for (let i = 0; i < this.args.length; i++) {
      const arg = this.args[i];
      if (arg === '--conversation') this.nativeSessionId = this.args[++i] || null;
      else if (arg.startsWith('--conversation=')) this.nativeSessionId = arg.slice(15);
    }
    this.transcriptPath = agyTranscriptPath(this.nativeSessionId);
    if (this.transcriptPath && existsSync(this.transcriptPath) && statSync(this.transcriptPath).size <= 32 * 1024 * 1024) {
      for (const item of agyTranscriptItems(readFileSync(this.transcriptPath, 'utf8'))) this.seen.add(`${this.nativeSessionId}:${item.id}`);
    }
  }
  describe() { return { ...super.describe(), runtime: 'agy-pty', structuredSources: ['agy-hooks', 'agy-transcript'] }; }
  async beforeStart({ sessionId }) {
    this.sessionId = sessionId;
    const timeoutMs = agentInteractionTimeoutMsFromConfig(readConfig()) || 300000;
    this.hookServer = await startAgyHookServer({
      timeoutMs, onEvent: payload => this.onHook(payload),
      onPermission: (payload, id) => this.permission(payload.toolCall || {}, id, Math.min(timeoutMs, 3600000)),
      onCancel: (id, reason) => this.pendingEvents.push({ type: 'agent.permission.resolved', provider: 'agy', callId: id, reason }),
    });
    try { await configureAgyHooks(); } catch (error) { this.hookServer.close(); throw error; }
  }
  buildLaunch() { return { command: 'agy', args: this.args, env: this.hookServer?.env || {} }; }
  permission(tool, id, timeoutMs, source = INTERACTION_SOURCES.HOOK) {
    const input = tool.args || tool.rawInput || {};
    this.pendingEvents.push(buildInteractionRequest({ provider: 'agy', runtime: this.describe().runtime,
      sessionId: this.sessionId, interactionId: id, source, kind: INTERACTION_KINDS.PERMISSION,
      title: `${tool.name || tool.title || 'Tool'} needs permission`,
      prompt: tool.title || 'Review this Antigravity action before continuing.',
      payload: agyPermissionPayload(tool, this.cwd),
      expiresAt: timeoutMs > 0 ? Math.floor((Date.now() + timeoutMs) / 1000) : null,
    }));
  }
  onHook(payload) {
    const nativeId = String(payload.conversationId || '');
    if (nativeId && nativeId !== this.nativeSessionId) {
      this.nativeSessionId = nativeId;
      this.transcriptPath = agyTranscriptPath(nativeId);
      this.pendingEvents.push({ type: 'agent.session.start', provider: 'agy', sessionId: nativeId, transcriptPath: this.transcriptPath });
    }
    if (payload.modelName && this.model !== payload.modelName) {
      this.model = payload.modelName; this.pendingEvents.push(this.modelStatusEvent());
    }
    if (payload.hookEventName === 'PreInvocation' && !this.busy) {
      this.busy = true; this.pendingEvents.push({ type: 'agent.task.started', provider: 'agy' });
    }
    if (payload.hookEventName === 'PreToolUse') {
      this.toolIdsByStep.set(payload.stepIdx, payload.toolCall?.id);
      this.pendingEvents.push({ type: 'agent.tool_call.start', provider: 'agy',
        callId: payload.toolCall?.id, tool: payload.toolCall?.name, input: payload.toolCall?.args });
    }
    if (payload.hookEventName === 'Stop') {
      this.busy = !payload.fullyIdle;
      this.pendingEvents.push({ type: 'agent.task.complete', provider: 'agy', fullyIdle: payload.fullyIdle });
    }
  }
  handleOutput(data) {
    this.output = (this.output + stripVTControlCharacters(data)).slice(-8000);
    const ready = this.output.lastIndexOf('? for shortcuts');
    const modal = Math.max(this.output.lastIndexOf('Select login method:'), this.output.lastIndexOf('Do you trust the contents'),
      this.output.lastIndexOf('Allow access to this file?'), this.output.lastIndexOf('Switch Model'), this.output.lastIndexOf('Set Effort'));
    this.ready = ready > modal && !this.userTyping;
    const observed = [...this.output.matchAll(/\b(auto|plan|accept-edits)\s*·/g)].at(-1)?.[1];
    if (observed && observed !== this.mode) { this.mode = observed; this.pendingEvents.push(this.modeStatusEvent()); }
    return [];
  }
  async submitRemoteMessage(executor, message) {
    if (!this.ready || this.hookServer?.pending.size) return false;
    await executor.submitMessage(message); return true;
  }
  onTerminalInput(data) {
    const text = String(data);
    if (text.includes('\x03')) { this.userTyping = false; this.onInterrupt(); }
    else if (text.includes('\r') || text.includes('\n')) this.userTyping = false;
    else if (/[\x20-\x7e\u0080-\uffff]/u.test(text)) { this.userTyping = true; this.ready = false; }
  }
  onInterrupt() {
    this.hookServer?.cancelAll();
    if (this.busy) this.pendingEvents.push({ type: 'agent.task.aborted', provider: 'agy', reason: 'user_interrupted' });
    this.busy = false;
  }
  resolvePermission(payload) {
    return this.hookServer?.resolve(payload.interactionId || payload.callId,
      payload.action || (['approved', 'approved_for_session'].includes(payload.decision) ? 'allow' : 'deny')) || false;
  }
  modelStatusEvent(extra = {}) { return { type: 'agent.model.status', provider: 'agy', runtime: this.describe().runtime,
    sessionId: this.sessionId, model: this.model, modelProvider: null, source: 'native', modelControl: 'unsupported', availableModels: [], ...extra }; }
  effortStatusEvent(extra = {}) { return { type: 'agent.effort.status', provider: 'agy', runtime: this.describe().runtime,
    effort: null, effortControl: 'unsupported', availableEfforts: [], ...extra }; }
  modeStatusEvent() { return { type: 'agent.mode.status', provider: 'agy', runtime: this.describe().runtime,
    mode: this.mode, modeControl: 'unsupported', availableModes: [] }; }
  getTranscriptPath() { return this.transcriptPath; }
  readConversationHistory(options) { return readAgyConversationHistory(this.transcriptPath, options); }
  scanStructuredEvents() {
    const events = this.pendingEvents.splice(0);
    if (this.transcriptPath && existsSync(this.transcriptPath)) {
      try {
        const stat = statSync(this.transcriptPath);
        const stamp = `${stat.mtimeMs}:${stat.size}`;
        if (stamp === this.transcriptStamp || stat.size > 32 * 1024 * 1024) return events;
        this.transcriptStamp = stamp;
        for (const item of agyTranscriptItems(readFileSync(this.transcriptPath, 'utf8'), { includeToolStarts: false })) {
          const id = `${this.nativeSessionId}:${item.id}`;
          if (this.seen.has(id)) continue;
          this.seen.add(id);
          events.push({ ...(item.event ? { ...item.event, callId: this.toolIdsByStep.get(item.sequence) || item.event.callId }
            : { type: item.role === 'user' ? 'user.text' : 'agent.text', text: item.text }),
            provider: 'agy', eventId: id, createdAt: Math.floor(Date.parse(item.createdAt) / 1000) || undefined });
        }
      } catch { /* A partial write is retried on the next scan. */ }
    }
    return events;
  }
  cleanup() { this.hookServer?.close(); }
}
