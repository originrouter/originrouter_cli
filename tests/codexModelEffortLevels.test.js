// The reasoning levels a model has.
//
// The runtime can take a level; the *model* can take a level. The second is
// the narrower question, and it is the one the App asks: a row the model
// cannot take is a row that fails when it is tapped.
//
// Three things are pinned here:
//
//   1. The catalogue is where a model's levels are said — the cloud's coding
//      catalogue first, the levels we know ourselves as the floor under it.
//   2. The device publishes the model's levels, not the runtime's whole
//      vocabulary.
//   3. Codex is told the same levels, because Codex keeps no list of its
//      own: the provider's model list is the list it reads, and the alias the
//      session asks for has to be in it.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_EFFORT_LEVELS,
  effortLevelsForModel,
  effortLevelsFromMetadata,
} from "../src/runtime/agentEffort.js";
import {
  buildEffortCatalogue,
  knownDefaultEffort,
  knownEffortLevels,
  knownMultiAgentEffort,
} from "../src/runtime/modelEffortCatalog.js";
import { OriginRouterCodingAuthProxy } from "../src/runtime/originrouterCodingAuthProxy.js";

// The catalogue is a list of models, and the levels belong to the model.
const catalogue = [
  { id: "gpt-5.4", effortLevels: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-6-astra", effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"] },
];

test("the levels come out of the catalogue's own metadata", () => {
  // The key the catalogue writes them under.
  assert.deepEqual(
    effortLevelsFromMetadata({
      reasoning: { enabled: true, effort_levels: ["low", "medium", "high"] },
    }),
    ["low", "medium", "high"],
  );
  // The flat shape is read too, because a catalogue entry does not have to
  // nest it.
  assert.deepEqual(
    effortLevelsFromMetadata({ effort_levels: ["medium", "high"] }),
    ["medium", "high"],
  );
  // The `{effort, description}` pair the app-server itself speaks is read as
  // the level it names.
  assert.deepEqual(
    effortLevelsFromMetadata({
      supported_reasoning_levels: [
        { effort: "low", description: "Faster" },
        { effort: "xhigh", description: "Deeper" },
      ],
    }),
    ["low", "xhigh"],
  );
  // A level no runtime can take is not a level: it would be a row that fails.
  assert.deepEqual(
    effortLevelsFromMetadata({ reasoning: { effort_levels: ["low", "turbo"] } }),
    ["low"],
  );
  // A model with nothing said about it has no levels, which is a different
  // thing from a model with no levels.
  assert.deepEqual(effortLevelsFromMetadata(null), []);
  assert.deepEqual(effortLevelsFromMetadata({}), []);
});

test("the levels belong to the model", () => {
  assert.deepEqual(
    effortLevelsForModel("gpt-5.4", catalogue),
    ["low", "medium", "high", "xhigh"],
  );
  // A model the catalogue does not name has no levels we know. That is not
  // the same as a model with none, and the caller decides what to offer.
  assert.deepEqual(effortLevelsForModel("gpt-9-imaginary", catalogue), []);
  assert.deepEqual(effortLevelsForModel("", catalogue), []);
});

