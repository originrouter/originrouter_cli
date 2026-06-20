// Stage 8.0A: exhaustive decision-to-wire mapping tests.
//
// OriginRouter keeps a legacy fallback for Codex CLIs that still emit
// `execCommandApproval` / `applyPatchApproval` (the pre-v2 method
// names). happy's reference has dropped the legacy surface — see open
// question #1 in docs/agent-runtime-audit.md. The legacy branch is
// exercised here to lock in the contract while it exists.

import assert from "node:assert/strict";
import { mapDecisionToWire } from "../src/adapters/codex/decisionMapping.js";

// ---- legacy=true ----

assert.equal(mapDecisionToWire("approved", true), "approved");
assert.equal(mapDecisionToWire("approved_for_session", true), "approved_for_session");
assert.equal(mapDecisionToWire("denied", true), "denied");
assert.equal(mapDecisionToWire("abort", true), "abort");
// Reverse mapping (new wire form → legacy wire form).
assert.equal(mapDecisionToWire("accept", true), "approved");
assert.equal(mapDecisionToWire("acceptForSession", true), "approved_for_session");
assert.equal(mapDecisionToWire("cancel", true), "abort");
// Unknown → denied.
assert.equal(mapDecisionToWire("wat", true), "denied");
assert.equal(mapDecisionToWire(undefined, true), "denied");
assert.equal(mapDecisionToWire(null, true), "denied");

// ---- legacy=false (current protocol) ----

assert.equal(mapDecisionToWire("approved", false), "accept");
assert.equal(mapDecisionToWire("approved_for_session", false), "acceptForSession");
assert.equal(mapDecisionToWire("denied", false), "decline");
assert.equal(mapDecisionToWire("abort", false), "cancel");
// Wire-form passthrough (already in new wire format).
assert.equal(mapDecisionToWire("accept", false), "accept");
assert.equal(mapDecisionToWire("acceptForSession", false), "acceptForSession");
assert.equal(mapDecisionToWire("decline", false), "decline");
assert.equal(mapDecisionToWire("cancel", false), "cancel");
// Unknown → decline.
assert.equal(mapDecisionToWire("wat", false), "decline");
assert.equal(mapDecisionToWire(undefined, false), "decline");
assert.equal(mapDecisionToWire(null, false), "decline");

// ---- Default flag (legacy=false when omitted) ----

assert.equal(mapDecisionToWire("approved"), "accept", "default flag is non-legacy");
assert.equal(mapDecisionToWire("denied"), "decline", "default flag is non-legacy");

// ---- Symmetry sanity ----
// Legacy `approved` ↔ non-legacy `accept` form the same intent and must
// each map to themselves in their own legacy state.
assert.equal(mapDecisionToWire("approved", true), "approved");
assert.equal(mapDecisionToWire("accept", false), "accept");

console.log("codex decision-mapping tests ok");
