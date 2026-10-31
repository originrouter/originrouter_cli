// The model an agent asks for, and the model that actually answers.
//
// An agent is started with a *route alias* — `originrouter-claude-model` and
// its four family siblings — instead of a concrete model id. The alias is a
// stable key, so a session can be pointed at a different model while it runs:
// the local gateway in front of the agent substitutes the concrete model on
// the way out, per request.
//
// The substitution point depends on the transport:
//
//   routes              the compatibility gateway in front of LiteLLM
//   originrouter-coding the per-session auth proxy in front of the cloud
//   remote-coding       the relay proxy in front of the remote device
//
// All three read the same five sources, in this order:
//
//   1. the session's own override (`session-models.json`) — what the reader
//      picked in the App while this session was running;
//   2. the device route for the alias's slot — what the frontend set;
//   3. the route provider's own model;
//   4. the model the session started on — the launch-time fallback;
//   5. the device's default model — the profile a device falls back to when
//      it has no route of its own.
//
// A transport with no gateway in front of it (the agent talks to Anthropic
// directly) gets no alias: there would be nothing to translate it, and a
// concrete id is the only thing that endpoint understands.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ROUTE_DEFS, effectiveAgentRoutes, fallbackModelsFor, getAgentRoutes } from "../config/routes.js";
import { defaultModelForSlot } from "../config/deviceDefaults.js";
import { activeAccountStateDir } from "../persistence/accounts.js";
import { createSessionModelReader } from "../proxy/sessionModels.js";

// The historical Codex alias. A proxy started by an older CLI may still ask
// for it, and it names the same slot as the canonical one.
const LEGACY_CODEX_ALIASES = Object.freeze({ codex: Object.freeze(["gpt-5.4"]) });

/**
 * The aliases one agent publishes, keyed by slot.
 *
 * @param {"claude"|"codex"} agent
 * @returns {Record<string, string>}
 */
export function agentAliasSlots(agent) {
  const def = ROUTE_DEFS[agent];
  return def ? { ...def.aliases } : {};
}

/**
 * The slot an alias names, or null when the alias is not one of ours.
 *
 * @param {"claude"|"codex"} agent
 * @param {string} alias
 * @returns {string|null}
 */
export function slotForAlias(agent, alias) {
  const value = String(alias || "").trim();
  if (!value) return null;
  const def = ROUTE_DEFS[agent];
  if (!def) return null;
  for (const [slot, name] of Object.entries(def.aliases)) {
    if (name === value) return slot;
  }
  const legacy = LEGACY_CODEX_ALIASES[agent] || [];
  if (legacy.includes(value)) return def.primarySlot;
  return null;
}

/**
 * The concrete model each slot ran on when the session started.
 *
 * The chain is the one `buildAgentProviderEnv` uses to fill the env: the
 * slot's own route model, then the provider's own model, then the primary
 * slot's model.
 *
 * @param {"claude"|"codex"} agent
 * @param {{routes?: object, provider?: object|null}} providerResult
 * @returns {Record<string, string|null>}
 */
export { fallbackModelsFor };

function configPath(stateDir) {
  return join(activeAccountStateDir(stateDir), "config.json");
}

// The device config is read on the request path, so it is cached behind the
// same mtime+size guard the session-model file uses. Writers replace the file
// atomically, so a torn read is not possible.
function createConfigReader(stateDir) {
  let cached = null;
  let stamp = "";

  return function current() {
    const path = configPath(stateDir);
    let nextStamp = "missing";
    try {
      const info = statSync(path);
      nextStamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      // No file yet (or removed). Same branch as an empty config.
    }
    if (cached && nextStamp === stamp) return cached;
    let parsed = {};
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // A config we cannot read is a config we have no route from. The
      // launch-time fallback still applies.
      parsed = {};
    }
    cached = parsed && typeof parsed === "object" ? parsed : {};
    stamp = nextStamp;
    return cached;
  };
}

