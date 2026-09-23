import { sendError, sendOk } from "./localApiHttp.js";

// ---------- Proxy write handlers (start | stop | restart) ----------

export async function handleProxyControl(ctx, res, action, body) {
  if (action === "stop") {
    if (typeof ctx.stopProxy !== "function") {
      return sendError(res, 503, "proxy manager not wired into daemon");
    }
    const result = await ctx.stopProxy();
    if (!result.ok) return sendError(res, 500, result.error || "stop failed");
    return sendOk(res, result);
  }
  // Stage 7.5: start/restart default to routes mode. Passing a provider is
  // still accepted as a debug/provider-mode escape hatch.
  const provider = typeof body.provider === "string" && body.provider ? body.provider : null;
  let port = Number.parseInt(body.port, 10);
  if (action === "restart" && !Number.isFinite(port)) {
    try {
      const status = await ctx.getProxyStatus();
      const currentPort = Number.parseInt(status?.port, 10);
      if (status?.state === "running" && Number.isFinite(currentPort)) {
        port = currentPort;
      }
    } catch {}
  }
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    return sendError(res, 400, `body.port must be an integer in [1024, 65535]`);
  }
  const fn = action === "start" ? ctx.startProxy : ctx.restartProxy;
  if (typeof fn !== "function") {
    return sendError(res, 503, `proxy ${action} not wired into daemon`);
  }
  const result = await fn(provider
    ? { mode: "provider", provider, port }
    : { mode: "route", port });
  if (!result.ok) return sendError(res, 409, result.error || `${action} failed`);
  return sendOk(res, result);
}
