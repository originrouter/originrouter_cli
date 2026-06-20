import { createServer } from "node:http";

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
// client sends a decision. A 55-second hard timeout (just inside Claude
// Code's 60-second matcher default) resolves the pending request with an
// explicit deny + message; Claude Code's local dialog then reappears.

const PERMISSION_TIMEOUT_MS = 55_000;

export function decisionToHookJson(decision, { permissionSuggestions } = {}) {
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
      return output({ behavior: "allow", updatedPermissions: permissionSuggestions });
    }
    return output({ behavior: "allow" });
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
    // Carried on the wire for future use; not acted on by the v1 hook server.
    permissionSuggestions: payload.permission_suggestions || payload.permissionSuggestions || [],
    resolution: {
      eventType: "agent.permission.resolve",
      decisions: ["approved", "approved_for_session", "denied", "abort"],
    },
  };
}

export function startClaudeHookServer({ onSessionStart, onPermissionRequest, onPermissionTimeout } = {}) {
  return new Promise((resolve, reject) => {
    const pendingPermissions = new Map();

    const resolvePermission = ({ callId, decision, reason }) => {
      const pending = pendingPermissions.get(callId);
      if (!pending) return false;
      pendingPermissions.delete(callId);
      clearTimeout(pending.timer);
      // Stage 8.0A: thread the original request's permission_suggestions
      // through to decisionToHookJson so `approved_for_session` can echo
      // them as `updatedPermissions`. Fall back to empty array when the
      // entry doesn't carry suggestions (defensive; shouldn't happen for
      // entries created via the /hook/permission-request path).
      const json = decisionToHookJson(decision || "denied", {
        permissionSuggestions: pending.permissionSuggestions || [],
      });
      pending.responseBody = JSON.stringify(json);
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
          const callId = `claude-perm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const event = buildPermissionRequestEvent(callId, payload);

          let timer;
          let settled = false;
          // Stage 8.0A: carry permissionSuggestions on the entry so
          // resolvePermission can pass them to decisionToHookJson.
          const entry = {
            permissionSuggestions: event.permissionSuggestions || [],
            respond() {
              if (settled) return;
              settled = true;
              response.writeHead(200, { "Content-Type": "application/json" });
              response.end(entry.responseBody || JSON.stringify(decisionToHookJson("denied", { permissionSuggestions: entry.permissionSuggestions })));
            },
            responseBody: null,
            timer: null,
          };

          timer = setTimeout(() => {
            if (pendingPermissions.has(callId)) {
              pendingPermissions.delete(callId);
              entry.responseBody = JSON.stringify(decisionToHookJson("timeout", { permissionSuggestions: entry.permissionSuggestions }));
              entry.respond();
              if (typeof onPermissionTimeout === "function") {
                try { onPermissionTimeout(callId, event); } catch {}
              }
            }
          }, PERMISSION_TIMEOUT_MS);

          entry.timer = timer;
          pendingPermissions.set(callId, entry);

          if (typeof onPermissionRequest === "function") {
            try {
              onPermissionRequest(callId, event);
            } catch (error) {
              // If the adapter throws synchronously, don't leave the request
              // hanging. Resolve as deny so Claude Code gets a clean answer.
              if (pendingPermissions.has(callId)) {
                pendingPermissions.delete(callId);
                clearTimeout(timer);
                entry.responseBody = JSON.stringify(decisionToHookJson("denied", { permissionSuggestions: entry.permissionSuggestions }));
                entry.respond();
              }
            }
          } else {
            // No consumer wired. Same fallback: deny rather than hang.
            if (pendingPermissions.has(callId)) {
              pendingPermissions.delete(callId);
              clearTimeout(timer);
              entry.responseBody = JSON.stringify(decisionToHookJson("denied", { permissionSuggestions: entry.permissionSuggestions }));
              entry.respond();
            }
          }
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
        stop: () => {
          for (const [, pending] of pendingPermissions) {
            clearTimeout(pending.timer);
          }
          pendingPermissions.clear();
          server.close();
        },
      });
    });

    server.on("error", reject);
  });
}
