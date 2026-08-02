import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../src/crypto/deviceE2eeIdentity.js";
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
      canonicalJson(payload);
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

test("daemon preserves text and tool history while removing undefined fields", async () => {
  const sent = [];
  const registry = {
    has: (sessionId) => sessionId === "session-1",
    history: () => ({
      messages: [
        {
          messageId: "assistant-1",
          role: "assistant",
          text: "done",
          optional: undefined,
        },
        {
          messageId: "tool-1",
          role: "event",
          event: {
            type: "agent.tool_call.end",
            tool: "Read",
            content: "file contents",
            omitted: undefined,
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
    }),
    controlSnapshot: () => ({ interactions: [], events: [] }),
    enqueueCommand: () => {},
  };
  const relayClient = {
    send: async (type, payload) => {
      canonicalJson(payload);
      sent.push({ type, payload });
      return { accepted: true };
    },
  };
  const router = new ExternalAgentRelayRouter({ registry, relayClient });

  assert.equal(await router.handle({
    type: "agent.history.request",
    sessionId: "session-1",
    requestId: "history-rich",
  }), true);
  assert.deepEqual(sent[0], {
    type: "agent.history.page",
    payload: {
      sessionId: "session-1",
      requestId: "history-rich",
      messages: [
        { messageId: "assistant-1", role: "assistant", text: "done" },
        {
          messageId: "tool-1",
          role: "event",
          event: {
            type: "agent.tool_call.end",
            tool: "Read",
            content: "file contents",
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  });
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

test("remote collaboration events retain a target after E2EE reconnects", async () => {
  const { sent, commands } = fixture();
  const registry = {
    has: (sessionId) => sessionId === "session-1",
    history: () => ({ messages: [], nextCursor: null, hasMore: false }),
    controlSnapshot: () => ({ interactions: [], events: [], mode: "default" }),
    enqueueCommand: (sessionId, command) =>
      commands.push({ sessionId, command }),
  };
  const router = new ExternalAgentRelayRouter({
    registry,
    relayClient: {
      send: async (type, payload) => {
        sent.push({ type, payload });
        return { accepted: true };
      },
    },
    targetDeviceForSession: (sessionId) =>
      sessionId === "session-1" ? "coordinator-device" : "",
  });
  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: { type: "agent.text", eventId: "remote-text", text: "progress" },
  });
  assert.equal(sent[0].payload.targetDeviceId, "coordinator-device");
  assert.equal(sent[0].payload.event.text, "progress");
});

test("daemon removes undefined fields before protected E2EE serialization", async () => {
  const { router, sent } = fixture();
  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: {
      type: "agent.text",
      eventId: "text-undefined",
      text: "complete",
      optional: undefined,
      metadata: { safe: true, omitted: undefined },
      blocks: [undefined, { text: "kept", omitted: undefined }],
    },
  });
  assert.deepEqual(sent[0].payload, {
    sessionId: "session-1",
    event: {
      type: "agent.text",
      eventId: "text-undefined",
      text: "complete",
      metadata: { safe: true },
      blocks: [null, { text: "kept" }],
    },
  });
});
