// Turning the CLI's bearer tokens into proofs — RFC 9449.
//
// Everything the CLI sends to its own control plane goes out as a bearer
// token, and a bearer token may be used by whoever holds it. The CLI keeps
// its token on disk, on a machine that is usually a server that is always
// on, and that is the case worth closing.
//
// This file is the part that closes it. It decides when a request may
// carry a proof, it registers the key that signs the proof, and it stays
// out of the way of every request that has nothing to do with it. Four
// rules do that:
//
//   * Only the CLI's own control plane and relay. The AI, coding and memory
//     audiences are checked by services that know nothing about proofs, and
//     a request that arrives with a scheme they do not read is a request
//     they may refuse for the scheme alone.
//   * Only the CLI's own token. A provider's API key and the local API's
//     token are not ours to re-scheme.
//   * Only after a registration. Before the server has accepted a key the
//     request stays a bearer request — which is what it was before this
//     file existed, and what it stays on a server that has never heard of
//     DPoP.
//   * Only against a deployment this device has registered with.
//
// The third rule is what makes the order of a deployment irrelevant: a CLI
// that talks to a server without these routes keeps working exactly as it
// did before, and a server that has them asks for a proof only from a
// device that has offered to give one.

import { OFFICIAL_RELAY_URLS } from "../constants.js";
import {
  DPOP_ALGORITHM,
  DPOP_SCHEME,
  dpopProof,
  dpopPublicJwk,
  dpopThumbprint,
  generateDpopKeyPair,
} from "../crypto/dpopIdentity.js";
import {
  readDeviceE2eeIdentity,
  signDeviceE2eeDpopRegistration,
} from "../crypto/deviceE2eeIdentity.js";
import { ACCESS_TOKEN_PREFIX } from "../runtime/authContract.js";
import { accessTokenFor, OAUTH_RESOURCES } from "../runtime/authContract.js";
import { readCodingAuth } from "../persistence/codingAuth.js";
import { isAccountStateDir, readActiveAccountScope } from "../persistence/accounts.js";
import { withProcessLock } from "../persistence/processLock.js";
import {
  dpopStorePath,
  readDpopRegistration,
  readDpopStore,
  setDpopRegistration,
  writeDpopStore,
} from "./dpopStore.js";

//: The deployment the public aliases belong to.
//
// The aliases answer for one service, so a key registered through one of
// them is the same key to the others. The registry on the server is keyed
// by the account, the device and the source — not by the address the
// request came in on — so one registration covers both.
export const OFFICIAL_DEPLOYMENT = OFFICIAL_RELAY_URLS[0];

const OFFICIAL_ORIGINS = new Set(OFFICIAL_RELAY_URLS.map((value) => originOf(value)));

//: The paths whose tokens this server can hold to a proof.
//
// The control plane and the relay are the two audiences a proof is enforced
// for. Everything else — the AI audit endpoints, the coding gateway, the
// memory service — is checked by a service that has no idea what a proof
// is, and a request that arrives with a scheme it does not read is a
// request it may refuse for the scheme alone.
const DPOP_PATH_PREFIXES = Object.freeze(["/cli/v1/", "/relay/v1/"]);

//: The path the registration routes live under.
const DPOP_ROUTE_PREFIX = "/cli/v1/dpop";

//: How long to wait before trying to recover a refused registration again.
//
// A device whose key was lost gets one chance to put a new one in place. A
// server that is down, or a proof the clock refused, would otherwise turn
// every request into another registration attempt.
const RECOVERY_COOLDOWN_MS = 15_000;
const REGISTRATION_REQUEST_TIMEOUT_MS = 15_000;

let ORIGINAL_FETCH = globalThis.fetch;

/**
 * Whether this CLI speaks DPoP at all.
 *
 * The switch exists for one reason: a deployment that wants the old
 * behaviour back. It turns the whole thing off — no registration, no
 * proofs, no change to any request — and it is the same switch a device
 * that has never registered is on by default, because a device with no key
 * has nothing to prove with.
 */
