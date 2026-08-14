import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacheCollaborationCapabilities,
  getCachedCollaborationCapabilities,
} from "../src/collaboration/collaborationCapabilityCache.js";
import {
  redactDisplayText,
  redactDisplayValue,
} from "../src/security/displayRedaction.js";

const redacted = redactDisplayValue({
  authorization: "Bearer or_at_highly-sensitive-value",
  nested: {
    api_key: "sk-v1-sensitive-provider-key",
    refresh_token: "or_rt_sensitive-refresh-token",
    password: "hunter2",
    sampled_tokens: 42,
    fencing_token: 7,
  },
});
assert.equal(redacted.authorization, "[REDACTED]");
assert.equal(redacted.nested.api_key, "[REDACTED]");
assert.equal(redacted.nested.refresh_token, "[REDACTED]");
assert.equal(redacted.nested.password, "[REDACTED]");
assert.equal(redacted.nested.sampled_tokens, 42);
assert.equal(redacted.nested.fencing_token, 7);

const keyText = redactDisplayText(`
authorization: Bearer or_at_never-print-this-value
-----BEGIN PRIVATE KEY-----
secret material
-----END PRIVATE KEY-----
`);
assert.ok(!keyText.includes("never-print-this-value"));
assert.ok(!keyText.includes("secret material"));
assert.match(keyText, /REDACTED/);

const stateDir = mkdtempSync(join(tmpdir(), "originrouter-capability-security-"));
cacheCollaborationCapabilities({
  device: { device_id: "device-security", name: "Security test" },
  runtimes: [{
    id: "codex",
    available: true,
    executable: "/private/operator/path/codex",
  }],
  providers: [{
    name: "private-provider",
    type: "proxy",
    api_key: "sk-v1-cache-must-not-contain-this",
    auth_token: "or_at_cache-must-not-contain-this",
    models: [{ id: "model-a", remote_enabled: true }],
  }],
  resolved_routes: {
    codex: {
      main: {
        provider: "private-provider",
        model: "model-a",
        auth_token: "or_at_route-cache-must-not-contain-this",
      },
    },
  },
  trusted_workspaces: [],
  permission_profiles: [],
  protocol_versions: {
    collaboration_snapshot: 2,
    collaboration_event: 2,
  },
  actions: { can_pause: true },
}, { stateDir });
const cachedText = readFileSync(
  join(stateDir, "collaboration-capabilities.json"),
  "utf8",
);
assert.ok(!cachedText.includes("cache-must-not-contain-this"));
assert.ok(!cachedText.includes("/private/operator/path/codex"));
const cached = getCachedCollaborationCapabilities("device-security", { stateDir });
assert.equal(cached.providers[0].models[0].id, "model-a");
assert.equal(cached.freshness.stale, true);

console.log("collaboration security tests passed");
