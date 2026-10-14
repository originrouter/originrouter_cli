import { timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
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

// Addresses that mean "every interface", used as bind targets.
export const WILDCARD_ADDRESSES = new Set(["0.0.0.0", "::", "::0"]);

// Addresses that mean "this machine only", used as bind targets.
export const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

// The address a client *on this machine* dials to reach a server bound to
// `bindAddress`.
//
// A wildcard accepts on every interface including loopback, and loopback is
// the only one of them that unambiguously means "this machine" — so it is what
// the daemon dials to talk to itself. A concrete bind is returned unchanged:
// an operator who pinned one interface meant it, and that interface answers on
// its own address too.
//
// This existed as a hand-rolled `bind === "0.0.0.0" ? "127.0.0.1" : bind` in
// six modules, two of which forgot the IPv6 wildcard. It is one rule and it
// lives here now.
export function loopbackDialHost(bindAddress) {
  const bind = String(bindAddress || "").trim();
  if (!bind) return "127.0.0.1";
  return WILDCARD_ADDRESSES.has(bind) ? "127.0.0.1" : bind;
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
  const stored = readApiToken(ctx.apiTokenPath ? dirname(ctx.apiTokenPath) : getStateDir());
  if (!stored) {
    return { ok: false, status: 503, error: "auth-not-initialized", reason: "auth-not-initialized" };
  }
  if (!safeEqual(m[1], stored)) {
    return { ok: false, status: 401, error: "unauthorized", reason: "invalid" };
  }
  return { ok: true };
}