export function dpopEnabled(env = process.env) {
  const value = String(env?.ORIGINROUTER_DPOP ?? "").trim().toLowerCase();
  if (!value) return true;
  return !["off", "0", "false", "no", "disabled"].includes(value);
}

/**
 * The origin of a URL, in the spelling the registry uses.
 *
 * A WebSocket URL is folded onto the HTTP origin it came from: the
 * relay's `wss://` address and its `https://` address are one service, and
 * a registration for one is a registration for the other.
 */
export function originOf(url) {
  const parsed = url instanceof URL ? url : new URL(String(url));
  const scheme = parsed.protocol === "ws:"
    ? "http:"
    : parsed.protocol === "wss:"
      ? "https:"
      : parsed.protocol;
  return `${scheme}//${parsed.host}`;
}

/**
 * Which deployment a URL belongs to.
 *
 * The public aliases are one deployment; anything else is a deployment of
 * its own, named by its address. A device that registered with one
 * deployment has no registration with another, and must not send a proof
 * there.
 */
export function deploymentFor(url) {
  let origin;
  try {
    origin = originOf(url);
  } catch {
    return null;
  }
  if (OFFICIAL_ORIGINS.has(origin)) return OFFICIAL_DEPLOYMENT;
  return origin;
}

/**
 * Whether a request to this URL is one the server may hold to a proof.
 */
export function usesDpopAudience(url) {
  let path;
  try {
    path = (url instanceof URL ? url : new URL(String(url))).pathname || "/";
  } catch {
    return false;
  }
  return DPOP_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The headers a request to this URL should carry.
 *
 * The answer is a bearer request unless every one of the rules above says
 * otherwise, and it is a bearer request whenever anything goes wrong: a
 * missing key, an unreadable store, a key the server does not hold. A
 * device that cannot sign a proof sends the request it would have sent
 * before this file existed, which is the request the server still accepts.
 */
export function dpopAuthHeaders({
  stateDir,
  method = "GET",
  url,
  token,
  accountScope = null,
} = {}) {
  const accessToken = String(token || "");
  if (!accessToken) return null;
  const bearer = { Authorization: `Bearer ${accessToken}` };
  if (!dpopEnabled()) return bearer;
  if (!accessToken.startsWith(ACCESS_TOKEN_PREFIX)) return bearer;
  if (!usesDpopAudience(url)) return bearer;
  const deployment = deploymentFor(url);
  if (!deployment) return bearer;
  const store = readDpopStore(stateDir, { accountScope, strict: true });
  const registration = store?.registrations?.[deployment];
  if (!registration) return bearer;
  // A revoked key is a key this device has given up. It stays revoked until
  // the device registers again, which it does on its own terms — not on
  // every request.
  if (registration.status !== "pending" && registration.status !== "active") {
    return bearer;
  }
  const privateJwk = store?.key?.private_jwk;
  if (!privateJwk) throw Object.assign(new Error("DPoP key is unavailable"), { code: "dpop_key_unavailable" });
  try {
    const publicJwk = store.key.public_jwk || dpopPublicJwk(privateJwk);
    const proof = dpopProof({
      privateJwk,
      publicJwk,
      accessToken,
      method,
      url,
    });
    return { Authorization: `${DPOP_SCHEME} ${accessToken}`, DPoP: proof };
  } catch {
    throw Object.assign(new Error("DPoP proof could not be signed"), { code: "dpop_key_unavailable" });
  }
}

/**
 * A function the relay's WebSocket handshake can ask for headers.
 *
 * The handshake cannot go through `fetch`, so it cannot be covered by the
 * wrapper below. It asks this instead, and gets the same answer for the
 * same reasons.
 */
export function createDpopProofProvider({ stateDir, accountScope = null } = {}) {
  return async function dpopProofProvider({ method = "GET", url, token } = {}) {
    return dpopAuthHeaders({ stateDir, method, url, token, accountScope });
  };
}

/**
 * Whether a failure is this device's key being wrong, rather than the
 * server being unreachable or the request being refused for some other
 * reason.
 *
 * This mirrors what the App decides: a refusal whose code names DPoP, at
 * 401, and not the one code that means "this server cannot store keys yet".
 */
export function isDpopRefusal(status, body) {
  const code = String(body?.detail?.code || body?.code || "");
  if (!code.startsWith("dpop_")) return false;
  if (code === "dpop_registry_unavailable") return false;
  return Number(status) === 401;
}

/**
 * The reason a refusal gives, when the refusal names one.
 *
 * The server answers a request it will not accept with a challenge that
 * names the error, so the reason is in the headers whether or not the
 * body has been read — and a streamed response has no body to read at
 * all. This is the same question `isDpopRefusal` asks of a body, asked
 * of headers instead.
 */
export function dpopRefusalCode(status, headers) {
  if (Number(status) !== 401) return null;
  let challenge = "";
  if (headers && typeof headers.get === "function") {
    challenge = String(headers.get("www-authenticate") || "");
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === "www-authenticate") {
        challenge = String(value || "");
        break;
      }
    }
  }
  const match = /error="([^"]+)"/i.exec(challenge);
  const code = match ? match[1] : "";
  if (!code.startsWith("dpop_")) return null;
  if (code === "dpop_registry_unavailable") return null;
  return code;
}

