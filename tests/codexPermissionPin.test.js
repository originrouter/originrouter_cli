import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoCodexBypassFlag,
  codexBypassFlagIn,
  codexAutonomyPermissionPin,
  codexThreadPermissionPin,
  codexTurnPermissionPin,
  withCodexThreadPermission,
  withCodexTurnPermission,
} from "../src/runtime/codexAppServerPrimitives.js";
import { CodexAdapter } from "../src/adapters/codexAdapter.js";

// ---------- the pin itself ----------

// The thread-level shape takes Codex's `SandboxMode` string. `workspace-write`
// is the floor that keeps a session usable: routine workspace work runs inside
// the sandbox, and anything needing an escape becomes a request.
assert.deepEqual(codexThreadPermissionPin(), {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: "workspace-write",
});

// The turn-level shape takes the camelCase tagged `SandboxPolicy` union, and
// names every field even though all of them are `#[serde(default)]` upstream:
// a default that changed would silently change what the user allowed.
assert.deepEqual(codexTurnPermissionPin(), {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
});

// `approvalsReviewer` is never omitted and is never "auto_review". Codex
// escalates an omitted reviewer to its Guardian subagent on its own when the
// model requires auto-review, which would take every request away from the App.
assert.equal(codexTurnPermissionPin().approvalsReviewer, "user");
assert.equal(codexThreadPermissionPin().approvalsReviewer, "user");

// The autonomy profile does not widen the sandbox. Every profile is answered by
// our broker, and a wider sandbox removes the escalations "unrestricted" is
// supposed to auto-approve (they stop being generated, and stop being audited).
assert.deepEqual(codexAutonomyPermissionPin(), codexTurnPermissionPin());

// Fresh objects each call: the caller spreads them into request params, and a
// shared object would let one request mutate the next one's policy.
const first = codexTurnPermissionPin();
first.sandboxPolicy.writableRoots.push("/tmp/elsewhere");
first.sandboxPolicy.networkAccess = true;
assert.deepEqual(codexTurnPermissionPin().sandboxPolicy.writableRoots, []);
assert.equal(codexTurnPermissionPin().sandboxPolicy.networkAccess, false);

// ---------- the pin wins over the caller ----------

// A call site that passes its own permission values is not a way to widen the
// pin. `turn/start` and `thread/settings/update` carry these three fields for
// the whole rest of the session, so a single caller-controlled value would be a
// silent handover — the composition is what makes "every request carries the
// pin" true by construction rather than by review.
assert.deepEqual(
  withCodexTurnPermission({
    threadId: "t1",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "dangerFullAccess" },
  }),
  {
    threadId: "t1",
    ...codexTurnPermissionPin(),
  },
);
assert.deepEqual(
  withCodexThreadPermission({
    cwd: "/w",
    model: "gpt-5",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "danger-full-access",
  }),
  {
    cwd: "/w",
    model: "gpt-5",
    ...codexThreadPermissionPin(),
  },
);
// The rest of the params survive untouched — this is a pin, not a filter.
assert.equal(withCodexTurnPermission({ threadId: "t1" }).threadId, "t1");

// ---------- every permission-changing request is built through them ----------

// The unit-level shapes above prove what the pin is. This proves it is what the
// session actually sends: four requests can change a thread's permission state
// (`thread/start`, `thread/resume`, `turn/start`, `thread/settings/update`), and
// a hand-built params object at any one of them drops the guarantee for every
// turn after it. A source-level check is the only place that gap is visible
// without standing up a fake app-server, which would test the fake.
const sessionSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "runtime", "codexAppServerSession.js"),
  "utf8",
);
// No bare pin spread survived the refactor: each one would be a call site that
// re-derived the params itself.
assert.equal(
  /\.\.\.codex(Thread|Turn|Autonomy)PermissionPin\(\)/.test(sessionSource),
  false,
  "spread the pin through withCodex*Permission instead of building params by hand",
);
for (const method of ["startTurn(", "updateThreadSettings("]) {
  const calls = [...sessionSource.matchAll(new RegExp(`client\\.${method.replace("(", "\\(")}`, "g"))];
  assert.ok(calls.length > 0, `${method} should be used by the session`);
  for (const call of calls) {
    assert.ok(
      sessionSource.slice(call.index, call.index + 400).includes("withCodexTurnPermission"),
      `${method} at offset ${call.index} must be pinned through withCodexTurnPermission`,
    );
  }
}

// The thread-level requests share one pinned options object instead of building
// it inline, so the pin is asserted at the definition and the calls are asserted
// to use it — spreading it is what carries the pin.
assert.ok(
  /const threadOptions = withCodexThreadPermission\(\{/.test(sessionSource),
  "threadOptions must be built through withCodexThreadPermission",
);
for (const method of ["startThread(", "resumeThread("]) {
  const calls = [...sessionSource.matchAll(new RegExp(`client\\.${method.replace("(", "\\(")}`, "g"))];
  assert.ok(calls.length > 0, `${method} should be used by the session`);
  for (const call of calls) {
    assert.ok(
      sessionSource.slice(call.index, call.index + 400).includes("threadOptions"),
      `${method} at offset ${call.index} must send the pinned threadOptions`,
    );
  }
}

// ---------- the launch-line guard ----------

// Every documented one-flag bypass, in the spelling Codex prints.
for (const flag of [
  "--approve-for-me",
  "--not-so-yolo",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
]) {
  assert.equal(codexBypassFlagIn(["codex", flag]), flag, `${flag} should be caught`);
  assert.throws(
    () => assertNoCodexBypassFlag([flag]),
    (error) => error.code === "CODEX_PERMISSION_BYPASS_FLAG" && error.exitCode === 64,
    `${flag} should refuse to start`,
  );
}

// Value-carrying spellings cannot slip past a name-only check.
assert.equal(codexBypassFlagIn(["--yolo=1"]), "--yolo");
assert.equal(codexBypassFlagIn(["--APPROVE-FOR-ME"]), "--approve-for-me");

// Ordinary flags, and the OriginRouter ones that only look similar, pass.
for (const args of [
  [],
  ["--model", "gpt-5"],
  ["--originrouter-autonomy", "guarded"],
  ["--originrouter-auto-approve"],
  ["--dangerously-skip-permissions"], // a Claude spelling, not a Codex one
  ["--sandbox", "workspace-write"],
  ["--ask-for-approval", "on-request"],
]) {
  assert.equal(codexBypassFlagIn(args), null, `${args.join(" ")} should be allowed`);
  assert.doesNotThrow(() => assertNoCodexBypassFlag(args));
}

// The native TUI path starts Codex through buildLaunch, so the guard has to be
// there too — the app-server runtime's own check never sees these args.
assert.throws(
  () => new CodexAdapter({ args: ["--yolo"] }).buildLaunch(),
  (error) => error.code === "CODEX_PERMISSION_BYPASS_FLAG",
);
assert.throws(
  () => new CodexAdapter({ args: ["--approve-for-me"], nativeConfig: true }).buildLaunch(),
  (error) => error.code === "CODEX_PERMISSION_BYPASS_FLAG",
);
assert.ok(new CodexAdapter({ args: ["--model", "x"] }).buildLaunch().args.includes("--model"));

console.log("codex permission pin tests passed");
