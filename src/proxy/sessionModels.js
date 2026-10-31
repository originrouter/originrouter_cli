// Per-session model overrides.
//
// The device-level route (config.routes) stays the default: when a session has
// no override, the agent asks the proxy for its alias and the proxy resolves it
// through the rendered route YAML. A session override does not touch routes, the
// proxy process, or the agent's own model string — it only tells the
// compatibility gateway which concrete upstream model to substitute when it sees
// that session's credential on a request.
//
// Why the credential and not a header: Claude Code and Codex already send a
// credential on every request, and the CLI already pins that credential through
// the same settings layer that pins the base URL (CLAUDE_TRANSPORT_ENV_KEYS in
// config/claudeConfig.js). Encoding the session id there costs one env value and
// works for both agents and for the native PTY runtime, with no SDK involvement
// and no per-request state in the agent process.
//
// The file is deliberately separate from config.json: it changes while agents
// run, and the route file is read by many long-lived components.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { activeAccountStateDir } from "../persistence/accounts.js";
import { enabledProviderModelEntries } from "../config/providerModels.js";
import { routeProviderForRead } from "../config/routes.js";

export const SESSION_MODELS_SCHEMA = "originrouter-session-models-v1";

// Prefix on the per-session credential. `sk-` keeps Claude Code happy (it
// refuses a credential without it), and the remainder is the lookup key the
// gateway uses. LiteLLM accepts any key here because route mode configures no
// master key — the constant `sk-noop-litellm-passthrough` relies on the same.
const CREDENTIAL_PREFIX = "sk-orlocal-";
const CREDENTIAL_RE = /^sk-orlocal-([A-Za-z0-9_-]{1,64})$/;

// Overrides are pruned oldest-first past this count. Each entry is ~120 bytes;
// the cap exists so the gateway's stat+parse stays flat on a long-lived device,
// not because the data is precious.
const MAX_SESSIONS = 2000;

// The transports with a model-rewrite point — a local gateway in front of the
// agent that substitutes the model on the way out:
//
//   routes              the compatibility gateway in front of LiteLLM
//   originrouter-coding the per-session auth proxy in front of the cloud
//   remote-coding       the relay proxy in front of the remote device
//
// All three work the same way: the agent holds a route alias, and the gateway
// turns that alias into the concrete model this session runs on. The agent
// asks for a name that never changes; what it resolves to can change between
// two turns.
//
// A transport without one of those gateways (the agent talks to Anthropic
// directly) hands the request to an upstream that owns the model string, so
// there is nowhere for an override to take effect.
//
// This is a property of the transport, not of direct-vs-bridge — a
// bridge-connected session on route mode may change its own conversation's
// model, which is exactly what a session-scoped choice means.
const MODEL_REWRITE_SOURCES = Object.freeze([
  "routes",
  "originrouter-coding",
  "remote-coding",
]);

/**
 * Whether this session's model may be changed on this transport.
 *
 * "unsupported" is not an error: the session still reports what it runs on, but
 * the App must not offer a picker whose change the CLI would accept and then
 * never apply.
 */
export function modelControlForTransport(source) {
  return MODEL_REWRITE_SOURCES.includes(String(source || ""))
    ? "supported"
    : "unsupported";
}

/**
 * The providers this transport reaches directly, by name.
 *
 * A direct upstream — the OriginRouter cloud, a remote device — serves its
 * own catalogue of model ids, and this device cannot enumerate it: the cloud
 * provider record carries no model list at all, and a remote device's list is
 * a snapshot of what that device offered the last time it was asked. So the
 * upstream is the authority on which ids it accepts, and the device must not
 * refuse an id it has no way to check.
 *
 * Route mode has none of these: every provider it can use is a LiteLLM
 * profile on this device, and those are checked against the local table.
 */
export function directProvidersForTransport(providerResult) {
  const source = String(providerResult?.source || "");
  if (source === "routes" || source === "inherited") return [];
  const name = providerResult?.routes?.main?.provider;
  return name ? [String(name)] : [];
}