/**
 * Whether a refusal says the key this device signs with is not the key
 * the server holds.
 *
 * These two are the ones a new key answers. The others — a proof that
 * did not match, a proof that was replayed — are about the request that
 * carried them, and registering again would not change them.
 */
export function isDpopKeyMismatch(code) {
  return code === "dpop_key_mismatch" || code === "dpop_key_not_registered";
}

function collectHeaders(input, init) {
  const out = {};
  const add = (source) => {
    if (!source) return;
    if (typeof source.forEach === "function" && !Array.isArray(source)) {
      source.forEach((value, key) => {
        out[String(key).toLowerCase()] = String(value);
      });
      return;
    }
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        out[String(entry[0]).toLowerCase()] = String(entry[1]);
      }
      return;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value == null) continue;
      out[String(key).toLowerCase()] = String(value);
    }
  };
  if (input && typeof input === "object" && typeof input.url === "string") {
    add(input.headers);
  }
  add(init?.headers);
  return out;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && typeof input.url === "string") {
    return input.url;
  }
  return null;
}

/**
 * Rewrite one request so that it carries a proof — or say that it must not
 * be touched.
 *
 * The rules are the ones at the top of this file. Anything that does not
 * match all of them comes out exactly as it went in, including the
 * requests to the local API, to a model provider and to the upstream
 * gateway, none of which have anything to do with this.
 */
export function rewriteForDpop(input, init, { stateDir, accountScope = null } = {}) {
  const raw = requestUrl(input);
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const headers = collectHeaders(input, init);
  const authorization = headers.authorization || "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) return null;
  const token = match[1];
  const method = String(init?.method || input?.method || "GET").toUpperCase();
  const replacement = dpopAuthHeaders({
    stateDir,
    method,
    url: url.toString(),
    token,
    accountScope,
  });
  if (!replacement) return null;
  if (replacement.Authorization === authorization) return null;
  // The collected headers are lower-cased, so the replacement has to be
  // lower-cased too. A request that carried both `Authorization` and
  // `authorization` would arrive with the two joined by a comma, and the
  // server would read a scheme it does not know.
  const merged = { ...headers };
  for (const [key, value] of Object.entries(replacement)) {
    merged[key.toLowerCase()] = value;
  }
  return { input, init: { ...init, headers: merged } };
}

/**
 * A `fetch` that carries proofs where they belong.
 *
 * The wrapper is deliberately narrow: it recognises the CLI's own token on
 * the CLI's own control plane and the CLI's own relay, and it changes
 * nothing else. A request it does not recognise goes out byte for byte as
 * it was written.
 */
