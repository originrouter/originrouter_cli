import http from 'node:http';
import { randomBytes } from 'node:crypto';

export async function startAgyHookServer({ onEvent, onPermission, onCancel, timeoutMs = 300000 }) {
  const token = randomBytes(32).toString('hex');
  const pending = new Map();
  let closed = false;
  const respond = (response, result, status = 200) => {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  };
  const finish = (id, decision, reason) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id); clearTimeout(entry.timer);
    respond(entry.response, { decision, reason });
    return true;
  };
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/hook' || request.headers.authorization !== `Bearer ${token}`) return respond(response, {}, 401);
    let body = '';
    try {
      for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) return respond(response, {}, 413); }
      const payload = JSON.parse(body);
      await onEvent(payload);
      if (payload.hookEventName !== 'PreToolUse') return respond(response, {});
      const id = `${payload.conversationId}:${payload.toolCall?.id || `step-${payload.stepIdx}`}`;
      if (pending.has(id)) return respond(response, { decision: 'deny', reason: 'Duplicate native permission request' });
      const entry = { response, timer: null };
      pending.set(id, entry);
      entry.timer = setTimeout(() => {
        if (finish(id, 'deny', 'OriginRouter approval expired')) onCancel(id, 'approval_timeout');
      }, Math.min(3600000, Math.max(1000, timeoutMs || 300000)));
      response.once('close', () => {
        if (pending.get(id) === entry) {
          pending.delete(id); clearTimeout(entry.timer); onCancel(id, 'native_request_aborted');
        }
      });
      await onPermission(payload, id);
    } catch {
      respond(response, { decision: 'deny', reason: 'OriginRouter could not process this Hook' });
    }
  });
  server.requestTimeout = 0;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    env: { ORIGINROUTER_AGY_HOOK_URL: `http://127.0.0.1:${server.address().port}/hook`, ORIGINROUTER_AGY_HOOK_TOKEN: token },
    pending,
    resolve(id, action) { return finish(id, action === 'allow' ? 'auto_approve' : 'deny', 'OriginRouter permission decision'); },
    cancelAll(reason = 'session_interrupted') { for (const id of [...pending.keys()]) { finish(id, 'deny', reason); onCancel(id, reason); } },
    close() { if (closed) return; closed = true; this.cancelAll('session_stopped'); server.close(); server.closeAllConnections(); },
  };
}