/**
 * Build the function that turns an alias into the model that should be sent.
 *
 * `agents` is a list rather than a single name because one device can serve
 * both runtimes, and the alias tables are disjoint: a gateway that does not
 * know which runtime a request came from can still tell from the alias
 * itself. The relay proxy is the case that needs this — the agent does not
 * announce its runtime to us, but it does ask for one of our aliases.
 *
 * @param {object} options
 * @param {"claude"|"codex"} options.agent
 * @param {Array<"claude"|"codex">} [options.agents] the alias tables to consult
 * @param {string} options.stateDir
 * @param {string} [options.sessionId] the session whose override applies
 * @param {Record<string, string|null>} [options.fallbackModels] launch-time models
 * @param {function(): object} [options.sessionModels] the session override table
 * @returns {(alias: string) => string|null}
 */
export function createAgentModelResolver({
  agent,
  agents = null,
  stateDir,
  sessionId = "",
  fallbackModels = {},
  sessionModels = null,
} = {}) {
  const overrides = sessionModels || createSessionModelReader(stateDir);
  const config = createConfigReader(stateDir);
  const agentList = (Array.isArray(agents) && agents.length ? agents : [agent])
    .filter(Boolean);

  return function resolve(alias) {
    // Which runtime owns this alias, and which slot of its route table.
    let owner = null;
    let slot = null;
    for (const name of agentList) {
      const found = slotForAlias(name, alias);
      if (found) {
        owner = name;
        slot = found;
        break;
      }
    }
    if (!slot) return null;

    // 1. The session's own override — what the reader picked in the App.
    //    A provider that has since been deleted falls through to the route.
    //    An override written for the other runtime is not this session's.
    const entry = sessionId ? overrides()[sessionId] : null;
    if (entry?.model) {
      const entryAgent = String(entry.agent || "").trim();
      if (!entryAgent || entryAgent === owner) {
        const providerName = String(entry.provider || "").trim();
        const provider = providerName ? config().providers?.[providerName] : null;
        if (!providerName || provider) return String(entry.model);
      }
    }

    // 2. The device route for this slot — what the frontend set.
    let routes = null;
    try {
      routes = effectiveAgentRoutes(owner, getAgentRoutes(config(), owner));
    } catch {
      // An inconsistent route table is not this request's problem: the
      // launch-time model still answers it.
    }
    const routed = routes?.[slot]?.model;
    if (routed) return String(routed);

    // 3. The provider's own model — the route's provider still exists, but
    //    the route no longer names a model for this slot.
    const providerName = routes?.main?.provider;
    const provider = providerName ? config().providers?.[providerName] : null;
    if (provider?.model) return String(provider.model);

    // 4. The model the session started on.
    const fallback = fallbackModels[slot] || fallbackModels.main || null;
    if (fallback) return String(fallback);

    // 5. The device's default model — the profile a device falls back to when
    //    it has no route of its own. It is the initial value of this map: a
    //    session starts on the device default, and the reader moves it from
    //    there.
    //
    //    It is a Cloud model, so it answers only for a Cloud route. A remote
    //    device serves its own models, and naming a Cloud one there would be
    //    a lie the remote device cannot answer.
    const providerType = provider?.type || null;
    if (!providerType || providerType === "originrouter") {
      const deviceDefault = defaultModelForSlot(owner, slot);
      if (deviceDefault) return deviceDefault;
    }
    return null;
  };
}

/**
 * Substitute the concrete model into a request body.
 *
 * The body is only touched when it names one of our aliases and a concrete
 * model is known. Anything else — a body that is not JSON, a body that names
 * a model we did not put there, a body whose alias we cannot resolve — is
 * forwarded byte for byte, because a gateway that mangles a request it does
 * not understand is worse than one that does nothing.
 *
 * @param {Buffer} body
 * @param {(alias: string) => string|null} resolve
 * @returns {Buffer}
 */
export function rewriteModelInBody(body, resolve) {
  if (!body || body.length === 0) return body;
  if (typeof resolve !== "function") return body;
  let document;
  try {
    document = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return body;
  if (typeof document.model !== "string") return body;
  const concrete = resolve(document.model);
  if (!concrete || concrete === document.model) return body;
  document.model = concrete;
  return Buffer.from(JSON.stringify(document), "utf8");
}