export function createDpopFetch({ stateDir, fetchFn = null, accountScope = null, onRefusal = null, prepareSession = null } = {}) {
  const options = { stateDir, accountScope, onRefusal, prepareSession };
  const inner = fetchFn || globalThis.fetch;
  const wrapped = async (input, init = {}) => {
    const currentStateDir = options.stateDir;
    const dynamicScope = typeof currentStateDir === "string" && options.accountScope == null && !isAccountStateDir(currentStateDir);
    const startingScope = dynamicScope ? readActiveAccountScope(currentStateDir) : null;
    const url = requestUrl(input);
    const authorization = collectHeaders(input, init).authorization || "";
    const token = /^(?:Bearer|DPoP)\s+(or_at_\S+)$/i.exec(authorization)?.[1];
    if (options.prepareSession && url && token && usesDpopAudience(url) && !isEnrollmentRequest(url, init?.method || input?.method)) {
      await options.prepareSession({ stateDir: options.stateDir, accountScope: options.accountScope, url, token });
      if (dynamicScope && readActiveAccountScope(currentStateDir) !== startingScope) {
        throw Object.assign(new Error("Account changed before the request was sent"), { code: "account_changed" });
      }
    }
    const rewritten = rewriteForDpop(input, init, options);
    let response = await inner(
      rewritten ? rewritten.input : input,
      rewritten ? rewritten.init : init,
    );
    // A registration can complete while a read is in flight. Retry a
    // bodyless read only if it was sent without a proof and the same
    // account now has one; never replay a mutation or a consumed Request.
    const sameAccount = () => !dynamicScope || readActiveAccountScope(currentStateDir) === startingScope;
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    // The server emits this challenge before entering a business handler.
    // Retry only replayable requests with a newly signed proof.
    const challenge = response?.headers?.get?.('www-authenticate') || '';
    if (options.prepareSession && response.status === 401 &&
        challenge.includes('device_session_not_activated') && sameAccount() &&
        typeof input === 'string' && /^Bearer\s+/i.test(authorization) &&
        (init.body == null || typeof init.body === 'string')) {
      await options.prepareSession({stateDir: options.stateDir, accountScope: options.accountScope,
        url, token, force: true});
      if (!sameAccount()) throw Object.assign(new Error('Account changed before retry'), {code:'account_changed'});
      const retry = rewriteForDpop(input, init, options);
      if (retry) {
        response.body?.cancel?.().catch?.(() => {});
        response = await inner(retry.input, retry.init);
      }
    }
    if (!rewritten && typeof input === "string" && init.body == null &&
        (method === "GET" || method === "HEAD") && sameAccount() &&
        dpopRefusalCode(response.status, response.headers) === "dpop_proof_required") {
      const retry = rewriteForDpop(input, init, options);
      if (retry && sameAccount()) {
        response.body?.cancel?.().catch?.(() => {});
        response = await inner(retry.input, retry.init);
      }
    }
    // A refusal that says the key is wrong is answered by putting a key
    // back in place, and the refusal itself is not waited for: the next
    // request is the one that carries the new proof. The refusal is
    // looked for in every response, including the ones that were not
    // rewritten — a device whose local record has gone missing is exactly
    // the device whose requests go out without a proof.
    const hook = options.onRefusal;
    if (typeof hook === "function") {
      const url = requestUrl(input);
      const code = dpopRefusalCode(response.status, response.headers);
      if (code && isDpopKeyMismatch(code) && url && usesDpopAudience(url) && sameAccount()) {
        Promise.resolve()
          .then(() => hook({ code, url, status: response.status }))
          .catch(() => {});
      }
    }
    return response;
  };
  wrapped.dpop = true;
  wrapped.raw = inner;
  wrapped.options = options;
  return wrapped;
}

