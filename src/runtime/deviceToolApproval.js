import { buildInteractionRequest, INTERACTION_KINDS, INTERACTION_SOURCES } from './agentInteractionContract.js';
import { displaySafeToolInput, toolInputContainsSecret } from './displaySafeToolInput.js';

// This is invoked without awaiting it in the command polling loop: the user's
// eventual answer itself arrives on that same loop.
export function createDeviceToolApprovalHandler({sessionId, provider, runtime, requestInteraction, markApplied, sendResult, revision, now = () => Date.now()}) {
  const active = new Map();
  return {
    start(payload) {
      const requestId = String(payload?.requestId || '');
      if (!/^dta_[0-9a-f-]{36}$/i.test(requestId) || active.has(requestId)) return false;
      const expiresAt = Number(payload.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= now()) return false;
      const controller = new AbortController();
      const capturedRevision = revision();
      active.set(requestId, controller);
      void (async () => {
        let accepted = false;
        try {
          const request = buildInteractionRequest({
            provider, runtime, sessionId, interactionId:requestId,
            source:INTERACTION_SOURCES.APP_SERVER, kind:INTERACTION_KINDS.PERMISSION,
            title:String(payload.title || 'Device tool request').slice(0, 500),
            prompt:String(payload.prompt || 'Review this action before continuing.').slice(0, 2000),
            payload:{tool:String(payload.tool || 'originrouter.device_tool'), tool_input:displaySafeToolInput(payload.input || {}),
              command:typeof payload.input?.command === 'string' ? payload.input.command : '',
              cwd:typeof payload.input?.cwd === 'string' ? payload.input.cwd : ''},
            containsSecret:toolInputContainsSecret(payload.input || {}), expiresAt,
          });
          const resolved = await requestInteraction(request, controller.signal);
          if (!resolved?.autoResolved && resolved?.interactionId) await markApplied(resolved);
          accepted = (resolved?.action === 'allow' || resolved?.action === 'submit')
            && !controller.signal.aborted && now() < expiresAt * 1000 && revision() === capturedRevision;
        } catch { accepted = false; }
        finally {
          active.delete(requestId);
          await sendResult({type:'agent.device_tool.approval_result',requestId,accepted}).catch(() => {});
        }
      })();
      return true;
    },
    cancel(requestId) { const controller = active.get(String(requestId || '')); if (!controller) return false; controller.abort(); return true; },
    close() { for (const controller of active.values()) controller.abort(); active.clear(); },
  };
}
