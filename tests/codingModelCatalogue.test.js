// The coding channel's model catalogue.
//
// The agent channel reads one list: the one the API serves at
// `/coding/v1/models`. It is the list the App's model picker reads and the
// only list cut to what the account may actually run, so a device that reads
// anything else names models the account's requests never run.
//
// What is pinned here:
//
//   1. The request goes to the coding channel, with the coding token — not
//      the console (`/ai/model`) and not the AI resource's token.
//   2. The entry is read through the lens the CLI needs: the id a request
//      carries, the vendor that runs it, and the levels the model takes.
//   3. A malformed answer is not a crash and not a silent empty list that
//      looks like an account with no models.

import assert from "node:assert/strict";
import test from "node:test";

import { codingBaseUrl, fetchCodingModelCatalogue } from "../src/runtime/codingModelCatalogue.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const signedIn = async () => makeOAuthCredential();

test("the base URL is the coding host and its own override wins", () => {
  assert.equal(
    codingBaseUrl({ ORIGINROUTER_CODING_BASE_URL: "https://coding.example/" }),
    "https://coding.example",
  );
  // The general override still answers when the channel one is not set: a
  // device pointed at a self-hosted API expects both channels to follow.
  assert.equal(
    codingBaseUrl({ ORIGINROUTER_BASE_URL: "https://self.example" }),
    "https://self.example",
  );
  assert.match(codingBaseUrl({}), /^https:\/\//);
});

test("the catalogue is read with the coding token", async () => {
  const calls = [];
  const models = await fetchCodingModelCatalogue({
    stateDir: "/tmp/coding-catalogue-test",
    env: { ORIGINROUTER_CODING_BASE_URL: "https://coding.example" },
    ensureFreshAccessTokenFn: signedIn,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          object: "list",
          data: [{
            id: "claude-sonnet-5",
            object: "model",
            owned_by: "claude",
            extra_properties: {
              origin: "claude",
              origin_name: "Anthropic",
              reasoning: { enabled: true, effort_levels: ["low", "medium", "high", "xhigh", "max"] },
            },
          }],
        }),
      };
    },
  });
  assert.equal(calls[0].url, "https://coding.example/coding/v1/models");
  assert.equal(calls[0].options.headers.Authorization, "Bearer or_at_coding_test");
  assert.deepEqual(models, [{
    id: "claude-sonnet-5",
    name: "claude-sonnet-5",
    origin: "Anthropic",
    originKey: "claude",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  }]);
});

test("a vendor without a display name falls back to the key, then to us", async () => {
  const models = await fetchCodingModelCatalogue({
    stateDir: "/tmp/coding-catalogue-test",
    env: { ORIGINROUTER_CODING_BASE_URL: "https://coding.example" },
    ensureFreshAccessTokenFn: signedIn,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "a", extra_properties: { origin: "deepseek" } },
          { id: "b", owned_by: "glm" },
          { id: "c" },
        ],
      }),
    }),
  });
  assert.equal(models[0].origin, "deepseek");
  assert.equal(models[1].origin, "glm");
  assert.equal(models[2].origin, "OriginRouter");
  // A model the catalogue says nothing about has no levels — which is not the
  // same as a model with none, and the caller decides what to offer.
  assert.deepEqual(models[0].effortLevels, []);
});

test("an entry without an id is skipped, and a duplicate id is served once", async () => {
  const models = await fetchCodingModelCatalogue({
    stateDir: "/tmp/coding-catalogue-test",
    env: { ORIGINROUTER_CODING_BASE_URL: "https://coding.example" },
    ensureFreshAccessTokenFn: signedIn,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "GLM-5.3-flash", extra_properties: { origin: "GLM" } },
          { id: "GLM-5.3-flash", extra_properties: { origin: "GLM" } },
          { id: "" },
          { name: "no id at all" },
        ],
      }),
    }),
  });
  assert.deepEqual(models.map((model) => model.id), ["GLM-5.3-flash"]);
});

test("a failed request is an error, not an empty catalogue", async () => {
  await assert.rejects(
    () => fetchCodingModelCatalogue({
      stateDir: "/tmp/coding-catalogue-test",
      env: { ORIGINROUTER_CODING_BASE_URL: "https://coding.example" },
      ensureFreshAccessTokenFn: signedIn,
      fetchFn: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ message: "session expired" }),
      }),
    }),
    /session expired/,
  );
});

test("no credential is a sign-in error", async () => {
  await assert.rejects(
    () => fetchCodingModelCatalogue({
      stateDir: "/tmp/coding-catalogue-test",
      env: { ORIGINROUTER_CODING_BASE_URL: "https://coding.example" },
      ensureFreshAccessTokenFn: async () => null,
      fetchFn: async () => { throw new Error("must not be called"); },
    }),
    /originrouter login/,
  );
});

test("the model list is read through the same lens as the App's picker", async () => {
  // The App groups by `origin_name`; the device has to group by the same
  // word, or the two ends show the same catalogue under different headings.
  const models = await fetchCodingModelCatalogue({
    stateDir: "/tmp/coding-catalogue-test",
    env: { ORIGINROUTER_CODING_BASE_URL: "https://coding.example" },
    ensureFreshAccessTokenFn: signedIn,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: "gpt-6-luna",
          extra_properties: {
            origin: "openai",
            origin_name: "OpenAI",
            reasoning: { enabled: true, effort_levels: ["none", "low", "medium", "high", "xhigh", "max"] },
          },
        }],
      }),
    }),
  });
  assert.equal(models[0].origin, "OpenAI");
  assert.equal(models[0].originKey, "openai");
  assert.deepEqual(models[0].effortLevels, ["none", "low", "medium", "high", "xhigh", "max"]);
});