function isEnrollmentRequest(url, method = 'GET') {
  let path;
  try { path = new URL(url).pathname; } catch { return false; }
  const verb = String(method || 'GET').toUpperCase();
  return (verb === 'GET' && path === `${DPOP_ROUTE_PREFIX}/status`) ||
    (verb === 'POST' && [`${DPOP_ROUTE_PREFIX}/key`, `${DPOP_ROUTE_PREFIX}/proof`,
      `${DPOP_ROUTE_PREFIX}/session/activate`].includes(path));
}

/** Prepare one login before its first protected request in this process. */
export function createDeviceSessionReadiness({ fetchFn, refreshFn = null, ensureFn = ensureDpopRegistered } = {}) {
  const ready = new Set();
  const running = new Map();
  return async ({ stateDir, accountScope = null, url, token, force = false }) => {
    const credential = readCodingAuth(stateDir);
    if (!credential) return;
    const control = accessTokenFor(credential, OAUTH_RESOURCES.CONTROL)?.token;
    const relay = accessTokenFor(credential, OAUTH_RESOURCES.RELAY)?.token;
    // A caller may deliberately use an unrelated credential. Do not change
    // the active installation's state on the strength of that request.
    if (token !== control && token !== relay) return;
    const scope = accountScope ?? credential.accountScope ?? null;
    const binding = [stateDir, scope, credential.sessionId, deploymentFor(url)].join('|');
    if (ready.has(binding) && !force) return;
    if (force) ready.delete(binding);
    const pending = running.get(binding);
    if (pending) return pending;
    const operation = (async () => {
      const refresh = refreshFn ?? (await import('../runtime/oauthTokenRefresher.js')).ensureFreshAccessToken;
      const current = await refresh({ stateDir, resource: OAUTH_RESOURCES.CONTROL, fetchFn });
      const live = readCodingAuth(stateDir);
      if (!current || !live || current.sessionId !== credential.sessionId ||
          live.sessionId !== credential.sessionId || live.accountScope !== credential.accountScope ||
          (scope != null && live.accountScope !== scope)) {
        throw Object.assign(new Error('Account changed during device authentication'), { code: 'account_changed' });
      }
      const accessToken = accessTokenFor(current, OAUTH_RESOURCES.CONTROL)?.token;
      const result = await ensureFn({ stateDir, controlBaseUrl: originOf(url), accessToken,
        deviceId: current.deviceId, accountScope: scope, fetchFn });
      const after = readCodingAuth(stateDir);
      if (!after || after.sessionId !== credential.sessionId || after.accountScope !== credential.accountScope) {
        throw Object.assign(new Error('Account changed during device authentication'), { code: 'account_changed' });
      }
      if (result?.status !== 'active') {
        throw Object.assign(new Error('Device authentication is not ready'), {
          code: result?.code || 'dpop_registration_unavailable',
        });
      }
      ready.add(binding);
    })();
    running.set(binding, operation);
    try { await operation; } finally { if (running.get(binding) === operation) running.delete(binding); }
  };
}

/**
 * The `fetch` this process started with.
 *
 * The registration flow uses it rather than the wrapper: the requests it
 * makes are the ones that decide whether a proof is needed at all, and
 * they must not be rewritten by the thing they are deciding about.
 */
export function rawFetch() {
  return ORIGINAL_FETCH;
}

/**
 * Put the wrapper in front of this process's `fetch`.
 *
 * Calling this twice is not a problem: the second call updates the state
 * directory the first wrapper reads and leaves the wrapper in place.
 */
export function installDpopFetch({ stateDir, fetchFn = null, onRefusal = null } = {}) {
  if (fetchFn) ORIGINAL_FETCH = fetchFn;
  const current = globalThis.fetch;
  if (current?.dpop) {
    current.options.stateDir = stateDir;
    if (onRefusal) current.options.onRefusal = onRefusal;
    return current;
  }
  const wrapped = createDpopFetch({ stateDir, fetchFn: ORIGINAL_FETCH, onRefusal,
    prepareSession: createDeviceSessionReadiness({ fetchFn: ORIGINAL_FETCH }) });
  globalThis.fetch = wrapped;
  return wrapped;
}

