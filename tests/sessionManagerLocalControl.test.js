import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager } from "../src/daemon/sessionManager.js";
import { readConfig, writeConfig } from "../src/persistence/state.js";

const PROVIDERS = {
  deepseek: {
    name: "deepseek",
    type: "litellm",
    litellmProvider: "deepseek",
    apiKey: "sk-ds",
    model: "deepseek-chat",
  },
  moonshot: {
    name: "moonshot",
    type: "litellm",
    litellmProvider: "moonshot",
    apiKey: "sk-ms",
    model: "moonshot-v1-8k",
  },
};

test("SessionManager applies local-control route updates from relay events", async () => {
  const prevHome = process.env.ORIGINROUTER_HOME;
  const home = mkdtempSync(join(tmpdir(), "originrouter-local-control-test-"));
  process.env.ORIGINROUTER_HOME = home;
  const restarts = [];
  let snapshotReports = 0;
  try {
    writeConfig({ providers: PROVIDERS });
    const manager = new SessionManager({
      relayClient: { send: async () => ({ ok: true }) },
      deviceId: "device-test",
      defaultExecutor: "fake",
      proxyManager: {
        async status() {
          return { state: "running", mode: "route", host: "127.0.0.1", port: 40123 };
        },
        async restart(args) {
          restarts.push(args);
          return { ok: true };
        },
      },
      onLocalControlChanged: async () => {
        snapshotReports += 1;
      },
    });

    await manager.handleLocalControlEvent({
      type: "local_control.route.set",
      agent: "claude",
      slot: "main",
      provider: "deepseek",
      model: "deepseek-chat",
    });

    let config = readConfig();
    assert.deepEqual(config.routes.claude.main, {
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.deepEqual(restarts, [{ mode: "route", port: 40123 }]);

    await manager.handleLocalControlEvent({
      type: "local_control.routes.replace",
      agent: "claude",
      routes: {
        main: { provider: "deepseek", model: "deepseek-chat" },
        small: { provider: "deepseek", model: "deepseek-chat" },
      },
    });
    config = readConfig();
    assert.equal(config.routes.claude.main.provider, "deepseek");
    assert.equal(config.routes.claude.small.provider, "deepseek");

    await assert.rejects(
      () => manager.handleLocalControlEvent({
        type: "local_control.routes.replace",
        agent: "claude",
        routes: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          small: { provider: "moonshot", model: "moonshot-v1-8k" },
        },
      }),
      /must use the same provider/,
    );

    await manager.handleLocalControlEvent({
      type: "local_control.route.clear",
      agent: "claude",
      slot: "main",
    });

    config = readConfig();
    assert.equal(config.routes?.claude?.main, undefined);
    assert.equal(restarts.length, 3);
    assert.equal(snapshotReports, 3);
  } finally {
    if (prevHome === undefined) delete process.env.ORIGINROUTER_HOME;
    else process.env.ORIGINROUTER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionManager restarts route-mode proxy for local-control litellm restart", async () => {
  const restarts = [];
  const manager = new SessionManager({
    relayClient: { send: async () => ({ ok: true }) },
    deviceId: "device-test",
    defaultExecutor: "fake",
    proxyManager: {
      async status() {
        return { state: "running", mode: "route", host: "127.0.0.1", port: 40123 };
      },
      async restart(args) {
        restarts.push(args);
        return { ok: true };
      },
    },
  });

  await manager.handleLocalControlEvent({ type: "local_control.litellm.restart" });
  assert.deepEqual(restarts, [{ mode: "route", port: 40123 }]);
});

test("SessionManager starts route-mode proxy for local-control litellm start", async () => {
  const starts = [];
  const manager = new SessionManager({
    relayClient: { send: async () => ({ ok: true }) },
    deviceId: "device-test",
    defaultExecutor: "fake",
    proxyManager: {
      async start(args) {
        starts.push(args);
        return { ok: true };
      },
    },
  });

  await manager.handleLocalControlEvent({
    type: "local_control.litellm.start",
    port: 40123,
  });
  assert.deepEqual(starts, [{ mode: "route", port: 40123 }]);
});

test("SessionManager starts Remote Share with an explicit Provider allow-list", async () => {
  const previousHome = process.env.ORIGINROUTER_HOME;
  const home = mkdtempSync(join(tmpdir(), "originrouter-remote-share-test-"));
  process.env.ORIGINROUTER_HOME = home;
  const starts = [];
  try {
    writeConfig({ providers: PROVIDERS });
    const manager = new SessionManager({
      relayClient: { send: async () => ({ ok: true }) },
      deviceId: "device-test",
      defaultExecutor: "fake",
      remoteShareProxyManager: {
        async start(args) {
          starts.push(args);
          return { ok: true };
        },
      },
    });

    await manager.handleLocalControlEvent({
      type: "local_control.remote_share.start",
      providers: ["deepseek", "glm"],
      port: 40124,
      e2eePolicy: "required",
    });

    assert.deepEqual(starts, [{
      mode: "share",
      providerNames: ["deepseek", "glm"],
      port: 40124,
    }]);
    assert.deepEqual(readConfig().remoteShare, {
      enabled: true,
      providers: ["deepseek", "glm"],
      port: 40124,
      e2eePolicy: "required",
    });
  } finally {
    if (previousHome === undefined) delete process.env.ORIGINROUTER_HOME;
    else process.env.ORIGINROUTER_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("SessionManager serves approval policy inspection over the encrypted relay", async () => {
  const previousHome = process.env.ORIGINROUTER_HOME;
  const home = mkdtempSync(join(tmpdir(), "originrouter-policy-relay-test-"));
  process.env.ORIGINROUTER_HOME = home;
  const sent = [];
  try {
    const manager = new SessionManager({
      relayClient: {
        async send(type, payload) {
          sent.push({ type, payload });
          return { ok: true };
        },
      },
      deviceId: "device-test",
      defaultExecutor: "fake",
    });
    assert.equal(manager.handleEvent({
      type: "approval.policy.capabilities",
      requestId: "cap-1",
    }), true);
    assert.equal(manager.handleEvent({
      type: "approval.policy.validate",
      requestId: "validate-1",
      policy: {
        version: 2,
        id: "relay-policy",
        defaults: { unmatched: "ask", parse_error: "ask", unknown: "ask" },
        rules: [{ id: "read", effect: "allow", actions: ["fs.read"] }],
      },
    }), true);
    assert.equal(manager.handleEvent({
      type: "approval.policy.simulate",
      requestId: "simulate-1",
      workspace: home,
      policy: {
        version: 2,
        id: "relay-policy",
        defaults: { unmatched: "ask", parse_error: "ask", unknown: "ask" },
        rules: [{
          id: "read",
          effect: "allow",
          actions: ["fs.read"],
          when: { field: "resource.path", op: "path_under", value: "${workspace}" },
        }],
      },
      request: {
        kind: "permission",
        source: "app-server",
        payload: { tool: "Read", tool_input: { file_path: join(home, "README.md") } },
      },
    }), true);
    await new Promise((resolve) => setImmediate(resolve));

    const capabilities = sent.find((item) => item.type === "approval.policy.capabilities.result");
    assert.equal(capabilities.payload.requestId, "cap-1");
    assert.ok(capabilities.payload.registry_hash);
    const validation = sent.find((item) => item.type === "approval.policy.validate.result");
    assert.equal(validation.payload.valid, true);
    assert.ok(validation.payload.impact);
    const simulation = sent.find((item) => item.type === "approval.policy.simulate.result");
    assert.equal(simulation.payload.effect, "allow");
    assert.deepEqual(simulation.payload.decisions.map((item) => item.action), ["fs.read"]);
  } finally {
    if (previousHome === undefined) delete process.env.ORIGINROUTER_HOME;
    else process.env.ORIGINROUTER_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
