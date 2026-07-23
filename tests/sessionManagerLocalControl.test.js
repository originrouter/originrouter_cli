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
      type: "local_control.route.clear",
      agent: "claude",
      slot: "main",
    });

    config = readConfig();
    assert.equal(config.routes?.claude?.main, undefined);
    assert.equal(restarts.length, 2);
    assert.equal(snapshotReports, 2);
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
