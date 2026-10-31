import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";

import { RelayClient } from "../src/relay/relayClient.js";

/**
 * A wrapper hands relaying to its daemon once the daemon connects. Its own
 * socket must close then: left open, it kept the device "online" at the relay
 * while ignoring every frame, so a command sent after the daemon dropped
 * vanished instead of being refused as offline.
 */
test("disconnect closes the events socket and lets connectEvents return", async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const { port } = server.address();
  const connections = [];
  server.on("connection", (socket) => connections.push(socket));

  const client = new RelayClient({
    relayUrl: `http://127.0.0.1:${port}`,
    deviceId: "cli-device",
  });
  const loop = client.connectEvents(() => {});
  while (connections.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const serverSide = connections[0];
  const closed = once(serverSide, "close");

  client.disconnect();

  await Promise.race([
    loop,
    new Promise((_, reject) => setTimeout(() => reject(new Error("connectEvents did not return")), 2_000)),
  ]);
  await closed;
  assert.equal(client._ws, null);
  server.close();
});

test("disconnect before any socket is a no-op", () => {
  const client = new RelayClient({ relayUrl: "http://127.0.0.1:1", deviceId: "cli-device" });
  client.disconnect();
  assert.equal(client._ws, null);
});
