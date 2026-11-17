import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "../src/crypto/deviceE2eeIdentity.js";
import { PROTECTED_DEVICE_MESSAGE_TYPES } from "../src/security/deviceE2eeRelayTransport.js";
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

test("daemon returns an empty tagged page when a transcript cannot be read", async () => {
  const sent = [];
  const registry = {
    has: () => true,
    history: () => {
      throw new Error("transcript disappeared");
    },
    list: () => [
      {
        session_id: "session-1",
        conversation_id: "claude:native-session-2",
        native_session_id: "native-session-2",
      },
    ],
    enqueueCommand: () => {},
  };
  const router = new ExternalAgentRelayRouter({
    registry,
    relayClient: {
      send: async (type, payload) => sent.push({ type, payload }),
    },
  });

  assert.equal(
    await router.handle({
      type: "agent.history.request",
      sessionId: "session-1",
      requestId: "history-failed",
    }),
    true,
  );
  assert.deepEqual(sent, [
    {
      type: "agent.history.page",
      payload: {
        sessionId: "session-1",
        requestId: "history-failed",
        messages: [],
        nextCursor: null,
        hasMore: false,
        conversationId: "claude:native-session-2",
        nativeSessionId: "native-session-2",
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

test("collaboration workers never enter ordinary Agent control or event relay", async () => {
  const sent = [];
  const commands = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: (sessionId) => sessionId === "collab-worker-1",
      enqueueCommand: (sessionId, command) => commands.push({ sessionId, command }),
    },
    relayClient: {
      send: async (type, payload) => sent.push({ type, payload }),
    },
    isCollaborationSession: (sessionId) => sessionId === "collab-worker-1",
  });
  assert.equal(await router.handle({
    type: "agent.message",
    sessionId: "collab-worker-1",
    message: "must stay in collaboration",
  }), false);
  assert.equal(await router.handle({
    type: "agent.interactions.snapshot.request",
    sessionIds: ["collab-worker-1"],
    requestId: "snapshot-1",
  }), false);
  assert.equal(await router.forwardRegistryNotification({
    type: "event",
    sessionId: "collab-worker-1",
    payload: { type: "agent.interaction.requested", interactionId: "i-1" },
  }), false);
  assert.deepEqual(commands, []);
  assert.deepEqual(sent, []);
});

test("daemon broadcasts live events to every subscribed App for a session", async () => {
  const sent = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: (sessionId) => sessionId === "session-1",
    },
    relayClient: {
      send: async () => {
        throw new Error("live events must use the subscriber broadcast path");
      },
      sendBroadcast: async (type, payload, options) => {
        sent.push({ type, payload, options });
        return { accepted: true };
      },
    },
  });

  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: {
      type: "agent.interaction.requested",
      interactionId: "permission-1",
      kind: "permission",
    },
  });
  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: {
      type: "agent.text",
      eventId: "text-1",
      text: "streaming",
    },
  });

  assert.deepEqual(sent, [
    {
      type: "agent.interaction.requested",
      payload: {
        type: "agent.interaction.requested",
        interactionId: "permission-1",
        kind: "permission",
        sessionId: "session-1",
      },
      options: { routeKey: "session-1" },
    },
    {
      type: "agent.stream.event",
      payload: {
        sessionId: "session-1",
        event: {
          type: "agent.text",
          eventId: "text-1",
          text: "streaming",
        },
      },
      options: { routeKey: "session-1" },
    },
  ]);
});

test("daemon broadcasts a losing interaction conflict to all subscribed Apps", async () => {
  const sent = [];
  const commands = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: (sessionId) => sessionId === "session-1",
      enqueueCommand: (sessionId, command) => commands.push({ sessionId, command }),
    },
    relayClient: {
      send: async () => {
        throw new Error("live conflicts must use the subscriber broadcast path");
      },
      sendBroadcast: async (type, payload, options) => {
        sent.push({ type, payload });
        assert.deepEqual(options, { routeKey: "session-1" });
        return { accepted: true };
      },
    },
  });

  const inbound = {
    type: "agent.interaction.resolve",
    sessionId: "session-1",
    interactionId: "permission-1",
    action: "allow",
    responseId: "response-b",
  };
  assert.equal(await router.handle(inbound), true);
  assert.equal(commands[0].command.responseId, "response-b");

  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: {
      type: "agent.interaction.result",
      interactionId: "permission-1",
      responseId: "response-b",
      status: "conflict",
      reason: "interaction_already_claimed",
    },
  });
  assert.deepEqual(sent, [{
    type: "agent.interaction.result",
    payload: {
      type: "agent.interaction.result",
      interactionId: "permission-1",
      responseId: "response-b",
      status: "conflict",
      reason: "interaction_already_claimed",
      sessionId: "session-1",
    },
  }]);
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

test("targeted collaboration events are not broadcast to unrelated Apps", async () => {
  const sent = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: () => true,
    },
    targetDeviceForSession: () => "coordinator-device",
    relayClient: {
      send: async (type, payload) => {
        sent.push({ type, payload });
        return { accepted: true };
      },
      sendBroadcast: async () => {
        throw new Error("targeted collaboration events must not broadcast");
      },
    },
  });

  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: { type: "agent.text", eventId: "targeted-1", text: "private" },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.targetDeviceId, "coordinator-device");
});

