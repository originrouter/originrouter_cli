// Stage 9.2 — Worker-side handler for incoming `remote.coding.request`
// events from originrouter-server. The worker fetches its own local
// LiteLLM proxy and streams status/headers/chunks back through the
// relay as `remote.coding.response.*` events.
//
// No auth. Caller credential/transport headers are stripped before
// forwarding. On upstream >= 500 the worker sends a single `error`
// event (no start/chunk/end). On fetch-throw or mid-stream throw the
// worker also sends a single `error` and stops.
//
// This file is pure I/O orchestration. The unit tests inject a
// `relayClient` (whose `send` is captured) and a `localProxyUrl` (a
// `node:http` mock or `null` for the "no local proxy" path).

import {
  decryptRemoteCodingRequest,
  encryptRemoteCodingResponse,
  REMOTE_CODING_E2EE_PROTOCOL,
} from "../crypto/remoteCodingE2ee.js";

const CREDENTIAL_TRANSPORT_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

function stripCredentialTransportHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (CREDENTIAL_TRANSPORT_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function decodeBase64Body(body) {
  if (body == null || body === "") return null;
  if (typeof body !== "string") return null;
  return Buffer.from(body, "base64");
}

function responseHeadersStripped(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === "content-encoding" || lk === "transfer-encoding") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Handle a `remote.coding.request` event.
 *
 * @param {object} envelope  The full event payload.
 * @param {object} deps
 * @param {object} deps.relayClient  Has `.send(type, payload)` — used to
 *   publish `remote.coding.response.*` events back through the relay.
 * @param {string|null} deps.localProxyUrl  `http://127.0.0.1:<port>` of
 *   the worker's local proxy, or `null` if the proxy is not running.
 * @param {Function} [deps.fetchFn]  Override fetch (for tests).
 * @param {AbortSignal} [deps.signal]  Optional abort signal; when aborted
 *   the in-flight fetch is cancelled.
 * @returns {Promise<{ ok: boolean, status?: number, code?: string, message?: string }>}
 */
export async function handleRemoteCodingRequest(envelope, deps) {
  const {
    relayClient,
    localProxyUrl,
    fetchFn = globalThis.fetch,
    signal,
    deviceId = null,
    e2eePolicy = "off",
    e2eeIdentity = null,
  } = deps;

  if (!envelope || typeof envelope !== "object") {
    return { ok: false, code: "upstream_error", message: "invalid envelope" };
  }
  const requestId = envelope.requestId;
  if (!requestId) {
    return { ok: false, code: "upstream_error", message: "missing requestId" };
  }
  if (deviceId && envelope.targetDeviceId && envelope.targetDeviceId !== deviceId) {
    await relayClient.send("remote.coding.response.error", {
      requestId,
      code: "e2ee_wrong_device",
      message: "remote coding request was addressed to another device",
    });
    return { ok: false, code: "e2ee_wrong_device" };
  }

  let requestEnvelope = envelope;
  let e2eeContext = null;
  if (envelope.protocol === REMOTE_CODING_E2EE_PROTOCOL) {
    if (!e2eeIdentity?.privateKey) {
      await relayClient.send("remote.coding.response.error", {
        requestId,
        code: "e2ee_target_incompatible",
        message: "target device has no end-to-end encryption identity",
      });
      return { ok: false, code: "e2ee_target_incompatible" };
    }
    try {
      const decrypted = decryptRemoteCodingRequest(envelope, e2eeIdentity);
      requestEnvelope = {
        ...decrypted.payload,
        requestId,
        sourceDeviceId: envelope.sourceDeviceId,
        targetDeviceId: envelope.targetDeviceId,
      };
      e2eeContext = decrypted.context;
    } catch (error) {
      await relayClient.send("remote.coding.response.error", {
        requestId,
        code: error?.code || "e2ee_decryption_failed",
        message: error?.message || "encrypted request could not be verified",
      });
      return { ok: false, code: error?.code || "e2ee_decryption_failed" };
    }
  } else if (e2eePolicy === "required") {
    await relayClient.send("remote.coding.response.error", {
      requestId,
      code: "e2ee_required",
      message: "target requires end-to-end encryption; plaintext was rejected",
    });
    return { ok: false, code: "e2ee_required" };
  }

  const sendResponse = async (type, payload) => {
    if (!e2eeContext) return relayClient.send(type, payload);
    const encrypted = encryptRemoteCodingResponse(e2eeContext, type, payload);
    return relayClient.send(type, encrypted);
  };
  if (!localProxyUrl) {
    await sendResponse("remote.coding.response.error", {
      requestId,
      code: "upstream_error",
      message: "local proxy is not running",
    });
    return { ok: false, code: "upstream_error", message: "local proxy is not running" };
  }

  const headers = stripCredentialTransportHeaders(requestEnvelope.headers);
  const body = decodeBase64Body(requestEnvelope.body);
  const url = `${localProxyUrl}${requestEnvelope.path || ""}`;

  let response;
  try {
    response = await fetchFn(url, {
      method: requestEnvelope.method || "POST",
      headers,
      body: body == null ? undefined : body,
      signal,
    });
  } catch (err) {
    await sendResponse("remote.coding.response.error", {
      requestId,
      code: "upstream_error",
      message: `fetch threw: ${err && err.message ? err.message : String(err)}`,
    });
    return { ok: false, code: "upstream_error", message: err && err.message };
  }

  // Upstream 5xx: surface as upstream_error, no start/chunk/end.
  if (response.status >= 500) {
    await sendResponse("remote.coding.response.error", {
      requestId,
      code: "upstream_error",
      status: response.status,
      message: `worker local proxy returned ${response.status}`,
    });
    return { ok: false, code: "upstream_error", status: response.status };
  }

  // Happy path: send start, then chunks, then end.
  await sendResponse("remote.coding.response.start", {
    requestId,
    status: response.status,
    headers: responseHeadersStripped(Object.fromEntries(response.headers.entries())),
  });

  if (!response.body) {
    await sendResponse("remote.coding.response.end", { requestId });
    return { ok: true, status: response.status };
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await sendResponse("remote.coding.response.chunk", {
        requestId,
        chunk: Buffer.from(value).toString("base64"),
      });
    }
    await sendResponse("remote.coding.response.end", { requestId });
    return { ok: true, status: response.status };
  } catch (err) {
    await sendResponse("remote.coding.response.error", {
      requestId,
      code: "upstream_error",
      message: `stream threw: ${err && err.message ? err.message : String(err)}`,
    });
    return { ok: false, code: "upstream_error", message: err && err.message };
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
