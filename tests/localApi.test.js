// Stage 3 local API smoke. Spawns startLocalApi() in-process on an ephemeral
// port and exercises every route with real HTTP requests. Uses a hand-crafted
// SessionManager-shaped fake with spy executor/adapter so we can assert that
// write paths route through sessionManager.handleEvent() and NOT through any
// relay.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalApi, projectSession } from "../src/local/localApi.js";
import { addProvider, setCurrentProvider } from "../src/config/providers.js";
import { setRoute } from "../src/config/routes.js";
import { readConfig, writeConfig } from "../src/persistence/state.js";
import { ensureApiToken } from "../src/persistence/authToken.js";

const home = mkdtempSync(join(tmpdir(), "originrouter-localapi-test-"));
process.env.ORIGINROUTER_HOME = home;

// Stage 6: ensure a token is on disk before booting the API. The auth gate
// refuses all writes when the file is missing (503 auth-not-initialized).
const TOKEN = ensureApiToken(home);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

let serverHandle;
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
    startedAt: new Date(Date.now() - 5000).toISOString(), // 5s uptime
    pid: 99999,
    version: "test-0.1.0",
    relayUrl: "http://localhost:8787",
    deviceId: "local-dev",
    relayConnected: () => relayConnected,
  };
  serverHandle = await startLocalApi(liveCtx, { port: 0 });
  // The server's liveCtx reads `ctx.localApiPort` lazily; we patch the bound
  // port onto the SAME ctx object we passed in.
  liveCtx.localApiPort = serverHandle.port;

  const base = `http://127.0.0.1:${serverHandle.port}`;

  // Stage 6: pass `noAuth: true` on a request to skip the Authorization
  // header. Used by the auth tests that assert 401/503 responses.
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

  // ---------- GET /local/status ----------
  {
    const { status, body } = await getJson("/local/status");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.daemon.port, serverHandle.port, "daemon.port should be the bound port");
    assert.equal(body.daemon.pid, 99999);
    assert.equal(body.daemon.deviceId, "local-dev");
    assert.equal(body.daemon.version, "test-0.1.0");
    assert.ok(body.daemon.uptimeSeconds >= 4, "uptime should reflect the seeded 5s start");
    assert.equal(body.relay.url, "http://localhost:8787");
    assert.equal(body.relay.connected, false);
    assert.equal(body.proxy.state, "not-installed");
    // Stage 5: handleLocalStatus now returns the real getProxyStatus() shape
    // (richer than the Stage 3 stub). The test's liveCtx has no getProxyStatus
    // override, so placeholderProxyStatus() runs — its shape is what we assert.
    assert.equal(body.proxy.port, null);
    assert.match(body.proxy.note, /LiteLLM/);
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
    assert.equal(body.provider.type, "litellm");
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
    assert.equal(status, 401);
    assert.equal(body.ok, false);
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
    assert.equal(body.aliases.codex.main, "originrouter-codex-model");
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
    assert.equal(cfg.providers.newhire.type, "litellm");
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
    // PUT with explicit type=anthropic is rejected.
    const { status, body } = await putJson("/providers/minimax", {
      type: "anthropic", baseUrl: "https://x", model: "m",
    });
    assert.equal(status, 400);
    assert.match(body.error, /type 'anthropic' is no longer supported/);
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

  // ---------- Write without token → 401 ----------
  {
    const { status, body } = await postJson("/providers/use", { name: "minimax", agent: "claude" }, { noAuth: true });
    assert.equal(status, 401);
    assert.equal(body.reason, "missing");
    assert.equal(body.error, "unauthorized");
    const r = await fetch(`${base}/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ghost", type: "anthropic", baseUrl: "https://x", apiKey: "sk-x", model: "m" }),
    });
    assert.equal(r.status, 401);
  }

  // ---------- Malformed token → 401 ----------
  {
    const r = await fetch(`${base}/providers/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer not-hex" },
      body: JSON.stringify({ name: "minimax", agent: "claude" }),
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.reason, "malformed");
  }

  // ---------- Wrong token → 401 ----------
  {
    const wrong = "0".repeat(64);
    const r = await fetch(`${base}/providers/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${wrong}` },
      body: JSON.stringify({ name: "minimax", agent: "claude" }),
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.reason, "invalid");
    // The 401 must also include the WWW-Authenticate hint.
    assert.match(r.headers.get("www-authenticate") || "", /Bearer realm="originrouter-local"/);
  }

  // ---------- /proxy/logs requires auth (GET) ----------
  {
    const r = await fetch(`${base}/proxy/logs?tail=10`);
    assert.equal(r.status, 401);
  }
  {
    // Without a logPath recorded, even authenticated request returns 404.
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

  // Bind safety: refuses non-loopback addresses BEFORE attempting to listen.
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
  assert.match(bindError.message, /bindAddress must be 127\.0\.0\.1 or ::1/);

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
    assert.equal(body.provider.type, "litellm");
    assert.equal(body.provider.litellmProvider, "custom_openai");
    assert.equal(body.provider.baseUrl, "https://api.deepseek.com/v2");
    // Disk shape now migrated.
    const reread = readConfig();
    assert.equal(reread.providers.deepseek.type, "litellm");
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

  console.log("local api smoke ok");
} finally {
  if (serverHandle) await serverHandle.close();
  rmSync(home, { recursive: true, force: true });
}