export function credentialForSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return `${CREDENTIAL_PREFIX}${id}`;
}

export function sessionIdFromCredential(value) {
  const match = CREDENTIAL_RE.exec(String(value || "").trim());
  return match ? match[1] : null;
}

// Both agents put the credential somewhere different on the wire: Claude sends
// `x-api-key`, the OpenAI-compatible side sends `Authorization: Bearer`.
export function sessionIdFromHeaders(headers = {}) {
  const apiKey = headers["x-api-key"];
  const fromApiKey = sessionIdFromCredential(
    Array.isArray(apiKey) ? apiKey[0] : apiKey,
  );
  if (fromApiKey) return fromApiKey;
  const authorization = headers.authorization;
  const raw = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = /^Bearer\s+(\S+)$/i.exec(String(raw || ""));
  return match ? sessionIdFromCredential(match[1]) : null;
}

export function sessionModelsPath(stateDir) {
  return join(activeAccountStateDir(stateDir), "session-models.json");
}

function emptyDocument() {
  return { schema: SESSION_MODELS_SCHEMA, updated_at: null, sessions: {} };
}

// Malformed or missing files degrade to "no overrides", never to an error: a
// corrupt override file must not stop an agent from running on its device
// route.
export function readSessionModels(stateDir) {
  const path = sessionModelsPath(stateDir);
  try {
    if (!existsSync(path)) return emptyDocument();
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const sessions = parsed && typeof parsed.sessions === "object" && parsed.sessions
      ? parsed.sessions
      : {};
    const clean = {};
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (!entry || typeof entry !== "object") continue;
      const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
      const model = typeof entry.model === "string" ? entry.model.trim() : "";
      if (!provider || !model) continue;
      clean[sessionId] = {
        agent: typeof entry.agent === "string" ? entry.agent : "",
        provider,
        model,
        updated_at: typeof entry.updated_at === "string" ? entry.updated_at : null,
      };
    }
    return {
      schema: SESSION_MODELS_SCHEMA,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : null,
      sessions: clean,
    };
  } catch {
    return emptyDocument();
  }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch {}
    }
  }
}

export function writeSessionModels(stateDir, document) {
  const sessions = document?.sessions && typeof document.sessions === "object"
    ? document.sessions
    : {};
  // Session ids are unique per run and nothing deletes them, so the table would
  // grow without bound on a long-lived device. Oldest-first pruning keeps it
  // small enough to stat and parse in the gateway's hot path.
  const entries = Object.entries(sessions);
  if (entries.length > MAX_SESSIONS) {
    entries
      .sort((left, right) => String(left[1]?.updated_at || "")
        .localeCompare(String(right[1]?.updated_at || "")));
    for (const [sessionId] of entries.slice(0, entries.length - MAX_SESSIONS)) {
      delete sessions[sessionId];
    }
  }
  const next = {
    schema: SESSION_MODELS_SCHEMA,
    updated_at: new Date().toISOString(),
    sessions,
  };
  atomicWrite(sessionModelsPath(stateDir), next);
  return next;
}

export function getSessionModel(stateDir, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  return readSessionModels(stateDir).sessions[id] || null;
}

/**
 * The provider record as the proxy sees it, or null when the provider is not
 * one the local proxy fronts.
 *
 * A legacy `type: "anthropic"` record is projected into the proxy shape, so
 * it is renderable; what it does not have is a model list, and that is what
 * stops a session from pointing at it.
 */
function litellmProviderRecord(config, providerName) {
  const record = config?.providers?.[providerName];
  if (!record) return null;
  const projected = routeProviderForRead(record) || record;
  const renderable = projected.type === "litellm"
    || (projected.type === "proxy" && projected.engine === "litellm");
  return renderable ? projected : null;
}

