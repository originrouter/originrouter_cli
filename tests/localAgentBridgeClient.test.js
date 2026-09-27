import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentBridgeClient } from "../src/local/localAgentBridgeClient.js";
import { ExternalAgentRegistry } from "../src/local/externalAgentRegistry.js";

test("reconnect rehydrates the installed autonomy snapshot even after the event tail is gone", async () => {
  const originalFetch = globalThis.fetch;
  const delivered = [];
  const client = new LocalAgentBridgeClient({ stateDir: "/tmp/originrouter-autonomy-reconnect-test",
    sessionId: "audit", onCommand: async () => {},
    endpointProvider: () => ({ baseUrl: "http://127.0.0.1:7437", token: "test" }),
  });
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/events")) delivered.push(JSON.parse(options.body).event);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    await client.sendEvent({ type: "agent.autonomy.status", eventId: "installed", autonomyProfile: "ai_review",
      aiReviewPolicy: { templateId: "ait_test_template", version: 3, contentHash: "a".repeat(64) } });
    client.setEndpoint(null);
    await client.connect();
    while (client.flushingEvents) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered[1].aiReviewPolicy, delivered[0].aiReviewPolicy);
  } finally { client.close(); globalThis.fetch = originalFetch; }
});

test("a live wrapper consumes new commands after the daemon restarts", async () => {
  const originalFetch = globalThis.fetch;
  let registry = new ExternalAgentRegistry();
  registry.register({ sessionId: "restart-test", agent: "claude" });
  const applied = [];
  const client = new LocalAgentBridgeClient({
    stateDir: "/tmp/originrouter-command-epoch-test",
    sessionId: "restart-test",
    onCommand: (command) => applied.push(command.responseId),
  });
  client.endpoint = { baseUrl: "http://127.0.0.1:7437", token: "test" };
  globalThis.fetch = async (url) => new Response(JSON.stringify(
    registry.commandsAfter("restart-test", Number(new URL(url).searchParams.get("after"))),
  ), { status: 200 });
  try {
    for (let n = 0; n < 6; n++) registry.enqueueCommand("restart-test", {
      type: "agent.interaction.resolve", responseId: `before-${n}`,
    });
    await client.pollCommands();
    assert.equal(client.commandCursor, 6);
    registry = new ExternalAgentRegistry();
    registry.register({ sessionId: "restart-test", agent: "claude" });
    registry.enqueueCommand("restart-test", {
      type: "agent.interaction.resolve", responseId: "allow-after-restart",
    });
    await client.pollCommands();
    await client.pollCommands();
    assert.equal(applied.filter((id) => id === "allow-after-restart").length, 1);
    assert.equal(client.commandCursor, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local agent command polling never applies one command twice", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  let releaseHandler;
  const handlerGate = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const applied = [];

  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        commands: [
          {
            type: "agent.message",
            commandId: "local-command-1",
            commandSequence: 1,
            message: "hello",
          },
        ],
        cursor: 1,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const client = new LocalAgentBridgeClient({
      stateDir: "/tmp/originrouter-local-bridge-test",
      sessionId: "session-1",
      onCommand: async (command) => {
        applied.push(command.commandId);
        await handlerGate;
      },
    });
    client.endpoint = { baseUrl: "http://127.0.0.1:7437", token: "test" };

    const firstPoll = client.pollCommands();
    await Promise.resolve();
    const overlappingPoll = client.pollCommands();
    releaseHandler();
    await Promise.all([firstPoll, overlappingPoll]);
    await client.pollCommands();

    assert.equal(fetchCount, 2);
    assert.deepEqual(applied, ["local-command-1"]);
    assert.equal(client.commandCursor, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("conversation metadata survives a daemon outage for reconnect", async () => {
  const client = new LocalAgentBridgeClient({
    stateDir: "/tmp/originrouter-local-bridge-conversation-test",
    sessionId: "session-1",
    onCommand: async () => {},
  });
  client.closed = true;

  assert.equal(
    await client.update({
      conversationId: "claude:new-conversation",
      nativeSessionId: "new-conversation",
      transcriptPath: "/tmp/new-conversation.jsonl",
    }),
    false,
  );
  assert.equal(client.sessionMetadata.conversationId, "claude:new-conversation");
  assert.equal(client.sessionMetadata.nativeSessionId, "new-conversation");
  assert.equal(
    client.sessionMetadata.transcriptPath,
    "/tmp/new-conversation.jsonl",
  );
});

test("event outbox replays an interaction after a short daemon outage", async () => {
  const originalFetch = globalThis.fetch;
  const endpoint = { baseUrl: "http://127.0.0.1:7437", token: "test" };
  let attempts = 0;
  const delivered = [];
  globalThis.fetch = async (_url, options) => {
    attempts += 1;
    if (attempts === 1) throw new Error("daemon restarting");
    delivered.push(JSON.parse(options.body).event);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const client = new LocalAgentBridgeClient({
      stateDir: "/tmp/originrouter-local-bridge-outbox-test",
      sessionId: "session-outbox",
    });
    client.endpoint = endpoint;
    assert.equal(await client.sendEvent({
      type: "agent.interaction.requested",
      interactionId: "permission-1",
    }), false);
    assert.equal(client.pendingEvents.length, 1);
    client.endpoint = endpoint;
    assert.equal(await client.flushEvents(), true);
    assert.deepEqual(delivered, [{
      type: "agent.interaction.requested",
      interactionId: "permission-1",
    }]);
    await client.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconnect restores a delivered native request, but not a finished request", async () => {
  const originalFetch = globalThis.fetch;
  const delivered = [];
  const endpoint = { baseUrl: "http://127.0.0.1:7437", token: "test" };
  globalThis.fetch = async (_url, options) => {
    if (options.body) delivered.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = new LocalAgentBridgeClient({
    stateDir: "/tmp/originrouter-reconnect-native-test", sessionId: "native-reconnect",
    endpointProvider: () => endpoint,
  });
  try {
    client.endpoint = endpoint;
    await client.sendEvent({ type: "agent.interaction.requested", interactionId: "pending-native", eventId: "request-native" });
    assert.equal(client.pendingEvents.length, 0);
    client.setEndpoint(null);
    await client.connect();
    // connect starts the outbox asynchronously; wait for its request to finish.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered.filter((item) => item.event?.eventId === "request-native").length, 2);
    await client.sendEvent({ type: "agent.interaction.result", interactionId: "pending-native", status: "applied" });
    client.setEndpoint(null);
    await client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(delivered.filter((item) => item.event?.eventId === "request-native").length, 2);
    assert.equal(client.pendingInteractions.size, 0);
  } finally {
    await client.close();
    globalThis.fetch = originalFetch;
  }
});