test("targeted collaboration events also reach subscribed Apps that can control the session", async () => {
  const sent = [];
  const router = new ExternalAgentRelayRouter({
    registry: { has: () => true },
    targetDeviceForSession: () => "coordinator-device",
    relayClient: {
      send: async () => {
        throw new Error("the targeted subscriber path must be used");
      },
      sendTargetedAndSubscribers: async (type, payload, options) => {
        sent.push({ type, payload, options });
        return { accepted: true };
      },
      sendBroadcast: async () => {
        throw new Error("targeted collaboration events must not use broadcast-only routing");
      },
    },
  });

  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: { type: "agent.text", eventId: "targeted-subscribed", text: "shared" },
  });
  assert.deepEqual(sent, [{
    type: "agent.stream.event",
    payload: {
      sessionId: "session-1",
      targetDeviceId: "coordinator-device",
      event: { type: "agent.text", eventId: "targeted-subscribed", text: "shared" },
    },
    options: { targetDeviceId: "coordinator-device", routeKey: "session-1" },
  }]);
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

test("daemon forwards finite decimal Agent metrics through E2EE serialization", async () => {
  const { router, sent } = fixture();
  await router.forwardRegistryNotification({
    type: "event",
    sessionId: "session-1",
    payload: {
      type: "agent.usage",
      eventId: "usage-decimal",
      costUsd: 0.0125,
      elapsedSeconds: 1.75,
    },
  });
  assert.equal(sent[0].payload.event.costUsd, 0.0125);
  assert.equal(sent[0].payload.event.elapsedSeconds, 1.75);
});

test("canonical E2EE JSON still rejects non-finite numbers", () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), /unsupported canonical JSON value/);
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /unsupported canonical JSON value/);
});

test("a subscribe answers every session's snapshot without serializing the sends", async () => {
  // One subscribe names every session the App knows about. Each snapshot used
  // to be awaited before the next was issued, so a wide registry spent the sum
  // of every round trip in the handler and the App repainted once per session.
  // The sends are independent, so they must be in flight together.
  const sent = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const sessionIds = Array.from({ length: 6 }, (_, index) => `session-${index}`);
  const registry = {
    has: (sessionId) => sessionIds.includes(sessionId),
    controlSnapshot: (sessionId) => ({ interactions: [], events: [], mode: "default", sessionId }),
    enqueueCommand: () => {},
  };
  const relayClient = {
    send: async (type, payload) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      sent.push({ type, payload });
      inFlight -= 1;
      return { accepted: true };
    },
  };
  const router = new ExternalAgentRelayRouter({ registry, relayClient });

  assert.equal(
    await router.handle({
      type: "agent.interactions.snapshot.request",
      sessionIds,
      requestId: "snapshot-1",
    }),
    true,
  );
  assert.equal(sent.length, sessionIds.length, "every session must be answered");
  assert.equal(
    peakInFlight,
    sessionIds.length,
    "the snapshots must overlap rather than run one after another",
  );
});

test("one failed snapshot does not suppress the rest", async () => {
  // A snapshot is self-contained: a registry that throws for one session must
  // not cost the App the snapshots of every other session in the same subscribe.
  const sent = [];
  const sessionIds = ["ok-1", "boom", "ok-2"];
  const registry = {
    has: (sessionId) => sessionIds.includes(sessionId),
    controlSnapshot: (sessionId) => {
      if (sessionId === "boom") throw new Error("snapshot exploded");
      return { interactions: [], events: [], mode: "default", sessionId };
    },
    enqueueCommand: () => {},
  };
  const relayClient = {
    send: async (type, payload) => {
      sent.push({ type, payload });
      return { accepted: true };
    },
  };
  const router = new ExternalAgentRelayRouter({ registry, relayClient });

  assert.equal(
    await router.handle({
      type: "agent.interactions.snapshot.request",
      sessionIds,
      requestId: "snapshot-2",
    }),
    true,
  );
  assert.deepEqual(
    sent.map((item) => item.payload.sessionId),
    ["ok-1", "ok-2"],
    "the healthy sessions must still be answered",
  );
});

test("a history request for a session the daemon has not registered is answered", async () => {
  // The wrapper announces a session to the account a moment before it
  // registers with its daemon. The App that asks in that moment used to get
  // nothing at all and waited out its whole history deadline.
  const { router, sent } = fixture();
  assert.equal(
    await router.handle({
      type: "agent.history.request",
      sessionId: "session-not-yet",
      requestId: "history-early",
    }),
    true,
  );
  assert.deepEqual(sent, [
    {
      type: "agent.history.delivery",
      payload: {
        sessionId: "session-not-yet",
        requestId: "history-early",
        accepted: false,
        retryable: true,
        code: "session_not_registered",
        reason: "The session is not registered on this device yet.",
      },
    },
  ]);
});

