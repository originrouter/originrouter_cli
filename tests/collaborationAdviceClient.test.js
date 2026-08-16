import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collaborationCapabilitySummary,
  requestCollaborationAdvice,
} from "../src/collaboration/collaborationAdviceClient.js";
import { writeCodingAuth } from "../src/persistence/codingAuth.js";
import { makeOAuthCredential } from "./support/oauthCredential.js";

const devices = [{
  deviceId: "local",
  local: true,
  online: true,
  trustStatus: "trusted",
  capabilities: {
    runtimes: [
      { id: "codex", available: true },
      { id: "claude", available: false },
      { id: "unknown", available: true },
    ],
    trusted_workspaces: [{ workspace_id: "workspace-local" }],
    resolved_routes: { codex: { main: { provider: "cloud", model: "model-a" } } },
  },
}, {
  deviceId: "remote",
  local: false,
  online: false,
  trustStatus: "trusted",
  cachedCapabilities: {
    runtimes: [{ id: "claude", available: true }],
    trusted_workspaces: [{ workspace_id: "workspace-remote" }],
    resolved_routes: { claude: { main: { provider: "cloud", model: "model-b" }, small: null } },
  },
}, {
  deviceId: "untrusted",
  local: false,
  online: true,
  trustStatus: "untrusted",
  capabilities: {
    runtimes: [{ id: "codex", available: true }],
    trusted_workspaces: [{ workspace_id: "must-not-affect-remote-count" }],
  },
}];

test("capability summary exposes counts and runtime IDs without device details", () => {
  const summary = collaborationCapabilitySummary(devices);
  assert.deepEqual(summary, {
    local_runtimes: ["codex"],
    trusted_remote_count: 1,
    online_remote_count: 0,
    remote_runtimes: ["claude"],
    trusted_workspace_count: 2,
    configured_route_count: 2,
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("workspace-local"), false);
  assert.equal(serialized.includes("deviceId"), false);
  assert.equal(serialized.includes("provider"), false);
  assert.equal(serialized.includes("model-a"), false);
});

test("advice request uses the AI audience and mandatory advisory policy", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-advice-"));
  try {
    writeCodingAuth(stateDir, makeOAuthCredential());
    let captured;
    const advice = await requestCollaborationAdvice({
      objective: "Investigate the production service status",
      requestedMode: "auto",
      coordinator: "codex",
      devices,
    }, {
      stateDir,
      endpoint: "https://example.invalid/ai/v1/collaboration/advice",
      fetchFn: async (url, init) => {
        captured = { url, init, body: JSON.parse(init.body) };
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              data: {
                advice: {
                  recommended_mode: "remote_ops",
                  risk_tier: "yellow",
                  reason: "Remote inspection requested.",
                  role_suggestions: [],
                },
              },
            };
          },
        };
      },
    });
    assert.equal(advice.recommended_mode, "remote_ops");
    assert.equal(captured.url, "https://example.invalid/ai/v1/collaboration/advice");
    assert.equal(captured.init.headers.Authorization, "Bearer or_at_ai_test");
    assert.deepEqual(captured.body.policy, {
      advisory_only: true,
      cannot_authorize_actions: true,
      local_policy_is_authoritative: true,
    });
    assert.equal("devices" in captured.body, false);
    assert.equal(JSON.stringify(captured.body).includes("workspace-local"), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("advice rejects invalid modes and risk tiers", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-advice-invalid-"));
  try {
    writeCodingAuth(stateDir, makeOAuthCredential());
    await assert.rejects(
      () => requestCollaborationAdvice({ objective: "Check", devices: [] }, {
        stateDir,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { data: { advice: { recommended_mode: "unsafe_mode", risk_tier: "green" } } };
          },
        }),
      }),
      (error) => error.code === "COLLABORATION_ADVICE_FAILED",
    );
    await assert.rejects(
      () => requestCollaborationAdvice({ objective: "Check", devices: [] }, {
        stateDir,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          async json() {
            return { data: { advice: { recommended_mode: "solo", risk_tier: "none" } } };
          },
        }),
      }),
      (error) => error.code === "COLLABORATION_ADVICE_INVALID_RESPONSE",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
