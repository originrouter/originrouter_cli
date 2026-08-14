import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheCollaborationCapabilities,
  getCachedCollaborationCapabilities,
} from "../src/collaboration/collaborationCapabilityCache.js";
import { interactiveCreatePayload } from "../src/commands/collaboration.js";

class ScriptedPrompt {
  constructor(answers) {
    this.answers = [...answers];
  }

  async question(text) {
    if (!this.answers.length) throw new Error(`No scripted answer for: ${text}`);
    return this.answers.shift();
  }
}

function capabilitySnapshot(deviceId, name) {
  return {
    schema_version: 1,
    captured_at: "2026-08-06T10:00:00.000Z",
    freshness: { stale: false, source: "e2ee" },
    device: {
      device_id: deviceId,
      name,
      cli_version: "0.1.0",
      default_workspace_path: "/srv/work",
    },
    runtimes: [{
      id: "codex",
      available: true,
      executable: "/private/path/that-must-not-be-cached",
      route_slots: ["main"],
    }],
    providers: [],
    resolved_routes: { codex: { main: null } },
    trusted_workspaces: [{
      workspace_id: "workspace-remote",
      display_name: "Remote work",
      canonical_path: "/srv/work",
    }],
    permission_profiles: [{
      id: "guarded",
      label: "Guarded",
      description: "Safe workspace work.",
    }],
    protocol_versions: {
      collaboration_snapshot: 2,
      collaboration_event: 2,
    },
    actions: { can_pause: true },
  };
}

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-capability-cache-"));
const remoteCapabilities = capabilitySnapshot("device-remote", "Remote Mac");
cacheCollaborationCapabilities(remoteCapabilities, { stateDir });
const cached = getCachedCollaborationCapabilities("device-remote", { stateDir });
assert.equal(cached.device.name, "Remote Mac");
assert.equal(cached.freshness.stale, true);
assert.equal(cached.freshness.source, "local_cache");
assert.equal("executable" in cached.runtimes[0], false);
assert.equal(
  statSync(join(stateDir, "collaboration-capabilities.json")).mode & 0o777,
  0o600,
);

const localCapabilities = capabilitySnapshot("device-local", "This Mac");
const memoryCache = new Map([["device-remote", cached]]);
const prompt = new ScriptedPrompt([
  "Prepare a change on the remote device",
  "",
  "1",
  "",
  "",
  "2",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
]);
const payload = await interactiveCreatePayload({
  prompt,
  requestFn: async (path) => {
    assert.equal(path, "/collaboration/local/capabilities");
    return { capabilities: localCapabilities };
  },
  loadDeviceDirectoryFn: async () => [{
    deviceId: "device-remote",
    deviceName: "Remote Mac",
    online: false,
    trustStatus: "trusted",
  }],
  cacheCapabilitiesFn: (value) => {
    memoryCache.set(value.device.device_id, value);
    return value;
  },
  getCachedCapabilitiesFn: (deviceId) => memoryCache.get(deviceId) || null,
  saveDraftFn: (draft) => ({
    draft_id: draft.draft_id || "draft-offline-device",
    created_at: draft.created_at || new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...draft,
  }),
  deleteDraftFn: () => true,
});
assert.equal(payload.participants[0].device_id, "device-remote");
assert.equal(payload.participants[0].workspace_id, "workspace-remote");

console.log("collaboration capability cache tests passed");
