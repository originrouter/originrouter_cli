// A permission prompt needs an identity.
//
// Claude Code 2.1.283 does not put a `tool_use_id` on `PermissionRequest`, so
// an adapter that keys permissions off that field has no id to mint — and the
// id it mints instead (a fresh random string) is what the adapter's pending
// map, the interaction registry, the card the App draws, and the resolve path
// are all keyed by. N deliveries of one ask therefore became N independent
// permissions: three cards for a single `Write`, each with its own expiry and
// its own denial sent back to the terminal.
//
// The fixtures below are the real payloads, captured from Claude Code 2.1.283
// by dumping the hook's stdin verbatim. They are the point of the file: the
// property under test is about what that version actually sends, and a
// hand-written approximation of it would not prove anything.

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import {
  permissionCallId,
  permissionRequestIdentity,
} from "../src/adapters/claude/hookIdentity.js";
import { startClaudeHookServer } from "../src/adapters/claude/hookServer.js";

// --- captured from `claude -p` with a dumping PermissionRequest hook ---

const PERMISSION_REQUEST = {
  cwd: "/private/tmp/or-probe2/w",
  effort: { level: "high" },
  hook_event_name: "PermissionRequest",
  permission_mode: "default",
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Write" }] }],
  prompt_id: "b806cd4d-79c8-48ee-bafc-30f64fb64959",
  session_id: "1bd7ea13-a4b9-4a8c-a918-a763e78682c2",
  tool_input: { content: "hi\n", file_path: "/private/tmp/or-probe2/w/demo.txt" },
  tool_name: "Write",
  transcript_path: "/Users/x/.claude/projects/-tmp-w/1bd7ea13.jsonl",
};

// The same ask, reported as finished. Claude Code adds `tool_use_id` here and
// nowhere else.
const POST_TOOL_USE = {
  ...PERMISSION_REQUEST,
  hook_event_name: "PostToolUse",
  duration_ms: 12,
  tool_use_id: "call_01a129a8bb887164ac106b56",
  tool_response: { success: true },
};

// A second, different ask inside the SAME prompt. This is the trap: both
// PermissionRequests carried this exact `prompt_id`.
const SECOND_ASK_SAME_PROMPT = {
  ...PERMISSION_REQUEST,
  tool_input: { content: "ho\n", file_path: "/private/tmp/or-probe2/w/b.txt" },
};

// ---------- identity ----------

test("identity survives key reordering in tool_input", () => {
  const reordered = {
    tool_name: "Write",
    tool_input: { file_path: "/x/demo.txt", content: "hi\n" },
    session_id: "s",
    prompt_id: "p",
  };
  assert.equal(
    permissionRequestIdentity(reordered),
    permissionRequestIdentity({
      session_id: "s",
      prompt_id: "p",
      tool_input: { content: "hi\n", file_path: "/x/demo.txt" },
      tool_name: "Write",
    }),
  );
});

test("prompt_id alone is not an identity — two asks in one prompt differ", () => {
  // Both real payloads shared prompt_id `0e627104-…`. Keying on it alone
  // would have merged two unrelated Writes into one permission.
  assert.equal(SECOND_ASK_SAME_PROMPT.prompt_id, PERMISSION_REQUEST.prompt_id);
  assert.notEqual(
    permissionRequestIdentity(SECOND_ASK_SAME_PROMPT),
    permissionRequestIdentity(PERMISSION_REQUEST),
  );
});

test("identity separates on every component that makes an ask distinct", () => {
  const base = permissionRequestIdentity(PERMISSION_REQUEST);
  const variants = {
    session: { ...PERMISSION_REQUEST, session_id: "other-session" },
    prompt: { ...PERMISSION_REQUEST, prompt_id: "other-prompt" },
    tool: { ...PERMISSION_REQUEST, tool_name: "Edit" },
    input: { ...PERMISSION_REQUEST, tool_input: { content: "bye\n", file_path: "/private/tmp/or-probe2/w/demo.txt" } },
  };
  for (const [label, payload] of Object.entries(variants)) {
    assert.notEqual(permissionRequestIdentity(payload), base, label);
  }
});

test("a PermissionRequest and its PostToolUse are the same ask", () => {
  // The property the terminal-decision bridge is built on: without it, a
  // decision taken in the terminal could never find the card it belongs to.
  assert.equal(
    permissionRequestIdentity(POST_TOOL_USE),
    permissionRequestIdentity(PERMISSION_REQUEST),
  );
});

test("an incomplete payload has no identity rather than a wrong one", () => {
  // Merging two asks that merely look alike is worse than showing two cards.
  assert.equal(permissionRequestIdentity({ tool_name: "Write" }), null);
  assert.equal(permissionRequestIdentity({ ...PERMISSION_REQUEST, prompt_id: "" }), null);
});

test("callId prefers Claude Code's own tool_use_id when a version sends one", () => {
  assert.equal(permissionCallId(POST_TOOL_USE), "call_01a129a8bb887164ac106b56");
  // PermissionRequest has none, so the payload identity stands in — and it is
  // deterministic, which the old random fallback was not.
  assert.equal(permissionCallId(PERMISSION_REQUEST), permissionCallId(PERMISSION_REQUEST));
  assert.match(permissionCallId(PERMISSION_REQUEST), /^claude-perm-[0-9a-f]{32}$/);
});

// ---------- hook server ----------

// The promise carries an `abort()` so a failing assertion can never strand a
// held socket: an unanswered permission is exactly the condition that makes
// the server keep waiting, so a test that dies before answering it would hang
// the whole run instead of reporting.
function post(server, payload) {
  const controller = new AbortController();
  const body = JSON.stringify(payload);
  const promise = new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/hook/permission-request",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        signal: controller.signal,
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: text }));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
  promise.abort = () => controller.abort();
  promise.catch(() => {});
  return promise;
}

