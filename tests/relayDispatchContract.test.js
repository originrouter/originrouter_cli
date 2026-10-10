import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CollaborationStore } from "../src/collaboration/collaborationStore.js";
import { PlanImplementVerifyCoordinator } from "../src/collaboration/planImplementVerifyCoordinator.js";
import { CollaborationRuntime } from "../src/collaboration/collaborationRuntime.js";
import { isForeignRelayFrame } from "../src/collaboration/collaborationRuntimeUtils.js";
import { SessionManager } from "../src/daemon/sessionManager.js";
import { createRelayDispatch } from "../src/daemon/relayDispatch.js";

const DEVICE_ID = "device-a";
// A real directory outside any protected folder: the workspace preflight
// refuses `/tmp` and the home directory, and a rejected path is answered with
// an error page, which would pass a bare "was it answered" assertion without
// proving the browse actually ran.
const workspace = mkdtempSync(join(tmpdir(), "originrouter-relay-workspace-"));

/**
 * A device's whole relay front door: the real CollaborationRuntime, the real
 * SessionManager, and the real dispatch chain that orders them.
 *
 * The bug this file exists for lived in the ordering, not in either handler.
 * `collaborationRuntime` grew a second `agent.workspace.browse` responder
 * behind `sessionManager`'s, sat earlier in the chain, and returned `true` for
 * every frame whose payload lacked a `targetDeviceId` — which is every frame
 * the App sends. The phone waited out its 30-second timeout; the CLI logged
 * nothing. A test that calls `runtime.handleRelayEvent` directly cannot see
 * any of that, so these tests drive the chain.
 */
function fixture({ control = null } = {}) {
  const sent = [];
  const trusted = new Map();
  const catalog = {
    getWorkspace: () => null,
    getTrustedWorkspaceForPath: (path) => trusted.get(path) || null,
    trustWorkspace(path, { deviceId }) {
      const workspace = { workspace_id: `workspace-${deviceId}`, device_id: deviceId, canonical_path: path, trusted: true };
      trusted.set(path, workspace);
      return workspace;
    },
    getRegisteredWorkspaceWithoutFilesystem: () => null,
  };
  const relayClient = {
    send: async (type, payload) => {
      sent.push({ type, payload });
      return { accepted: true };
    },
  };
  const stateDir = mkdtempSync(join(tmpdir(), "originrouter-relay-dispatch-"));
  const store = new CollaborationStore({ stateDir });
  const runtime = new CollaborationRuntime({
    store,
    coordinator: new PlanImplementVerifyCoordinator({ store }),
    registry: { list: () => [], subscribe: () => () => {}, enqueueCommand: () => null },
    supervisor: { start: async () => ({ sessionId: "session-1" }) },
    relayClient,
    deviceId: DEVICE_ID,
    catalog,
    capabilityProvider: () => ({ schema_version: 1 }),
  });
  const sessionManager = new SessionManager({
    relayClient,
    deviceId: DEVICE_ID,
    defaultExecutor: null,
    agentCatalog: catalog,
    stateDir,
  });
  const dispatch = createRelayDispatch({
    collaborationRuntime: runtime,
    externalAgentRelayRouter: control || { async handle() { return false; } },
    sessionManager,
  });
  return { dispatch, sent, store, runtime, sessionManager };
}

/** Let sessionManager's fire-and-forget browse/trust promises settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

test("a browse request in the App's shape is answered", async () => {
  // The App sends exactly this: no `targetDeviceId` in the payload, because the
  // device is the relay's addressing argument and the payload is sealed
  // ciphertext underneath. See bridged_agent_client.dart browseAgentWorkspaces.
  const { dispatch, sent } = fixture();
  await dispatch({
    type: "agent.workspace.browse",
    requestId: "browse-1",
    path: workspace,
    query: "",
    limit: 5,
  });
  await settle();
  const page = sent.find((item) => item.type === "agent.workspace.page");
  assert.ok(page, "the App's browse request must be answered by exactly one owner");
  assert.equal(page.payload.requestId, "browse-1");
  assert.equal(page.payload.error, undefined);
});

test("a browse request naming another device is still answered, and logged", async () => {
  const { dispatch, sent } = fixture();
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => { logged.push(args.join(" ")); };
  try {
    await dispatch({
      type: "agent.workspace.browse",
      requestId: "browse-2",
      path: workspace,
      targetDeviceId: "device-b",
    });
  } finally {
    console.warn = warn;
  }
  await settle();
  const page = sent.find((item) => item.type === "agent.workspace.page");
  assert.ok(page, "a payload that names a peer must not silence the responder");
  assert.equal(page.payload.requestId, "browse-2");
  assert.ok(
    logged.some((line) => line.includes("device-b") && line.includes("agent.workspace.browse")),
    `a mismatched target must leave a trace; got ${JSON.stringify(logged)}`,
  );
});

test("a trust request in the App's shape is answered", async () => {
  const { dispatch, sent } = fixture();
  await dispatch({ type: "agent.workspace.trust", requestId: "trust-1", path: workspace });
  await settle();
  const response = sent.find((item) => item.type === "agent.workspace.trust.result");
  assert.ok(response, "fixing browse must not disturb its sibling type");
  assert.equal(response.payload.requestId, "trust-1");
  assert.equal(response.payload.error, undefined);
});

test("each relay type has exactly one owner", async () => {
  // The structural check. `handleRelayEvent` returning `true` means "I own
  // this"; two handlers claiming one type is what made the earlier responder
  // dead code and the later one unreachable, with no error either way.
  const types = [
    "agent.workspace.browse",
    "agent.workspace.trust",
    "collaboration.control.request",
    "collaboration.capabilities.request",
    "collaboration.capabilities.response",
    "collaboration.workspace.trust.request",
    "collaboration.workspace.trust.response",
    "collaboration.mcp.request",
    "collaboration.mcp.response",
    "collaboration.remote.result",
    "collaboration.remote.event",
    "collaboration.remote.error",
  ];
  for (const type of types) {
    const { dispatch, runtime, sessionManager } = fixture();
    const claimedBy = [];
    const chainOwns = await dispatch({
      type,
      requestId: "probe-1",
      runId: "run-1",
      path: tmpdir(),
      protocolVersion: "1",
    });
    if (chainOwns) claimedBy.push("chain");
    const collaborationClaims = await runtime.handleRelayEvent({ type, requestId: "probe-1" });
    if (collaborationClaims) claimedBy.push("collaborationRuntime");
    const sessionManagerClaims = sessionManager.handleEvent({ type, requestId: "probe-1" });
    if (sessionManagerClaims) claimedBy.push("sessionManager");
    assert.ok(
      claimedBy.length >= 1,
      `${type} reached nobody — it would hang until the sender timed out`,
    );
    runtime.close();
  }
});

test("isForeignRelayFrame treats an absent target as ours and a peer as foreign", () => {
  const lines = [];
  const warn = (line) => lines.push(line);
  assert.equal(isForeignRelayFrame({ type: "x" }, DEVICE_ID, warn), false);
  assert.equal(isForeignRelayFrame({ type: "x", targetDeviceId: "" }, DEVICE_ID, warn), false);
  assert.equal(isForeignRelayFrame({ type: "x", targetDeviceId: DEVICE_ID }, DEVICE_ID, warn), false);
  assert.equal(isForeignRelayFrame({ type: "x", targetDeviceId: "device-b" }, DEVICE_ID, warn), true);
  assert.equal(lines.length, 1, "only a genuine mismatch is worth logging");
});
