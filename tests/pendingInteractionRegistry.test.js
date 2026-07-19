import assert from "node:assert/strict";

import { PendingInteractionRegistry } from "../src/runtime/pendingInteractionRegistry.js";

const requested = [];
const results = [];
let now = 1_000;
const registry = new PendingInteractionRegistry({
  now: () => now,
  tombstoneTtlMs: 500,
  onRequested: async (request) => requested.push(request),
  onResult: async (result) => results.push(result),
});

const request = {
  type: "agent.interaction.requested",
  interactionId: "interaction-1",
  sessionId: "session-1",
  kind: "questions",
  payload: { questions: [{ id: "q1" }] },
};
const pending = registry.request(request);
assert.deepEqual(registry.snapshot(), [{ ...request, status: "pending" }]);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(requested, [request]);

const first = registry.resolve({
  interactionId: "interaction-1",
  responseId: "response-1",
  action: "submit",
  response: { answers: { q1: ["yes"] } },
});
assert.deepEqual(first, {
  accepted: true,
  status: "applying",
  firstDelivery: true,
});
assert.equal((await pending).responseId, "response-1");
assert.deepEqual(registry.snapshot(), [{ ...request, status: "applying" }]);

const duplicateWhileApplying = registry.resolve({
  interactionId: "interaction-1",
  responseId: "response-1",
  action: "submit",
  response: { answers: { q1: ["yes"] } },
});
assert.equal(duplicateWhileApplying.firstDelivery, false);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(results.at(-1).status, "applying");

await registry.markResult("interaction-1", "applied", {
  responseId: "response-1",
});
assert.equal(results.at(-1).status, "applied");
assert.deepEqual(registry.snapshot(), []);

const duplicateAfterApply = registry.resolve({
  interactionId: "interaction-1",
  responseId: "response-1",
  action: "submit",
  response: {},
});
assert.equal(duplicateAfterApply.status, "applied");
await new Promise((resolve) => setImmediate(resolve));
assert.equal(results.at(-1).reason, "already_resolved");

now += 501;
const missing = registry.resolve({
  interactionId: "interaction-1",
  responseId: "response-2",
  action: "cancel",
  response: {},
});
assert.equal(missing.accepted, false);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(results.at(-1).status, "not_found");

const cancelRegistry = new PendingInteractionRegistry({
  onResult: async (result) => results.push(result),
});
const canceled = cancelRegistry.request({
  ...request,
  interactionId: "interaction-2",
});
await cancelRegistry.cancelAll("session_stopped");
await assert.rejects(canceled, /session_stopped/);
assert.equal(results.at(-1).status, "canceled");

const expiringRegistry = new PendingInteractionRegistry();
const expiring = expiringRegistry.request({
  ...request,
  interactionId: "interaction-3",
});
await expiringRegistry.markResult("interaction-3", "expired", {
  reason: "native_request_timeout",
});
await assert.rejects(expiring, /native_request_timeout/);
assert.deepEqual(expiringRegistry.snapshot(), []);

const autoExpiringResults = [];
const autoExpiringRegistry = new PendingInteractionRegistry({
  onResult: async (result) => autoExpiringResults.push(result),
});
const autoExpiring = autoExpiringRegistry.request({
  ...request,
  interactionId: "interaction-4",
  expiresAt: Math.floor((Date.now() + 25) / 1000),
});
await assert.rejects(autoExpiring, /interaction_expired/);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(autoExpiringResults.at(-1).status, "expired");
assert.equal(autoExpiringResults.at(-1).reason, "auto_resolution_timeout");

console.log("pending interaction registry tests passed");
