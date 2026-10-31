import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";
import { OAUTH_RESOURCES, accessTokenFor } from "./authContract.js";
import { rewriteModelInBody, createAgentModelResolver, fallbackModelsFor } from "./agentModelRewrite.js";
import { buildEffortCatalogue } from "./modelEffortCatalog.js";
import { CODEX_MAIN_ALIAS } from "../config/routes.js";
import {
  DEFAULT_ORIGINROUTER_BASE_URL,
} from "../config/providerRoutes.js";

const TOKEN_HEADROOM_MS = 120_000;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const ALLOWED_PATH_PREFIXES = Object.freeze([
  "/coding/v1/models",
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

function forwardedHeaders(headers, token, runId = "") {
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
      || lower === "x-originrouter-collaboration-run"
    ) continue;
    if (value != null) out[name] = value;
  }
  out.Authorization = `Bearer ${token}`;
  out["Accept-Encoding"] = "identity";
  if (runId) out["X-OriginRouter-Collaboration-Run"] = runId;
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

function isModelsPath(rawUrl) {
  try {
    const parsed = new URL(rawUrl || "/", "http://127.0.0.1");
    return parsed.pathname === "/coding/v1/models";
  } catch {
    return false;
  }
}

// The levels Codex is told a model has.
//
// Codex keeps no list of its own: the levels a model has are the ones the
// provider's model list says, and this proxy is the provider. An empty list
// is what Codex falls back to when the provider says nothing — and a model
// with no levels has no effort to offer, and no way to resolve `ultra`.
//
// So the levels the device publishes for a model are published here too, and
// the two agree because they come from the same catalogue.
const CODEX_EFFORT_DESCRIPTIONS = Object.freeze({
  none: "No reasoning at all",
  minimal: "The lightest reasoning",
  low: "Faster responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
});

function codexModelInfo(model, levels = [], defaults = {}) {
  const slug = typeof model?.id === "string" ? model.id.trim() : "";
  if (!slug) return null;
  const supported = Array.isArray(levels) ? levels : [];
  return {
    slug,
    display_name: typeof model.name === "string" && model.name.trim()
      ? model.name.trim()
      : slug,
    base_instructions: "",
    supported_reasoning_levels: supported.map((effort) => ({
      effort,
      description: CODEX_EFFORT_DESCRIPTIONS[effort] || "",
    })),
    ...(defaults.default ? { default_reasoning_level: defaults.default } : {}),
    ...(defaults.multiAgent ? { multi_agent_reasoning_effort: defaults.multiAgent } : {}),
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    support_verbosity: false,
    truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [],
  };
}

async function normalizeCodexModelsResponse(req, response, catalogue = null) {
  if (!isModelsPath(req.url) || !response.ok) return response;
  const body = await response.text();
  let payload;
  try { payload = JSON.parse(body); } catch { return new Response(body, response); }
  if (Array.isArray(payload?.models) || !Array.isArray(payload?.data)) {
    return new Response(body, response);
  }
  const models = payload.data
    .map((model) => {
      const known = catalogue?.levelsFor(model?.id) || null;
      return codexModelInfo(model, known?.levels || [], {
        default: known?.default || null,
        multiAgent: known?.multiAgent || null,
      });
    })
    .filter(Boolean);
  // The alias is the model the session actually asks for, so it has to be in
  // the list: Codex resolves a model by the name it holds, and an alias that
  // is not in the list is a model it knows nothing about — no levels, no
  // clamping, and `ultra` with nothing to resolve to.
  if (catalogue?.aliasModels) {
    for (const alias of catalogue.aliasModels) {
      const slug = typeof alias?.slug === "string" ? alias.slug.trim() : "";
      if (!slug) continue;
      const concrete = alias.resolveModel?.() || null;
      const known = catalogue.levelsFor(concrete);
      models.push(codexModelInfo(
        { id: slug, name: concrete || slug },
        known?.levels || [],
        { default: known?.default || null, multiAgent: known?.multiAgent || null },
      ));
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify({ models }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class OriginRouterCodingAuthProxy {
  constructor({
    stateDir,
    upstreamBaseUrl = DEFAULT_ORIGINROUTER_BASE_URL,
    runId = "",
    fetchFn = globalThis.fetch,
    ensureFreshAccessTokenFn = ensureFreshAccessToken,
    maxRequestBytes = MAX_REQUEST_BYTES,
    onGatewayResponseIds = null,
    modelResolver = null,
    effortCatalogue = null,
  }) {
    this.stateDir = stateDir;
    this.upstreamBaseUrl = trimBaseUrl(upstreamBaseUrl);
    this.runId = String(runId || "").trim();
    this.fetchFn = fetchFn;
    this.ensureFreshAccessTokenFn = ensureFreshAccessTokenFn;
    this.maxRequestBytes = maxRequestBytes;
    this.onGatewayResponseIds = typeof onGatewayResponseIds === "function" ? onGatewayResponseIds : null;
    // The agent asks for a route alias; this turns it into the concrete model
    // the cloud should answer with. Null means "do not rewrite anything".
    this.modelResolver = typeof modelResolver === "function" ? modelResolver : null;
    // What the models on offer can do. The model list Codex reads is written
    // here, so this is where the levels a model has are told.
    this.effortCatalogue = effortCatalogue;
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
      headers: forwardedHeaders(req.headers, token, this.runId),
      body: body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      redirect: "manual",
      signal,
    });
  }

  _observeGatewayResponseIds(headers) {
    if (!this.onGatewayResponseIds) return;
    const values = [
      headers.get("x-originrouter-response-id"),
      headers.get("x-originrouter-request-id"),
      headers.get("x-gateway-response-id"),
      headers.get("x-response-id"),
      headers.get("x-openai-request-id"),
      headers.get("x-request-id"),
    ].filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim().slice(0, 255));
    if (values.length) {
      try { this.onGatewayResponseIds([...new Set(values)]); } catch {}
    }
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
      const rawBody = await readBody(req, this.maxRequestBytes);
      // The agent holds a route alias, not a model id. The cloud is asked for
      // the concrete model this session runs on, which may have changed since
      // the session started.
      const body = this.modelResolver
        ? rewriteModelInBody(rawBody, this.modelResolver)
        : rawBody;
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
      upstream = await normalizeCodexModelsResponse(req, upstream, this.effortCatalogue);
      this._observeGatewayResponseIds(upstream.headers);
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
  runId = "",
  sessionId = "",
  onGatewayResponseIds = null,
  effortCatalogue = null,
  proxyFactory = (options) => new OriginRouterCodingAuthProxy(options),
} = {}) {
  if (providerResult?.source !== "originrouter-coding") {
    return { providerResult, proxy: null };
  }
  // This proxy belongs to one session, so it knows whose override applies.
  // The alias it receives is translated into the model this session runs on
  // — the override the reader picked, the device route, or the model the
  // session started on.
  const modelResolver = createAgentModelResolver({
    agent,
    stateDir,
    sessionId,
    fallbackModels: fallbackModelsFor(agent, providerResult),
  });
  const proxy = proxyFactory({
    stateDir,
    upstreamBaseUrl: DEFAULT_ORIGINROUTER_BASE_URL,
    runId,
    onGatewayResponseIds,
    modelResolver,
    // What the models on offer can do, so the model list Codex reads is the
    // model list the device publishes. The alias is in that list too: the
    // session asks for the alias, and an alias Codex has never heard of is a
    // model with no levels.
    effortCatalogue: buildEffortCatalogue({
      models: effortCatalogue,
      aliasModels: agent === "codex"
        ? [{
          slug: CODEX_MAIN_ALIAS,
          resolveModel: () => modelResolver(CODEX_MAIN_ALIAS),
        }]
        : [],
    }),
  });
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
