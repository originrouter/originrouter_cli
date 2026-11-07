import { randomUUID } from 'node:crypto';

function fail(code, message) { return Object.assign(new Error(message), {code}); }

// An approval is tied to one attached managed wrapper, account and request.
// The daemon does not act merely because an MCP client says it was approved.
export class DeviceToolApprovalBroker {
  constructor({registry, accountProvider, now = () => Date.now(), timeoutMs = 90_000} = {}) {
    this.registry = registry;
    this.accountProvider = accountProvider;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.unsubscribe = registry.subscribe((event) => this.onEvent(event));
    this.closed = false;
  }
  onEvent({type, sessionId, payload}) {
    if (type === 'command' && ['terminal.interrupt','session.stop','agent.message'].includes(payload?.type)) {
      for (const item of this.pending.values()) if (item.sessionId === sessionId) item.finish(fail('DEVICE_TOOL_CANCELLED','Agent turn changed before approval'));
      return;
    }
    if (type === 'unregistered' || (type === 'updated' && payload?.attached === false)) {
      for (const item of this.pending.values()) if (item.sessionId === sessionId) item.finish(fail('DEVICE_TOOL_SESSION_ENDED','Agent session is no longer attached'));
      return;
    }
    if (type !== 'device_tool_approval_result' || payload?.type !== 'agent.device_tool.approval_result') return;
    const item = this.pending.get(String(payload.requestId || ''));
    if (!item || item.sessionId !== sessionId) return;
    if (this.now() >= item.deadline) return item.finish(fail('DEVICE_TOOL_APPROVAL_EXPIRED','Agent tool approval expired'));
    if (this.accountProvider() !== item.account) return item.finish(fail('DEVICE_TOOL_ACCOUNT_CHANGED','Account changed during approval'));
    const facts = this.registry.sessionFacts(sessionId);
    if (!facts?.attached || !facts.supportsDeviceTools) return item.finish(fail('DEVICE_TOOL_SESSION_ENDED','Agent session is no longer attached'));
    if (payload.accepted !== true) return item.finish(fail('DEVICE_TOOL_DENIED','Agent tool operation was not approved'));
    item.finish(null);
  }
  authorize(sessionId, request, {signal} = {}) {
    if (this.closed) return Promise.reject(fail('DEVICE_TOOL_UNAVAILABLE','Agent tool approval is unavailable'));
    if (signal?.aborted) return Promise.reject(fail('DEVICE_TOOL_CANCELLED','Agent tool request was cancelled'));
    const facts = this.registry.sessionFacts(sessionId);
    if (!facts?.attached || !facts.supportsDeviceTools) return Promise.reject(fail('DEVICE_TOOL_UNAVAILABLE','This Agent session does not support device tool approvals'));
    if (this.pending.size >= 128) return Promise.reject(fail('DEVICE_TOOL_LIMIT','Too many pending Agent tool requests'));
    const account = this.accountProvider();
    const requestId = `dta_${randomUUID()}`;
    const deadline = this.now() + this.timeoutMs;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
        this.pending.delete(requestId);
        if (error) {
          try { this.registry.enqueueCommand(sessionId, {type:'agent.device_tool.cancel', requestId}); } catch {}
          reject(error);
        } else resolve({account});
      };
      const cancelled = () => finish(fail('DEVICE_TOOL_CANCELLED','Agent tool request was cancelled'));
      const timer = setTimeout(() => finish(fail('DEVICE_TOOL_APPROVAL_EXPIRED','Agent tool approval expired')), this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {sessionId, account, deadline, finish});
      signal?.addEventListener('abort', cancelled, {once:true});
      try {
        this.registry.enqueueCommand(sessionId, {type:'agent.device_tool.approval', requestId,
          expiresAt:Math.ceil(deadline / 1000), tool:request.tool, title:request.title,
          prompt:request.prompt, input:request.input});
      } catch { finish(fail('DEVICE_TOOL_SESSION_ENDED','Agent session is no longer attached')); }
    });
  }
  close() {
    this.closed = true;
    this.unsubscribe?.();
    for (const item of [...this.pending.values()]) item.finish(fail('DEVICE_TOOL_UNAVAILABLE','Agent tool approval is unavailable'));
  }
}
