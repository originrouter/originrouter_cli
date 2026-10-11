import { createServer } from "node:http";
import { permissionCallId, permissionRequestIdentity } from "./hookIdentity.js";

// Claude Code passes the JSON hook input to the hook command's stdin.
// For `PermissionRequest`, the input looks like:
//   { hook_event_name: "PermissionRequest", session_id, tool_name,
//     tool_input, permission_suggestions, ... }
//
// For `SessionStart`, the input looks like:
//   { hook_event_name: "SessionStart", session_id, transcript_path, cwd, ... }
//
// The hook server holds a `pendingPermissions` map keyed by `callId`. When
// a PermissionRequest arrives, we generate a callId, hand the structured
// event to the adapter, and suspend the HTTP response until the remote
// client sends a decision.
//
// How long that hold lasts is `permissionTimeoutMs`, passed in by the adapter
// from `agent.interactionTimeoutMs`. It only has to outlive the decision
// window — its job is to answer Claude Code when no answer is coming, not to
// be the deadline anyone decided on. `0` means no deadline of ours at all;
// Claude Code's own hook timeout is then what finally ends the wait, which is
// the correct owner for that decision. See config/agentInteractionTimeout.js.

// Kept as named constants because they are the fallback when a caller passes
// nothing, and because the hook forwarder and the hook settings file are sized
// against them. `CLAUDE_PERMISSION_TIMEOUT_MS` is deliberately longer than
// `CLAUDE_INTERACTION_DECISION_TIMEOUT_MS`: the inner window decides, and this
// is only the backstop.
export const CLAUDE_INTERACTION_DECISION_TIMEOUT_MS = 300_000;
export const CLAUDE_PERMISSION_TIMEOUT_MS = 315_000;

export function decisionToElicitationHookJson(action, { content } = {}) {
  const normalized = action === "accept" || action === "decline" || action === "cancel"
    ? action
    : "decline";
  return {
    hookSpecificOutput: {
      hookEventName: "Elicitation",
      action: normalized,
      ...(normalized === "accept" && content && typeof content === "object"
        ? { content }
        : {}),
    },
  };
}

export function decisionToHookJson(decision, { permissionSuggestions, updatedInput } = {}) {
  const output = (value) => ({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: value,
    },
  });

  // Stage 8.0A: when the remote resolves `approved_for_session` AND the
  // original Claude Code hook request carried `permission_suggestions`,
  // echo them as `updatedPermissions` so Claude Code persists a
  // session-scoped rule instead of treating this as a one-shot allow.
  // The v1 plain `{behavior:"allow"}` is preserved as the fallback when
  // no suggestions are present (callers passing `{permissionSuggestions:
  // []}` or no second arg at all).
  if (decision === "approved" || decision === "approved_for_session") {
    if (
      decision === "approved_for_session"
      && Array.isArray(permissionSuggestions)
      && permissionSuggestions.length > 0
    ) {
      return output({
        behavior: "allow",
        updatedPermissions: permissionSuggestions,
        ...(updatedInput && typeof updatedInput === "object" ? { updatedInput } : {}),
      });
    }
    return output({
      behavior: "allow",
      ...(updatedInput && typeof updatedInput === "object" ? { updatedInput } : {}),
    });
  }
  if (decision === "denied") {
    return output({
      behavior: "deny",
      message: "Denied by OriginRouter remote approval.",
    });
  }
  if (decision === "abort") {
    return output({
      behavior: "deny",
      interrupt: true,
      message: "Aborted by OriginRouter remote approval.",
    });
  }
  if (decision === "timeout") {
    return output({
      behavior: "deny",
      message: "OriginRouter remote approval timed out. Please retry or approve locally.",
    });
  }
  return output({
    behavior: "deny",
    message: "Unknown decision; defaulting to deny.",
  });
}

function buildPermissionRequestEvent(callId, payload) {
  return {
    type: "agent.permission.request.detected",
    provider: "claude",
    callId,
    tool: payload.tool_name || payload.toolName || "unknown",
    input: payload.tool_input || payload.toolInput || {},
    // Echoed back as updatedPermissions for approved_for_session decisions.
    permissionSuggestions: payload.permission_suggestions || payload.permissionSuggestions || [],
    permissionMode: payload.permission_mode || payload.permissionMode || null,
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: ["approved", "approved_for_session", "denied", "abort"],
    },
  };
}

function buildElicitationRequestEvent(interactionId, payload) {
  return {
    interactionId,
    mode: payload.mode === "url" ? "url" : "form",
    serverName: payload.mcp_server_name || payload.serverName || "",
    message: payload.message || "",
    url: payload.url || "",
    requestedSchema: payload.requested_schema || payload.requestedSchema || {},
    elicitationId: payload.elicitation_id || payload.elicitationId || null,
  };
}

