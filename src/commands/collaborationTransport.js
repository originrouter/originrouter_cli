import { readApiToken } from "../persistence/authToken.js";
import { ensureStateDir, readDaemonState } from "../persistence/state.js";
import {
  CollaborationCliError,
  collaborationErrorDetails,
} from "./collaborationErrors.js";

export function localApi() {
  const stateDir = ensureStateDir();
  const state = readDaemonState();
  const token = readApiToken(stateDir);
  if (!state?.localApiPort || !token) {
    throw new CollaborationCliError("OriginRouter daemon is not running.", {
      exitCode: 3,
      diagnosticCode: "LOCAL_DAEMON_UNAVAILABLE",
      impact: "No collaboration can be created or controlled until the local service is available.",
      action: "Run `originrouter service start` or `originrouter daemon`, then try again.",
    });
  }
  const bind = state.localApiBindAddress || "127.0.0.1";
  const host = bind === "0.0.0.0" || bind === "::" ? "127.0.0.1" : bind;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return { baseUrl: `http://${urlHost}:${state.localApiPort}`, token };
}

export function interruptedError(message = "Operation interrupted.") {
  const error = new Error(message);
  error.code = "ORIGINROUTER_INTERRUPTED";
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw interruptedError();
}

export async function request(path, { method = "GET", body, signal } = {}) {
  let api;
  let response;
  try {
    throwIfAborted(signal);
    api = localApi();
    response = await fetch(`${api.baseUrl}${path}`, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${api.token}`,
        ...(body == null ? {} : { "Content-Type": "application/json" }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted) throw interruptedError();
    if (error instanceof CollaborationCliError) throw error;
    throw new CollaborationCliError("Could not connect to the local OriginRouter service.", {
      exitCode: 3,
      diagnosticCode: "LOCAL_API_CONNECTION_FAILED",
      impact: "The requested operation was not sent. Existing Daemon-owned Runs may still be active.",
      action: "Run `originrouter service status`, then restart the service if necessary.",
      cause: error,
    });
  }
  let payload;
  try {
    const raw = await response.text();
    if (!raw.trim()) {
      if (response.ok) throw new Error("Local API returned an empty response body.");
      payload = {};
    } else {
      payload = JSON.parse(raw);
    }
  } catch (error) {
    if (!response.ok) payload = {};
    else {
      throw new CollaborationCliError("The local OriginRouter service returned an incomplete JSON response.", {
        exitCode: 10,
        diagnosticCode: "LOCAL_API_INVALID_RESPONSE",
        impact: "The response could not be consumed, but the Daemon-owned Run may still be active.",
        action: "OriginRouter will reconnect automatically. Check `originrouter service status` if retries continue.",
        cause: error,
      });
    }
  }
  if (!response.ok || payload.ok === false) {
    const message = typeof payload.error === "string"
      ? payload.error
      : payload.error?.message || payload.message || `Local collaboration request failed (${response.status})`;
    const diagnosticCode = String(payload.reason || payload.error?.code || "COLLABORATION_REQUEST_FAILED").toUpperCase();
    throw new CollaborationCliError(message, {
      diagnosticCode,
      ...collaborationErrorDetails(response.status, diagnosticCode),
    });
  }
  return payload.data || payload;
}
