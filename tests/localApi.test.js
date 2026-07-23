// Stage 3 local API smoke. Spawns startLocalApi() in-process on an ephemeral
// port and exercises every route with real HTTP requests. Uses a hand-crafted
// SessionManager-shaped fake with spy executor/adapter so we can assert that
// write paths route through sessionManager.handleEvent() and NOT through any
// relay.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalApi, projectSession } from "../src/local/localApi.js";
import { addProvider, setCurrentProvider } from "../src/config/providers.js";
import { setRoute } from "../src/config/routes.js";
import { readConfig, writeConfig } from "../src/persistence/state.js";
import { ensureApiToken } from "../src/persistence/authToken.js";
import { LocalAuditStore } from "../src/persistence/localAuditStore.js";
import { AgentCatalog } from "../src/persistence/agentCatalog.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-localapi-test-"));
process.env.ORIGINROUTER_HOME = home;

// Stage 6: ensure a token is on disk before booting the API. The auth gate
// refuses all writes when the file is missing (503 auth-not-initialized).
const TOKEN = ensureApiToken(home);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let serverHandle;
let agentCatalog;
try {
  // ---------- Seed a config + spy sessionManager ----------

  let config = {};
  config = addProvider(config, {
    name: "minimax",
    type: "litellm",
    litellmProvider: "anthropic",
    baseUrl: "https://api.minimax.example/v1",
    apiKey: "sk-minimax-1234567890",
    model: "MiniMax-M3",
    smallFastModel: "MiniMax-M2.7",
  });
  config = addProvider(config, {
    name: "deepseek",
    type: "litellm",
    litellmProvider: "custom_openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-ds-1234567890",
    model: "deepseek-chat",
  });
  writeConfig(config);

  const spiedExecutor = {
    writeCalls: [],
    interruptCalls: 0,
    write(data) { this.writeCalls.push(data); },
    interrupt() { this.interruptCalls += 1; },
  };
  const spiedAdapter = {
    resolvePermissionCalls: [],
    resolvePermission(payload) { this.resolvePermissionCalls.push(payload); },
  };
  const sessionId = "test-session-1";
  let proxyStatus = {
    state: "not-installed",
    port: null,
    version: null,
    pid: null,
    currentProvider: null,
    mode: null,
    routesHash: null,
    aliases: null,
    note: "LiteLLM proxy control lands in Stage 4.",
  };
  const proxyRestartCalls = [];
  const proxyStartCalls = [];
  const remoteShareStartCalls = [];
  let remoteShareStatus = {
    state: "stopped",
    port: null,
    currentProviders: [],
    mode: "share",
  };
  const fakeSessionManager = {
    sessions: new Map([
      [sessionId, {
        id: sessionId,
        sessionId,
        agent: "claude",
        command: "claude",
        args: [],
        status: "running",
        cwd: "/tmp/proj",
        pid: 12345,
        executorKind: "pty",
        startedAt: new Date().toISOString(),
        executor: spiedExecutor,
        adapter: spiedAdapter,
        // Internal-only fields that MUST NOT leak:
        scanTimer: 12345, // sentinel — projectSession must strip this
        cleanedUp: false,
        _privateStuff: "secret",
      }],
    ]),
    handleEventCalls: [],
    // Mimic SessionManager.handleEvent()'s dispatch to executor/adapter so we
    // can assert the local API correctly walks the control path. The real
    // SessionManager does the same dispatch; this is a one-method copy.
    handleEvent(payload) {
      this.handleEventCalls.push(payload);
      const session = this.sessions.get(payload.sessionId);
      if (!session) return;
      if (payload.type === "terminal.input") session.executor.write(payload.data || "");
      else if (payload.type === "terminal.interrupt") session.executor.interrupt();
      else if (payload.type === "agent.permission.resolve") session.adapter.resolvePermission(payload);
    },
  };

  // ---------- Boot the server ----------

  let relayConnected = false;
  const liveCtx = {
    sessionManager: fakeSessionManager,
    configProvider: () => readConfig(),
    getProxyStatus: async () => proxyStatus,
    startProxy: async (args) => {
      proxyStartCalls.push(args);
      return { ok: true, state: "running", port: args.port, pid: 7786, mode: args.mode };
    },
    restartProxy: async (args) => {
      proxyRestartCalls.push(args);
      return { ok: true, state: "running", port: args.port, pid: 7788, mode: args.mode };
    },
    getRemoteShareProxyStatus: async () => remoteShareStatus,
    startRemoteShareProxy: async (args) => {
      remoteShareStartCalls.push(args);
      remoteShareStatus = {
        state: "running",
        port: args.port,
        currentProviders: args.providerNames,
        mode: "share",
      };
      return { ok: true, ...remoteShareStatus };
    },
    stopRemoteShareProxy: async () => ({ ok: true, state: "stopped" }),
    restartRemoteShareProxy: async (args) => ({ ok: true, ...args, state: "running" }),
    startedAt: new Date(Date.now() - 5000).toISOString(), // 5s uptime
    pid: 99999,
    version: "test-0.1.0",
    relayUrl: "https://app.easytransnote.com",
    deviceId: "local-dev",
    relayConnected: () => relayConnected,
  };
  agentCatalog = new AgentCatalog({ stateDir: home });
  liveCtx.agentCatalog = agentCatalog;
  serverHandle = await startLocalApi(liveCtx, { port: 0 });
  // The server's liveCtx reads `ctx.localApiPort` lazily; we patch the bound
  // port onto the SAME ctx object we passed in.
  liveCtx.localApiPort = serverHandle.port;

  const base = `http://127.0.0.1:${serverHandle.port}`;

  // Stage 6+: pass `noAuth: true` on a request to skip the Authorization
  // header. Loopback requests are allowed; LAN requests still require bearer.
  async function getJson(path, { noAuth = false } = {}) {
    const headers = noAuth ? {} : { ...AUTH };
    const r = await fetch(`${base}${path}`, { headers });
    return { status: r.status, body: await r.json() };
  }
  async function postJson(path, body, { noAuth = false } = {}) {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(noAuth ? {} : AUTH) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  async function putJson(path, body, { noAuth = false } = {}) {
    const r = await fetch(`${base}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(noAuth ? {} : AUTH) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  async function deleteJson(path, { noAuth = false } = {}) {
    const r = await fetch(`${base}${path}`, {
      method: "DELETE",
      headers: noAuth ? {} : { ...AUTH },
    });
    return { status: r.status, body: await r.json() };
  }

  // ============================================================
  // Read endpoints
  // ============================================================

  // ---------- CLI-only Collaboration Coordinator ----------
  {
    const created = await postJson("/collaboration/local/runs", {
      objective: "Plan, implement, and verify export support.",
      agents: {
        lead: {
          runtime: "codex",
          device_id: "local-dev",
          responsibilities: ["research", "review_plan", "verify_result"],
        },
        worker: {
          runtime: "claude",
          device_id: "local-dev",
          responsibilities: ["propose_plan", "implement", "rework"],
        },
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.run.state, "created");
    const runId = created.body.run.run_id;
    const started = await postJson(`/collaboration/local/runs/${runId}/start`, {});
    assert.equal(started.body.run.state, "researching");
    const planning = await postJson(`/collaboration/local/runs/${runId}/begin-planning`, {});
    assert.equal(planning.body.run.state, "planning");
    const detail = await getJson(`/collaboration/local/runs/${runId}`);
    assert.equal(detail.body.run.agents.worker.runtime, "claude");
  }

  // ---------- GET /local/status ----------
  {
    const { status, body } = await getJson("/local/status");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.daemon.port, serverHandle.port, "daemon.port should be the bound port");
    assert.equal(body.daemon.pid, 99999);
    assert.equal(body.daemon.deviceId, "local-dev");
    assert.equal(body.daemon.version, "test-0.1.0");
    assert.equal(body.daemon.bindAddress, "127.0.0.1");
    assert.equal(body.daemon.authMode, "bearer");
    assert.equal(body.daemon.lanEnabled, false);
    assert.equal(body.daemon.baseUrl, `http://127.0.0.1:${serverHandle.port}`);
    assert.ok(body.daemon.uptimeSeconds >= 4, "uptime should reflect the seeded 5s start");
    assert.equal(body.relay.url, "https://app.easytransnote.com");
    assert.equal(body.relay.connected, false);
    assert.equal(body.proxy.state, "not-installed");
    assert.equal(body.proxy.port, null);
    assert.match(body.proxy.note, /LiteLLM/);
    assert.deepEqual(body.remoteShare.catalog, []);
  }

  // ---------- POST /remote-share/start ----------
  {
    const { status, body } = await postJson("/remote-share/start", {
      providers: ["minimax", "deepseek"],
      port: 40124,
      e2eePolicy: "required",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(remoteShareStartCalls.at(-1), {
      providerNames: ["minimax", "deepseek"],
      port: 40124,
    });
    assert.deepEqual(body.catalog.map((item) => item.provider), ["minimax", "deepseek"]);
    assert.equal(body.e2eePolicy, "required");
  }

  // ---------- POST /proxy/restart ----------
  {
    const start = await postJson("/proxy/start", { port: 43123 });
    assert.equal(start.status, 200);
    assert.equal(start.body.ok, true);
    assert.deepEqual(proxyStartCalls.at(-1), { mode: "route", port: 43123 });

    proxyStatus = {
      state: "running",
      port: 43123,
      version: "1.83.0",
      pid: 7787,
      currentProvider: null,
      mode: "route",
      routesHash: "abc",
      aliases: null,
    };
    const { status, body } = await postJson("/proxy/restart", {});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.port, 43123);
    assert.deepEqual(proxyRestartCalls.at(-1), { mode: "route", port: 43123 });
    proxyStatus = {
      state: "not-installed",
      port: null,
      version: null,
      pid: null,
      currentProvider: null,
      mode: null,
      routesHash: null,
      aliases: null,
      note: "LiteLLM proxy control lands in Stage 4.",
    };
  }

  // ---------- GET /providers ----------
  {
    const { status, body } = await getJson("/providers");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.providers.length, 2);
    const names = body.providers.map((p) => p.name).sort();
    assert.deepEqual(names, ["deepseek", "minimax"]);
    // apiKey is masked — never raw.
    for (const p of body.providers) {
      assert.ok(!p.apiKey.includes("1234567890"), `apiKey for ${p.name} should be masked`);
    }
  }

  // ---------- GET /providers/:name ----------
  {
    const { status, body } = await getJson("/providers/minimax");
    assert.equal(status, 200);
    assert.equal(body.provider.name, "minimax");
    // Stage 9.0: persisted type is "proxy", engine is "litellm". The
    // API projects the legacy "litellm" wire type for backward compat
    // with existing API consumers.
    assert.equal(body.provider.type, "proxy");
    assert.equal(body.provider.engine, "litellm");
    assert.equal(body.provider.litellmProvider, "anthropic");
  }
  {
    const { status, body } = await getJson("/providers/ghost");
    assert.equal(status, 404);
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown provider 'ghost'/);
  }
  {
    // Format-illegal names fall through to 404 (not 400). showProvider is the
    // single source of truth for "exists vs not".
    const { status, body } = await getJson("/providers/has%2Fslash");
    assert.equal(status, 404);
  }

  // ---------- POST /providers/use ----------
  {
    // Stage 7.8: provider use for claude writes ONLY routes.claude.main.
    // routes.claude.small is independent state owned by the routes layer;
    // smallFastModel is [legacy] and no longer seeds small on use.
    const { status, body } = await postJson("/providers/use", { name: "minimax", agent: "claude" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.setProvider, "minimax");
    assert.equal(body.setAgent, "claude");
    assert.equal(body.routes.claude.main.provider, "minimax");
    assert.equal(body.routes.claude.main.model,    "MiniMax-M3");
    assert.equal(body.routes.claude.small, null, "small must NOT be seeded from smallFastModel");
    // The response carries proxy state (no proxy in this fixture).
    assert.equal(body.proxy.state, "not-installed");
  }
  {
    // Stage 7.8: openai-compatible is a valid litellm provider; use
    // succeeds. small is preserved across provider use calls (still null
    // in this fixture — preservation of null).
    const { status, body } = await postJson("/providers/use", { name: "deepseek", agent: "claude" });
    assert.equal(status, 200);
    assert.equal(body.routes.claude.main.provider, "deepseek");
    assert.equal(body.routes.claude.small, null, "small remains unset across provider use calls");
  }
  {
    // Stage 7.8+: Claude "current" markers in the browser must be derived
    // from routes.claude, not the legacy currentProvider.claude field.
    writeConfig(setCurrentProvider(readConfig(), "claude", "minimax"));
    const { status, body } = await getJson("/providers");
    assert.equal(status, 200);
    const byName = Object.fromEntries(body.providers.map((p) => [p.name, p]));
    assert.equal(byName.deepseek.current.claude, "deepseek");
    assert.equal(byName.minimax.current.claude, null);
  }
  {
    // Missing agent -> 400
    const { status, body } = await postJson("/providers/use", { name: "minimax" });
    assert.equal(status, 400);
    assert.match(body.error, /agent must be/);
  }
  {
    // Bad agent value -> 400
    const { status, body } = await postJson("/providers/use", { name: "minimax", agent: "cursor" });
    assert.equal(status, 400);
  }
  {
    const { status, body } = await getJson("/routes", { noAuth: true });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  }
  {
    const { status, body } = await getJson("/routes");
    assert.equal(status, 200);
    assert.equal(body.routes.claude.main.provider, "deepseek");
  }
  {
    // Unknown provider -> 404
    const { status, body } = await postJson("/providers/use", { name: "ghost", agent: "claude" });
    assert.equal(status, 404);
  }
  {
    // Stage 8.0: codex is route-mode only. POST /providers/use { agent: "codex" }
    // writes routes.codex.main and projects it under routes.codex.
    const { status, body } = await postJson("/providers/use", { name: "deepseek", agent: "codex" });
    assert.equal(status, 200);
    assert.equal(body.routes.codex.main.provider, "deepseek");
    assert.equal(body.routes.codex.main.model, "deepseek-chat");
    assert.equal(body.setAgent, "codex");
  }
  {
    // GET /routes response shape: nested per-agent routes, flat aliases
    // (backward compat with local-console.html), nested aliases.
    const { status, body } = await getJson("/routes");
    assert.equal(status, 200);
    assert.equal(body.routes.claude.main.provider, "deepseek");
    assert.equal(body.routes.codex.main.provider, "deepseek");
    // Flat aliases (kept for local-console.html normalizeRoutesPayload).
    assert.equal(body.aliases.main,  "originrouter-claude-model");
    assert.equal(body.aliases.small, "originrouter-claude-fast-model");
    // Nested per-agent aliases (Stage 8.0).
    assert.equal(body.aliases.codex.main, "gpt-5.4");
    assert.equal(body.aliases.claude.main, "originrouter-claude-model");
  }
  {
    // GET /routes/codex shows only the Codex slot.
    const { status, body } = await getJson("/routes/codex");
    assert.equal(status, 200);
    assert.equal(body.agent, "codex");
    assert.equal(body.routes.main.provider, "deepseek");
    // Codex has no small slot in Stage 8.0; the response shape is { main }
    // without a `small` key.
    assert.equal(body.routes.small, undefined);
  }
  {
    // POST /routes/codex/main works.
    const { status, body } = await postJson("/routes/codex/main",
      { provider: "deepseek", model: "deepseek-chat" });
    assert.equal(status, 200);
    assert.equal(body.routes.codex.main.provider, "deepseek");
  }
  {
    // POST /routes/codex/small is a hard error.
    const { status, body } = await postJson("/routes/codex/small",
      { provider: "deepseek", model: "x" });
    assert.equal(status, 400);
    assert.match(body.error || "", /unknown route slot 'small' for agent 'codex'/);
  }
  {
    // DELETE /routes/codex/main works.
    const r = await fetch(`${base}/routes/codex/main`, {
      method: "DELETE", headers: AUTH,
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.routes.codex.main, null, "codex main cleared");
  }
  {
    // Re-set for the delete-cleanup test below.
    const { status } = await postJson("/routes/codex/main",
      { provider: "deepseek", model: "deepseek-chat" });
    assert.equal(status, 200);
  }

  // ============================================================
  // Stage 5: provider CRUD
  // ============================================================

  // ---------- POST /providers (add) ----------
  {
    // Success: response has masked apiKey; the raw key is persisted to disk.
    // Stage 7.6: type=litellm, litellmProvider=anthropic. The legacy
    // type=anthropic is rejected on add.
    const { status, body } = await postJson("/providers", {
      name: "newhire",
      type: "litellm",
      litellmProvider: "anthropic",
      baseUrl: "https://api.newhire.example/v1",
      apiKey: "sk-newhire-1234567890",
      model: "newhire-model",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.provider.name, "newhire");
    assert.ok(!body.provider.apiKey.includes("1234567890"), "apiKey must be masked in response");
    assert.match(body.provider.apiKey, /sk-n/);
    const cfg = readConfig();
    assert.equal(cfg.providers.newhire.apiKey, "sk-newhire-1234567890", "raw key must persist on disk");
    // Stage 9.0: persisted on disk is type=proxy, engine=litellm.
    assert.equal(cfg.providers.newhire.type, "proxy");
    assert.equal(cfg.providers.newhire.engine, "litellm");
    assert.equal(cfg.providers.newhire.litellmProvider, "anthropic");
  }
  {
    // Duplicate name -> 409 (validation runs before duplicate check in
    // the addProvider path; here we use a valid type=litellm).
    const { status, body } = await postJson("/providers", {
      name: "newhire", type: "litellm", litellmProvider: "anthropic",
      baseUrl: "https://x", apiKey: "sk-x", model: "m",
    });
    assert.equal(status, 409);
    assert.match(body.error, /already exists/);
  }
  {
    // Stage 7.6: missing type defaults to "litellm". The error then is
    // "litellm requires litellmProvider" (no litellmProvider on the body).
    const { status, body } = await postJson("/providers", {
      name: "noname", baseUrl: "https://x", apiKey: "sk-x", model: "m",
    });
    assert.equal(status, 400);
    assert.match(body.error, /requires litellmProvider/);
  }
  {
    // Invalid type -> 400.
    const { status, body } = await postJson("/providers", {
      name: "badtype", type: "gpt",
      baseUrl: "https://x", apiKey: "sk-x", model: "m",
    });
    assert.equal(status, 400);
    assert.match(body.error, /invalid type/);
  }
  {
    // Stage 7.7: apiKey is runtimeRequired (not required) so save now
    // succeeds; doctor warns about runtime need.
    const { status, body } = await postJson("/providers", {
      name: "nokey", type: "litellm", litellmProvider: "anthropic",
      baseUrl: "https://x", model: "m",
    });
    assert.equal(status, 200, `unexpected: ${JSON.stringify(body)}`);
    assert.ok(body.provider, "expected provider in response");
  }
  {
    // openai-compatible on add is rejected outright (Stage 7 migration).
    const { status, body } = await postJson("/providers", {
      name: "ocbad", type: "openai-compatible", baseUrl: "https://x",
      apiKey: "sk-x", model: "m",
    });
    assert.equal(status, 400);
    assert.match(body.error, /openai-compatible.*no longer supported/);
  }
  {
    // Stage 7.6: litellm/anthropic accepts any baseUrl shape; the
    // legacy direct anthropic validation no longer applies. The baseUrl
    // is opaque to OriginRouter (LiteLLM validates it).
    const { status, body } = await postJson("/providers", {
      name: "badurl", type: "litellm", litellmProvider: "anthropic",
      baseUrl: "not-a-url", apiKey: "sk-x", model: "m",
    });
    assert.equal(status, 200);
    assert.equal(body.provider.baseUrl, "not-a-url");
  }

  // ---------- PUT /providers/:name (update) ----------
  {
    // Successful update of baseUrl + model, no apiKey in body -> existing key preserved.
    // Stage 7.6: type=litellm/litellmProvider=anthropic.
    const { status, body } = await putJson("/providers/minimax", {
      type: "litellm",
      litellmProvider: "anthropic",
      baseUrl: "https://api.minimax.example/v2",
      model: "MiniMax-M3.1",
    });
    assert.equal(status, 200);
    assert.equal(body.provider.baseUrl, "https://api.minimax.example/v2");
    assert.equal(body.provider.model, "MiniMax-M3.1");
    const cfg = readConfig();
    assert.equal(cfg.providers.minimax.apiKey, "sk-minimax-1234567890", "absent apiKey must keep current");
    assert.equal(cfg.providers.minimax.baseUrl, "https://api.minimax.example/v2");
  }
  {
    // Empty-string apiKey -> keep current (Stage 5 rule).
    const { status } = await putJson("/providers/minimax", {
      type: "litellm", litellmProvider: "anthropic",
      baseUrl: "https://x", model: "m", apiKey: "",
    });
    assert.equal(status, 200);
    const cfg = readConfig();
    assert.equal(cfg.providers.minimax.apiKey, "sk-minimax-1234567890", "empty apiKey must keep current");
  }
  {
    // Non-empty apiKey -> rotated on disk.
    const { status } = await putJson("/providers/minimax", {
      type: "litellm", litellmProvider: "anthropic",
      baseUrl: "https://x", model: "m", apiKey: "sk-rotated-9999",
    });
    assert.equal(status, 200);
    const cfg = readConfig();
    assert.equal(cfg.providers.minimax.apiKey, "sk-rotated-9999", "non-empty apiKey must update");
  }
  {
    // Unknown name -> 404.
    const { status, body } = await putJson("/providers/ghost", {
      type: "anthropic", baseUrl: "https://x", model: "m",
    });
    assert.equal(status, 404);
    assert.match(body.error, /unknown provider 'ghost'/);
  }
  {
    // Stage 9.0: PUT with explicit type=anthropic is accepted as an
    // alias and normalized to proxy(engine=litellm, litellmProvider=anthropic).
    // The persisted record carries the canonical shape; the API response
    // is the projected record.
    const { status, body } = await putJson("/providers/minimax", {
      type: "anthropic", baseUrl: "https://x", model: "m-anthropic",
    });
    assert.equal(status, 200, `update failed: ${JSON.stringify(body)}`);
    assert.equal(body.provider.type, "proxy");
    assert.equal(body.provider.engine, "litellm");
    assert.equal(body.provider.litellmProvider, "anthropic");
    const cfg = readConfig();
    assert.equal(cfg.providers.minimax.type, "proxy");
    assert.equal(cfg.providers.minimax.engine, "litellm");
    assert.equal(cfg.providers.minimax.model, "m-anthropic");
  }
  {
    // apiKey wrong type (number) -> 400 (with type=litellm).
    const { status, body } = await putJson("/providers/minimax", {
      type: "litellm", litellmProvider: "anthropic",
      baseUrl: "https://x", model: "m", apiKey: 12345,
    });
    assert.equal(status, 400);
    assert.match(body.error, /must be a string/);
  }

  // ---------- DELETE /providers/:name ----------
  {
    // Successful remove.
    const { status, body } = await deleteJson("/providers/deepseek");
    assert.equal(status, 200);
    assert.equal(body.removed, "deepseek");
    const cfg = readConfig();
    assert.equal(cfg.providers.deepseek, undefined);
  }
  {
    // Already gone -> 404.
    const { status, body } = await deleteJson("/providers/deepseek");
    assert.equal(status, 404);
    assert.match(body.error, /unknown provider 'deepseek'/);
  }
  {
    // Restore deepseek for any later tests in this file that may need it.
    // (Future-proofing: if test order ever depends on it.)
    const restored = addProvider(readConfig(), {
      name: "deepseek",
      type: "litellm",
      litellmProvider: "custom_openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-ds-1234567890",
      model: "deepseek-chat",
    });
    writeConfig(restored);
  }

  // ---------- DELETE /providers/:name clears routes (Stage 7.8) ----------
  {
    // Seed two providers and route both main and small at one of them.
    let cfg = readConfig();
    cfg = addProvider(cfg, {
      name: "routed-main",
      type: "litellm",
      litellmProvider: "deepseek",
      apiKey: "sk-rm",
      model: "deepseek-chat",
    });
    cfg = addProvider(cfg, {
      name: "routed-fast",
      type: "litellm",
      litellmProvider: "deepseek",
      apiKey: "sk-rf",
      model: "deepseek-mini",
    });
    cfg = setRoute(cfg, "claude", "main",  { provider: "routed-main", model: "deepseek-chat" });
    cfg = setRoute(cfg, "claude", "small", { provider: "routed-fast", model: "deepseek-mini" });
    writeConfig(cfg);

    // Remove routed-fast: small should be cleared; main untouched; response
    // carries routes + proxy snapshot.
    const r1 = await deleteJson("/providers/routed-fast");
    assert.equal(r1.status, 200);
    assert.equal(r1.body.removed, "routed-fast");
    assert.equal(r1.body.routes.claude.main.provider,  "routed-main");
    assert.equal(r1.body.routes.claude.small, null, "small was pointing at the removed provider");
    assert.equal(r1.body.proxy && r1.body.proxy.state, "not-installed");
    const cfg1 = readConfig();
    assert.equal(cfg1.routes.claude.main.provider, "routed-main");
    assert.equal(cfg1.routes.claude.small, undefined);
    assert.equal(cfg1.providers["routed-fast"], undefined);

    // Now remove routed-main: main should be cleared; routes object should
    // be removed entirely (both slots gone).
    const r2 = await deleteJson("/providers/routed-main");
    assert.equal(r2.status, 200);
    assert.equal(r2.body.routes.claude.main,  null);
    assert.equal(r2.body.routes.claude.small, null);
    const cfg2 = readConfig();
    assert.equal(cfg2.routes, undefined, "all route slots cleared → routes object removed");
    assert.equal(cfg2.providers["routed-main"], undefined);
  }
  {
    // Routes pointing at an unrelated provider are NOT touched.
    let cfg = readConfig();
    cfg = addProvider(cfg, {
      name: "preserved-prov",
      type: "litellm",
      litellmProvider: "deepseek",
      apiKey: "sk-pp",
      model: "deepseek-chat",
    });
    cfg = addProvider(cfg, {
      name: "to-delete",
      type: "litellm",
      litellmProvider: "deepseek",
      apiKey: "sk-td",
      model: "deepseek-chat",
    });
    cfg = setRoute(cfg, "claude", "main", { provider: "preserved-prov", model: "deepseek-chat" });
    writeConfig(cfg);
    const r = await deleteJson("/providers/to-delete");
    assert.equal(r.status, 200);
    const cfg2 = readConfig();
    assert.equal(cfg2.routes.claude.main.provider, "preserved-prov", "unrelated route preserved");
    assert.equal(cfg2.providers["to-delete"], undefined);
  }

  // ============================================================
  // Stage 6: auth gate + new endpoints
  // ============================================================

  // ---------- GET /local/auth/challenge (public) ----------
  {
    const { status, body } = await getJson("/local/auth/challenge");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.authRequired, true);
    assert.ok(body.tokenFile.endsWith("local-api.token"), `tokenFile = ${body.tokenFile}`);
  }

  // ---------- Loopback write without token succeeds ----------
  {
    const { status, body } = await postJson("/providers/use", { name: "minimax", agent: "claude" }, { noAuth: true });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.setProvider, "minimax");
  }

  // ---------- /proxy/logs is available to loopback without token ----------
  {
    const r = await fetch(`${base}/proxy/logs?tail=10`);
    assert.equal(r.status, 404);
  }
  {
    // Without a logPath recorded, authenticated request also returns 404.
    const { status, body } = await getJson("/proxy/logs?tail=10");
    assert.equal(status, 404);
  }
  {
    // Bad tail -> 400.
    const { status, body } = await getJson("/proxy/logs?tail=0");
    assert.equal(status, 400);
  }

  // ---------- GET /proxy/status ----------
  {
    const { status, body } = await getJson("/proxy/status");
    assert.equal(status, 200);
    assert.equal(body.state, "not-installed");
  }

  // ---------- GET /sessions (empty) ----------
  {
    const { status, body } = await getJson("/sessions");
    assert.equal(status, 200);
    assert.equal(body.sessions.length, 1);
    const s = body.sessions[0];
    // Whitelist: only safe fields.
    assert.equal(s.sessionId, sessionId);
    assert.equal(s.agent, "claude");
    assert.equal(s.command, "claude");
    assert.equal(s.status, "running");
    assert.equal(s.cwd, "/tmp/proj");
    assert.equal(s.pid, 12345);
    assert.equal(s.executor, "pty");
    // Internal fields MUST NOT leak.
    assert.equal(s.adapter, undefined, "adapter instance must not be in JSON");
    assert.equal(s.executor_instance, undefined, "executor instance must not be in JSON");
    assert.equal(s.scanTimer, undefined, "scanTimer handle must not be in JSON");
    assert.equal(s.cleanedUp, undefined, "internal cleanedUp flag must not be in JSON");
    assert.equal(s._privateStuff, undefined, "underscore-prefixed fields must not leak");
  }

  // ============================================================
  // Write endpoints (control paths) — the critical assertions.
  // These MUST route through sessionManager.handleEvent(), NOT relayClient.send().
  // ============================================================

  // Reset the spies.
  fakeSessionManager.handleEventCalls.length = 0;
  spiedExecutor.writeCalls.length = 0;
  spiedExecutor.interruptCalls = 0;
  spiedAdapter.resolvePermissionCalls.length = 0;

  // ---------- POST /sessions/:id/input ----------
  {
    const { status, body } = await postJson(`/sessions/${sessionId}/input`, { data: "ls\r" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.action, "input");
    // The handle was called with the right payload.
    assert.equal(fakeSessionManager.handleEventCalls.length, 1);
    assert.deepEqual(fakeSessionManager.handleEventCalls[0], {
      type: "terminal.input", sessionId, data: "ls\r",
    });
    // And executor.write was actually invoked via the SessionManager's existing path.
    assert.deepEqual(spiedExecutor.writeCalls, ["ls\r"]);
  }

  // ---------- POST /sessions/:id/interrupt ----------
  {
    const { status, body } = await postJson(`/sessions/${sessionId}/interrupt`, {});
    assert.equal(status, 200);
    assert.equal(body.action, "interrupt");
    assert.deepEqual(fakeSessionManager.handleEventCalls[1], {
      type: "terminal.interrupt", sessionId,
    });
    assert.equal(spiedExecutor.interruptCalls, 1);
  }

  // ---------- POST /sessions/:id/permission ----------
  {
    const { status, body } = await postJson(`/sessions/${sessionId}/permission`, {
      callId: "perm_abc", decision: "approved",
    });
    assert.equal(status, 200);
    assert.equal(body.action, "permission");
    assert.deepEqual(fakeSessionManager.handleEventCalls[2], {
      type: "agent.permission.resolve",
      sessionId,
      callId: "perm_abc",
      decision: "approved",
      data: undefined,
    });
    assert.equal(spiedAdapter.resolvePermissionCalls.length, 1);
    assert.equal(spiedAdapter.resolvePermissionCalls[0].callId, "perm_abc");
    assert.equal(spiedAdapter.resolvePermissionCalls[0].decision, "approved");
  }

  // ---------- Bad input payloads ----------
  {
    const { status, body } = await postJson(`/sessions/${sessionId}/input`, {});
    assert.equal(status, 400);
    assert.match(body.error, /body\.data must be a string/);
  }
  {
    const { status, body } = await postJson(`/sessions/${sessionId}/permission`, { decision: "approved" });
    assert.equal(status, 400);
    assert.match(body.error, /body\.callId is required/);
  }
  {
    const { status, body } = await postJson(`/sessions/${sessionId}/permission`, { callId: "x" });
    assert.equal(status, 400);
    assert.match(body.error, /body\.decision is required/);
  }

  // ---------- Unknown session id -> 404, handleEvent NOT called ----------
  {
    fakeSessionManager.handleEventCalls.length = 0;
    const { status, body } = await postJson(`/sessions/nope/input`, { data: "x" });
    assert.equal(status, 404);
    assert.equal(fakeSessionManager.handleEventCalls.length, 0, "handleEvent must NOT be called for unknown session");
  }

  // ============================================================
  // CORS preflight + bind safety
  // ============================================================

  {
    const r = await fetch(`${base}/providers`, { method: "OPTIONS" });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("access-control-allow-methods"), "GET, POST, PUT, DELETE, OPTIONS");
    assert.equal(r.headers.get("access-control-allow-headers"), "Content-Type, Authorization");
  }

  // Bind safety: refuses non-loopback addresses BEFORE attempting to listen
  // unless the caller explicitly opts into LAN control.
  // We construct the ctx with bindAddress: "0.0.0.0" and assert the throw —
  // no second server is started.
  let bindError = null;
  try {
    await startLocalApi({
      sessionManager: fakeSessionManager,
      bindAddress: "0.0.0.0",
    }, { port: 0 });
  } catch (err) {
    bindError = err;
  }
  assert.ok(bindError, "startLocalApi with bindAddress='0.0.0.0' should throw");
  assert.match(bindError.message, /requires --allow-lan/);

  let lanHandle = null;
  try {
    lanHandle = await startLocalApi({
      sessionManager: fakeSessionManager,
      bindAddress: "0.0.0.0",
      allowLanControl: true,
    }, { port: 0 });
    assert.equal(lanHandle.bindAddress, "0.0.0.0");
  } finally {
    if (lanHandle) await lanHandle.close();
  }

  // Same for any non-loopback address.
  for (const bad of ["192.168.1.1", "10.0.0.1", "8.8.8.8"]) {
    let err2 = null;
    try { await startLocalApi({ sessionManager: fakeSessionManager, bindAddress: bad }, { port: 0 }); }
    catch (e) { err2 = e; }
    assert.ok(err2, `${bad} should be rejected`);
  }

  // ============================================================
  // projectSession helper
  // ============================================================

  {
    const projected = projectSession({
      id: "x", sessionId: "x", agent: "claude", command: "claude", args: ["--foo"],
      status: "running", cwd: "/x", pid: 1, executorKind: "pty",
      startedAt: "2026-06-17T00:00:00Z",
      adapter: { resolvePermission: () => {} },
      scanTimer: 12345,
      cleanedUp: false,
    });
    assert.deepEqual(projected, {
      sessionId: "x",
      agent: "claude",
      command: "claude",
      args: ["--foo"],
      status: "running",
      cwd: "/x",
      pid: 1,
      executor: "pty",
      startedAt: "2026-06-17T00:00:00Z",
    });
  }

  // ============================================================
  // Stage 7: catalog endpoint + new field validation
  // ============================================================

  // ---------- GET /catalog/litellm-providers is public ----------
  {
    // Reach without an Authorization header (noAuth = true bypasses injection).
    const { status, body } = await getJson("/catalog/litellm-providers", { noAuth: true });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.providers) && body.providers.length >= 5);
    const ids = body.providers.map((p) => p.id);
    assert.ok(ids.includes("deepseek"));
    assert.ok(ids.includes("bedrock"));
    assert.ok(ids.includes("qwen-via-dashscope"));
    // Each entry has the basic shape.
    const first = body.providers[0];
    assert.ok(first.id && first.label && first.prefix && Array.isArray(first.fields));
  }

  // ---------- POST /providers with type=litellm + litellmProvider=bedrock ----------
  {
    const { status, body } = await postJson("/providers", {
      name: "br-test",
      type: "litellm",
      litellmProvider: "bedrock",
      awsRegion: "us-east-1",
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    });
    assert.equal(status, 200);
    assert.equal(body.provider.litellmProvider, "bedrock");
    assert.equal(body.provider.awsRegion, "us-east-1");
  }
  {
    // Stage 7.7: awsRegion is runtimeRequired only — save succeeds. Doctor
    // warns about runtime need; proxy-start surfaces hint when LiteLLM
    // refuses to boot.
    const { status, body } = await postJson("/providers", {
      name: "br-noregion",
      type: "litellm",
      litellmProvider: "bedrock",
      model: "x",
    });
    assert.equal(status, 200, `unexpected: ${JSON.stringify(body)}`);
  }
  {
    // Unknown litellmProvider -> 400.
    const { status, body } = await postJson("/providers", {
      name: "ghost",
      type: "litellm",
      litellmProvider: "ghost",
      apiKey: "k",
      model: "m",
    });
    assert.equal(status, 400);
    assert.match(body.error, /not a known LiteLLM adapter/);
  }

  // ---------- POST /providers with type=openai-compatible -> 400 ----------
  {
    const { status, body } = await postJson("/providers", {
      name: "legacy-add",
      type: "openai-compatible",
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
    });
    assert.equal(status, 400);
    assert.match(body.error, /no longer supported/);
  }

  // ---------- PUT on legacy record auto-normalizes ----------
  {
    // Hand-edit disk to legacy shape.
    const cfg = readConfig();
    cfg.providers.deepseek = {
      name: "deepseek",
      type: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-ds-1234567890",
      model: "deepseek-chat",
    };
    writeConfig(cfg);
    // PUT with no `type` field — auto-normalize.
    const { status, body } = await putJson("/providers/deepseek", {
      baseUrl: "https://api.deepseek.com/v2",
    });
    assert.equal(status, 200);
    // Stage 9.0: API response carries the canonical projected shape.
    assert.equal(body.provider.type, "proxy");
    assert.equal(body.provider.engine, "litellm");
    assert.equal(body.provider.litellmProvider, "custom_openai");
    assert.equal(body.provider.baseUrl, "https://api.deepseek.com/v2");
    // Disk shape now migrated.
    const reread = readConfig();
    assert.equal(reread.providers.deepseek.type, "proxy");
    assert.equal(reread.providers.deepseek.engine, "litellm");
    assert.equal(reread.providers.deepseek.litellmProvider, "custom_openai");
  }
  {
    // PUT with explicit type=openai-compatible rejects.
    const { status, body } = await putJson("/providers/deepseek", {
      type: "openai-compatible",
    });
    assert.equal(status, 400);
    assert.match(body.error, /no longer supported/);
  }

  // ---------- PUT smallFastModel on litellm -> warnings[] returned ----------
  {
    // Reset deepseek to a fresh litellm record.
    writeConfig(addProvider(readConfig(), {
      name: "ds-fresh",
      type: "litellm",
      litellmProvider: "deepseek",
      apiKey: "sk-ds",
      model: "deepseek-chat",
    }));
    const { status, body } = await putJson("/providers/ds-fresh", {
      smallFastModel: "fast",
    });
    assert.equal(status, 200);
    // Stage 7.6: smallFastModel on litellm is allowed (it's a seed for
    // routes.claude.small on provider use). No warning, no drop.
    assert.equal(body.provider.smallFastModel, "fast");
    assert.equal(body.warnings.length, 0);
  }

  // ---------- GET /providers/:name masks new secret fields ----------
  {
    const { status, body } = await postJson("/providers", {
      name: "aws-secret",
      type: "litellm",
      litellmProvider: "bedrock",
      awsRegion: "us-east-1",
      awsSecretAccessKey: "very-long-secret-1234567890",
      awsSessionToken: "session-token-abcdef",
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    });
    assert.equal(status, 200);
    // The response in POST is `provider` (showProvider) which uses maskSecret.
    assert.notEqual(body.provider.awsSecretAccessKey, "very-long-secret-1234567890");
    assert.notEqual(body.provider.awsSessionToken, "session-token-abcdef");
  }

  // ---------- Local-first external Agent session bridge ----------
  {
    const initial = await getJson("/agent/local/settings/detail");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.profile, "concise");

    const updated = await putJson("/agent/local/settings/detail", {
      profile: "standard",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.profile, "standard");
    assert.equal(readConfig().agent.detailProfile, "standard");

    const rejected = await putJson("/agent/local/settings/detail", {
      profile: "raw-terminal",
    });
    assert.equal(rejected.status, 400);
  }

  // ---------- Local-first external Agent session bridge ----------
  {
    const transcriptPath = join(home, "claude-session.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({
        type: "user",
        uuid: "local-u1",
        timestamp: "2026-07-17T00:00:00Z",
        message: { content: "hello from terminal" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "local-a1",
        timestamp: "2026-07-17T00:00:01Z",
        message: { content: [{ type: "text", text: "hello from Claude" }] },
      }),
    ].join("\n"));
    const registered = await postJson("/agent/local/sessions/register", {
      sessionId: "external-claude-1",
      agent: "claude",
      title: "Claude local session",
      deviceId: "local-dev",
      cwd: home,
      transcriptPath,
    });
    assert.equal(registered.status, 200);
    assert.equal(registered.body.session.session_id, "external-claude-1");

    const catalogStatus = await getJson("/agent/catalog/status");
    assert.equal(catalogStatus.status, 200);
    assert.equal(catalogStatus.body.catalog.conversations, 1);
    const catalogList = await getJson("/agent/catalog/conversations?search=Claude");
    assert.equal(catalogList.status, 200);
    assert.equal(catalogList.body.conversations.length, 1);
    assert.equal(
      catalogList.body.conversations[0].conversation_id,
      "external-claude-1",
    );
    assert.equal(catalogList.body.conversations[0].transcript_available, true);
    const catalogDetail = await getJson(
      "/agent/catalog/conversations/external-claude-1",
    );
    assert.equal(catalogDetail.status, 200);
    assert.equal(catalogDetail.body.conversation.runs.length, 1);
    const catalogWorkspaces = await getJson("/agent/catalog/workspaces");
    assert.equal(catalogWorkspaces.status, 200);
    assert.equal(catalogWorkspaces.body.workspaces.length, 1);

    const sessions = await getJson("/agent/local/sessions");
    assert.equal(sessions.body.sessions.length, 1);
    assert.equal(sessions.body.sessions[0].control_path, "local");
    assert.ok(!JSON.stringify(sessions.body).includes(transcriptPath));

    const history = await getJson("/agent/local/sessions/external-claude-1/history?limit=50");
    assert.deepEqual(history.body.messages.map((item) => item.text), [
      "hello from terminal",
      "hello from Claude",
    ]);

    const localAudit = new LocalAuditStore({ stateDir: home });
    localAudit.appendEvent(
      { sessionId: "external-claude-1", cwd: home, agent: "claude" },
      {
        type: "agent.interaction.requested",
        interactionId: "audit-approval-1",
        kind: "permission",
        title: "Run migration?",
        payload: {
          tool: "Bash",
          command: "mysql -e \"ALTER TABLE users ADD COLUMN flag INT\"",
          cwd: home,
        },
      },
    );
    localAudit.appendEvent(
      { sessionId: "external-claude-1", cwd: home, agent: "claude" },
      {
        type: "agent.interaction.result",
        interactionId: "audit-approval-1",
        status: "applied",
        action: "allow",
        decisionSource: "app_local",
      },
    );
    const audit = await getJson(
      "/agent/local/sessions/external-claude-1/audit?category=approval&limit=20",
    );
    assert.equal(audit.status, 200);
    assert.equal(audit.body.records.length, 1);
    assert.equal(audit.body.records[0].outcome, "allowed");
    assert.equal(audit.body.records[0].decisionSource, "app_local");

    const inquiry = await postJson(
      "/agent/local/sessions/external-claude-1/inquiries/approval/query",
      {
        protocol_version: "1",
        query_id: "inq_localapi0001",
        query: "Who approved this request?",
      },
    );
    assert.equal(inquiry.status, 200);
    assert.equal(inquiry.body.evidence_bundle.domain, "approval");
    assert.equal(inquiry.body.evidence_bundle.evidence.length, 1);
    assert.equal(
      inquiry.body.evidence_bundle.evidence[0].source_type,
      "approval_decision",
    );
    assert.equal(inquiry.body.evidence_bundle.policy.allow_actions, false);

    const sent = await postJson("/agent/local/sessions/external-claude-1/message", {
      message: "continue",
    });
    assert.equal(sent.body.accepted, true);
    assert.match(sent.body.request_id, /^local_command_/);
    const commands = await getJson("/agent/local/sessions/external-claude-1/commands?after=0");
    assert.equal(commands.body.commands[0].message, "continue");

    const interaction = await postJson("/agent/local/sessions/external-claude-1/interaction", {
      interactionId: "interaction-local-1",
      responseId: "response-local-1",
      action: "allow",
      response: { remember_for_session: true },
    });
    assert.equal(interaction.body.accepted, true);
    const mode = await postJson("/agent/local/sessions/external-claude-1/mode", {
      mode: "plan",
      requestId: "mode-local-1",
    });
    assert.equal(mode.body.accepted, true);
    const autonomy = await postJson("/agent/local/sessions/external-claude-1/autonomy", {
      profile: "custom",
      allowedScopes: ["workspace_edits", "workspace_commands"],
      requestId: "autonomy-local-1",
    });
    assert.equal(autonomy.body.accepted, true);
    const controlCommands = await getJson("/agent/local/sessions/external-claude-1/commands?after=1");
    assert.deepEqual(controlCommands.body.commands.map((item) => item.type), [
      "agent.interaction.resolve",
      "agent.mode.set",
      "agent.autonomy.set",
    ]);
    assert.deepEqual(controlCommands.body.commands.at(-1).allowedScopes, [
      "workspace_edits",
      "workspace_commands",
    ]);

    const stopped = await postJson("/agent/local/sessions/external-claude-1/stop", {});
    assert.equal(stopped.body.accepted, true);
    const stopCommand = await getJson("/agent/local/sessions/external-claude-1/commands?after=4");
    assert.equal(stopCommand.body.commands[0].type, "session.stop");

    await postJson("/agent/local/sessions/external-claude-1/events", {
      event: { type: "agent.text", text: "live reply" },
    });
    const events = await getJson("/agent/local/events?after=0");
    assert.ok(events.body.events.some((event) => event.text === "live reply"));
  }

  console.log("local api smoke ok");
} finally {
  if (serverHandle) await serverHandle.close();
  if (agentCatalog) agentCatalog.close();
  rmSync(home, { recursive: true, force: true });
}
