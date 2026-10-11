import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The setting itself is covered by agentInteractionTimeout.test.js. This file
// checks the thing that actually matters: that `0` survives every layer
// between the config file and the wire.
//
// A config value that reads back correctly but gets swallowed one layer down
// by a `||` default, a `Math.max(10, x || DEFAULT)`, or a `setTimeout(fn, 0)`
// is worse than no setting at all — the user believes they turned the deadline
// off and a timer still fires. So each layer is driven directly, here, rather
// than inferred from the wiring.

process.env.ORIGINROUTER_HOME = mkdtempSync(join(tmpdir(), "originrouter-timeout-layers-"));

const { agentInteractionGraceMs, agentInteractionTimeoutMsFromConfig } =
  await import("../src/config/agentInteractionTimeout.js");

function postPermission(port) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/hook/permission-request",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
    }));
  });
}

// Every awaited HTTP round trip is bounded. Without this a substituted default
// does not fail the test — it blocks on it, because a request held for the old
// five minutes simply never comes back. A test that hangs tells you nothing
// about which layer regressed; these turn it into a named failure.
async function within(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Claude: the hook server's hold ----------

const { startClaudeHookServer } = await import("../src/adapters/claude/hookServer.js");

{
  // With no deadline the server must keep holding, and answering late must
  // still work.
  let heldCallId = null;
  const server = await startClaudeHookServer({
    permissionTimeoutMs: 0,
    onPermissionRequest: (callId) => { heldCallId = callId; },
  });

  // "Still answerable" alone does not prove anything: a hold of five minutes is
  // also still answerable after 150ms, so a substituted default would sail
  // through a timing check. What separates them is whether a timer was armed at
  // all. `setTimeout` appears exactly once in hookServer.js — it is the hold —
  // so watching it names the failure instead of hiding it.
  const armedDelays = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    armedDelays.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };

  let pending;
  try {
    pending = postPermission(server.port);
    await new Promise((resolve) => realSetTimeout(resolve, 150));
    assert.ok(heldCallId, "the request should have reached onPermissionRequest");
    assert.deepEqual(
      armedDelays,
      [],
      `no deadline was configured, so no hold may be armed (armed: ${armedDelays.join(", ")})`,
    );
    assert.ok(
      server.resolvePermission({ callId: heldCallId, decision: "approved" }),
      "a held request must still be answerable — nothing timed it out",
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  const body = await within(pending, 2_000, "the held permission round trip");
  assert.match(body, /"behavior":"allow"/, "the late answer must reach Claude Code");
  server.stop();
}

// ---------- the same layer, with a real deadline ----------

{
  // The complement: a positive hold must still arm, or the setting would be a
  // one-way door into a permission that can never expire.
  let timedOutCallId = null;
  const server = await startClaudeHookServer({
    permissionTimeoutMs: 40,
    onPermissionRequest: (callId) => { timedOutCallId = callId; },
    onPermissionTimeout: (callId) => { timedOutCallId = callId; },
  });

  const body = await within(
    postPermission(server.port),
    2_000,
    "the permission that should have expired",
  );
  assert.ok(timedOutCallId, "the hold should have fired");
  assert.match(body, /timed out/i, "a positive hold must answer Claude Code with a timeout");
  server.stop();
}

// ---------- Codex: the app-server approval timer ----------

const { CodexAppServerClient } = await import("../src/adapters/codex/appServerClient.js");

{
  // 0 must survive the constructor's `?? CODEX_APPROVAL_TIMEOUT_MS`. A
  // falsy-check default would turn it into 315_000 and the user would get the
  // timer they just turned off.
  const client = new CodexAppServerClient({ approvalTimeoutMs: 0 });
  assert.equal(client.approvalTimeoutMs, 0, "0 must not be replaced by the default");

  // And the positive default still applies when nothing is passed, so the
  // escape hatch is not silently the default.
  assert.ok(new CodexAppServerClient({}).approvalTimeoutMs > 0);
}

// ---------- the hook settings file ----------

const { generateClaudeHookSettings } = await import("../src/adapters/claude/hookSettings.js");

{
  // argv[2] is what the forwarder sizes its socket from. A 0 that became a
  // default here would reintroduce the deadline at the outermost layer.
  const noDeadline = JSON.parse(readFileSync(
    generateClaudeHookSettings({ port: 43211, permissionTimeoutMs: 0 }),
    "utf8",
  ));
  const permHook = noDeadline.hooks.PermissionRequest[0].hooks[0];
  assert.equal(permHook.args.length, 3);
  assert.equal(permHook.args[2], "0", "forwarder must receive 0, not a substituted default");
  // Claude Code insists on a finite deadline, so this one stays large rather
  // than being removed — but it is Claude's ceiling, not our timer.
  assert.ok(permHook.timeout > 360, "Claude Code still needs a finite, larger deadline");

  // A configured window scales every layer together, and the inner ones stay
  // inside the outer one. If the hook deadline were the shorter of the two,
  // Claude Code would kill the hook process mid-request and the request would
  // end for a reason nobody configured.
  const holdMs = agentInteractionGraceMs(
    agentInteractionTimeoutMsFromConfig({ agent: { interactionTimeoutMs: "10m" } }),
  );
  const configured = JSON.parse(readFileSync(
    generateClaudeHookSettings({ port: 43212, permissionTimeoutMs: holdMs }),
    "utf8",
  ));
  const cfgHook = configured.hooks.PermissionRequest[0].hooks[0];
  assert.equal(Number(cfgHook.args[2]), 615_000);
  assert.ok(cfgHook.timeout * 1000 > 615_000, "the hook deadline must outlast the hold");
}

// ---------- the hook forwarder socket ----------

const { postHookBody } = await import("../scripts/claude-session-hook-forwarder-impl.cjs");

{
  // postOnce must skip setTimeout entirely for a non-positive value. Passing
  // 0 straight through would fire on the next tick and abort every permission.
  let seenTimeout = "untouched";
  const result = await postHookBody(
    JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s1" }),
    65000,
    {
      permissionRequestTimeoutMs: 0,
      requestFn: (_options, callback) => {
        const response = {
          statusCode: 200,
          on(event, handler) {
            if (event === "data") handler(Buffer.from("ok"));
            if (event === "end") handler();
            return this;
          },
        };
        return {
          setTimeout(ms) { seenTimeout = ms; return this; },
          on() { return this; },
          end() { setTimeout(() => callback(response), 30); },
          destroy() {},
        };
      },
    },
  );

  assert.equal(seenTimeout, "untouched", "a 0 timeout must not reach req.setTimeout");
  assert.equal(result.responseBody, "ok");
}

console.log("interaction timeout layer tests passed");