test("an unregistered session's other frames still fall through to the session manager", async () => {
  const { router, sent, commands } = fixture();
  assert.equal(
    await router.handle({ type: "agent.message", sessionId: "session-not-yet", message: "hi" }),
    false,
  );
  assert.deepEqual(sent, []);
  assert.deepEqual(commands, []);
});

test("a command for a run whose process is gone gets a terminal answer", async () => {
  // The registry keeps knowing a session after its process ends so its
  // transcript stays answerable. A command queued onto that row has no
  // wrapper to drain it — before the row was deleted outright the command
  // simply vanished; now the App hears the refusal.
  const sent = [];
  const commands = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: () => true,
      sessionFacts: () => ({ status: "stopped", attached: false }),
      enqueueCommand: (sessionId, command) => commands.push({ sessionId, command }),
    },
    relayClient: {
      send: async (type, payload) => sent.push({ type, payload }),
    },
  });
  assert.equal(
    await router.handle({
      type: "agent.message",
      sessionId: "dead-1",
      requestId: "req-dead-1",
      message: "still there?",
    }),
    true,
  );
  assert.deepEqual(commands, []);
  assert.deepEqual(sent, [
    {
      type: "agent.control.delivery",
      payload: {
        sessionId: "dead-1",
        requestId: "req-dead-1",
        accepted: false,
        retryable: false,
        code: "session_detached",
        reason: "The session is not running on this device.",
      },
    },
  ]);
});

test("a live session holding a pending approval still takes its resolve", async () => {
  // `waiting_approval` is the public status of a live process waiting on its
  // user — refusing its `agent.interaction.resolve` because the status is
  // not literally `running` deadlocks the approval the command exists to
  // answer. Attachment is the gate; the waiting states are not detachment.
  const commands = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: () => true,
      sessionFacts: () => ({ status: "waiting_approval", attached: true }),
      enqueueCommand: (sessionId, command) => commands.push({ sessionId, command }),
    },
    relayClient: {
      send: async () => {
        throw new Error("a waiting session is alive; no refusal is owed");
      },
    },
  });
  assert.equal(
    await router.handle({
      type: "agent.interaction.resolve",
      sessionId: "waiting-1",
      interactionId: "approval-1",
      action: "allow",
    }),
    true,
  );
  assert.equal(commands.length, 1);
});

test("a run inside its re-attach window still queues commands", async () => {
  // A daemon restart leaves a live wrapper detached for the seconds it needs
  // to re-register. Dropping a user's message on that race is worse than
  // holding it, so a `running` row queues whether or not it has re-attached.
  const commands = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: () => true,
      sessionFacts: () => ({ status: "running", attached: false }),
      enqueueCommand: (sessionId, command) => commands.push({ sessionId, command }),
    },
    relayClient: {
      send: async () => {
        throw new Error("no delivery is owed while the run is live");
      },
    },
  });
  assert.equal(
    await router.handle({
      type: "agent.message",
      sessionId: "grace-1",
      message: "hold this",
    }),
    true,
  );
  assert.equal(commands.length, 1);
});

test("a command that went stale between the check and the write still answers", async () => {
  // `expireStale` can retire a row after `sessionFacts` read it. The enqueue
  // then throws, and an uncaught throw is exactly the silent drop the
  // delivery answers instead of.
  const sent = [];
  const router = new ExternalAgentRelayRouter({
    registry: {
      has: () => true,
      sessionFacts: () => ({ status: "running", attached: true }),
      enqueueCommand: () => {
        const error = new Error("local agent session is not active");
        error.code = "SESSION_NOT_ACTIVE";
        throw error;
      },
    },
    relayClient: {
      send: async (type, payload) => sent.push({ type, payload }),
    },
  });
  assert.equal(
    await router.handle({ type: "agent.message", sessionId: "stale-1", message: "hi" }),
    true,
  );
  assert.equal(sent[0].payload.code, "session_detached");
});

test("every *.delivery reply the daemon emits is on the protected route", async () => {
  // A delivery is a reply: it carries no targetDeviceId and can only ride the
  // pairwise E2EE session its request arrived on. Miss the protected set and
  // the message falls onto the plaintext fallback, which has no route for a
  // targetless reply — the App hears nothing and the refusal exists only in
  // the daemon's logs. `agent.control.delivery` shipped exactly that way.
  // The relay does not whitelist types, so nothing but this test can notice.
  const src = await fs.readdir("src", { recursive: true });
  const sentTypes = new Set();
  for (const name of src) {
    if (!String(name).endsWith(".js")) continue;
    const text = await fs.readFile(path.join("src", String(name)), "utf8");
    for (const match of text.matchAll(/\.send(?:Acknowledged)?\("([^"]+\.delivery)"/g)) {
      sentTypes.add(match[1]);
    }
  }
  assert.ok(sentTypes.size > 0, "the scan found no *.delivery sends — check the pattern");
  for (const type of sentTypes) {
    assert.ok(
      PROTECTED_DEVICE_MESSAGE_TYPES.has(type),
      `${type} is sent but not protected — it will be dropped as a targetless plaintext reply`,
    );
  }
});
