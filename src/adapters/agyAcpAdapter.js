import { AgyAdapter } from './agyAdapter.js';
import { AgyAcpClient } from './agy/acpClient.js';
import { agyTranscriptPath } from './agy/history.js';
import { INTERACTION_SOURCES } from '../runtime/agentInteractionContract.js';
import { assertAgyAccountConfig } from './agy/accountConfig.js';
import { agentInteractionTimeoutMsFromConfig } from '../config/agentInteractionTimeout.js';
import { readConfig } from '../persistence/state.js';
import { randomUUID } from 'node:crypto';
import { buildInteractionRequest, INTERACTION_KINDS } from '../runtime/agentInteractionContract.js';
import { agentGatewayMcpConfig } from '../mcp/agentGatewayConfig.js';
import { agyCommands, agyPromptContent, agyToolContent } from './agy/acpContent.js';
import { supportedAgyForm, validAgyFormValues } from './agy/acpForms.js';

function optionsFor(config) {
  return (config?.options || []).flatMap(option => option.options ? optionsFor(option) : [option]);
}

export class AgyAcpAdapter extends AgyAdapter {
  constructor(options = {}) {
    super(options); this.supportsRawTerminal = false; this.configOptions = []; this.approvals = new Map(); this.client = options.client || new AgyAcpClient();
    this.initialMessage = null; this.resumeId = null; this.accountConfigHome = options.accountConfigHome;
    this.commands = []; this.activePrompts = new Set(); this.toolCalls = new Map(); this.turnId = null;
    for (let i = 0; i < this.args.length; i++) {
      const arg = this.args[i];
      if (arg === '--prompt') this.initialMessage = this.args[++i];
      else if (arg === '--conversation') this.resumeId = this.args[++i];
      else if (arg.startsWith('--conversation=')) this.resumeId = arg.slice(15);
      else if (arg === '--model') this.launchModel = this.args[++i];
      else if (arg.startsWith('--model=')) this.launchModel = arg.slice(8);
    }
  }
  describe() { return { adapter: 'agy-acp', runtime: 'agy-acp', structuredSources: ['agy-acp', 'agy-transcript'] }; }
  async beforeStart({ sessionId, stateDir }) { assertAgyAccountConfig([], { home: this.accountConfigHome }); this.sessionId = sessionId; this.stateDir = stateDir; }
  buildLaunch() { return { command: 'agy', args: ['acp'], env: {} }; }
  configure(result) {
    if (Array.isArray(result.configOptions)) this.configOptions = result.configOptions;
    if (result.models) this.models = result.models;
    if (result.modes) this.modes = result.modes;
    this.model = this.configOptions.find(item => item.id === 'model' || item.category === 'model')?.currentValue || this.models?.currentModelId || null;
    this.pendingEvents.push(this.modelStatusEvent(), this.effortStatusEvent(), this.modeStatusEvent());
  }
  modelConfig() { return this.configOptions.find(item => item.category === 'model' || item.id === 'model'); }
  effortConfig() { return this.configOptions.find(item => item.id === 'thought_level' || item.id === 'thoughtLevel'); }
  modelStatusEvent(extra = {}) {
    const config = this.modelConfig();
    const options = config ? optionsFor(config).map(item => ({ id: item.value, displayName: item.name || item.value }))
      : (this.models?.availableModels || []).map(item => ({ id: item.modelId, displayName: item.name || item.modelId }));
    return { ...super.modelStatusEvent(), model: this.model, availableModels: options.map(item => ({ ...item, provider: '', providerName: 'Antigravity' })),
      modelControl: config && options.length && !this.authenticationRequired ? 'supported' : 'unsupported',
      ...(this.authenticationRequired ? { availableModels: [] } : {}), ...extra };
  }
  effortStatusEvent(extra = {}) {
    const config = this.effortConfig();
    const levels = optionsFor(config).map(item => item.value);
    return { ...super.effortStatusEvent(), effort: config?.currentValue || null,
      availableEfforts: this.authenticationRequired ? [] : levels, effortControl: levels.length && !this.authenticationRequired ? 'supported' : 'unsupported', ...extra };
  }
  async setOption(payload, config, value, status) {
    let accepted = false, reason = 'model_control_unsupported';
    try {
      if (config && optionsFor(config).some(item => item.value === value)) {
        const result = await this.client.request('session/set_config_option', { sessionId: this.nativeSessionId, configId: config.id, value });
        this.configure(result);
        accepted = this.configOptions.find(item => item.id === config.id)?.currentValue === value;
        reason = accepted ? null : 'native_setting_not_confirmed';
      }
    } catch (error) { reason = error.message; }
    this.pendingEvents.push(status.call(this, { requestId: payload.requestId || null, accepted, reason }));
    return accepted;
  }
  setModel(payload) { return this.setOption(payload, this.modelConfig(), String(payload.model || ''), this.modelStatusEvent); }
  setEffort(payload) { return this.setOption(payload, this.effortConfig(), String(payload.effort || ''), this.effortStatusEvent); }
  modeStatusEvent(extra = {}) {
    const config = this.configOptions?.find(item => item.id === 'mode');
    return { type: 'agent.mode.status', provider: 'agy', runtime: 'agy-acp', mode: config?.currentValue || 'default',
      modeControl: config ? 'supported' : 'unsupported', availableModes: optionsFor(config).map(item => ({ id: item.value, label: item.name || item.value })), ...extra };
  }
  setMode(payload) { return this.setOption(payload, this.configOptions.find(item => item.id === 'mode'), String(payload.mode || ''), this.modeStatusEvent); }
  async submitRemoteMessage(_executor, message, payload = {}) {
    if (!this.ready || this.interrupting || this.approvals.size || this.activePrompts.size >= 16) return false;
    const prompt = agyPromptContent(message, payload.content, this.client.capabilities?.promptCapabilities);
    if (!prompt) return false;
    const starting = !this.busy;
    if (starting) { this.turnId = randomUUID(); this.turnError = null; this.canceled = false; this.toolCalls.clear(); }
    const turnId = this.turnId, request = {};
    this.activePrompts.add(request);
    this.busy = true;
    this.pendingEvents.push({ type: 'user.text', provider: 'agy', text: message || '[Attached context]',
      ...(payload.origin === 'supervisor' ? { origin: 'supervisor' } : {}),
      eventId: `local-message-${payload.messageId || randomUUID()}`,
      ...(payload.content?.length ? { attachments: payload.content.map(block => ({ type: block.type, name: block.resource?.uri || block.mimeType })) } : {}) });
    if (starting) this.pendingEvents.push({ type: 'agent.task.started', provider: 'agy', supervisorTurnId: turnId });
    // ACP explicitly defines a concurrent prompt as steering the current
    // turn. It is not a second turn and its early response cannot end it.
    void this.client.request('session/prompt', { sessionId: this.nativeSessionId, prompt }, { timeoutMs: 0 })
      .then(result => {
        if (result.stopReason === 'cancelled') this.canceled = true;
        this.finishPrompt(request, turnId, result.stopReason);
      }).catch(error => {
        this.turnError = error.message;
        this.finishPrompt(request, turnId);
      });
    return true;
  }
  finishPrompt(request, turnId, stopReason) {
    this.activePrompts.delete(request);
    if (this.activePrompts.size || turnId !== this.turnId) return;
    this.busy = false;
    const canceled = this.interrupting || this.canceled; this.interrupting = false;
    for (const [id, tool] of this.toolCalls) if (!tool.ended) {
      tool.ended = true;
      this.pendingEvents.push({ type: 'agent.tool_call.end', provider: 'agy', callId: id,
        content: canceled ? 'Cancelled' : 'Turn ended', isError: canceled || Boolean(this.turnError) });
    }
    this.cancelInteractions('native_request_aborted');
    this.pendingEvents.push({ type: canceled ? 'agent.task.aborted' : this.turnError ? 'agent.task.failed' : 'agent.task.complete',
      provider: 'agy', supervisorTurnId: turnId, stopReason, ...(this.turnError ? { error: this.turnError } : {}) });
    for (const resolve of this.cancelWaiters || []) resolve(true);
    this.cancelWaiters = [];
  }
  async interruptForRecovery(turnId) {
    if (!this.busy || turnId !== this.turnId || this.approvals.size) return false;
    this.onInterrupt();
    if (!this.busy) return true;
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); this.cancelWaiters = (this.cancelWaiters || []).filter(item => item !== done); resolve(value); };
      const timer = setTimeout(() => done(false), 10000);
      (this.cancelWaiters ||= []).push(done);
    });
  }
  resolvePermission(payload) {
    const id = payload.interactionId || payload.callId, entry = this.approvals.get(id);
    if (!entry) return false;
    this.approvals.delete(id); clearTimeout(entry.timer);
    if (entry.kind === 'form') {
      const action = ['submit', 'allow'].includes(payload.action) ? 'accept' : payload.action === 'cancel' ? 'cancel' : 'decline';
      const content = payload.response?.values || payload.response || {};
      if (action === 'accept' && !validAgyFormValues(entry.schema, content)) { entry.resolve({ action: 'cancel' }); return false; }
      entry.resolve({ action, ...(action === 'accept' ? { content } : {}) });
      return true;
    }
    const allow = payload.action === 'allow' || ['approved', 'approved_for_session'].includes(payload.decision);
    const option = entry.options.find(item => item.kind === (allow ? 'allow_once' : 'reject_once'));
    entry.resolve({ outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
    return Boolean(option) || payload.action === 'cancel' || !allow;
  }
  cancelInteractions(reason) {
    for (const [id, entry] of this.approvals) {
      clearTimeout(entry.timer); entry.resolve(entry.kind === 'form' ? { action: 'cancel' } : { outcome: { outcome: 'cancelled' } });
      this.pendingEvents.push({ type: 'agent.permission.resolved', callId: id, reason });
    }
    this.approvals.clear();
  }
  onInterrupt() {
    if (this.interrupting) return;
    this.cancelInteractions('native_request_aborted');
    if (this.busy && this.nativeSessionId && !this.client.closed) {
      this.interrupting = true;
      this.client.notify('session/cancel', { sessionId: this.nativeSessionId });
    }
  }
  notification(message) {
    if (message.method !== 'session/update' || message.params.sessionId !== this.nativeSessionId) return;
    const update = message.params.update || {};
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = update.content?.text || '';
        if (/^(?:error:\s*)?(?:failed to construct executor\b|UNAUTHENTICATED\b|authentication required\b|please sign in to view available models\b)/i.test(text.trim())) {
          this.turnError = text.slice(0, 2048);
          this.authenticationRequired = /auth|sign.?in/i.test(text);
          this.pendingEvents.push({ type: 'agent.adapter.status', provider: 'agy', state: this.authenticationRequired ? 'authentication_required' : 'runtime_failed', message: this.turnError }, this.modelStatusEvent(), this.effortStatusEvent());
        }
        if (update.content?.type === 'text') this.pendingEvents.push({ type: 'agent.text.delta', provider: 'agy', text: update.content.text, supervisorTurnId: this.turnId });
        break;
      }
      case 'agent_thought_chunk':
        if (update.content?.type === 'text') this.pendingEvents.push({ type: 'agent.thinking', provider: 'agy', text: update.content.text });
        break;
      case 'plan':
        this.pendingEvents.push({ type: 'plan.updated', provider: 'agy', entries: update.entries || [],
          text: (update.entries || []).map(entry => `[${entry.status}] ${entry.content}`).join('\n').slice(0, 64000) });
        break;
      case 'available_commands_update':
        this.commands = agyCommands(update.availableCommands);
        this.pendingEvents.push({ type: 'agent.commands', provider: 'agy', commands: this.commands });
        break;
      case 'usage_update':
        if (Number.isFinite(update.used) && Number.isFinite(update.size)) this.pendingEvents.push({
          type: 'agent.usage', provider: 'agy', contextUsedTokens: Math.max(0, update.used), contextWindowTokens: Math.max(0, update.size),
          amountMicros: null, costSource: 'unsupported' });
        break;
      case 'tool_call':
        if (this.toolCalls.has(update.toolCallId)) break;
        this.toolCalls.set(update.toolCallId, { ...update, ended: false });
        this.pendingEvents.push({ type: 'agent.tool_call.start', provider: 'agy', callId: update.toolCallId, tool: update.title || update.kind, input: update.rawInput || {} }); break;
      case 'tool_call_update': {
        const tool = { ...this.toolCalls.get(update.toolCallId), ...update };
        this.toolCalls.set(update.toolCallId, tool);
        if (['completed', 'failed'].includes(update.status) && !tool.ended) {
          tool.ended = true;
          this.pendingEvents.push({ type: 'agent.tool_call.end', provider: 'agy', callId: update.toolCallId,
            content: agyToolContent(tool.content, tool.rawOutput), isError: update.status === 'failed' });
        }
        break;
      }
      case 'config_option_update': this.configure({ configOptions: update.configOptions }); break;
      case 'current_mode_update':
        this.mode = update.currentModeId;
        for (const config of this.configOptions) if (config.id === 'mode') config.currentValue = this.mode;
        this.pendingEvents.push(this.modeStatusEvent()); break;
    }
  }
  createExecutor() {
    const adapter = this;
    return {
      terminal: null,
      async start({ cwd, env, onExit, onError }) {
        let launched = false;
        adapter.client.on('exit', result => { if (launched) onExit?.(result); });
        adapter.client.on('protocolError', onError);
        adapter.client.on('notification', message => adapter.notification(message));
        adapter.client.onRequest = (method, params, rpcId) => {
          if (!['session/request_permission', 'elicitation/create'].includes(method)) throw Object.assign(new Error('Unsupported ACP client method'), { code: -32601 });
          const isForm = method === 'elicitation/create';
          if (isForm && (params.mode === 'url' || !supportedAgyForm(params.requestedSchema))) {
            throw Object.assign(new Error('Unsupported ACP elicitation schema'), { code: -32602 });
          }
          if (isForm && params.sessionId !== adapter.nativeSessionId) return { action: 'cancel' };
          if (params.sessionId !== adapter.nativeSessionId) return { outcome: { outcome: 'cancelled' } };
          const id = `${adapter.nativeSessionId}:acp-${rpcId}`;
          const timeoutMs = agentInteractionTimeoutMsFromConfig(readConfig());
          return new Promise(resolve => {
            const timer = timeoutMs > 0 ? setTimeout(() => {
              adapter.approvals.delete(id); resolve(isForm ? { action: 'cancel' } : { outcome: { outcome: 'cancelled' } });
              adapter.pendingEvents.push({ type: 'agent.permission.resolved', callId: id, reason: 'approval_timeout' });
            }, timeoutMs) : null;
            adapter.approvals.set(id, { resolve, timer, kind: isForm ? 'form' : 'permission', schema: params.requestedSchema, options: params.options || [] });
            if (isForm) adapter.pendingEvents.push(buildInteractionRequest({ provider: 'agy', runtime: 'agy-acp',
              sessionId: adapter.sessionId, interactionId: id, source: INTERACTION_SOURCES.ACP, kind: INTERACTION_KINDS.FORM,
              title: params.title || 'Antigravity question', prompt: params.message || 'Antigravity needs input.',
              payload: { schema: params.requestedSchema },
              containsSecret: Object.values(params.requestedSchema.properties || {}).some(field => field?.writeOnly || field?.format === 'password'),
              expiresAt: timeoutMs > 0 ? Math.floor((Date.now() + timeoutMs) / 1000) : null }));
            else adapter.permission(params.toolCall || {}, id, timeoutMs, INTERACTION_SOURCES.ACP);
          });
        };
        try {
          await adapter.client.connect({ cwd, env });
          const deviceMcp = adapter.stateDir ? agentGatewayMcpConfig(adapter.sessionId, { deviceTools: true, stateDir: adapter.stateDir }) : null;
          const params = { cwd, mcpServers: deviceMcp ? [{ name: 'originrouter_device', command: deviceMcp.command,
            args: deviceMcp.args, env: Object.entries(deviceMcp.env || {}).map(([name, value]) => ({ name, value })) }] : [],
            ...(adapter.resumeId ? { sessionId: adapter.resumeId } : {}) };
          const result = await adapter.client.request(adapter.resumeId ? 'session/resume' : 'session/new', params);
          adapter.nativeSessionId = result.sessionId || adapter.resumeId;
          if (!adapter.nativeSessionId) throw new Error('Antigravity did not return a native session id');
          adapter.transcriptPath = agyTranscriptPath(adapter.nativeSessionId);
          adapter.configure(result);
          adapter.pendingEvents.push({ type: 'agent.capabilities', provider: 'agy', promptCapabilities: adapter.client.capabilities?.promptCapabilities || {} });
          if (!adapter.model) throw new Error('Antigravity returned no available model; check the official agy login and account availability');
          if (adapter.launchModel && !await adapter.setModel({ model: adapter.launchModel })) throw new Error('The requested model is not available in the native Antigravity catalog');
          adapter.pendingEvents.unshift({ type: 'agent.session.start', provider: 'agy', sessionId: adapter.nativeSessionId, transcriptPath: adapter.transcriptPath });
          adapter.ready = true;
          launched = true;
          return { pid: adapter.client.child.pid, executor: 'acp' };
        } catch (error) { adapter.client.close(); throw error; }
      },
      write() { return false; }, resize() {},
      submitMessage(message) { return adapter.submitRemoteMessage(null, message); },
      interrupt() { adapter.onInterrupt(); },
      stop() { adapter.onInterrupt(); adapter.client.close(); },
    };
  }
  scanStructuredEvents() { return this.pendingEvents.splice(0); }
  async onRegistered() { if (this.initialMessage) { const message = this.initialMessage; this.initialMessage = null; await this.submitRemoteMessage(null, message); } }
  cleanup() { this.ready = false; this.cancelInteractions('session_ended'); this.client.close(); }
}
