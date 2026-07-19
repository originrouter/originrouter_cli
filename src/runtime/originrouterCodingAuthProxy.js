import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";
import { OAUTH_RESOURCES, accessTokenFor } from "./authContract.js";
import { DEFAULT_ORIGINROUTER_BASE_URL } from "../config/providerRoutes.js";

const TOKEN_HEADROOM_MS = 120_000;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const ALLOWED_PATH_PREFIXES = Object.freeze([
  "/coding/v1/messages",
  "/coding/v1/chat/completions",
  "/coding/v1/responses",
]);

function trimBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function localCredential(req) {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1] || null;
}

function allowedPath(rawUrl) {
  try {
    const parsed = new URL(rawUrl || "/", "http://127.0.0.1");
    return parsed.origin === "http://127.0.0.1"
      && ALLOWED_PATH_PREFIXES.some((prefix) => (
        parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`)
      ));
  } catch {
    return false;
  }
}

function forwardedHeaders(headers, token) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      lower === "host"
      || lower === "connection"
      || lower === "content-length"
      || lower === "transfer-encoding"
      || lower === "authorization"
      || lower === "proxy-authorization"
      || lower === "x-api-key"
      || lower === "accept-encoding"
    ) continue;
    if (value != null) out[name] = value;
  }
  out.Authorization = `Bearer ${token}`;
  out["Accept-Encoding"] = "identity";
  return out;
}

function responseHeaders(headers) {
  const out = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding") continue;
    out[name] = value;
  }
  return out;
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request_too_large");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, body) {
  if (res.headersSent) return res.end();
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export class OriginRouterCodingAuthProxy {
  constructor({
    stateDir,
    upstreamBaseUrl = DEFAULT_ORIGINROUTER_BASE_URL,
    fetchFn = globalThis.fetch,
    ensureFreshAccessTokenFn = ensureFreshAccessToken,
    maxRequestBytes = MAX_REQUEST_BYTES,
  }) {
    this.stateDir = stateDir;
    this.upstreamBaseUrl = trimBaseUrl(upstreamBaseUrl);
    this.fetchFn = fetchFn;
    this.ensureFreshAccessTokenFn = ensureFreshAccessTokenFn;
    this.maxRequestBytes = maxRequestBytes;
    this.localToken = `or_local_${randomBytes(32).toString("base64url")}`;
    this._server = null;
    this._port = null;
    this._sockets = new Set();
  }

  async start() {
    if (this._server) return this.status();
    await this._codingToken();
    const server = http.createServer((req, res) => {
      void this._handle(req, res);
    });
    server.on("connection", (socket) => {
      this._sockets.add(socket);
      socket.on("close", () => this._sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        this._port = server.address().port;
        resolve();
      });
    });
    server.unref();
    this._server = server;
    return this.status();
  }

  status() {
    return Object.freeze({
      state: this._server ? "running" : "stopped",
      host: this._server ? "127.0.0.1" : null,
      port: this._port,
      localToken: this._server ? this.localToken : null,
      upstreamBaseUrl: this.upstreamBaseUrl,
      runtime: "originrouter-coding-auth",
    });
  }

  async stop() {
    if (!this._server) return;
    for (const socket of this._sockets) {
      try { socket.destroy(); } catch {}
    }
    this._sockets.clear();
    const server = this._server;
    this._server = null;
    this._port = null;
    await new Promise((resolve) => server.close(resolve));
  }

  async _codingToken(options = {}) {
    const credential = await this.ensureFreshAccessTokenFn({
      stateDir: this.stateDir,
      resource: OAUTH_RESOURCES.CODING,
      headroomMs: TOKEN_HEADROOM_MS,
      ...options,
    });
    const record = accessTokenFor(credential, OAUTH_RESOURCES.CODING);
    if (!record?.token) {
      const error = new Error("OriginRouter login is required");
      error.code = "OAUTH_LOGIN_REQUIRED";
      throw error;
    }
    return record.token;
  }

  async _fetchUpstream(req, body, token, signal) {
    const url = new URL(req.url, `${this.upstreamBaseUrl}/`);
    return this.fetchFn(url, {
      method: req.method,
      headers: forwardedHeaders(req.headers, token),
      body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      redirect: "manual",
      signal,
    });
  }

  async _handle(req, res) {
    if (!safeEqual(localCredential(req), this.localToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!allowedPath(req.url)) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", () => {
      if (!res.writableEnded) abort();
    });

    try {
      const body = await readBody(req, this.maxRequestBytes);
      let token = await this._codingToken();
      let upstream = await this._fetchUpstream(req, body, token, controller.signal);
      if (upstream.status === 401) {
        try { await upstream.body?.cancel(); } catch {}
        const refreshed = await this._codingToken({
          forceRefresh: true,
          staleToken: token,
        });
        token = refreshed;
        upstream = await this._fetchUpstream(req, body, token, controller.signal);
      }
      res.writeHead(upstream.status, responseHeaders(upstream.headers));
      if (!upstream.body) {
        res.end();
        return;
      }
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error?.code === "REQUEST_TOO_LARGE") {
        sendJson(res, 413, { error: "request_too_large" });
        return;
      }
      const loginRequired = error?.code === "OAUTH_REFRESH_EXPIRED"
        || error?.code === "OAUTH_LOGIN_REQUIRED"
        || error?.code === "invalid_grant";
      sendJson(res, loginRequired ? 401 : 502, {
        error: loginRequired ? "originrouter_login_required" : "coding_gateway_unavailable",
      });
    }
  }
}

export async function protectOriginrouterCodingEnv(agent, providerResult, {
  stateDir,
  proxyFactory = (options) => new OriginRouterCodingAuthProxy(options),
} = {}) {
  if (providerResult?.source !== "originrouter-coding") {
    return { providerResult, proxy: null };
  }
  const proxy = proxyFactory({ stateDir, upstreamBaseUrl: DEFAULT_ORIGINROUTER_BASE_URL });
  const status = await proxy.start();
  const localBase = `http://${status.host}:${status.port}`;
  const env = { ...providerResult.env };
  if (agent === "claude") {
    // Explicitly shadow a stale shell/launchd API key. Omitting this field
    // would let `{ ...process.env, ...env }` pass an unrelated sk-ant key to
    // Claude Code and trigger its custom-key prompt.
    env.ANTHROPIC_API_KEY = "";
    env.ANTHROPIC_BASE_URL = `${localBase}/coding`;
    env.ANTHROPIC_AUTH_TOKEN = status.localToken;
  } else {
    env.OPENAI_BASE_URL = `${localBase}/coding/v1`;
    env.OPENAI_API_KEY = status.localToken;
  }
  return {
    providerResult: { ...providerResult, env },
    proxy,
  };
}
