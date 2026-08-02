import http from "node:http";

import { CompatibilityEngine, CompatibilityPatchError, protocolForRequest } from "./engine.js";
import { compatibilityContextForRequest } from "./routeMap.js";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function requestHeaders(headers, bodyLength = null) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "host" || lower === "content-length"
        || lower === "accept-encoding") continue;
    if (value != null) result[lower] = value;
  }
  if (bodyLength != null) result["content-length"] = String(bodyLength);
  return result;
}

function responseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value != null) result[key] = value;
  }
  return result;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("request body exceeds compatibility gateway limit"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  });
  res.end(body);
}

async function collectReadable(readable, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("upstream body exceeds compatibility gateway limit"), {
      code: "body_too_large",
    });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writePatchedJson(res, status, headers, document, patchCount) {
  const body = Buffer.from(JSON.stringify(document));
  const outputHeaders = { ...headers };
  delete outputHeaders["content-length"];
  outputHeaders["content-length"] = String(body.length);
  if (patchCount > 0) outputHeaders["x-originrouter-compatibility-patches"] = String(patchCount);
  res.writeHead(status, outputHeaders);
  res.end(body);
}

async function proxySseWithCompatibility({
  upstreamResponse,
  res,
  status,
  headers,
  engine,
  context,
  requestPatchCount,
}) {
  delete headers["content-length"];
  if (requestPatchCount > 0) {
    headers["x-originrouter-compatibility-patches"] = String(requestPatchCount);
  }
  res.writeHead(status, headers);
  let pending = "";
  let appliedCount = requestPatchCount;
  const streamState = {};
  const emitBlock = async (block, separator) => {
    if (!block) {
      res.write(separator);
      return;
    }
    const lines = block.split(/\r?\n/);
    const output = [];
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        output.push(line);
        continue;
      }
      const raw = line.slice(5).trimStart();
      if (!raw || raw === "[DONE]") {
        output.push(line);
        continue;
      }
      try {
        const document = JSON.parse(raw);
        const result = await engine.apply("stream", context, document, streamState);
        appliedCount += result.applied.length;
        output.push(`data: ${JSON.stringify(result.document)}`);
      } catch (error) {
        if (error instanceof CompatibilityPatchError) throw error;
        output.push(line);
      }
    }
    res.write(`${output.join("\n")}${separator}`);
  };
  for await (const chunk of upstreamResponse) {
    pending += chunk.toString("utf8");
    for (;;) {
      const match = pending.match(/\r?\n\r?\n/);
      if (!match || match.index == null) break;
      const index = match.index;
      const separator = match[0];
      const block = pending.slice(0, index);
      pending = pending.slice(index + separator.length);
      await emitBlock(block, separator);
    }
  }
  if (pending) await emitBlock(pending, "");
  void appliedCount;
  res.end();
}

function proxyRequest({
  req,
  res,
  upstream,
  body = null,
  compatibility = null,
  compatibilityContext = null,
  engineProvider = null,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
}) {
  return new Promise((resolve) => {
    const target = new URL(req.url || "/", upstream);
    const upstreamRequest = http.request(target, {
      method: req.method,
      headers: requestHeaders(req.headers, body == null ? null : body.length),
    }, async (upstreamResponse) => {
      const headers = responseHeaders(upstreamResponse.headers);
      const requestPatchCount = compatibility?.applied?.length || 0;
      const engine = typeof engineProvider === "function" ? engineProvider() : null;
      const status = upstreamResponse.statusCode || 502;
      const contentType = String(upstreamResponse.headers["content-type"] || "").toLowerCase();
      const phase = status >= 400 ? "error" : "response";
      try {
        if (engine && compatibilityContext && contentType.includes("text/event-stream")
            && engine.matchingPatches("stream", compatibilityContext).length > 0) {
          await proxySseWithCompatibility({
            upstreamResponse,
            res,
            status,
            headers,
            engine,
            context: compatibilityContext,
            requestPatchCount,
          });
          resolve();
          return;
        }
        if (engine && compatibilityContext && contentType.includes("application/json")
            && engine.matchingPatches(phase, compatibilityContext).length > 0) {
          const raw = await collectReadable(upstreamResponse, maxBodyBytes);
          const document = JSON.parse(raw.toString("utf8"));
          const result = await engine.apply(phase, compatibilityContext, document, {});
          writePatchedJson(
            res,
            status,
            headers,
            result.document,
            requestPatchCount + result.applied.length,
          );
          resolve();
          return;
        }
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, error.code === "body_too_large" ? 502 : 502, {
            error: {
              code: error.code || "originrouter_compatibility_response_failed",
              message: error.message,
              patch_id: error.patchId || null,
            },
          });
        } else {
          res.destroy(error);
        }
        resolve();
        return;
      }
      if (requestPatchCount) {
        headers["x-originrouter-compatibility-patches"] = String(requestPatchCount);
      }
      res.writeHead(status, headers);
      upstreamResponse.pipe(res);
      upstreamResponse.on("end", resolve);
    });
    upstreamRequest.on("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: { code: "originrouter_upstream_unavailable", message: error.message } });
      } else {
        res.destroy(error);
      }
      resolve();
    });
    req.on("aborted", () => upstreamRequest.destroy());
    if (body == null) req.pipe(upstreamRequest);
    else upstreamRequest.end(body);
  });
}

function isPatchableRequest(req) {
  if (String(req.method || "GET").toUpperCase() !== "POST") return false;
  return protocolForRequest(req.url) !== "http.unknown";
}

export function createCompatibilityGateway({
  upstreamBaseUrl,
  routeMap = { aliases: {} },
  engine = new CompatibilityEngine(),
  engineProvider = null,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  logger = console,
} = {}) {
  if (!upstreamBaseUrl) throw new Error("upstreamBaseUrl is required");
  const upstream = new URL(upstreamBaseUrl);
  return http.createServer(async (req, res) => {
    if (!isPatchableRequest(req)) {
      await proxyRequest({ req, res, upstream });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (error) {
      sendJson(res, error.code === "body_too_large" ? 413 : 400, {
        error: { code: error.code || "invalid_request", message: error.message },
      });
      return;
    }
    let document;
    try {
      document = JSON.parse(raw.toString("utf8"));
    } catch {
      await proxyRequest({ req, res, upstream, body: raw });
      return;
    }
    const protocol = protocolForRequest(req.url);
    const context = compatibilityContextForRequest(routeMap, {
      method: req.method,
      path: req.url,
      protocol,
      body: document,
    });
    try {
      const activeEngine = typeof engineProvider === "function" ? engineProvider() : engine;
      const result = await activeEngine.apply("request", context, document);
      const body = Buffer.from(JSON.stringify(result.document));
      if (result.applied.length) {
        logger.log?.("[compatibility] request patches applied", {
          protocol,
          providerFamily: context.providerFamily,
          modelAlias: context.model,
          patches: result.applied.map((patch) => patch.id),
        });
      }
      await proxyRequest({
        req,
        res,
        upstream,
        body,
        compatibility: result,
        compatibilityContext: context,
        engineProvider: () => activeEngine,
        maxBodyBytes,
      });
    } catch (error) {
      const status = error instanceof CompatibilityPatchError ? 422 : 500;
      sendJson(res, status, {
        error: {
          code: error.code || "originrouter_compatibility_error",
          message: error.message,
          patch_id: error.patchId || null,
        },
      });
    }
  });
}