export function startClaudeHookServer({
  onSessionStart,
  onPermissionRequest,
  onPermissionTimeout,
  onElicitationRequest,
  onElicitationTimeout,
  onHookEvent,
  permissionTimeoutMs = CLAUDE_PERMISSION_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const pendingPermissions = new Map();
    // Second index over the same entries. Claude Code can deliver one
    // `PermissionRequest` more than once for the same ask; without this the
    // repeats would mint separate ids and become separate permissions.
    const pendingPermissionsByIdentity = new Map();
    const pendingElicitations = new Map();

    // `0` — and any non-positive value — means "hold until someone answers".
    // armHold() then returns null and every `clearTimeout(entry.timer)` below
    // is a no-op on null, so the rest of the file needs no null checks.
    // Normalized once here rather than at each of the two call sites.
    const holdMs = Number(permissionTimeoutMs) > 0 ? Number(permissionTimeoutMs) : 0;
    const armHold = (onFire) => (holdMs > 0 ? setTimeout(onFire, holdMs) : null);

    // Drops an entry from both indexes. The identity index is shared across
    // every call id, so only the entry that is actually mapped there may
    // remove it — a later hold for the same ask owns the slot by then.
    const releasePermission = (entry) => {
      if (pendingPermissions.get(entry.callId) === entry) {
        pendingPermissions.delete(entry.callId);
      }
      if (entry.identity && pendingPermissionsByIdentity.get(entry.identity) === entry) {
        pendingPermissionsByIdentity.delete(entry.identity);
      }
    };

    const resolvePermission = ({ callId, decision, reason, updatedInput }) => {
      const pending = pendingPermissions.get(callId);
      if (!pending) return false;
      releasePermission(pending);
      clearTimeout(pending.timer);
      // Stage 8.0A: thread the original request's permission_suggestions
      // through to decisionToHookJson so `approved_for_session` can echo
      // them as `updatedPermissions`. Fall back to empty array when the
      // entry doesn't carry suggestions (defensive; shouldn't happen for
      // entries created via the /hook/permission-request path).
      const json = decisionToHookJson(decision || "denied", {
        permissionSuggestions: pending.permissionSuggestions || [],
        updatedInput,
      });
      pending.responseBody = JSON.stringify(json);
      pending.respond();
      return true;
    };

    const resolveElicitation = ({ interactionId, action, content }) => {
      const pending = pendingElicitations.get(interactionId);
      if (!pending) return false;
      pendingElicitations.delete(interactionId);
      clearTimeout(pending.timer);
      pending.responseBody = JSON.stringify(decisionToElicitationHookJson(action, { content }));
      pending.respond();
      return true;
    };

    const server = createServer((request, response) => {
      if (request.method !== "POST") {
        response.writeHead(404).end("not found");
        return;
      }

      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = {};
        try {
          payload = JSON.parse(raw);
        } catch {}

        if (request.url === "/hook/session-start") {
          const sessionId = payload.session_id || payload.sessionId;
          if (sessionId && typeof onSessionStart === "function") {
            onSessionStart(sessionId, payload);
          }
          response.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
          return;
        }

        if (request.url === "/hook/permission-request") {
          // Hold the response open. The forwarder reads it once we end(),
          // copies the body to its own stdout, and exits so Claude Code
          // picks up the structured decision.
          //
          // One ask must produce one permission. Claude Code is free to
          // deliver the same `PermissionRequest` more than once — and on
          // 2.1.283 it does — and every delivery that minted its own id
          // became a separate hold, a separate interaction, and a separate
          // card. Keying on the ask's identity instead means a repeat joins
          // the hold that is already open and receives the same answer.
          // A client that hangs up will never read a decision. When the last
          // one leaves, the hold is dead weight: releasing it here is what
          // stops a card outliving the request that created it.
          //
          // The signal is the RESPONSE's `close`, not the request's. A
          // request's `close` fires the moment its body has been consumed —
          // while the client is still sitting there waiting for exactly this
          // answer — so treating it as a hangup would release every live
          // permission the instant it was created. The response's `close` only
          // fires when the answer has been written (`writableEnded`) or the
          // connection died before we could write it, and that second case is
          // the one that needs releasing.
          const watchDisconnect = (held, heldResponse) => {
            heldResponse.on("close", () => {
              if (held.settled || heldResponse.writableEnded) return;
              held.responses = held.responses.filter(
                (item) => item.response !== heldResponse,
              );
              if (held.responses.length > 0) return;
              clearTimeout(held.timer);
              held.settled = true;
              releasePermission(held);
              if (typeof onPermissionTimeout === "function") {
                try {
                  onPermissionTimeout(held.callId, held.event, { reason: "client_disconnected" });
                } catch {}
              }
            });
          };

          const identity = permissionRequestIdentity(payload);
          const open = identity ? pendingPermissionsByIdentity.get(identity) : null;
          if (open && !open.settled) {
            open.responses.push({ response });
            watchDisconnect(open, response);
            return;
          }

          const callId = permissionCallId(payload);
          const event = buildPermissionRequestEvent(callId, payload);

          let timer = null;
          // Stage 8.0A: carry permissionSuggestions on the entry so
          // resolvePermission can pass them to decisionToHookJson.
          const entry = {
            callId,
            identity,
            settled: false,
            responses: [{ response }],
            permissionSuggestions: event.permissionSuggestions || [],
            respond() {
              if (entry.settled) return;
              entry.settled = true;
              const body = entry.responseBody
                || JSON.stringify(decisionToHookJson("denied", { permissionSuggestions: entry.permissionSuggestions }));
              for (const target of entry.responses) {
                try {
                  target.response.writeHead(200, { "Content-Type": "application/json" });
                  target.response.end(body);
                } catch {}
              }
            },
            responseBody: null,
            timer: null,
            event,
          };
          watchDisconnect(entry, response);

          timer = armHold(() => {
            if (pendingPermissions.get(callId) === entry) {
              releasePermission(entry);
              entry.responseBody = JSON.stringify(decisionToHookJson("timeout", { permissionSuggestions: entry.permissionSuggestions }));
              entry.respond();
              if (typeof onPermissionTimeout === "function") {
                try { onPermissionTimeout(callId, event); } catch {}
              }
            }
          });

          entry.timer = timer;
          pendingPermissions.set(callId, entry);
          if (identity) pendingPermissionsByIdentity.set(identity, entry);

          if (typeof onPermissionRequest === "function") {
            try {
              onPermissionRequest(callId, event, { identity });
            } catch (error) {
              // If the adapter throws synchronously, don't leave the request
              // hanging. Resolve as deny so Claude Code gets a clean answer.
              if (pendingPermissions.get(callId) === entry) {
                releasePermission(entry);
                clearTimeout(timer);
                entry.responseBody = JSON.stringify(decisionToHookJson("denied", { permissionSuggestions: entry.permissionSuggestions }));
                entry.respond();
              }
            }
          } else {
            // No consumer wired. Same fallback: deny rather than hang.
            if (pendingPermissions.get(callId) === entry) {
              releasePermission(entry);
              clearTimeout(timer);
              entry.responseBody = JSON.stringify(decisionToHookJson("denied", { permissionSuggestions: entry.permissionSuggestions }));
              entry.respond();
            }
          }
          return;
        }

        if (request.url === "/hook/elicitation") {
          const interactionId = payload.elicitation_id
            || payload.elicitationId
            || `claude-elicit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const event = buildElicitationRequestEvent(interactionId, payload);
          let settled = false;
          const entry = {
            responseBody: null,
            timer: null,
            respond() {
              if (settled) return;
              settled = true;
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(entry.responseBody || JSON.stringify(decisionToElicitationHookJson("decline")));
            },
          };
          entry.timer = armHold(() => {
            if (!pendingElicitations.has(interactionId)) return;
            pendingElicitations.delete(interactionId);
            entry.responseBody = JSON.stringify(decisionToElicitationHookJson("decline"));
            entry.respond();
            if (typeof onElicitationTimeout === "function") {
              try { onElicitationTimeout(interactionId, event); } catch {}
            }
          });
          pendingElicitations.set(interactionId, entry);
          if (typeof onElicitationRequest === "function") {
            try {
              onElicitationRequest(interactionId, event);
            } catch {
              pendingElicitations.delete(interactionId);
              clearTimeout(entry.timer);
              entry.respond();
            }
          } else {
            pendingElicitations.delete(interactionId);
            clearTimeout(entry.timer);
            entry.respond();
          }
          return;
        }

        if (request.url === "/hook/event") {
          if (typeof onHookEvent === "function") {
            try { onHookEvent(payload); } catch {}
          }
          response.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
          return;
        }

        response.writeHead(404).end("not found");
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to start Claude hook server."));
        return;
      }

      resolve({
        port: address.port,
        resolvePermission,
        resolveElicitation,
        stop: () => {
          for (const [, pending] of pendingPermissions) {
            clearTimeout(pending.timer);
            pending.responseBody = JSON.stringify(decisionToHookJson("denied"));
            pending.respond();
          }
          for (const [, pending] of pendingElicitations) {
            clearTimeout(pending.timer);
            pending.responseBody = JSON.stringify(decisionToElicitationHookJson("cancel"));
            pending.respond();
          }
          pendingPermissions.clear();
          pendingPermissionsByIdentity.clear();
          pendingElicitations.clear();
          server.close();
        },
      });
    });

    server.on("error", reject);
  });
}