async function startServer(handlers = {}) {
  const requests = [];
  const timeouts = [];
  const server = await startClaudeHookServer({
    permissionTimeoutMs: 30_000,
    onPermissionRequest: (callId, event, meta) => {
      requests.push({ callId, event, meta });
    },
    onPermissionTimeout: (callId, event, meta) => {
      timeouts.push({ callId, reason: meta?.reason });
    },
    ...handlers,
  });
  return { server, requests, timeouts };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("the same ask delivered three times is one permission", async (t) => {
  const { server, requests } = await startServer();
  t.after(() => server.stop());

  const held = [post(server, PERMISSION_REQUEST), post(server, PERMISSION_REQUEST), post(server, PERMISSION_REQUEST)];
  t.after(() => held.forEach((item) => item.abort()));
  await settle();

  assert.equal(requests.length, 1, "one ask must produce one interaction");

  assert.ok(server.resolvePermission({ callId: requests[0].callId, decision: "approved" }));
  const answers = await Promise.all(held);
  for (const answer of answers) {
    assert.equal(answer.status, 200);
    // Every copy gets the same answer, so Claude Code is never left waiting on
    // a repeat that nobody will ever resolve.
    assert.equal(JSON.parse(answer.body).hookSpecificOutput.decision.behavior, "allow");
  }
});

test("different asks are still different permissions", async (t) => {
  const { server, requests } = await startServer();
  t.after(() => server.stop());

  const held = [post(server, PERMISSION_REQUEST), post(server, SECOND_ASK_SAME_PROMPT)];
  t.after(() => held.forEach((item) => item.abort()));
  await settle();

  assert.equal(requests.length, 2, "two writes in one prompt are two permissions");
  assert.notEqual(requests[0].callId, requests[1].callId);

  server.resolvePermission({ callId: requests[0].callId, decision: "denied" });
  server.resolvePermission({ callId: requests[1].callId, decision: "approved" });
  const [first, second] = await Promise.all(held);
  assert.equal(JSON.parse(first.body).hookSpecificOutput.decision.behavior, "deny");
  assert.equal(JSON.parse(second.body).hookSpecificOutput.decision.behavior, "allow");
});

test("a repeat that arrives after the ask was answered opens a fresh one", async (t) => {
  // A tombstone here would silently swallow a legitimate re-ask for the same
  // path with the same content.
  const { server, requests } = await startServer();
  t.after(() => server.stop());

  const first = post(server, PERMISSION_REQUEST);
  t.after(() => first.abort());
  await settle();
  server.resolvePermission({ callId: requests[0].callId, decision: "denied" });
  await first;

  const second = post(server, PERMISSION_REQUEST);
  t.after(() => second.abort());
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].callId, requests[0].callId);
  server.resolvePermission({ callId: requests[1].callId, decision: "denied" });
  await second;
});

test("a client that hangs up releases the hold and tells the front end", async (t) => {
  const { server, requests, timeouts } = await startServer();
  t.after(() => server.stop());

  const held = post(server, PERMISSION_REQUEST);
  t.after(() => held.abort());
  await settle();
  assert.equal(requests.length, 1);

  held.abort();
  await settle();

  assert.equal(timeouts.length, 1, "an orphaned permission must not stay pending");
  assert.equal(timeouts[0].callId, requests[0].callId);
  assert.equal(timeouts[0].reason, "client_disconnected");

  // And the ask can be asked again rather than being stuck as resolved.
  assert.ok(!server.resolvePermission({ callId: requests[0].callId, decision: "approved" }));
});

test("one client leaving does not release a hold another is still waiting on", async (t) => {
  const { server, requests, timeouts } = await startServer();
  t.after(() => server.stop());

  const abandoned = post(server, PERMISSION_REQUEST);
  t.after(() => abandoned.abort());
  const waiting = post(server, PERMISSION_REQUEST);
  t.after(() => waiting.abort());
  await settle();

  abandoned.abort();
  await settle();
  assert.deepEqual(timeouts, [], "a duplicate is still waiting for this answer");

  assert.ok(server.resolvePermission({ callId: requests[0].callId, decision: "approved" }));
  assert.equal(JSON.parse((await waiting).body).hookSpecificOutput.decision.behavior, "allow");
});

test("an unanswered hold stays open while its client waits", async (t) => {
  // The regression guard for the disconnect handler itself: a request's
  // `close` fires the moment its body is consumed, so listening there would
  // abandon every live permission the instant it was created.
  const { server, requests, timeouts } = await startServer();
  t.after(() => server.stop());

  const held = post(server, PERMISSION_REQUEST);
  t.after(() => held.abort());
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.deepEqual(timeouts, [], "a client that is still waiting must not be treated as gone");
  assert.ok(server.resolvePermission({ callId: requests[0].callId, decision: "approved" }));
  await held;
});

test("the hold still expires on its own when nobody answers", async (t) => {
  const { server, requests, timeouts } = await startServer({
    permissionTimeoutMs: 120,
  });
  t.after(() => server.stop());

  const held = post(server, PERMISSION_REQUEST);
  t.after(() => held.abort());
  const answer = await held;

  assert.equal(requests.length, 1);
  assert.equal(timeouts[0].reason, undefined, "the default reason stays `timeout`");
  assert.equal(
    JSON.parse(answer.body).hookSpecificOutput.decision.message,
    "OriginRouter remote approval timed out. Please retry or approve locally.",
  );
});