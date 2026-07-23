import assert from "node:assert/strict";
import test from "node:test";

import { ExternalAgentRelayRouter } from "../src/daemon/externalAgentRelayRouter.js";

function fixture() {
  const sent = [];
  const commands = [];
  const registry = {
    has: (sessionId) => sessionId === "session-1",
    history: () => ({ messages: [], nextCursor: null, hasMore: false }),
    controlSnapshot: () => ({ interactions: [], events: [], mode: "default" }),
    enqueueCommand: (sessionId, command) =>
      commands.push({ sessionId, command }),
  };
  const relayClient = {
    send: async (type, payload) => {
      sent.push({ type, payload });
      return { accepted: true };
    },
  };
  return {
    router: new ExternalAgentRelayRouter({ registry, relayClient }),
    sent,
    commands,
  };
}

test("daemon returns an empty history page for a registered manual session", async () => {
  const { router, sent } = fixture();
  assert.equal(
    await router.handle({
      type: "agent.history.request",
      sessionId: "session-1",
      requestId: "history-1",
    }),
    true,
  );
  assert.deepEqual(sent, [
    {
      type: "agent.history.page",
      payload: {
        sessionId: "session-1",
        requestId: "history-1",
        messages: [],
        nextCursor: null,
        hasMore: false,
      },
    },
  ]);
});

test("daemon routes App messages to the exact registered session", async () => {
  const { router, commands } = fixture();
  const message = {
    type: "agent.message",
    sessionId: "session-1",
    messageId: "message-1",
    message: "hello",
  };
  assert.equal(await router.handle(message), true);
  assert.deepEqual(commands, [{ sessionId: "session-1", command: message }]);
  assert.equal(await router.handle({ ...message, sessionId: "other" }), false);
});

test("daemon forwards full transient text and session acknowledgements", async () => {
  const { router, sent } = fixture();
  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: { type: "agent.text", eventId: "text-1", text: "done" },
  });
  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: {
      type: "agent.message.result",
      eventId: "ack-1",
      messageId: "message-1",
      accepted: true,
    },
  });
  assert.equal(sent[0].type, "agent.stream.event");
  assert.equal(sent[0].payload.event.text, "done");
  assert.equal(sent[1].type, "agent.message.result");
  assert.equal(sent[1].payload.sessionId, "session-1");
});
