import assert from "node:assert/strict";

import {
  AGENT_COMMAND_TYPE,
  COMMAND_KIND_SIDE_MESSAGE,
  COMMAND_KIND_SLASH,
  buildCommandsEvent,
  claudeSideQuestionPrompt,
  codexSideBoundaryItem,
  commandsForSession,
  normalizeCommandPayload,
} from "../src/agent/slashCommands.js";
import { handleRemoteEvent } from "../src/local/agentSessionPrimitives.js";

const names = (list) => list.map((entry) => entry.name);

// ---- Menus are per-session and gated by the session's own flags ----

{
  const claude = commandsForSession({ agent: "claude", runtime: "claude-sdk" });
  assert.ok(names(claude).includes("btw"));
  assert.ok(names(claude).includes("effort"), "effort rides our own channel on every session");
  assert.ok(!names(claude).includes("model"), "gateway sessions must not offer a CLI /model");

  const native = commandsForSession({ agent: "claude", runtime: "claude-sdk", nativeConfig: true });
  assert.ok(names(native).includes("model"), "native sessions keep the CLI's own model picker");

  const codex = commandsForSession({ agent: "codex", runtime: "codex-app-server" });
  assert.ok(names(codex).includes("side"));
  assert.equal(
    codex.find((entry) => entry.name === "side").aliases.includes("btw"),
    true,
    "codex names it /btw too",
  );

  const codexPty = commandsForSession({ agent: "codex", runtime: "codex-pty" });
  assert.ok(!names(codexPty).includes("side"), "PTY has no structured side surface");
  assert.ok(names(codexPty).includes("compact"));

  assert.deepEqual(commandsForSession({ agent: "unknown" }), []);
}

// ---- Wire normalization ----

{
  const normalized = normalizeCommandPayload({
    command: { name: "/review", args: " the diff " },
    requestId: "r1",
  });
  assert.equal(normalized.kind, COMMAND_KIND_SLASH);
  assert.equal(normalized.name, "review");
  assert.equal(normalized.args, "the diff");
  assert.equal(normalized.requestId, "r1");

  const side = normalizeCommandPayload({ command: { kind: "side_message", text: "what?" } });
  assert.equal(side.kind, COMMAND_KIND_SIDE_MESSAGE);
  assert.equal(side.text, "what?");
}

// ---- The commands event is the session's own list ----

{
  const event = buildCommandsEvent({ sessionId: "s1", provider: "claude", commands: [{ name: "btw" }] });
  assert.equal(event.type, "agent.commands");
  assert.equal(event.sessionId, "s1");
  assert.deepEqual(event.commands, [{ name: "btw" }]);
}

// ---- PTY sessions inject only commands their own menu named ----

{
  const written = [];
  const submitted = [];
  const ctx = {
    sessionId: "s1",
    adapter: {},
    executor: {
      write: (data) => written.push(data),
      submitMessage: async (message) => { submitted.push(message); },
    },
    sessionCommands: commandsForSession({ agent: "codex", runtime: "codex-pty" }),
  };
  const inject = (command) =>
    handleRemoteEvent({ type: AGENT_COMMAND_TYPE, sessionId: "s1", command }, ctx);

  assert.equal(await inject({ name: "compact" }), true);
  await Promise.resolve();
  assert.equal(submitted[0], "/compact");

  assert.equal(await inject({ name: "review", args: "the diff" }), true);
  await Promise.resolve();
  assert.equal(submitted[1], "/review the diff");

  assert.equal(await inject({ name: "frobnicate" }), false, "unknown commands are refused");

  // route:"app" entries are handled by the App itself and never injected —
  // the managed claude menu marks quit/export/rename that way.
  const appCtx = {
    ...ctx,
    sessionCommands: commandsForSession({ agent: "claude", runtime: "claude-sdk" }),
  };
  assert.equal(
    await handleRemoteEvent(
      { type: AGENT_COMMAND_TYPE, sessionId: "s1", command: { name: "quit" } },
      appCtx,
    ),
    false,
    "route:app never reaches the terminal",
  );
  assert.equal(
    await inject({ kind: COMMAND_KIND_SIDE_MESSAGE, text: "hi" }),
    false,
    "side messages are refused on PTY",
  );
  // Other session ids never reach this executor.
  assert.equal(
    await handleRemoteEvent(
      { type: AGENT_COMMAND_TYPE, sessionId: "other", command: { name: "compact" } },
      ctx,
    ),
    undefined,
  );
  assert.equal(submitted.length, 2);
}

// ---- Side payloads carry the agents' own semantics ----

{
  const boundary = codexSideBoundaryItem();
  assert.equal(boundary.type, "message");
  assert.match(boundary.content[0].text, /Side conversation boundary/);

  const prompt = claudeSideQuestionPrompt({
    question: "second",
    history: [{ question: "first", response: "answer one" }],
  });
  assert.match(prompt, /Earlier side question: first/);
  assert.match(prompt, /<system-reminder>/);
  assert.ok(prompt.endsWith("second"));
}

console.log("agent slash command tests ok");
