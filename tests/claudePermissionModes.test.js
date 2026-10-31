// The Claude permission surface: what a managed session may be told to do, and
// what it is allowed to say it can do.
//
// Two lists, one policy:
//
//   - the modes `agent.mode.set` accepts,
//   - the modes `agent.mode.status` publishes as available.
//
// Both leave out "auto" and "dontAsk", for the same reason on both sides:
// neither mode produces a request that reaches the broker. "auto" is blocked
// by the session's own settings pin (`disableAutoMode`), and "dontAsk" denies
// without asking. A mode the App cannot select, but is shown, is a button
// that cannot work; a mode the App can select, but that never reaches the
// broker, is a button that silently blinds it.
//
// `bypassPermissions` stays: it is a deliberate, user-typed choice, and it is
// the one way to accept a plan that asks for exactly that.

import assert from "node:assert/strict";

import {
  CLAUDE_AVAILABLE_MODES,
  CLAUDE_REMOTE_MODE_IDS,
} from "../src/runtime/claudeSdkSession.js";
import { withClaudePermissionSafety } from "../src/adapters/claude/hookSettings.js";

// The vocabulary the SDK runtime accepts and publishes.
assert.deepEqual([...CLAUDE_REMOTE_MODE_IDS], [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);
assert.deepEqual(
  CLAUDE_AVAILABLE_MODES.map((item) => item.id),
  [...CLAUDE_REMOTE_MODE_IDS],
);

// The two modes that cannot work are not in either list.
for (const gone of ["auto", "dontAsk"]) {
  assert.equal(CLAUDE_REMOTE_MODE_IDS.includes(gone), false, `${gone} must not be accepted`);
  assert.equal(
    CLAUDE_AVAILABLE_MODES.some((item) => item.id === gone),
    false,
    `${gone} must not be published`,
  );
}

// The published list carries labels, because the App shows the mode's name.
for (const mode of CLAUDE_AVAILABLE_MODES) {
  assert.equal(typeof mode.id, "string");
  assert.ok(mode.label, `${mode.id} should have a label`);
}

// ---------- the settings pin ----------

// The safety keys are in every settings file, whatever the caller passed.
const safety = withClaudePermissionSafety({});
assert.equal(safety.disableAutoMode, "disable");
assert.equal(safety.permissions.defaultMode, "default");

// A caller cannot weaken them.
const hostile = withClaudePermissionSafety({
  disableAutoMode: "enable",
  permissions: { defaultMode: "auto" },
});
assert.equal(hostile.disableAutoMode, "disable");
assert.equal(hostile.permissions.defaultMode, "default");

// …and the merge is a merge: the user's own permission rules survive.
const withRules = withClaudePermissionSafety({
  permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm:*)"] },
});
assert.deepEqual(withRules.permissions.allow, ["Bash(npm test)"]);
assert.deepEqual(withRules.permissions.deny, ["Bash(rm:*)"]);
assert.equal(withRules.permissions.defaultMode, "default");

// The rest of the settings survive: this is a pin, not a filter.
const kept = withClaudePermissionSafety({
  env: { ANTHROPIC_MODEL: "m" },
  hooks: { SessionStart: [] },
});
assert.equal(kept.env.ANTHROPIC_MODEL, "m");
assert.deepEqual(kept.hooks.SessionStart, []);

// Nothing but the safety keys is added to a settings object that had none.
assert.deepEqual(Object.keys(withClaudePermissionSafety({})).sort(), [
  "disableAutoMode",
  "permissions",
]);

console.log("claude permission mode tests passed");