async function dpopRequest({
  send,
  url,
  method = "GET",
  token,
  headers = {},
  body = null,
}) {
  const response = await send(url, {
    method,
    signal: AbortSignal.timeout(REGISTRATION_REQUEST_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw Object.assign(new Error('Invalid device authentication response', { cause: error }), {
      code: 'dpop_invalid_response',
    });
  }
  const detail = payload?.detail && typeof payload.detail === "object" ? payload.detail : null;
  return {
    ok: response.ok,
    status: response.status,
    data: payload?.data ?? payload,
    code: detail?.code || payload?.code || null,
    payload,
  };
}

/**
 * The proof a registration request should carry, when this device has a key
 * to sign with.
 *
 * The status route asks for a proof from a device whose key is already
 * active, so a device that has one has to present it — otherwise it could
 * not even find out what the server thinks of it. A device with no key
 * sends a bearer request, which is the request it would have sent before
 * this existed.
 */
function proofHeaders({ store, token, method, url }) {
  const privateJwk = store?.key?.private_jwk;
  if (!privateJwk) return {};
  try {
    const publicJwk = store.key.public_jwk || dpopPublicJwk(privateJwk);
    const proof = dpopProof({ privateJwk, publicJwk, accessToken: token, method, url });
    return { Authorization: `${DPOP_SCHEME} ${token}`, DPoP: proof };
  } catch (error) {
    throw Object.assign(new Error('Cannot sign device authentication proof', { cause: error }), {
      code: 'dpop_key_unavailable',
    });
  }
}

/**
 * Bring this device's DPoP registration up to date.
 *
 * The steps are the App's, in the same order: ask the server what it
 * thinks, prove the key if it is waiting for a proof, and register — with
 * the device's own long-term key signing for it — when there is nothing to
 * prove.
 *
 * A caller requiring device authentication must treat a result other than
 * active as a failure; an unregistered device cannot use protected routes.
 */
export async function ensureDpopRegistered({
  stateDir,
  controlBaseUrl,
  accessToken,
  deviceId,
  fetchFn = null,
  accountScope = null,
  now = new Date(),
} = {}) {
  if (!dpopEnabled()) return { status: "disabled" };
  const base = String(controlBaseUrl || '').replace(/\/+$/, '');
  if (!base || !accessToken || !deviceId || !deploymentFor(base)) return { status: 'skipped' };
  const storePath = dpopStorePath(stateDir, { accountScope });
  const verifyScope = () => {
    if (dpopStorePath(stateDir, { accountScope }) !== storePath) {
      throw Object.assign(new Error('Account changed during device authentication'), { code: 'account_changed' });
    }
  };
  return withProcessLock(storePath, async () => {
    verifyScope();
    const innerFetch = fetchFn || rawFetch();
    const guardedFetch = async (...args) => {
      verifyScope();
      const response = await innerFetch(...args);
      verifyScope();
      return response;
    };
    return ensureDpopRegisteredLocked({ stateDir, controlBaseUrl, accessToken,
      deviceId, fetchFn: guardedFetch, accountScope, now });
  }, {timeoutCode: 'dpop_registration_lock_timeout'});
}

async function ensureDpopRegisteredLocked({
  stateDir, controlBaseUrl, accessToken, deviceId, fetchFn, accountScope, now,
}) {
  if (!dpopEnabled()) return { status: "disabled" };
  const base = String(controlBaseUrl || "").replace(/\/+$/, "");
  const token = String(accessToken || "");
  if (!base || !token || !deviceId) return { status: "skipped" };
  const deployment = deploymentFor(base);
  if (!deployment) return { status: "skipped" };
  const send = fetchFn || rawFetch();

  let store = readDpopStore(stateDir, { accountScope, strict: true });
  let localJkt = null;
  if (store?.key?.private_jwk) {
    try {
      localJkt = dpopThumbprint(store.key.public_jwk || dpopPublicJwk(store.key.private_jwk));
    } catch {
      localJkt = null;
    }
  }

  // What does the server think of this device?
  const statusUrl = `${base}${DPOP_ROUTE_PREFIX}/status`;
  const status = await dpopRequest({
    send,
    url: statusUrl,
    method: "GET",
    token,
    headers: proofHeaders({ store, token, method: "GET", url: statusUrl }),
  });
  if (status.status === 404) return { status: "unsupported" };
  if (status.ok && status.data?.available === false) return { status: "unavailable" };
  // Only a definite key disagreement justifies enrollment. A network or
  // server failure must never be mistaken for a missing registration.
  if (!status.ok && !(status.status === 401 && [
    "dpop_key_mismatch", "dpop_key_not_registered", "dpop_proof_required",
  ].includes(status.code))) {
    return { status: "refused", code: status.code || `http_${status.status}` };
  }
  if (status.ok && (status.data?.available !== true ||
      !['none', 'pending', 'active', 'revoked'].includes(status.data?.status) ||
      (status.data.status !== 'none' &&
       (typeof status.data.jkt !== 'string' || !status.data.jkt)))) {
    return { status: 'refused', code: 'dpop_invalid_response' };
  }
  const serverStatus = status.ok ? status.data.status : null;
  const serverJkt = status.ok && typeof status.data?.jkt === "string" ? status.data.jkt : null;

  if (localJkt && serverJkt === localJkt) {
    if (serverStatus === "active") {
      setDpopRegistration(
        stateDir,
        deployment,
        { status: "active", jkt: localJkt, origin: base },
        { accountScope },
      );
      return activateDeviceSession({ send, base, token, store, jkt: localJkt });
    }
    if (serverStatus === "pending") {
      setDpopRegistration(
        stateDir,
        deployment,
        { status: "pending", jkt: localJkt, origin: base },
        { accountScope },
      );
      const proved = await proveRegistration({
        send, base, token, store, deployment, accountScope, stateDir, jkt: localJkt,
      });
      if (proved.status !== "active") return proved;
      return activateDeviceSession({ send, base, token, store, jkt: localJkt });
    }
  }

  // A revoked key is a key this device has given up, or one that was taken
  // away. Either way it is not the key this device signs with any more, so
  // the next one is a new one.
  const revoked = serverStatus === "revoked";
  if (!store?.key?.private_jwk || revoked) {
    const pair = generateDpopKeyPair();
    store = {
      ...(store || { version: 1, registrations: {} }),
      key: { private_jwk: pair.privateJwk, public_jwk: pair.publicJwk },
    };
    writeDpopStore(stateDir, store, { accountScope });
  }
  const privateJwk = store.key.private_jwk;
  const publicJwk = store.key.public_jwk || dpopPublicJwk(privateJwk);
  const jkt = dpopThumbprint(publicJwk);

  const identity = readDeviceE2eeIdentity(stateDir, { accountScope });
  if (!identity) return { status: "no_identity" };
  let binding;
  try {
    binding = signDeviceE2eeDpopRegistration(identity, { deviceId, jkt, now });
  } catch (error) {
    return { status: "identity_mismatch", code: error.message };
  }

  const registered = await dpopRequest({
    send,
    url: `${base}${DPOP_ROUTE_PREFIX}/key`,
    method: "POST",
    token,
    body: { jwk: publicJwk, alg: DPOP_ALGORITHM, binding },
  });
  if (!registered.ok) {
    return { status: "refused", code: registered.code || `http_${registered.status}` };
  }

  // The server now holds the key as pending, which enforces nothing. The
  // local record is written before the proof so that the request carrying
  // the proof is already a `DPoP` request — a proof that does not travel
  // with the scheme it belongs to is a proof the server has no reason to
  // look for.
  setDpopRegistration(
    stateDir,
    deployment,
    { status: "pending", jkt, origin: base },
    { accountScope },
  );
  const proved = await proveRegistration({
    send, base, token, store, deployment, accountScope, stateDir, jkt,
  });
  if (proved.status !== "active") return proved;
  return activateDeviceSession({ send, base, token, store, jkt });
}

async function activateDeviceSession({ send, base, token, store, jkt }) {
  const url = `${base}${DPOP_ROUTE_PREFIX}/session/activate`;
  const result = await dpopRequest({
    send, url, method: "POST", token,
    headers: proofHeaders({ store, token, method: "POST", url }),
  });
  return result.ok
    ? { status: "active", jkt }
    : { status: "refused", code: result.code || `http_${result.status}` };
}

/**
 * Show the server that the key works, and record the enforcement it turns
 * on.
 *
 * A failure here leaves the device on a pending key, which enforces
 * nothing — so the device keeps working, and the next attempt tries again.
 * That is the whole reason the server has a pending state.
 */
async function proveRegistration({
  send, base, token, store, deployment, accountScope, stateDir, jkt,
}) {
  const proofUrl = `${base}${DPOP_ROUTE_PREFIX}/proof`;
  const proved = await dpopRequest({
    send,
    url: proofUrl,
    method: "POST",
    token,
    headers: proofHeaders({ store, token, method: "POST", url: proofUrl }),
  });
  if (proved.ok) {
    setDpopRegistration(
      stateDir,
      deployment,
      { status: "active", jkt, origin: base },
      { accountScope },
    );
    return { status: "active", jkt };
  }
  return { status: "pending", jkt, code: proved.code || `http_${proved.status}` };
}

/**
 * Put a key back in place after the server refused the one this device had.
 *
 * The server holds an active key for this device that this device cannot
 * prove — a reinstall, a restored backup, a store that was cleared. If it
 * is the local record that still exists, drop it; if the key itself is
 * gone, there is nothing to drop. Either way the next step is the same,
 * and it is the reason the registration route is the one route that does
 * not ask for a proof.
 */
export async function recoverDpopRegistration({
  stateDir,
  controlBaseUrl,
  accessToken,
  deviceId,
  fetchFn = null,
  accountScope = null,
} = {}) {
  const base = String(controlBaseUrl || "").replace(/\/+$/, "");
  return ensureDpopRegistered({
    stateDir,
    controlBaseUrl: base,
    accessToken,
    deviceId,
    fetchFn,
    accountScope,
  });
}

/**
 * Watch for a refused proof and try once to put a key back in place.
 *
 * This is deliberately lazy. The registration is done at sign-in and when
 * the daemon connects; this is the case where the device found out in the
 * middle of a request that its key no longer matches, and it is better
 * answered by the next request than by this one.
 *
 * The three things a registration needs — the address of the server, the
 * token to register with, and the name of this device — are read when the
 * recovery runs rather than when it is set up. The daemon knows all three
 * only later: the address when it has resolved its endpoint, the token
 * when it has one that has not expired, and the device when it has been
 * told which one it is.
 */
export function createDpopRecovery({
  stateDir,
  controlBaseUrl,
  accessToken,
  deviceId,
  fetchFn = null,
  accountScope = null,
  cooldownMs = RECOVERY_COOLDOWN_MS,
  now = () => Date.now(),
} = {}) {
  let lastAttemptAt = 0;
  let running = null;
  return async function recoverDpopRecovery() {
    if (running) return running;
    const moment = now();
    if (moment - lastAttemptAt < cooldownMs) return null;
    lastAttemptAt = moment;
    running = (async () => {
      try {
        const base = typeof controlBaseUrl === "function" ? await controlBaseUrl() : controlBaseUrl;
        const token = typeof accessToken === "function" ? await accessToken() : accessToken;
        const device = typeof deviceId === "function" ? await deviceId() : deviceId;
        if (!base || !token || !device) return null;
        return await recoverDpopRegistration({
          stateDir,
          controlBaseUrl: base,
          accessToken: token,
          deviceId: device,
          fetchFn,
          accountScope,
        });
      } catch {
        return null;
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
