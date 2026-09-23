import { timingSafeEqual } from "node:crypto";
import { readApiToken } from "../persistence/authToken.js";
import { getStateDir } from "../persistence/state.js";

// Bearer-token regex: case-insensitive 64 hex chars.
const BEARER_RE = /^Bearer\s+([a-f0-9]{64})$/i;

// DANGER: dev-only escape hatch. When set, ALL write requests pass without a
// token. Used by tests that boot the local API in isolation (without a
// daemon). Production code paths must NOT set this.
const DEV_INSECURE = process.env.ORIGINROUTER_DEV_INSECURE === "1";

export function httpHost(address) {
  return String(address).includes(":") && !String(address).startsWith("[")
    ? `[${address}]`
    : address;
}

export function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(new Error(`invalid JSON: ${err.message}`)); }
    });
    req.on("error", reject);
  });
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendOk(res, data) { sendJson(res, 200, { ok: true, ...data }); }

export function sendError(res, status, error, { reason, wwwAuth } = {}) {
  const body = { ok: false, error };
  if (reason) body.reason = reason;
  const headers = {};
  if (wwwAuth) headers["WWW-Authenticate"] = 'Bearer realm="originrouter-local"';
  sendJson(res, status, body, headers);
}

// Constant-time compare on equal-length buffers. `timingSafeEqual` throws if
// the lengths differ, so we length-check first.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ab, bb);
}

// Returns { ok: true } on success, or { ok: false, status, error, reason }.
// Only health/static discovery and the proof-based E2EE bootstrap are public.
export function requireAuth(req, ctx) {
  if (DEV_INSECURE) return { ok: true };
  const url = req.url || "/";
  const path = url.split("?")[0];
  if ([
    "/local/e2ee/session",
    "/local/e2ee/messages",
    "/local/pair/redeem",
  ].includes(path)) {
    return { ok: true };
  }
  const publicRead = (req.method === "GET" || req.method === "HEAD")
    && [
      "/local/auth/challenge",
      "/local/e2ee/challenge",
      "/catalog/litellm-providers",
    ].includes(path);
  const needsAuth = req.method !== "OPTIONS" && !publicRead;
  if (!needsAuth) return { ok: true };
  const header = req.headers.authorization;
  if (!header) {
    return { ok: false, status: 401, error: "unauthorized", reason: "missing" };
  }
  const m = BEARER_RE.exec(header);
  if (!m) {
    return { ok: false, status: 401, error: "unauthorized", reason: "malformed" };
  }
  const stored = readApiToken(ctx.apiTokenPath ? dirnameOf(ctx.apiTokenPath) : getStateDir());
  if (!stored) {
    return { ok: false, status: 503, error: "auth-not-initialized", reason: "auth-not-initialized" };
  }
  if (!safeEqual(m[1], stored)) {
    return { ok: false, status: 401, error: "unauthorized", reason: "invalid" };
  }
  return { ok: true };
}

function dirnameOf(p) {
  // Lightweight dirname to avoid pulling another helper.
  const i = String(p).lastIndexOf("/");
  return i < 0 ? "." : String(p).slice(0, i);
}
