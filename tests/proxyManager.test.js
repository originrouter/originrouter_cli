// Stage 4 ProxyManager tests. Spawn and fetch are mocked; we exercise the
// lifecycle without touching the filesystem beyond a tempdir + writing
// proxy.state.json through the real writeProxyState helper.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";

import { ProxyManager } from "../src/proxy/manager.js";
import { addProvider } from "../src/config/providers.js";
import { litellmBinaryPath, pythonBinaryPath } from "../src/proxy/litellm.js";
import { readLocalProxySnapshot } from "../src/proxy/snapshot.js";
import { writeProxyState, readProxyState, clearProxyState, writeConfig } from "../src/persistence/state.js";

// ---------- Mock spawn ----------

class MockChild {
  constructor({ pid, stdoutLines = [], stderrLines = [], exitCode = 0 }) {
    this.pid = pid;
    this.stdoutLines = stdoutLines;
    this.stderrLines = stderrLines;
    this.exitCode = exitCode;
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.killed = false;
    this.exitListeners = [];
    // Push lines shortly after construction so consumers can attach.
    queueMicrotask(() => {
      for (const l of stdoutLines) this.stdout.push(l);
      for (const l of stderrLines) this.stderr.push(l);
      this.stdout.push(null);
      this.stderr.push(null);
      // Do NOT auto-emit exit; the test decides when.
    });
  }
  kill(sig) {
    this.killed = sig;
    // Simulate exit on kill.
    setImmediate(() => this._emitExit(this.exitCode, sig));
  }
  on(event, fn) {
    if (event === "exit") this.exitListeners.push(fn);
  }
  once(event, fn) { this.on(event, fn); }
  _emitExit(code, signal) {
    for (const fn of this.exitListeners) fn(code, signal);
  }
}

function mockSpawnFactory({ pid = 54321, stdoutLines = [], stderrLines = [], exitCode = 0 } = {}) {
  const calls = [];
  const child = new MockChild({ pid, stdoutLines, stderrLines, exitCode });
  return {
    calls,
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      return child;
    },
    child,
  };
}

const silentLogger = { log() {}, error() {} };

// ---------- Helpers to seed the temp state dir ----------

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "originrouter-proxy-test-"));
  return home;
}

function seedProviders(home) {
  let cfg = {};
  // Stage 7.6: minimax is a litellm/anthropic provider (Anthropic-compatible
  // endpoint through the LiteLLM proxy). The "refuses anthropic" test
  // becomes "refuses type=anthropic legacy" — that test path uses
  // the legacy openai-compatible seed below, not minimax.
  cfg = addProvider(cfg, {
    name: "minimax",
    type: "litellm",
    litellmProvider: "anthropic",
    baseUrl: "https://api.minimax.example/v1",
    apiKey: "sk-minimax-1234567890",
    model: "minimax-chat",
    smallFastModel: "minimax-chat-fast",
  });
  // deepseek is a litellm provider (Stage 7: routed through the proxy).
  cfg = addProvider(cfg, {
    name: "deepseek",
    type: "litellm",
    litellmProvider: "deepseek",
    baseUrl: "https://api.deepseek.example/v1",
    apiKey: "sk-deepseek-1234567890",
    model: "deepseek-chat",
  });
  process.env.ORIGINROUTER_HOME = home;
  return import("../src/persistence/state.js").then(({ writeConfig }) => {
    writeConfig(cfg);
  });
}

function fakeInstalledVenv(home, version = "1.83.0") {
  // Create a sentinel file that isInstalled() checks for.
  const py = pythonBinaryPath(home, version);
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(py, "#!/bin/sh\necho mock\n");
  writeFileSync(litellmBinaryPath(home, version), "#!/bin/sh\necho mock\n");
}

function makeManager(home, { fetchOk = true, fetchBody = "{}", stateKey = "proxy" } = {}) {
  const { calls, spawn, child } = mockSpawnFactory({ pid: 54321 });
  const fetchCalls = [];
  const fetchFn = async (url) => {
    fetchCalls.push(url);
    return { ok: fetchOk, status: fetchOk ? 200 : 503, text: async () => fetchBody, json: async () => JSON.parse(fetchBody) };
  };
  const manager = new ProxyManager({
    stateDir: home,
    stateKey,
    pythonCommand: "/usr/bin/python3",
    logger: silentLogger,
    spawnFn: spawn,
    fetchFn,
  });
  return { manager, spawnCalls: calls, fetchCalls, child };
}