/**
 * Why a target is rejected. The caller turns this into a 400 / a launch warning
 * rather than silently running on the device default — a user who picked a
 * model and got a different one needs to know.
 *
 * `allowedProviders` names the providers this session's transport reaches
 * directly. Those serve their own catalogue, which the device cannot
 * enumerate, so the upstream is the authority: an id the device has never
 * heard of is accepted, and only a provider the device *does* know about but
 * that has no such model enabled is refused.
 */
export function validateSessionModelTarget(config, { provider, model, allowedProviders = [] } = {}) {
  const providerName = String(provider || "").trim();
  const modelId = String(model || "").trim();
  if (!providerName) return { ok: false, reason: "provider_required" };
  if (!modelId) return { ok: false, reason: "model_required" };
  const direct = (Array.isArray(allowedProviders) ? allowedProviders : [])
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  if (direct.includes(providerName)) {
    const record = config?.providers?.[providerName];
    if (!record) return { ok: false, reason: "provider_not_found" };
    // A provider that publishes a model list (a remote device does) is still
    // checked against it: that list is what the device offered, and an id
    // outside it is an id the device will refuse.
    const enabled = enabledProviderModelEntries(record);
    if (enabled.length && !enabled.some((entry) => entry.id === modelId)) {
      return { ok: false, reason: "model_not_enabled" };
    }
    return { ok: true, provider: providerName, model: modelId };
  }
  const projected = litellmProviderRecord(config, providerName);
  if (!projected) {
    const record = config?.providers?.[providerName];
    if (!record) return { ok: false, reason: "provider_not_found" };
    return { ok: false, reason: "provider_not_litellm" };
  }
  const enabled = enabledProviderModelEntries(projected).some((entry) => entry.id === modelId);
  if (!enabled) return { ok: false, reason: "model_not_enabled" };
  return { ok: true, provider: providerName, model: modelId };
}

export function setSessionModel(stateDir, sessionId, { agent, provider, model } = {}) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("session id is required");
  const providerName = String(provider || "").trim();
  const modelId = String(model || "").trim();
  if (!providerName || !modelId) throw new Error("provider and model are required");
  const document = readSessionModels(stateDir);
  document.sessions[id] = {
    agent: String(agent || "").trim(),
    provider: providerName,
    model: modelId,
    updated_at: new Date().toISOString(),
  };
  return writeSessionModels(stateDir, document);
}

export function clearSessionModel(stateDir, sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("session id is required");
  const document = readSessionModels(stateDir);
  if (!document.sessions[id]) return document;
  delete document.sessions[id];
  return writeSessionModels(stateDir, document);
}

/**
 * The provider record and model id a session's usage should be priced against.
 *
 * Without an override this is the device route. With one it is the override's
 * provider — a session that runs on a different provider bills against that
 * provider's price table, not the route's.
 */
export function resolvePricingTarget(config, sessionModel, fallback = {}) {
  if (!sessionModel?.provider || !sessionModel?.model) {
    return { provider: fallback.provider ?? null, model: fallback.model ?? null };
  }
  const record = config?.providers?.[sessionModel.provider];
  const projected = record ? (routeProviderForRead(record) || record) : null;
  return { provider: projected ?? null, model: sessionModel.model };
}

/**
 * Resolve a launch-time `--model` value into an override target.
 *
 * Two accepted shapes:
 *   - `<provider>/<model.id>` — the alias the proxy publishes
 *   - `<model.id>` — resolved against the device route's provider for that
 *     agent, which is what a user typing `--model deepseek-chat` means
 *
 * Returns `{ ok: true, provider, model }` or `{ ok: false, reason }`.
 *
 * `allowedProviders` are the transport's direct upstreams; see
 * `validateSessionModelTarget`.
 */
