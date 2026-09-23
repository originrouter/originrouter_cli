import { sendError, sendOk } from "./localApiHttp.js";

// ---------- Write handler (single dispatch over the 3 session actions) ----------

export async function handleSessionControl(ctx, res, sessionId, action, body) {
  if (!ctx.sessionManager) {
    return sendError(res, 503, "session manager not available");
  }
  if (!ctx.sessionManager.sessions.has(sessionId)) {
    return sendError(res, 404, `unknown session '${sessionId}'`);
  }

  let payload;
  if (action === "input") {
    if (typeof body.data !== "string") {
      return sendError(res, 400, "body.data must be a string");
    }
    payload = { type: "terminal.input", sessionId, data: body.data };
  } else if (action === "interrupt") {
    payload = { type: "terminal.interrupt", sessionId };
  } else if (action === "permission") {
    if (!body.callId || typeof body.callId !== "string") {
      return sendError(res, 400, "body.callId is required");
    }
    if (!body.decision || typeof body.decision !== "string") {
      return sendError(res, 400, "body.decision is required");
    }
    payload = {
      type: "agent.permission.resolve",
      sessionId,
      callId: body.callId,
      decision: body.decision,
      data: body.data,
    };
  } else if (action === "interaction") {
    // Stage 8.9: agent.interaction.resolve route. Accepts
    // interactionId + decision (required) and forwards the new
    // envelope into the local session. The legacy /permission
    // route above stays unchanged.
    if (!body.interactionId || typeof body.interactionId !== "string") {
      return sendError(res, 400, "body.interactionId is required");
    }
    if (!body.decision || typeof body.decision !== "string") {
      return sendError(res, 400, "body.decision is required");
    }
    payload = {
      type: "agent.interaction.resolve",
      sessionId,
      interactionId: body.interactionId,
      // Belt-and-suspenders: callers may pass callId too, but
      // interactionId is the canonical field for the new envelope.
      callId: body.callId || body.interactionId,
      decision: body.decision,
      value: body.value,
      data: body.data,
      reason: body.reason,
    };
  } else {
    return sendError(res, 400, `unknown action '${action}'`);
  }

  try {
    ctx.sessionManager.handleEvent(payload);
  } catch (err) {
    return sendError(res, 500, err.message || "handleEvent threw");
  }
  return sendOk(res, { sessionId, action });
}