// ---------- Tests ----------

let home;
try {
  home = makeHome();
  process.env.ORIGINROUTER_HOME = home;

  await seedProviders(home);

  // ============================================================
  // status(): not-installed when venv missing
  // ============================================================
  {
    // Ensure no venv from a previous run leaks into this case.
    rmSync(pythonBinaryPath(home), { force: true });
    const { manager } = makeManager(home);
    const s = await manager.status();
    assert.equal(s.state, "not-installed");
    assert.equal(s.port, null);
    assert.equal(s.pid, null);
    assert.equal(s.currentProvider, null);
  }

  // ============================================================
  // status(): stopped after writeProxyState({state:stopped}) (manual state)
  // ============================================================
  {
    fakeInstalledVenv(home);
    const { manager } = makeManager(home);
    writeProxyState({
      version_pinned: "1.83.0",
      state: "stopped",
      pid: null,
      provider: "deepseek",
    });
    const s = await manager.status();
    assert.equal(s.state, "stopped");
    assert.equal(s.version, "1.83.0");
    assert.equal(s.currentProvider, "deepseek");
  }

  // ============================================================
  // start() refuses when not installed
  // ============================================================
  {
    clearProxyState();
    rmSync(pythonBinaryPath(home), { force: true });  // ensure not-installed
    const { manager } = makeManager(home);
    const r = await manager.start({ mode: "provider", providerName: "deepseek", port: 40123 });
    assert.equal(r.ok, false);
    assert.match(r.error, /not installed/);
  }

  // Default for the rest: venv IS installed.
  fakeInstalledVenv(home);

  // ============================================================
  // share-mode start renders and records every selected Provider
  // ============================================================
  {
    await seedProviders(home);
    clearProxyState("remote-share-proxy");
    const { manager } = makeManager(home, { stateKey: "remote-share-proxy" });
    const result = await manager.start({
      mode: "share",
      providerNames: ["minimax", "deepseek"],
      port: 40124,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.providers, ["minimax", "deepseek"]);
    const state = readProxyState("remote-share-proxy");
    assert.equal(state.mode, "share");
    assert.deepEqual(state.providers, ["minimax", "deepseek"]);
    const yaml = readFileSync(state.configPath, "utf8");
    assert.match(yaml, /model_name: minimax/);
    assert.match(yaml, /model_name: deepseek/);
    await manager.stop();
  }

  // ============================================================
  // start() refuses unknown provider (legacy provider mode)
  // ============================================================
  {
    fakeInstalledVenv(home);
    clearProxyState();
    const { manager } = makeManager(home);
    const r = await manager.start({ mode: "provider", providerName: "ghost", port: 40123 });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown provider 'ghost'/);
  }

  // ============================================================
  // Stage 7.6: minimax is now type=litellm (anthropic-compatible). The
  // "refuses anthropic" test is replaced with a "refuses unknown
  // provider" test (since legacy type=anthropic is rejected on add, we
  // can't have a type=anthropic provider in the seed).
  // ============================================================
  {
    clearProxyState();
    const { manager } = makeManager(home);
    const r = await manager.start({ mode: "provider", providerName: "ghost", port: 40123 });
    // unknown provider name should refuse.
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown provider 'ghost'/);
  }

  // ============================================================
  // start() refuses port=0 (auto-port not supported yet)
  // ============================================================
  {
    clearProxyState();
    const { manager, spawnCalls } = makeManager(home);
    const r = await manager.start({ mode: "provider", providerName: "deepseek", port: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error, /auto-port/);
    assert.equal(spawnCalls.length, 0);
  }

  // ============================================================
  // Stage 8.0: route-mode start requires at least one route set
  // (Claude or Codex). Neither set → "no routes configured" error.
  // ============================================================
  {
    clearProxyState();
    fakeInstalledVenv(home);
    // No routes set in config.
    writeConfig({ providers: { deepseek: { name: "deepseek", type: "litellm", litellmProvider: "deepseek", apiKey: "sk", model: "deepseek-chat" } } });
    const { manager, spawnCalls } = makeManager(home);
    const r = await manager.start({ mode: "route", port: 40123 });
    assert.equal(r.ok, false);
    assert.match(r.error, /no routes configured\. Set claude\.main or codex\.main first/);
    assert.equal(spawnCalls.length, 0);
  }

  // ============================================================
  // start() refuses when another proxy is already running
  // ============================================================
  {
    clearProxyState();
    fakeInstalledVenv(home);
    writeProxyState({
      version_pinned: "1.83.0", state: "running", pid: 99999, port: 12345,
      host: "127.0.0.1", provider: "deepseek", startedAt: new Date().toISOString(),
    });
    // Stub process.kill so the manager's status() probe sees pid 99999 alive.
    const _origKill = process.kill;
    process.kill = (pid, sig) => {
      if (sig === 0 && pid === 99999) return true;
      return _origKill(pid, sig);
    };
    try {
      const { manager, spawnCalls } = makeManager(home);
      const r = await manager.start({ mode: "provider", providerName: "deepseek", port: 40123 });
      assert.equal(r.ok, false);
      assert.match(r.error, /already running/);
      assert.equal(spawnCalls.length, 0);
    } finally {
      process.kill = _origKill;
    }
  }

  // ============================================================
  // start() happy path: spawns, health-checks, writes state
  // ============================================================
  {
    clearProxyState();
    fakeInstalledVenv(home);
    // Stub process.kill so the manager's status() probe sees the spawned
    // (mock) child as alive. The MockChild has no real OS pid.
    const _origKill = process.kill;
    process.kill = (pid, sig) => {
      if (sig === 0) return true;  // pretend all pids in this test are alive
      return _origKill(pid, sig);
    };
    try {
      const { manager, spawnCalls, fetchCalls } = makeManager(home);
      const r = await manager.start({ mode: "provider", providerName: "deepseek", port: 40123 });
      assert.equal(r.ok, true);
      assert.equal(r.state, "running");
      assert.equal(r.port, 40123);
      assert.equal(r.provider, "deepseek");
      // spawn called with the expected argv.
      assert.equal(spawnCalls.length, 1);
      const { cmd, args } = spawnCalls[0];
      assert.ok(cmd.endsWith("/venv/bin/litellm"), `litellm path was ${cmd}`);
      assert.deepEqual(args, [
        "--config", r.configPath,
        "--host", "127.0.0.1",
        "--port", "40123",
      ]);
      // Stage 7: rendered YAML uses the deepseek/ prefix (catalog-driven).
      const yaml = readFileSync(r.configPath, "utf8");
      assert.match(yaml, /model: deepseek\/deepseek-chat/);
      // Health endpoint was hit.
      assert.ok(fetchCalls.some((u) => u.endsWith("/health/liveliness")));
      // State file written.
      const cur = readProxyState();
      assert.equal(cur.state, "running");
      assert.equal(cur.port, 40123);
      assert.equal(cur.provider, "deepseek");
      assert.equal(cur.pid, 54321);

      // status() now reports running.
      const s = await manager.status();
      assert.equal(s.state, "running");
      assert.equal(s.port, 40123);
      assert.equal(s.currentProvider, "deepseek");
    } finally {
      process.kill = _origKill;
    }
  }

  // ============================================================
  // start() with unhealthy proxy clears state and returns error
  // ============================================================
  {
    clearProxyState();
    fakeInstalledVenv(home);
    const { manager, spawnCalls, fetchCalls } = makeManager(home, { fetchOk: false });
    const r = await manager.start({ mode: "provider", providerName: "deepseek", port: 40123 });
    assert.equal(r.ok, false);
    assert.match(r.error, /failed to become healthy/);
    // The spawned child was killed and state cleared.
    assert.equal(readProxyState(), null);
  }

  // ============================================================
  // start() accepts legacy type=openai-compatible (projects to custom_openai)
  // ============================================================
  {
    clearProxyState();
    fakeInstalledVenv(home);
    // Hand-edit the disk record to legacy shape.
    const { writeConfig, readConfig } = await import("../src/persistence/state.js");
    const cfg = readConfig();
    cfg.providers.deepseek = {
      name: "deepseek",
      type: "openai-compatible",
      baseUrl: "https://api.deepseek.example/v1",
      apiKey: "sk-deepseek-1234567890",
      model: "deepseek-chat",
    };
    writeConfig(cfg);
    const { manager } = makeManager(home);
    const r = await manager.start({ mode: "provider", providerName: "deepseek", port: 40124 });
    assert.equal(r.ok, true);
    // The rendered YAML uses openai/ prefix (custom_openai profile) — same as
    // the v1 Stage 4 output for legacy providers.
    const yaml = readFileSync(r.configPath, "utf8");
    assert.match(yaml, /model: openai\/deepseek-chat/);
    // Disk record is NOT migrated on start — still legacy.
    const stillLegacy = readConfig().providers.deepseek.type;
    assert.equal(stillLegacy, "openai-compatible");
  }

  // ============================================================
  // stop() with running proxy: clears state, child killed
  // ============================================================
  {
    fakeInstalledVenv(home);
    writeProxyState({
      version_pinned: "1.83.0", state: "running", pid: 54321, port: 40123,
      host: "127.0.0.1", provider: "deepseek",
      startedAt: new Date().toISOString(),
    });
    // Use the same MockChild that start() would create, then verify stop()
    // signals it. To do that we set manager.activeChild to a fresh child.
    const { manager, child } = makeManager(home);
    manager.activeChild = child;
    const r = await manager.stop();
    assert.equal(r.ok, true);
    assert.equal(r.state, "stopped");
    assert.equal(child.killed, "SIGTERM");
    assert.equal(readProxyState(), null);
  }

  // ============================================================
  // stop() with no state returns ok idempotently
  // ============================================================
  {
    clearProxyState();
    const { manager } = makeManager(home);
    const r = await manager.stop();
    assert.equal(r.ok, true);
    assert.equal(r.state, "stopped");
    assert.match(r.note, /no running/);
  }

  // ============================================================
  // readLocalProxySnapshot(): direct CLI launchers see persisted running proxy
  // ============================================================
  {
    clearProxyState();
    writeProxyState({
      version_pinned: "1.83.0", state: "running", pid: 54321, port: 40123,
      host: "127.0.0.1", provider: "deepseek",
      startedAt: new Date().toISOString(),
      configPath: "/tmp/config.yaml",
      logPath: "/tmp/litellm.log",
    });
    const _origKill = process.kill;
    process.kill = (pid, sig) => {
      if (sig === 0 && pid === 54321) return true;
      return _origKill(pid, sig);
    };
    try {
      const snap = readLocalProxySnapshot();
      assert.equal(snap.state, "running");
      assert.equal(snap.port, 40123);
      assert.equal(snap.currentProvider, "deepseek");
      assert.equal(snap.host, "127.0.0.1");
    } finally {
      process.kill = _origKill;
      clearProxyState();
    }
  }

  // ============================================================
  // status(): running with dead pid reconciles to stopped
  // ============================================================
  {
    clearProxyState();
    fakeInstalledVenv(home);
    writeProxyState({
      version_pinned: "1.83.0", state: "running", pid: 11111, port: 40123,
      host: "127.0.0.1", provider: "deepseek",
      startedAt: new Date().toISOString(),
    });
    // pid 11111 doesn't exist; process.kill(pid, 0) will throw.
    const { manager } = makeManager(home);
    const s = await manager.status();
    assert.equal(s.state, "stopped");
    assert.equal(s.currentProvider, "deepseek");
    // State cleared as a side effect.
    assert.equal(readProxyState(), null);
  }

  // ============================================================
  // status(): EPERM pid probe + healthy endpoint still reports running
  // ============================================================
  {
    clearProxyState();
    fakeInstalledVenv(home);
    writeProxyState({
      version_pinned: "1.83.0", state: "running", pid: 22222, port: 40123,
      host: "127.0.0.1", provider: "deepseek",
      startedAt: new Date().toISOString(),
    });
    const _origKill = process.kill;
    process.kill = (pid, sig) => {
      if (sig === 0 && pid === 22222) {
        const err = new Error("operation not permitted");
        err.code = "EPERM";
        throw err;
      }
      return _origKill(pid, sig);
    };
    try {
      const { manager } = makeManager(home);
      const s = await manager.status();
      assert.equal(s.state, "running");
      assert.equal(s.currentProvider, "deepseek");
    } finally {
      process.kill = _origKill;
      clearProxyState();
    }
  }

  console.log("proxy manager tests ok");
} finally {
  if (home) rmSync(home, { recursive: true, force: true });
}