test("the levels we know ourselves are the floor under the catalogue", () => {
  assert.deepEqual(knownEffortLevels("gpt-5.4"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(knownEffortLevels("gpt-5.3-codex"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(knownEffortLevels("gpt-6-astra"), [
    "low", "medium", "high", "xhigh", "max", "ultra",
  ]);
  // A model nothing knows about has no levels.
  assert.deepEqual(knownEffortLevels("gpt-9-imaginary"), []);
  // The level a model runs on before anyone chooses one is not the same for
  // all of them.
  assert.equal(knownDefaultEffort("gpt-6-astra"), "low");
  assert.equal(knownDefaultEffort("gpt-5.4"), "medium");
  assert.equal(knownDefaultEffort("gpt-9-imaginary"), null);
  // `ultra` is a client concept: it resolves to the model's multi-agent
  // level when the model has one, and to the deepest level otherwise.
  assert.equal(knownMultiAgentEffort("gpt-6-astra"), "xhigh");
  assert.equal(knownMultiAgentEffort("gpt-5.4"), null);
});

test("the proxy's catalogue answers for a model and for the alias", () => {
  const proxyCatalogue = buildEffortCatalogue({
    models: catalogue,
    aliasModels: [{
      slug: "originrouter-codex-model",
      resolveModel: () => "gpt-6-astra",
    }],
  });
  assert.deepEqual(proxyCatalogue.levelsFor("gpt-5.4").levels, [
    "low", "medium", "high", "xhigh",
  ]);
  assert.equal(proxyCatalogue.levelsFor("gpt-6-astra").default, "low");
  assert.equal(proxyCatalogue.levelsFor("gpt-6-astra").multiAgent, "xhigh");
  assert.equal(proxyCatalogue.levelsFor("gpt-9-imaginary"), null);
  assert.equal(proxyCatalogue.levelsFor(""), null);

  // The alias carries the levels of the model behind it, because the alias is
  // the model the session asks for.
  const alias = proxyCatalogue.aliasModels[0];
  assert.equal(alias.slug, "originrouter-codex-model");
  assert.deepEqual(
    proxyCatalogue.levelsFor(alias.resolveModel()).levels,
    ["low", "medium", "high", "xhigh", "max", "ultra"],
  );
});

test("every level a catalogue can publish is a level a runtime can take", () => {
  for (const model of catalogue) {
    for (const level of model.effortLevels) {
      assert.equal(AGENT_EFFORT_LEVELS.includes(level), true, level);
    }
  }
});

test("the proxy publishes a model's levels to Codex, alias included", async () => {
  const proxy = new OriginRouterCodingAuthProxy({
    stateDir: "/tmp/originrouter-test",
    ensureFreshAccessTokenFn: async () => ({
      kind: "oauth",
      clientId: "originrouter_cli",
      source: "originrouter_cli",
      deviceId: "device-test",
      sessionId: "or_ses_test",
      refreshToken: "or_rt_test",
      refreshExpiresAt: Date.now() + 60_000,
      tokenEndpoint: "https://surety.example/api/oauth/token",
      revocationEndpoint: "https://surety.example/api/oauth/revoke",
      accessTokens: {
        coding: {
          token: "or_at_models",
          expiresAt: Date.now() + 600_000,
          scopes: ["coding.invoke"],
        },
      },
    }),
    fetchFn: async () => new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "gpt-5.4", object: "model", name: "GPT-5.4" },
        { id: "gpt-6-astra", object: "model", name: "GPT-6 Astra" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    effortCatalogue: buildEffortCatalogue({
      models: catalogue,
      aliasModels: [{
        slug: "originrouter-codex-model",
        resolveModel: () => "gpt-6-astra",
      }],
    }),
  });
  await proxy.start();
  try {
    const status = proxy.status();
    const response = await fetch(
      `http://${status.host}:${status.port}/coding/v1/models?client_version=0.155.1`,
      { method: "GET", headers: { Authorization: `Bearer ${status.localToken}` } },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    const bySlug = new Map(payload.models.map((model) => [model.slug, model]));

    // The model's own levels, so Codex's picker and its clamping agree with
    // what the device publishes.
    assert.deepEqual(
      bySlug.get("gpt-5.4").supported_reasoning_levels.map((level) => level.effort),
      ["low", "medium", "high", "xhigh"],
    );
    assert.equal(bySlug.get("gpt-5.4").default_reasoning_level, "medium");
    assert.deepEqual(
      bySlug.get("gpt-6-astra").supported_reasoning_levels.map((level) => level.effort),
      ["low", "medium", "high", "xhigh", "max", "ultra"],
    );
    assert.equal(bySlug.get("gpt-6-astra").multi_agent_reasoning_effort, "xhigh");

    // The alias is in the list: the session asks for the alias, and an alias
    // Codex has never heard of is a model with no levels at all.
    const aliasModel = bySlug.get("originrouter-codex-model");
    assert.ok(aliasModel);
    assert.deepEqual(
      aliasModel.supported_reasoning_levels.map((level) => level.effort),
      ["low", "medium", "high", "xhigh", "max", "ultra"],
    );
  } finally {
    await proxy.stop();
  }
});
