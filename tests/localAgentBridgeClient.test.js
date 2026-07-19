import assert from "node:assert/strict";
import test from "node:test";

import { LocalAgentBridgeClient } from "../src/local/localAgentBridgeClient.js";

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
