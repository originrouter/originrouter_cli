// The device default is the initial value of the alias map.
//
// A session starts on the device's default model, and the reader moves it from
// there. That only works if the default lives somewhere the map reads: the
// route table — which is also the one place the App can show it and change
// it.
//
// What this file holds down:
//
//   1. The device has a default even when nobody chose one: Claude's primary
//      and Haiku models, and Codex's primary.
//   2. The map answers each alias with the device's default for that slot.
//   3. A session's own choice replaces that answer, and leaves the device's
//      other sessions alone.
//   4. A device whose config predates the route table is given the default on
//      its own — the upgrade carries it over, because the map has nothing to
//      read without it.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDefaultCloudRoutes,
  carryOverDefaultRoutes,
} from "../src/commands/agentRouteSetup.js";
import {
  DEFAULT_CLOUD_ROUTE_MODELS,
  defaultModelForSlot,
  defaultRouteSlots,
} from "../src/config/deviceDefaults.js";
import { createAgentModelResolver } from "../src/runtime/agentModelRewrite.js";
import { setSessionModel } from "../src/proxy/sessionModels.js";
import { activeAccountStateDir } from "../src/persistence/accounts.js";

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-device-default-"));

function writeConfig(config) {
  const dir = activeAccountStateDir(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

// --- the profile -------------------------------------------------------

assert.deepEqual(defaultRouteSlots("claude"), {
  main: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
});
assert.deepEqual(defaultRouteSlots("codex"), { main: "gpt-5.6-sol" });

// A family the profile does not pin inherits the primary model, so its
// default is the primary default.
assert.equal(defaultModelForSlot("claude", "main"), "claude-sonnet-5");
assert.equal(defaultModelForSlot("claude", "haiku"), "claude-haiku-4-5");
assert.equal(defaultModelForSlot("claude", "opus"), "claude-sonnet-5");
assert.equal(defaultModelForSlot("claude", "sonnet"), "claude-sonnet-5");
assert.equal(defaultModelForSlot("claude", "fable"), "claude-sonnet-5");
assert.equal(defaultModelForSlot("codex", "main"), "gpt-5.6-sol");
assert.equal(defaultModelForSlot("codex", "haiku"), null);

// The bundled values are the ones the device default is made of.
assert.equal(DEFAULT_CLOUD_ROUTE_MODELS.claudeMain, "claude-sonnet-5");
assert.equal(DEFAULT_CLOUD_ROUTE_MODELS.claudeHaiku, "claude-haiku-4-5");
assert.equal(DEFAULT_CLOUD_ROUTE_MODELS.codexMain, "gpt-5.6-sol");

// --- the default reaches the device ------------------------------------

const seeded = applyDefaultCloudRoutes().config;
assert.equal(seeded.routes.claude.main.model, "claude-sonnet-5");
assert.equal(seeded.routes.claude.haiku.model, "claude-haiku-4-5");
assert.equal(seeded.routes.codex.main.model, "gpt-5.6-sol");

// --- the map's initial value is the device default ---------------------

writeConfig(seeded);
const resolve = createAgentModelResolver({
  agent: "claude",
  agents: ["claude", "codex"],
  stateDir,
});
assert.equal(resolve("originrouter-claude-model"), "claude-sonnet-5");
assert.equal(resolve("originrouter-claude-haiku"), "claude-haiku-4-5");
assert.equal(resolve("originrouter-claude-opus"), "claude-sonnet-5");
assert.equal(resolve("originrouter-codex-model"), "gpt-5.6-sol");

// --- and a session's own choice replaces it ----------------------------

setSessionModel(stateDir, "sess-a", {
  agent: "claude",
  provider: "originrouter-cloud",
  model: "claude-opus-5",
});
const forA = createAgentModelResolver({
  agent: "claude",
  stateDir,
  sessionId: "sess-a",
});
assert.equal(forA("originrouter-claude-model"), "claude-opus-5");
// The device's other sessions are untouched: the change is the session's.
assert.equal(resolve("originrouter-claude-model"), "claude-sonnet-5");

// --- a device with no route is given the default -----------------------

const carried = carryOverDefaultRoutes({ providers: {} }, { hasCredential: true });
assert.equal(carried.changed, true);
assert.equal(carried.config.routes.claude.main.model, "claude-sonnet-5");
assert.equal(carried.config.routes.claude.haiku.model, "claude-haiku-4-5");
assert.equal(carried.config.routes.codex.main.model, "gpt-5.6-sol");

// The map now has an initial value on a device that had none.
writeConfig(carried.config);
const afterCarry = createAgentModelResolver({
  agent: "claude",
  agents: ["claude", "codex"],
  stateDir,
});
assert.equal(afterCarry("originrouter-claude-model"), "claude-sonnet-5");
assert.equal(afterCarry("originrouter-codex-model"), "gpt-5.6-sol");

rmSync(stateDir, { recursive: true, force: true });
