// The coding channel's model catalogue.
//
// The agent channel has a catalogue of its own: the API serves it at
// `/coding/v1/models`, and it is the only list that says what a model can do.
// It is cut to the account's tier — a free account is shown the models its
// requests would actually run on, not the whole catalogue with a downgrade
// waiting behind every entry.
//
// The console catalogue (`/ai/model`) answers a different question — what the
// account could buy — and it is not cut by tier. The agent channel reading it
// is what made the device and the App disagree: the App listed the account's
// coding models while the device named models the account's requests would
// never run, so the model the device routed to was a lie the reader could see
// through the App's own list.
//
// This is the same list the App reads, so the device and the App look at one
// list — the list the requests are answered out of.

import { accessTokenFor, OAUTH_RESOURCES } from "./authContract.js";
import { ensureFreshAccessToken } from "./oauthTokenRefresher.js";
import { effortLevelsFromMetadata } from "./agentEffort.js";
import { DEFAULT_ORIGINROUTER_BASE_URL } from "../config/providerRoutes.js";

// The catalogue is asked for a couple of times a session at most, and a
// catalogue that cannot be reached must not hold a session up.
const REQUEST_TIMEOUT_MS = 10_000;

function trimBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/// The host the coding API is served from.
///
/// The coding API is its own host and its own service: the console
/// catalogue and the control plane are different hosts, and the override is
/// named for the channel so it cannot be confused with either of them.
export function codingBaseUrl(env = process.env) {
  return trimBaseUrl(
    env.ORIGINROUTER_CODING_BASE_URL
      || env.ORIGINROUTER_BASE_URL
      || DEFAULT_ORIGINROUTER_BASE_URL,
  );
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

/// The models the account's coding requests may name, and what each can do.
///
/// The answer is the OpenAI list shape the API serves, read through the lens
/// the CLI needs:
///
///   * `id` — the id a request carries, and the only id the catalogue
///     publishes for the coding channel;
///   * `origin` — the vendor that runs the model, as the reader reads it;
///   * `effortLevels` — the reasoning levels the model takes.
///
/// The catalogue publishes no display name for a model, so the name is the
/// id: a name the reader can recognise is the App's to draw, and inventing
/// one here would be a second answer to the same question.
export async function fetchCodingModelCatalogue({
  stateDir,
  fetchFn = globalThis.fetch,
  env = process.env,
  ensureFreshAccessTokenFn = ensureFreshAccessToken,
} = {}) {
  const token = await signedInToken({
    stateDir,
    resource: OAUTH_RESOURCES.CODING,
    ensureFreshAccessTokenFn,
  });
  const payload = await requestJson(fetchFn, `${codingBaseUrl(env)}/coding/v1/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  const seen = new Set();
  for (const entry of entries) {
    const id = nonEmptyString(entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const extra = entry?.extra_properties && typeof entry.extra_properties === "object"
      ? entry.extra_properties
      : {};
    const originKey = nonEmptyString(extra.origin) || nonEmptyString(entry?.owned_by);
    models.push({
      id,
      name: nonEmptyString(entry?.name) || id,
      origin: nonEmptyString(extra.origin_name) || originKey || "OriginRouter",
      originKey,
      effortLevels: effortLevelsFromMetadata(extra),
    });
  }
  return models;
}
