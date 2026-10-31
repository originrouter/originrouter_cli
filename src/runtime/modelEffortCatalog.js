// The reasoning levels a model supports.
//
// Two sources, resolved in the order the rest of the CLI resolves things.
//
//   1. The catalogue. Ours: a model entry in the cloud's coding catalogue
//      carries `metadata.reasoning.effort_levels`, and the catalogue is
//      where we say what a model can do. It wins.
//   2. What we know ourselves. The table below is what Codex's own model
//      catalogue says about the models it knows, kept here so a device that
//      cannot reach the cloud still answers with the model's own levels
//      rather than with the runtime's whole vocabulary.
//
// A model neither source knows is a model whose levels we do not know. That
// is not the same as a model with no levels: the caller says what to offer
// when the answer is empty, and the answer is empty only when we truly have
// nothing to say.

import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";
import { effortLevelsForModel, effortLevelsFromMetadata } from "./agentEffort.js";
import { DEFAULT_ORIGINROUTER_AI_SERVER_BASE_URL } from "../config/providerRoutes.js";

// The catalogue is asked for once, at session start, and the session waits
// for it. A cloud that cannot be reached must not hold the session up for
// long: the levels we know ourselves are enough to answer with.
const REQUEST_TIMEOUT_MS = 5_000;

// The levels Codex's own catalogue gives the models it ships with.
//
// The list is a copy, and a copy goes stale: a model Codex learns about
// later is a model this table has never heard of. The catalogue is where a
// new model is declared, and the table is the floor under it.
//
// `ultra` is the level above `max`. Codex does not send it to the model —
// it sends the model's multi-agent level and keeps the delegation behaviour
// for itself — so a model that has it is a model whose multi-agent level we
// also know.
const CODEX_MODEL_EFFORT_LEVELS = Object.freeze({
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6.1-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-daybreak-blue-latest": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-daybreak-red-latest": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "codex-auto-review": ["low", "medium", "high", "xhigh", "max"],
});

// The level a model runs on when nobody has chosen one.
//
// Codex's own catalogue states a default per model, and it is not the same
// for all of them: the frontier models open at `low`, the others at
// `medium`. A session nobody has put on a level runs on this one, so the
// device says it rather than staying quiet.
const CODEX_MODEL_DEFAULT_EFFORT = Object.freeze({
  "gpt-6-astra": "low",
  "gpt-6.1-sol": "low",
  "gpt-6.1-terra": "low",
  "gpt-6-sol": "medium",
  "gpt-6-luna": "medium",
  "gpt-5.6-sol": "low",
  "gpt-5.6-terra": "medium",
  "gpt-5.6-luna": "medium",
  "gpt-daybreak-blue-latest": "low",
  "gpt-daybreak-red-latest": "medium",
  "gpt-5.5": "medium",
  "gpt-5.4": "medium",
  "gpt-5.4-mini": "medium",
  "gpt-5.3-codex": "medium",
  "codex-auto-review": "medium",
});

// The level Codex sends to the model when the reader picks `ultra`.
//
// `ultra` is not a level the model takes; it is Codex's own way of asking
// for the deepest reasoning *and* the delegation that goes with it. The
// model still sees an ordinary level, and this is the one it sees.
//
// Most models have no multi-agent level of their own; Codex falls back to
// the deepest level the model has. Only the models that say otherwise are
// listed here.
const CODEX_MODEL_MULTI_AGENT_EFFORT = Object.freeze({
  "gpt-6-astra": "xhigh",
  "gpt-6.1-sol": "xhigh",
  "gpt-6.1-terra": "xhigh",
});

// The levels we know about a model, with nothing fetched.
export function knownEffortLevels(modelId) {
  const id = String(modelId || "").trim();
  const levels = CODEX_MODEL_EFFORT_LEVELS[id];
  return levels ? [...levels] : [];
}

// The level a model runs on before anyone chooses one.
export function knownDefaultEffort(modelId) {
  const id = String(modelId || "").trim();
  return CODEX_MODEL_DEFAULT_EFFORT[id] || null;
}

// The level a model actually sees when the reader picks `ultra`.
export function knownMultiAgentEffort(modelId) {
  const id = String(modelId || "").trim();
  return CODEX_MODEL_MULTI_AGENT_EFFORT[id] || null;
}

// The model ids we know the levels of.
export function knownEffortModelIds() {
  return Object.keys(CODEX_MODEL_EFFORT_LEVELS);
}

function trimBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function signedInToken({
  stateDir,
  resource,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
}) {
  const credential = await ensureFreshAccessTokenFn({ stateDir, resource });
  const token = accessTokenFor(credential, resource)?.token;
  if (!token) {
    throw new Error("OriginRouter Cloud and remote routes require `originrouter login`.");
  }
  return token;
}

async function requestJson(fetchFn, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchFn(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The status below is the useful, non-sensitive diagnostic.
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error || `request failed (${response.status})`;
    throw new Error(String(message));
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("OriginRouter returned an invalid JSON response.");
  }
  return payload;
}

// The cloud's coding catalogue, as a list of models with their levels.
//
// The catalogue is asked for the same `/ai/model` list the App's model picker
// reads, so the device and the App are looking at one list. A failure here
// is not fatal: the levels we know ourselves are enough to answer.
export async function fetchCloudEffortCatalogue({
  stateDir,
  fetchFn = globalThis.fetch,
  env = process.env,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
} = {}) {
  const token = await signedInToken({
    stateDir,
    resource: OAUTH_RESOURCES.AI,
    ensureFreshAccessTokenFn,
  });
  const baseUrl = trimBaseUrl(
    env.ORIGINROUTER_AI_SERVER_BASE_URL || DEFAULT_ORIGINROUTER_AI_SERVER_BASE_URL,
  );
  const payload = await requestJson(fetchFn, `${baseUrl}/ai/model`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ v: "coding" }),
  });
  if (payload.code !== 1) {
    throw new Error("OriginRouter Cloud model catalogue request was rejected.");
  }
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const groups = data?.model_list;
  if (!Array.isArray(groups)) return [];
  const models = [];
  const seen = new Set();
  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.models)) continue;
    for (const entry of group.models) {
      const id = nonEmptyString(entry?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        name: nonEmptyString(entry?.name) || id,
        effortLevels: effortLevelsFromMetadata(entry?.metadata),
      });
    }
  }
  return models;
}

// The catalogue the device answers with: what the cloud says, and what we
// know ourselves, in that order.
//
// The cloud's answer is best effort — a device with no login, or a cloud
// that cannot be reached, still answers with the levels it knows.
export async function loadEffortCatalogue({
  stateDir,
  fetchFn = globalThis.fetch,
  env = process.env,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
} = {}) {
  let cloud = [];
  try {
    cloud = await fetchCloudEffortCatalogue({
      stateDir,
      fetchFn,
      env,
      ensureFreshAccessTokenFn,
    });
  } catch {
    cloud = [];
  }
  const models = new Map();
  for (const id of knownEffortModelIds()) {
    models.set(id, { id, effortLevels: knownEffortLevels(id) });
  }
  for (const model of cloud) {
    if (!model?.id) continue;
    // The catalogue speaks for itself: a model it lists without levels is a
    // model it says nothing about, and what we knew about it still stands.
    models.set(model.id, {
      id: model.id,
      name: model.name || model.id,
      effortLevels: model.effortLevels?.length
        ? [...model.effortLevels]
        : knownEffortLevels(model.id),
    });
  }
  return [...models.values()];
}

// The catalogue the proxy answers a model list from.
//
// Codex keeps no list of its own: the levels a model has are the ones the
// provider's model list says, and this proxy is the provider. So the levels
// the device publishes to the App and the levels Codex reads are the same
// levels, read out of the same catalogue — otherwise the App would offer a
// level Codex silently drops.
//
// The alias belongs in the list too. The session asks for the alias, and a
// model that is not in the list is a model Codex knows nothing about: no
// levels, no `ultra` to resolve, and a level clamped away. The alias carries
// the levels of the concrete model behind it, which is the model the reader
// picked or the device routed to.
export function buildEffortCatalogue({ models = [], aliasModels = [] } = {}) {
  const list = Array.isArray(models) ? models : [];
  const entries = new Map();
  for (const model of list) {
    const id = String(model?.id || "").trim();
    if (!id || entries.has(id)) continue;
    entries.set(id, {
      levels: effortLevelsForModel(id, list),
      default: knownDefaultEffort(id),
      multiAgent: knownMultiAgentEffort(id),
    });
  }
  return {
    models: list,
    aliasModels: Array.isArray(aliasModels) ? aliasModels : [],
    // What a model can do, or null when we know nothing about it.
    levelsFor(modelId) {
      const id = String(modelId || "").trim();
      if (!id) return null;
      return entries.get(id) || null;
    },
  };
}
