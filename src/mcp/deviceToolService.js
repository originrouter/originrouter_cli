import { randomUUID } from 'node:crypto';
import { normalizeScheduledTask } from '../runtime/scheduledTaskRules.js';

function fail(code, message) { return Object.assign(new Error(message), {code}); }
function string(value, field, max = 191) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail('DEVICE_TOOL_INVALID', `${field} is invalid`);
  return value;
}
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('DEVICE_TOOL_INVALID', 'tool input is invalid');
  return structuredClone(value);
}
function sameAccount(provider, account) {
  if (provider() !== account) throw fail('DEVICE_TOOL_ACCOUNT_CHANGED','Account changed during tool request');
}
function checkSignal(signal) { if (signal?.aborted) throw fail('DEVICE_TOOL_CANCELLED','Agent tool request was cancelled'); }
function publicTarget(target) {
  if (!target) throw fail('REMOTE_ENV_NOT_FOUND','Remote target not found');
  const {credentialRef, ...safe} = target;
  return safe;
}

/** Only model-facing task/SSH operations. Target credentials and management
 * actions are intentionally absent. Every operation uses the managed Agent's
 * existing approval policy and the daemon validates state again afterwards. */
export class DeviceToolService {
  constructor({broker, registry, scheduled, remote, accountProvider} = {}) {
    this.broker=broker; this.registry=registry; this.scheduled=scheduled; this.remote=remote; this.accountProvider=accountProvider;
    this.unsubscribe=registry.subscribe(({type,sessionId,payload}) => {
      if (type === 'unregistered' || (type === 'updated' && payload?.attached === false)) this.remote?.manager.closeOwner(sessionId);
    });
  }
  async approve(sessionId, operation, input, signal) {
    if (JSON.stringify(input).length > 15_000) throw fail('DEVICE_TOOL_INVALID','Tool request is too large to review');
    const result = await this.broker.authorize(sessionId,{tool:`originrouter.${operation}`,title:`OriginRouter: ${operation}`,
      prompt:'Review this device operation before allowing the Agent to continue.',input},{signal});
    sameAccount(this.accountProvider,result.account);
    checkSignal(signal);
    if (!this.registry.sessionFacts(sessionId)?.attached) throw fail('DEVICE_TOOL_SESSION_ENDED','Agent session is no longer attached');
    return result.account;
  }
  async handle(sessionId, operation, raw, {signal} = {}) {
    const input=plain(raw || {});
    const account=this.accountProvider();
    if (!this.registry.sessionFacts(sessionId)?.supportsDeviceTools) throw fail('DEVICE_TOOL_UNAVAILABLE','This Agent session does not support device tools');
    if (operation === 'scheduled.list' || operation === 'scheduled.history') {
      const taskId = input.taskId == null ? null : string(input.taskId,'task id',64);
      await this.approve(sessionId,operation,{...(taskId ? {taskId} : {})},signal); sameAccount(this.accountProvider,account);
      return this.scheduled.handle(operation === 'scheduled.list' ? 'list' : 'history', taskId ? {taskId} : {});
    }
    if (operation === 'scheduled.save') {
      const rawTask=plain(input.task);
      const launch=plain(rawTask.launch);
      // Model tools cannot submit arbitrary policy bundles or hidden fields.
      const allowedLaunch={agentType:launch.agentType,workspaceId:launch.workspaceId,initialMessage:launch.initialMessage,
        permissionProfile:launch.permissionProfile || 'manual',...(launch.provider ? {provider:launch.provider} : {}),...(launch.model ? {model:launch.model} : {})};
      if (!['manual','guarded','unrestricted'].includes(allowedLaunch.permissionProfile)) throw fail('DEVICE_TOOL_INVALID','Model-created tasks support manual, guarded, or unrestricted permissions; select an AI approval template in the app for AI review');
      const task=normalizeScheduledTask({id:rawTask.id || `st_${randomUUID()}`,name:rawTask.name,enabled:rawTask.enabled,
        schedule:rawTask.schedule,launch:allowedLaunch});
      const existing=this.scheduled.store.get(task.id);
      const baseRevision=input.baseRevision ?? null;
      if (existing ? baseRevision !== existing.revision : baseRevision != null && baseRevision !== 0) throw fail('SCHEDULED_TASK_CONFLICT','Scheduled task changed');
      await this.approve(sessionId,operation,{task,baseRevision},signal); sameAccount(this.accountProvider,account);
      return this.scheduled.handle('save',{task,baseRevision});
    }
    if (operation === 'scheduled.delete' || operation === 'scheduled.run') {
      const id=string(input.id,'task id',64);
      const task=this.scheduled.store.get(id);
      if (!task) throw fail('SCHEDULED_TASK_NOT_FOUND','Scheduled task not found');
      const baseRevision=input.baseRevision ?? task.revision;
      if (baseRevision !== task.revision) throw fail('SCHEDULED_TASK_CONFLICT','Scheduled task changed');
      await this.approve(sessionId,operation,{task},signal); sameAccount(this.accountProvider,account);
      if (this.scheduled.store.get(id)?.revision !== baseRevision) throw fail('SCHEDULED_TASK_CONFLICT','Scheduled task changed after approval');
      return this.scheduled.handle(operation === 'scheduled.run' ? 'run' : 'delete',{id,baseRevision});
    }
    if (operation === 'remote.list') {
      await this.approve(sessionId,operation,{},signal); sameAccount(this.accountProvider,account);
      return {targets:this.remote.store.list()};
    }
    if (operation === 'remote.open') {
      const id=string(input.id,'target id');
      const target=publicTarget(this.remote.store.get(id,account));
      await this.approve(sessionId,operation,{target},signal); sameAccount(this.accountProvider,account);
      const opened = await this.remote.manager.open(sessionId,id,{expectedRevision:target.revision});
      if (signal?.aborted) {
        await this.remote.manager.close(sessionId,opened.handle).catch(() => {});
        checkSignal(signal);
      }
      return opened;
    }
    if (['remote.exec','remote.chdir','remote.close'].includes(operation)) {
      const handle=string(input.handle,'handle',191);
      const info=await this.remote.manager.sessionInfo(sessionId,handle);
      if (info.outcomeUnknown && operation !== 'remote.close') throw fail('REMOTE_ENV_SESSION_UNCERTAIN','A previous command may still be running. Inspect the host independently before closing this session and opening another.');
      sameAccount(this.accountProvider,account);
      const target=publicTarget(this.remote.store.get(info.targetId,account));
      if (target.revision !== info.revision) throw fail('REMOTE_ENV_CONFLICT','Remote target changed');
      const context={target,handle,cwd:info.cwd,...(info.outcomeUnknown ? {outcomeUnknown:true} : {})};
      let command, cwd, path, timeoutMs, maxOutputBytes;
      if (operation === 'remote.exec') {
        command=string(input.command,'command',8192);
        if (Buffer.byteLength(command) > 8192) throw fail('DEVICE_TOOL_INVALID','Command is too large');
        cwd=input.cwd == null ? info.cwd : string(input.cwd,'cwd',4096);
        if (!cwd.startsWith('/') || /[\r\n]/.test(cwd)) throw fail('DEVICE_TOOL_INVALID','cwd must be an absolute path');
        timeoutMs=input.timeoutMs ?? 60_000; maxOutputBytes=input.maxOutputBytes ?? 131_072;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1_048_576) throw fail('DEVICE_TOOL_INVALID','Invalid execution limit');
        Object.assign(context,{command,cwd,timeoutMs,maxOutputBytes});
      }
      if (operation === 'remote.chdir') {
        path=string(input.path,'path',4096);
        if (!path.startsWith('/') || /[\r\n]/.test(path)) throw fail('DEVICE_TOOL_INVALID','path must be an absolute path');
        context.path=path;
      }
      await this.approve(sessionId,operation,context,signal); sameAccount(this.accountProvider,account);
      const current=await this.remote.manager.sessionInfo(sessionId,handle);
      if (current.revision !== info.revision || current.targetId !== info.targetId) throw fail('REMOTE_ENV_CONFLICT','Remote target changed after approval');
      if (current.outcomeUnknown && operation !== 'remote.close') throw fail('REMOTE_ENV_SESSION_UNCERTAIN','A previous command may still be running. Inspect the host independently before closing this session and opening another.');
      sameAccount(this.accountProvider,account);
      checkSignal(signal);
      if (operation === 'remote.exec') return this.remote.manager.run(sessionId,handle,command,{cwd,timeoutMs,maxOutputBytes,signal});
      if (operation === 'remote.chdir') return this.remote.manager.chdir(sessionId,handle,path,{signal});
      return this.remote.manager.close(sessionId,handle);
    }
    throw fail('DEVICE_TOOL_INVALID','Unknown device tool operation');
  }
  close() { this.unsubscribe?.(); }
}