export function resolveLaunchModelTarget(config, { agent, model, provider, allowedProviders = [] } = {}) {
  const raw = String(model || "").trim();
  if (!raw) return { ok: false, reason: "model_required" };
  const providers = config?.providers || {};
  // Longest first so `open/router` beats a hypothetical provider named `open`.
  const candidates = Object.keys(providers).sort((left, right) => right.length - left.length);
  for (const name of candidates) {
    if (raw.startsWith(`${name}/`)) {
      return validateSessionModelTarget(config, {
        provider: name,
        model: raw.slice(name.length + 1),
        allowedProviders,
      });
    }
  }
  const fallbackProvider = String(provider || "").trim()
    || deviceRouteProviderFor(config, agent);
  if (!fallbackProvider) return { ok: false, reason: "provider_required" };
  return validateSessionModelTarget(config, {
    provider: fallbackProvider,
    model: raw,
    allowedProviders,
  });
}

function deviceRouteProviderFor(config, agent) {
  const entry = config?.routes?.[agent]?.main;
  return typeof entry?.provider === "string" ? entry.provider : "";
}

/**
 * Apply a launch-time `--model` as a session override.
 *
 * Returns `{ applied: true }` when the override was written, and
 * `{ applied: false, reason }` otherwise. Callers must not fall back to handing
 * the raw value to the agent: in route mode the agent holds the route alias, so
 * a concrete id handed straight through would name a model the proxy cannot
 * resolve.
 */
export function applyLaunchSessionModel(config, stateDir, sessionId, { agent, model, provider, allowedProviders = [] } = {}) {
  if (!String(model || "").trim()) return { applied: false, reason: "model_absent" };
  const target = resolveLaunchModelTarget(config, { agent, model, provider, allowedProviders });
  if (!target.ok) return { applied: false, reason: target.reason };
  setSessionModel(stateDir, sessionId, {
    agent,
    provider: target.provider,
    model: target.model,
  });
  return { applied: true, provider: target.provider, model: target.model };
}

 /**
 * Read the override table once per change instead of once per request.
 *
 * The gateway sits in front of every model call, so a stat + parse per request
 * would be paid on each turn. mtime+size is enough here: writers replace the
 * file atomically through rename(), so a torn read is not possible.
 */
export function createSessionModelReader(stateDir) {
  let cached = null;
  let stamp = "";

  return function current() {
    const path = sessionModelsPath(stateDir);
    let nextStamp = "missing";
    try {
      const info = statSync(path);
      nextStamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      // No file yet (or removed). Same branch as an empty table.
    }
    if (cached && nextStamp === stamp) return cached;
    cached = readSessionModels(stateDir).sessions;
    stamp = nextStamp;
    return cached;
  };
}

/**
 * Build the gateway-side resolver.
 *
 * It resolves a request to `{ provider, model, alias }` when the session has an
 * override, and to null otherwise. `knownAliases` is the route map's alias table:
 * the proxy publishes every enabled `<provider>/<model.id>` there, so checking
 * against it needs no config read and automatically rejects a model that was
 * disabled after the override was written.
 */
export function createSessionModelResolver({
  stateDir,
  knownAliases = () => ({}),
  logger = null,
} = {}) {
  const current = createSessionModelReader(stateDir);
  let warned = "";

  return function resolve(headers, document) {
    let sessionId;
    try {
      sessionId = sessionIdFromHeaders(headers);
    } catch {
      return null;
    }
    if (!sessionId) return null;
    const entry = current()[sessionId];
    if (!entry) return null;
    const alias = `${entry.provider}/${entry.model}`;
    if (!knownAliases()[alias]) {
      // The provider was deleted or the model disabled while the session ran.
      // Falling back to the device route is the documented behaviour; say it
      // once per session so the log does not fill up per turn.
      if (warned !== `${sessionId}:${alias}`) {
        warned = `${sessionId}:${alias}`;
        logger?.warn?.(
          `[session-models] ${sessionId} wants '${alias}', which the proxy no longer serves; using the device route`,
        );
      }
      return null;
    }
    return { sessionId, provider: entry.provider, model: entry.model, alias };
  };
}
