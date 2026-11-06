// The levels a reader declared for a model of their own.
//
// Three sources answer "what levels does this model take", in a fixed order:
// what the reader wrote, the coding catalogue, and the table we keep
// ourselves. This file pins the first one — it is the only one the device
// cannot recover from anywhere else, and it is read on every session that
// runs on a provider the reader configured.
//
// The declaration belongs to a *provider*, not to a model id: the same id
// can sit under two providers with two different answers, and the provider
// the session runs on is the one that answers.

import assert from "node:assert/strict";
import test from "node:test";

import { loadEffortCatalogue, readerEffortLevels } from "../src/runtime/modelEffortCatalog.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const config = {
  providers: {
    work: {
      name: "work",
      type: "proxy",
      models: [
        { id: "gpt-5.4", enabled: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
    personal: {
      name: "personal",
      type: "proxy",
      models: [
        { id: "GLM-5.3-flash", enabled: true, effortLevels: ["low", "high", "max"] },
        { id: "xhigh-only", enabled: true, effortLevels: ["xhigh"] },
        { id: "no-levels", enabled: true },
      ],
    },
  },
};

test("a declared list is the answer, in the reader's order", () => {
  assert.deepEqual(
    readerEffortLevels(config, "gpt-5.4", "work"),
    ["low", "medium", "high"],
  );
});

test("the model id is matched without regard to case", () => {
  // The server resolves an id case-insensitively, so a declaration written as
  // `GLM-5.3-flash` is a declaration about `glm-5.3-flash`.
  assert.deepEqual(
    readerEffortLevels(config, "glm-5.3-flash", "personal"),
    ["low", "high", "max"],
  );
  assert.deepEqual(
    readerEffortLevels(config, "GLM-5.3-FLASH", "personal"),
    ["low", "high", "max"],
  );
});

test("a level no runtime can take is dropped", () => {
  const declared = readerEffortLevels(
    {
      providers: {
        work: {
          name: "work",
          models: [{ id: "m", effortLevels: ["low", "turbo", "high"] }],
        },
      },
    },
    "m",
    "work",
  );
  assert.deepEqual(declared, ["low", "high"]);
});

test("no declaration is null, which is not the same as an empty one", () => {
  assert.equal(readerEffortLevels(config, "no-levels", "personal"), null);
  assert.equal(readerEffortLevels(config, "unknown-model", "personal"), null);
  assert.equal(readerEffortLevels(config, "", "personal"), null);
  assert.equal(readerEffortLevels({}, "gpt-5.4", "work"), null);
  // A declaration that is empty after dropping unusable levels says nothing
  // either: it is the reader saying "this model does not reason", and the
  // catalogue and the floor table still get their say.
  assert.equal(
    readerEffortLevels(
      { providers: { p: { name: "p", models: [{ id: "m", effortLevels: ["turbo"] }] } } },
      "m",
      "p",
    ),
    null,
  );
});

test("the provider named wins, and another provider's declaration is the fallback", () => {
  const twoProviders = {
    providers: {
      first: {
        name: "first",
        models: [{ id: "shared", effortLevels: ["low"] }],
      },
      second: {
        name: "second",
        models: [{ id: "shared", effortLevels: ["low", "high"] }],
      },
    },
  };
  assert.deepEqual(readerEffortLevels(twoProviders, "shared", "second"), ["low", "high"]);
  assert.deepEqual(readerEffortLevels(twoProviders, "shared", "first"), ["low"]);
  // No provider named: the first declaration found is better than nothing.
  assert.deepEqual(readerEffortLevels(twoProviders, "shared"), ["low"]);
  // A provider the config does not have still answers with what was declared
  // somewhere — the model is the same model.
  assert.deepEqual(readerEffortLevels(twoProviders, "shared", "gone"), ["low"]);
});

test("the reader's words beat the catalogue and the floor table", async () => {
  // One model id, three answers: the reader declared two levels, the
  // catalogue publishes four, and the floor table knows it too. The reader's
  // answer is the one the device publishes, because only they know what the
  // model they configured really takes.
  const catalogue = await loadEffortCatalogue({
    stateDir: "/tmp/effort-catalogue-test",
    env: { ORIGINROUTER_CODING_BASE_URL: "https://coding.example" },
    ensureFreshAccessTokenFn: async () => makeOAuthCredential(),
    fetchFn: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          id: "gpt-5.5",
          extra_properties: {
            reasoning: { enabled: true, effort_levels: ["low", "medium", "high", "xhigh"] },
          },
        }],
      }),
    }),
  });
  // The catalogue really was read: its own answer is the four levels.
  const fromCatalogue = catalogue.find((entry) => entry.id === "gpt-5.5");
  assert.deepEqual(fromCatalogue.effortLevels, ["low", "medium", "high", "xhigh"]);
  const declared = readerEffortLevels(
    {
      providers: {
        work: {
          name: "work",
          models: [{ id: "gpt-5.5", enabled: true, effortLevels: ["low", "high"] }],
        },
      },
    },
    "gpt-5.5",
    "work",
  );
  assert.deepEqual(declared, ["low", "high"]);
});
