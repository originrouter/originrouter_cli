// The session's model has to be visible outside the runtime that owns it.
//
// The runtime publishes `agent.model.status`; the registry folds it into the
// session record; the control snapshot and the session projection carry it
// out. The App reads the session's own model from there.
//
// The list of models that may be chosen is a different fact with a different
// owner: it belongs to the device, goes out in the device's provider snapshot
// (`localControlProviderSnapshot`), and is NOT carried on the session. A copy
// per session would go stale the moment the device's providers changed.

import assert from "node:assert/strict";

import { localControlProviderSnapshot } from "../src/daemon/daemonPrimitives.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";

const config = {
  providers: {
    deepseek: {
      name: "deepseek",
      type: "proxy",
      engine: "litellm",
      models: [
        { id: "deepseek-chat", enabled: true },
        { id: "deepseek-reasoner", enabled: true },
        { id: "deepseek-off", enabled: false },
      ],
    },
    "openai-codex": {
      name: "openai-codex",
      type: "proxy",
      engine: "litellm",
      models: [{ id: "gpt-5-codex", enabled: true }],
    },
    remote: {
      name: "remote",
      type: "remote",
      target: "proxy",
      models: [{ id: "remote-model", enabled: true }],
    },
  },
};

// The list is the device's own, and the device states it once — in the
// provider snapshot, with each model's `enabled` flag. A reader filters on that
// flag; the device does not pre-filter, because the flag is also what the
// provider management page needs.
const snapshotProviders = localControlProviderSnapshot(config);
assert.deepEqual(
  snapshotProviders.map((provider) => provider.name),
  ["deepseek", "openai-codex", "remote"],
);
const deepseek = snapshotProviders.find((provider) => provider.name === "deepseek");
assert.deepEqual(deepseek.models, [
  { id: "deepseek-chat", enabled: true, remoteEnabled: false },
  { id: "deepseek-reasoner", enabled: true, remoteEnabled: false },
  { id: "deepseek-off", enabled: false, remoteEnabled: false },
]);
// A model the device does not front as a proxy still appears here — the
// snapshot describes the device, not the editable catalogue.
const remote = snapshotProviders.find((provider) => provider.name === "remote");
assert.equal(remote.type, "remote");

// What the event offered is only used here as an example of a catalogue; the
// assertions below are that none of it survives onto the session.
const deviceModels = [
  { id: "deepseek-chat", provider: "deepseek", providerName: "deepseek" },
  { id: "deepseek-reasoner", provider: "deepseek", providerName: "deepseek" },
  { id: "gpt-5-codex", provider: "openai-codex", providerName: "openai-codex" },
];

let now = 1_000_000;
const registry = new ExternalAgentRegistry({ now: () => now });
registry.register({
  sessionId: "claude-local-1",
  agent: "claude",
  deviceId: "device-local",
  deviceName: "MacBook",
});

// The register payload names the model the *device* is routed to. That is
// the device's fact — it belongs to the catalog, and it changes when the
// device's route changes — so it is not the session's own model. A session
// that chose nothing says so, and the record must not borrow the device's
// name for it.
registry.register({
  sessionId: "claude-local-2",
  agent: "claude",
  deviceId: "device-local",
  deviceName: "MacBook",
  model: "claude-sonnet-5",
});
const registered = registry
  .list()
  .find((item) => item.session_id === "claude-local-2");
assert.equal(registered.model, null);
assert.equal(registered.model_source, "device");

// A session with no override follows the device route, and says so.
registry.appendEvent("claude-local-1", {
  type: "agent.model.status",
  model: null,
  modelProvider: null,
  source: "device",
  modelControl: "supported",
  availableModels: deviceModels,
});
let snapshot = registry.controlSnapshot("claude-local-1");
assert.equal(snapshot.model, null);
assert.equal(snapshot.modelProvider, null);
assert.equal(snapshot.modelSource, "device");
assert.equal(snapshot.modelControl, "supported");
// The catalogue is not the session's to carry, even though the event offered
// one: nothing on the record holds it.
assert.equal("availableModels" in snapshot, false);

let projected = registry.list().find((item) => item.session_id === "claude-local-1");
assert.equal(projected.model, null);
assert.equal(projected.model_source, "device");
assert.equal("available_models" in projected, false);

// A pinned model replaces the device route, and the record says which
// provider answers.
registry.appendEvent("claude-local-1", {
  type: "agent.model.status",
  model: "deepseek-reasoner",
  modelProvider: "deepseek",
  source: "session",
  modelControl: "supported",
});
snapshot = registry.controlSnapshot("claude-local-1");
assert.equal(snapshot.model, "deepseek-reasoner");
assert.equal(snapshot.modelProvider, "deepseek");
assert.equal(snapshot.modelSource, "session");

projected = registry.list().find((item) => item.session_id === "claude-local-1");
assert.equal(projected.model, "deepseek-reasoner");
assert.equal(projected.model_provider, "deepseek");

// Clearing the override returns the session to the device route. The model
// is assigned rather than kept, so a cleared session does not keep naming
// the model it no longer uses.
registry.appendEvent("claude-local-1", {
  type: "agent.model.status",
  model: null,
  modelProvider: null,
  source: "device",
  modelControl: "supported",
});
snapshot = registry.controlSnapshot("claude-local-1");
assert.equal(snapshot.model, null);
assert.equal(snapshot.modelProvider, null);
assert.equal(snapshot.modelSource, "device");

console.log("sessionModelStatus: ok");
